import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { crypto as acmeCrypto, type Authorization } from "acme-client";
import { Agent, fetch as undiciFetch } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Log } from "../log.ts";
import { clientAddress } from "../request.ts";
import { startHttp } from "../server.ts";
import { selfSigned, type TestPair } from "../testing/certs.ts";
import { callTool, testConfig, testDeps } from "../testing/harness.ts";
import { ok, type Register } from "../tools/common.ts";
import { CertStore, secureContext } from "./certs.ts";
import { acmeProtocol, startFront, type Front } from "./tls.ts";

const name = "mcp.bugnet.sh";
const sig = "0d0a0d0a000d0a515549540a";
const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");
// TCP over IPv4 from 203.0.113.7:40000 to 127.0.0.1:8444
const v4Header = hex(`${sig} 21 11 000c cb007107 7f000001 9c40 20fc`);
const v6Header = hex(
    `${sig} 21 21 0024 20010db8000000000000000000000007 00000000000000000000000000000001 9c40 20fc`,
);
const mappedHeader = hex(
    `${sig} 21 21 0024 00000000000000000000ffffc6336405 00000000000000000000000000000001 9c40 20fc`,
);
const localHeader = hex(`${sig} 20 00 0000`);

const whoami: Register = (server) => {
    server.registerTool(
        "test_whoami",
        { description: "Returns the client address", inputSchema: z.object({}) },
        async () => ok("whoami", { address: clientAddress() ?? null }),
    );
};

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

interface Fixture {
    port: number;
    pair: TestPair;
    certs: CertStore;
    dir: string;
    logs: Logged[];
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
});

async function start(frontToml = "", opts: { load?: boolean } = {}): Promise<Fixture> {
    const pair = await selfSigned([name, "localhost"]);
    const dir = mkdtempSync(join(tmpdir(), "bugnet-front-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const certFile = join(dir, "cert.pem");
    const keyFile = join(dir, "key.pem");
    writeFileSync(certFile, pair.cert);
    writeFileSync(keyFile, pair.key);
    const config = testConfig(
        [
            'listen_addr = "127.0.0.1:0"',
            `public_url = "https://${name}"`,
            "[front]",
            'tls_addr = "127.0.0.1:0"',
            `cert_file = "${certFile}"`,
            `key_file = "${keyFile}"`,
            'proxy_timeout = "300ms"',
            'handshake_timeout = "300ms"',
            frontToml,
        ].join("\n"),
    );
    const logs: Logged[] = [];
    const http: HttpServer = await startHttp(testDeps({ config }), [whoami]);
    const certs = new CertStore(certFile, keyFile);
    if (opts.load !== false) certs.reload();
    const front: Front = await startFront({
        settings: config.front,
        certs,
        http,
        log: recordLog(logs),
    });
    cleanups.push(async () => {
        http.closeAllConnections();
        await new Promise((r) => http.close(r));
        await front.close();
    });
    const { port } = front.server.address() as AddressInfo;
    return { port, pair, certs, dir, logs };
}

async function rawConnect(port: number, header?: Buffer): Promise<Socket> {
    const raw = netConnect(port, "127.0.0.1");
    raw.on("error", () => {});
    await once(raw, "connect");
    if (header) raw.write(header);
    return raw;
}

async function tlsTo(
    f: Fixture,
    header: Buffer | undefined,
    opts: ConnectionOptions = {},
): Promise<TLSSocket> {
    const raw = await rawConnect(f.port, header);
    const socket = tlsConnect({
        socket: raw,
        servername: name,
        ca: [f.pair.cert],
        ALPNProtocols: ["http/1.1"],
        ...opts,
    });
    cleanups.push(() => void socket.destroy());
    await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("closed before the handshake ended")));
    });
    return socket;
}

async function get(socket: TLSSocket, path: string, host = name): Promise<string> {
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    await once(socket, "end");
    return Buffer.concat(chunks).toString();
}

async function post(socket: TLSSocket, host: string): Promise<string> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.write(
        `POST /mcp HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\n` +
            `Accept: application/json, text/event-stream\r\nContent-Length: ${body.length}\r\n` +
            `Connection: close\r\n\r\n${body}`,
    );
    await once(socket, "end");
    return Buffer.concat(chunks).toString();
}

// An MCP client whose every connection opens with the given PROXY header
async function mcpClient(f: Fixture, header: Buffer | undefined): Promise<Client> {
    const agent = new Agent({
        connect: (_opts, callback) => {
            const raw = netConnect(f.port, "127.0.0.1", () => {
                if (header) raw.write(header);
                const socket = tlsConnect({ socket: raw, servername: name, ca: [f.pair.cert] });
                socket.once("secureConnect", () => callback(null, socket));
                socket.once("error", (e) => callback(e, null));
            });
            raw.on("error", (e) => callback(e, null));
        },
    });
    cleanups.push(() => agent.close());
    const fetch = ((url: string | URL, init?: RequestInit) =>
        undiciFetch(url, {
            ...(init as object),
            dispatcher: agent,
        })) as unknown as typeof globalThis.fetch;
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(`https://${name}/mcp`), { fetch }),
    );
    cleanups.push(() => client.close());
    return client;
}

