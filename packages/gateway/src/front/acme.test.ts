import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { crypto as acmeCrypto, type Authorization } from "acme-client";
import { afterEach, describe, expect, it } from "vitest";
import type { Log } from "../log.ts";
import { startHttp } from "../server.ts";
import { selfSigned, testCa, type TestCa } from "../testing/certs.ts";
import { testConfig, testDeps } from "../testing/harness.ts";
import { Acme, type Order, type OrderRequest } from "./acme.ts";
import { CertStore } from "./certs.ts";
import { startTlsFront, type TlsFront } from "./index.ts";
import { acmeProtocol } from "./tls.ts";

const name = "mcp.bugnet.sh";
const day = 86_400_000;
const keyAuthorization = "token-abc.thumbprint-xyz";
const v4Header = Buffer.from(
    "0d0a0d0a000d0a515549540a" + "2111000c" + "cb0071077f000001" + "9c4020fc",
    "hex",
);

interface Logged {
    level: string;
    msg: string;
    fields?: Record<string, unknown>;
}

function recordLog(lines: Logged[]): Log {
    return {
        info: (msg, fields) => lines.push({ level: "info", msg, fields }),
        warn: (msg, fields) => lines.push({ level: "warn", msg, fields }),
        error: (msg, fields) => lines.push({ level: "error", msg, fields }),
    };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "bugnet-acme-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

async function tlsTo(port: number, opts: ConnectionOptions): Promise<TLSSocket> {
    const raw = netConnect(port, "127.0.0.1");
    raw.on("error", () => {});
    await once(raw, "connect");
    raw.write(v4Header);
    const socket = tlsConnect({ socket: raw, servername: name, ...opts });
    cleanups.push(() => void socket.destroy());
    await once(socket, "secureConnect");
    return socket;
}

interface FakeCa {
    order: Order;
    requests: OrderRequest[];
    port: (p: number) => void;
}

// Answers like an ACME CA, checking each name over a real acme-tls/1 handshake before it signs
function fakeCa(ca: TestCa, lifetimeMs = 90 * day): FakeCa {
    let setPort: (p: number) => void = () => {};
    const port = new Promise<number>((r) => (setPort = r));
    const requests: OrderRequest[] = [];
    const order: Order = async (req) => {
        requests.push(req);
        for (const value of acmeCrypto.readCsrDomains(req.csr).altNames) {
            const authz = { identifier: { type: "dns", value } } as Authorization;
            await req.challenges.answer(authz, keyAuthorization);
            const probe = await tlsTo(await port, {
                servername: value,
                ALPNProtocols: [acmeProtocol],
                rejectUnauthorized: false,
            });
            const pem = probe.getPeerX509Certificate()?.toString() ?? "";
            if (!acmeCrypto.isAlpnCertificateAuthorizationValid(pem, keyAuthorization)) {
                throw new Error(`the challenge for ${value} failed`);
            }
            req.challenges.withdraw(value);
        }
        const now = Date.now();
        return ca.issue(req.csr, {
            notBefore: new Date(now - 60_000),
            notAfter: new Date(now + lifetimeMs),
        });
    };
    return { order, requests, port: setPort };
}

async function startAcmeFront(dir: string, fake: FakeCa, toml = ""): Promise<[TlsFront, Logged[]]> {
    const config = testConfig(
        [
            'listen_addr = "127.0.0.1:0"',
            `public_url = "https://${name}"`,
            "[front]",
            'tls_addr = "127.0.0.1:0"',
            'acme_directory = "https://acme.invalid/directory"',
            "acme_accept_terms = true",
            `acme_dir = "${dir}"`,
            toml,
        ].join("\n"),
    );
    const http: HttpServer = await startHttp(testDeps({ config }), []);
    const logs: Logged[] = [];
    const tls = await startTlsFront(config, http, recordLog(logs), fake.order);
    cleanups.push(async () => {
        http.closeAllConnections();
        await new Promise((r) => http.close(r));
        await tls.close();
    });
    fake.port((tls.front.server.address() as AddressInfo).port);
    return [tls, logs];
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("ACME certificates", () => {
    it("orders through a real acme-tls/1 handshake and serves the issued chain", async () => {
        const dir = tempDir();
        const ca = await testCa();
        const fake = fakeCa(ca);
        const [tls, logs] = await startAcmeFront(dir, fake);
        await expect.poll(() => tls.certs.current?.names, { timeout: 10_000 }).toEqual([name]);
        expect(fake.requests).toHaveLength(1);
        const port = (tls.front.server.address() as AddressInfo).port;
        const socket = await tlsTo(port, { ca: [ca.cert] });
        expect(socket.authorized).toBe(true);
        expect(socket.getPeerX509Certificate()?.fingerprint256.replaceAll(":", "")).toBe(
            tls.certs.current?.sha256.toUpperCase(),
        );
        expect(mode(dir)).toBe(0o700);
        expect(mode(join(dir, "account.key"))).toBe(0o600);
        expect(mode(join(dir, "key.pem"))).toBe(0o600);
        expect(mode(join(dir, "cert.pem"))).toBe(0o644);
        expect(logs.map((l) => l.msg)).toEqual(
            expect.arrayContaining(["ACME account key created", "certificate issued"]),
        );
        const issued = logs.find((l) => l.msg === "certificate issued");
        expect(issued?.fields).toMatchObject({ names: [name] });
        expect(tls.certs.challenge(name)).toBeUndefined();
        expect(tls.acme?.nextCheckAt).toBeGreaterThan(Date.now() + 11 * 3_600_000);
    });

    it("keeps the account key and a valid certificate across restarts", async () => {
        const dir = tempDir();
        const ca = await testCa();
        const first = fakeCa(ca);
        const [tls] = await startAcmeFront(dir, first);
        await expect.poll(() => tls.certs.current, { timeout: 10_000 }).toBeDefined();
        const sha = tls.certs.current?.sha256;
        await tls.close();
        const accountKey = readFileSync(join(dir, "account.key"));

        const second = fakeCa(ca);
        const [again, logs] = await startAcmeFront(dir, second);
        expect(again.certs.current?.sha256).toBe(sha);
        await expect.poll(() => again.acme?.nextCheckAt).toBeGreaterThan(Date.now());
        expect(second.requests).toHaveLength(0);
        expect(logs[0]?.msg).toBe("certificate loaded");

        const third = fakeCa(ca);
        const [more] = await startAcmeFront(
            dir,
            third,
            'acme_domains = ["mcp.bugnet.sh", "gw.bugnet.sh"]',
        );
        await expect
            .poll(() => more.certs.current?.names, { timeout: 10_000 })
            .toEqual(["mcp.bugnet.sh", "gw.bugnet.sh"]);
        expect(third.requests[0]?.accountKey.equals(accountKey)).toBe(true);
    });

    it("refuses to start with ACME off when the certificate files fail", async () => {
        const dir = tempDir();
        const config = testConfig(
            [
                "[front]",
                'tls_addr = "127.0.0.1:0"',
                `cert_file = "${join(dir, "missing.pem")}"`,
                `key_file = "${join(dir, "missing.key")}"`,
            ].join("\n"),
        );
        const http = await startHttp(
            testDeps({ config: testConfig('listen_addr = "127.0.0.1:0"') }),
        );
        cleanups.push(async () => {
            await new Promise((r) => http.close(r));
        });
        await expect(startTlsFront(config, http, recordLog([]))).rejects.toThrow(
            /front certificate: ENOENT/,
        );
    });

    it("logs a failed reload and keeps the certificate in use", async () => {
        const dir = tempDir();
        const pair = await selfSigned([name]);
        writeFileSync(join(dir, "c.pem"), pair.cert);
        writeFileSync(join(dir, "k.pem"), pair.key);
        const config = testConfig(
            [
                'listen_addr = "127.0.0.1:0"',
                "[front]",
                'tls_addr = "127.0.0.1:0"',
                `cert_file = "${join(dir, "c.pem")}"`,
                `key_file = "${join(dir, "k.pem")}"`,
            ].join("\n"),
        );
        const http = await startHttp(testDeps({ config }));
        const logs: Logged[] = [];
        const tls = await startTlsFront(config, http, recordLog(logs));
        cleanups.push(async () => {
            await new Promise((r) => http.close(r));
            await tls.close();
        });
        const sha = tls.certs.current?.sha256;
        writeFileSync(join(dir, "c.pem"), "garbage");
        tls.reload();
        expect(logs.at(-1)).toMatchObject({ level: "error" });
        expect(tls.certs.current?.sha256).toBe(sha);
        const next = await selfSigned([name]);
        writeFileSync(join(dir, "c.pem"), next.cert);
        writeFileSync(join(dir, "k.pem"), next.key);
        tls.reload();
        expect(logs.at(-1)).toMatchObject({ level: "info", msg: "certificate reloaded" });
        expect(tls.certs.current?.sha256).not.toBe(sha);
    });
});

describe("renewal timing", () => {
    async function store(dir: string, notBefore: number, notAfter: number, names = [name]) {
        const pair = await selfSigned(names, {
            notBefore: new Date(notBefore),
            notAfter: new Date(notAfter),
        });
        writeFileSync(join(dir, "cert.pem"), pair.cert);
        writeFileSync(join(dir, "key.pem"), pair.key);
        const certs = new CertStore(join(dir, "cert.pem"), join(dir, "key.pem"));
        certs.reload();
        return certs;
    }

    function acmeAt(
        dir: string,
        certs: CertStore,
        now: () => number,
        order: Order,
        logs: Logged[] = [],
    ): Acme {
        const acme = new Acme({
            dir,
            domains: [name],
            renewBeforeMs: 30 * day,
            certs,
            order,
            log: recordLog(logs),
            now,
        });
        cleanups.push(() => acme.stop());
        return acme;
    }

    // Second precision, as certificates keep it
    const t0 = Math.floor(Date.now() / 1000) * 1000;

    it("renews 30 days before expiry", async () => {
        const dir = tempDir();
        const certs = await store(dir, t0, t0 + 90 * day);
        let now = t0 + 59 * day;
        const ca = fakeCa(await testCa());
        const acme = acmeAt(
            dir,
            certs,
            () => now,
            async (req) => {
                ca.requests.push(req);
                return (await testCa()).issue(req.csr, {
                    notBefore: new Date(now),
                    notAfter: new Date(now + 90 * day),
                });
            },
        );
        expect(acme.renewAt()).toBe(t0 + 60 * day);
        await acme.check();
        expect(ca.requests).toHaveLength(0);
        expect(acme.nextCheckAt).toBe(now + 12 * 3_600_000);
        now = t0 + 60 * day - 3_600_000;
        await acme.check();
        expect(acme.nextCheckAt).toBe(t0 + 60 * day);
        now = t0 + 60 * day;
        await acme.check();
        expect(ca.requests).toHaveLength(1);
        expect(certs.current?.notAfter.getTime()).toBeGreaterThan(t0 + 140 * day);
    });

    it("never renews before half the lifetime, so short certificates cannot loop", async () => {
        const dir = tempDir();
        const certs = await store(dir, t0, t0 + 40 * day);
        const acme = acmeAt(
            dir,
            certs,
            () => t0,
            async () => "unused",
        );
        expect(acme.renewAt()).toBe(t0 + 20 * day);
        const shortest = await store(dir, t0, t0 + 6 * day);
        const brief = acmeAt(
            dir,
            shortest,
            () => t0,
            async () => "unused",
        );
        expect(brief.renewAt()).toBe(t0 + 3 * day);
    });

    it("orders at once when the certificate lacks a name", async () => {
        const dir = tempDir();
        const certs = await store(dir, t0, t0 + 90 * day, ["old.bugnet.sh"]);
        const acme = acmeAt(
            dir,
            certs,
            () => t0,
            async () => "unused",
        );
        expect(acme.renewAt()).toBe(0);
    });

    it("backs off after a failed order and keeps the old certificate", async () => {
        const dir = tempDir();
        const certs = await store(dir, t0 - 89 * day, t0 + day);
        const sha = certs.current?.sha256;
        const logs: Logged[] = [];
        let calls = 0;
        const acme = acmeAt(
            dir,
            certs,
            () => t0,
            async () => {
                calls += 1;
                throw new Error("urn:ietf:params:acme:error:connection, no answer");
            },
            logs,
        );
        await acme.check();
        expect(acme.nextCheckAt).toBe(t0 + 5 * 60_000);
        await acme.check();
        expect(acme.nextCheckAt).toBe(t0 + 10 * 60_000);
        for (let i = 0; i < 10; i += 1) await acme.check();
        expect(acme.nextCheckAt).toBe(t0 + 6 * 3_600_000);
        expect(calls).toBe(12);
        expect(certs.current?.sha256).toBe(sha);
        expect(logs.find((l) => l.level === "error")).toMatchObject({
            msg: "certificate order failed",
            fields: { retryInSeconds: 300, names: [name] },
        });
    });

    it("gives up on an order that never answers, so later renewals still run", async () => {
        const dir = tempDir();
        const certs = await store(dir, t0 - 89 * day, t0 + day);
        const logs: Logged[] = [];
        const acme = new Acme({
            dir,
            domains: [name],
            renewBeforeMs: 30 * day,
            certs,
            order: () => new Promise(() => {}),
            log: recordLog(logs),
            now: () => t0,
            orderTimeoutMs: 50,
        });
        cleanups.push(() => acme.stop());
        await acme.check();
        expect(logs.at(-1)?.fields?.err).toBe("the order took over 0.05 s");
        expect(acme.nextCheckAt).toBe(t0 + 5 * 60_000);
    });

    it("refuses a chain that does not match the ordered key", async () => {
        const dir = tempDir();
        const certs = await store(dir, t0 - 89 * day, t0 + day);
        const before = readFileSync(join(dir, "cert.pem"), "utf8");
        const stranger = await selfSigned([name]);
        const logs: Logged[] = [];
        const acme = acmeAt(
            dir,
            certs,
            () => t0,
            async () => stranger.cert,
            logs,
        );
        await acme.check();
        expect(logs.at(-1)?.fields?.err).toMatch(/mismatch/);
        expect(readFileSync(join(dir, "cert.pem"), "utf8")).toBe(before);
    });
});