async function closedWithin(socket: Socket, ms: number): Promise<number> {
    const started = Date.now();
    await Promise.race([
        once(socket, "close"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("still open")), ms)),
    ]);
    return Date.now() - started;
}

async function refused(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (e) {
        return (e as Error).message;
    }
    throw new Error("the connection was accepted");
}

describe("TLS front", () => {
    it("answers /healthz over TLS after a PROXY header", async () => {
        const f = await start();
        const res = await get(await tlsTo(f, v4Header), "/healthz");
        expect(res).toMatch(/^HTTP\/1\.1 200 /);
        expect(res).toMatch(/\r\n\r\n3\r\nok\n\r\n0\r\n\r\n$/);
    });

    it("keeps the Host check behind TLS", async () => {
        const f = await start();
        const bad = await post(await tlsTo(f, v4Header), "evil.example");
        expect(bad).toMatch(/^HTTP\/1\.1 403 /);
        const good = await post(await tlsTo(f, v4Header), `${name}:443`);
        expect(good).toMatch(/^HTTP\/1\.1 200 /);
    });

    it("gives tool calls the client the PROXY header names", async () => {
        const f = await start();
        const cases: [Buffer, string][] = [
            [v4Header, "203.0.113.7"],
            [v6Header, "2001:db8::7"],
            [mappedHeader, "198.51.100.5"],
            [localHeader, "127.0.0.1"],
        ];
        for (const [header, address] of cases) {
            const client = await mcpClient(f, header);
            const r = await callTool(client, "test_whoami");
            expect(r.structured.address).toBe(address);
        }
    });

    it("refuses a connection without a PROXY header and logs why", async () => {
        const f = await start();
        expect(await refused(tlsTo(f, undefined))).toMatch(/closed|ECONNRESET|socket/);
        await expect.poll(() => f.logs.map((l) => l.msg)).toContain("proxy header refused");
        expect(f.logs[0]?.fields?.err).toMatch(/signature/);
    });

    it("refuses garbage, an oversized header and a silent client", async () => {
        const f = await start();
        const garbage = await rawConnect(f.port, Buffer.from("GET / HTTP/1.1\r\n\r\n"));
        expect(await closedWithin(garbage, 1000)).toBeLessThan(1000);
        const big = await rawConnect(f.port, hex(`${sig} 21 11 0400`));
        expect(await closedWithin(big, 1000)).toBeLessThan(1000);
        const silent = await rawConnect(f.port);
        expect(await closedWithin(silent, 2000)).toBeGreaterThanOrEqual(250);
        const errs = f.logs.map((l) => String(l.fields?.err));
        expect(errs.some((e) => /signature/.test(e))).toBe(true);
        expect(errs.some((e) => /cap/.test(e))).toBe(true);
        expect(errs.some((e) => /within 300 ms/.test(e))).toBe(true);
    });

    it("drops a TLS handshake that stalls after the header", async () => {
        const f = await start();
        const stalled = await rawConnect(f.port, v4Header);
        expect(await closedWithin(stalled, 2000)).toBeGreaterThanOrEqual(250);
    });

    it("speaks TLS 1.2 and 1.3 with HTTP/1.1 only", async () => {
        const f = await start();
        const v13 = await tlsTo(f, v4Header, { ALPNProtocols: ["h2", "http/1.1"] });
        expect([v13.getProtocol(), v13.alpnProtocol]).toEqual(["TLSv1.3", "http/1.1"]);
        const v12 = await tlsTo(f, v4Header, { maxVersion: "TLSv1.2" });
        expect([v12.getProtocol(), v12.alpnProtocol]).toEqual(["TLSv1.2", "http/1.1"]);
        const plain = await tlsTo(f, v4Header, { ALPNProtocols: [] });
        expect(plain.alpnProtocol).toBe(false);
        expect(await get(plain, "/healthz")).toMatch(/^HTTP\/1\.1 200 /);
        const old = tlsTo(f, v4Header, {
            minVersion: "TLSv1",
            maxVersion: "TLSv1.1",
            ciphers: "DEFAULT@SECLEVEL=0",
        });
        expect(await refused(old)).toMatch(/version|protocol|alert/i);
        expect(await refused(tlsTo(f, v4Header, { ALPNProtocols: ["h2"] }))).toMatch(
            /no application protocol|alert/i,
        );
    });

    it("serves the files' certificate and rereads them on reload", async () => {
        const f = await start();
        const first = await tlsTo(f, v4Header);
        expect(first.getPeerX509Certificate()?.checkHost(name)).toBe(name);
        const next = await selfSigned([name]);
        writeFileSync(join(f.dir, "cert.pem"), next.cert);
        writeFileSync(join(f.dir, "key.pem"), next.key);
        const loaded = f.certs.reload();
        expect(loaded.names).toEqual([name]);
        const second = await tlsTo(f, v4Header, { ca: [next.cert] });
        expect(second.getPeerX509Certificate()?.fingerprint256).not.toBe(
            first.getPeerX509Certificate()?.fingerprint256,
        );
        writeFileSync(join(f.dir, "key.pem"), f.pair.key);
        expect(() => f.certs.reload()).toThrow(/mismatch/);
        writeFileSync(join(f.dir, "cert.pem"), "not a certificate");
        expect(() => f.certs.reload()).toThrow();
        const third = await tlsTo(f, v4Header, { ca: [next.cert] });
        expect(third.getPeerX509Certificate()?.fingerprint256).toBe(
            second.getPeerX509Certificate()?.fingerprint256,
        );
    });

    it("runs without PROXY headers when the setting is off", async () => {
        const f = await start("proxy_protocol = false");
        const client = await mcpClient(f, undefined);
        const r = await callTool(client, "test_whoami");
        expect(r.structured.address).toBe("127.0.0.1");
        expect(await refused(tlsTo(f, v4Header))).toMatch(/closed|ECONNRESET|socket|wrong/);
    });
});

describe("TLS-ALPN-01 answers", () => {
    const keyAuthorization = "token-abc.thumbprint-xyz";

    async function challengeFor(domain: string) {
        const authz = { identifier: { type: "dns", value: domain } } as Authorization;
        const key = await acmeCrypto.createPrivateEcdsaKey();
        const [, cert] = await acmeCrypto.createAlpnCertificate(authz, keyAuthorization, key);
        return { context: secureContext(cert, key), cert };
    }

    const acmeClient = { ALPNProtocols: [acmeProtocol], rejectUnauthorized: false };

    it("answers acme-tls/1 with the challenge certificate", async () => {
        const f = await start();
        f.certs.setChallenge(name, (await challengeFor(name)).context);
        const socket = await tlsTo(f, v4Header, acmeClient);
        expect([socket.getProtocol(), socket.alpnProtocol]).toEqual(["TLSv1.3", acmeProtocol]);
        const peer = socket.getPeerX509Certificate();
        expect(peer?.subjectAltName).toBe(`DNS:${name}`);
        const pem = peer?.toString() ?? "";
        expect(acmeCrypto.isAlpnCertificateAuthorizationValid(pem, keyAuthorization)).toBe(true);
        expect(await closedWithin(socket, 1000)).toBeLessThan(1000);
        const normal = await tlsTo(f, v4Header);
        expect(normal.getPeerX509Certificate()?.fingerprint256).toBe(
            new X509Certificate(f.pair.cert).fingerprint256,
        );
    });

    it("swaps in the challenge certificate over TLS 1.2 as well", async () => {
        const f = await start();
        const stand = await selfSigned([name]);
        f.certs.setChallenge(name, secureContext(stand.cert, stand.key));
        const socket = await tlsTo(f, v4Header, { ...acmeClient, maxVersion: "TLSv1.2" });
        expect([socket.getProtocol(), socket.alpnProtocol]).toEqual(["TLSv1.2", acmeProtocol]);
        expect(socket.getPeerX509Certificate()?.fingerprint256).toBe(
            new X509Certificate(stand.cert).fingerprint256,
        );
        // OpenSSL clients refuse the library's certificate in TLS 1.2 for its key usage, Go's do not
        f.certs.setChallenge(name, (await challengeFor(name)).context);
        const strict = tlsTo(f, v4Header, { ...acmeClient, maxVersion: "TLSv1.2" });
        expect(await refused(strict)).toMatch(/ecc cert not for signing/);
    });

    it("refuses acme-tls/1 for a name without a challenge in flight", async () => {
        const f = await start();
        expect(await refused(tlsTo(f, v4Header, acmeClient))).toMatch(/alert|protocol/i);
        f.certs.setChallenge("other.bugnet.sh", (await challengeFor("other.bugnet.sh")).context);
        expect(await refused(tlsTo(f, v4Header, acmeClient))).toMatch(/alert|protocol/i);
        f.certs.setChallenge(name, (await challengeFor(name)).context);
        f.certs.clearChallenge(name);
        expect(await refused(tlsTo(f, v4Header, acmeClient))).toMatch(/alert|protocol/i);
    });

    it("answers challenges before the first certificate exists", async () => {
        const f = await start("", { load: false });
        expect(await refused(tlsTo(f, v4Header))).toMatch(/alert|handshake|closed|socket/i);
        f.certs.setChallenge(name, (await challengeFor(name)).context);
        const socket = await tlsTo(f, v4Header, acmeClient);
        expect(socket.alpnProtocol).toBe(acmeProtocol);
    });
});
