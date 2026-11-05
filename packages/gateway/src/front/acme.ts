/**
 * Certificates from an ACME CA by the TLS-ALPN-01 challenge of RFC 8737.
 *
 * The CA reaches the TLS front through HAProxy's SNI split and checks the challenge certificate
 * the front answers acme-tls/1 with. The account key and the issued pair stay in acme_dir, so a
 * restart neither registers a new account nor orders a certificate it already holds. A
 * certificate renews acme_renew_before its expiry, and never before half its lifetime, so a
 * short-lived certificate cannot make the gateway order in a loop.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, crypto as acmeCrypto, type Authorization } from "acme-client";
import type { Log } from "../log.ts";
import { loadPair, secureContext, type CertPair, type CertStore } from "./certs.ts";

export interface Challenges {
    answer(authz: Authorization, keyAuthorization: string): Promise<void>;
    withdraw(name: string): void;
}

export interface OrderRequest {
    accountKey: Buffer;
    csr: Buffer;
    challenges: Challenges;
}

// Orders one certificate and resolves to its PEM chain
export type Order = (req: OrderRequest) => Promise<string>;

export function acmeOrder(directoryUrl: string, email: string): Order {
    return async ({ accountKey, csr, challenges }) => {
        const client = new Client({ directoryUrl, accountKey });
        return client.auto({
            csr,
            ...(email ? { email } : {}),
            termsOfServiceAgreed: true,
            challengePriority: ["tls-alpn-01"],
            // The library's self check dials the name's port 443 from here, the CA's check suffices
            skipChallengeVerification: true,
            challengeCreateFn: async (authz, challenge, keyAuthorization) => {
                // The library's challenge types name only http-01 and dns-01
                if ((challenge.type as string) !== "tls-alpn-01") {
                    throw new Error(`the CA offers no tls-alpn-01 for ${authz.identifier.value}`);
                }
                await challenges.answer(authz, keyAuthorization);
            },
            challengeRemoveFn: async (authz) => challenges.withdraw(authz.identifier.value),
        });
    };
}

export interface AcmeOptions {
    dir: string;
    domains: string[];
    renewBeforeMs: number;
    certs: CertStore;
    order: Order;
    log: Log;
    now?: () => number;
}

const maxSleepMs = 12 * 3_600_000;
const firstRetryMs = 5 * 60_000;
const maxRetryMs = 6 * 3_600_000;

function writeAtomic(path: string, data: string | Buffer, mode: number): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
}

export function describePair(pair: CertPair): Record<string, unknown> {
    return { names: pair.names, notAfter: pair.notAfter.toISOString(), sha256: pair.sha256 };
}

export class Acme {
    private timer: NodeJS.Timeout | undefined;
    private running: Promise<void> | undefined;
    private failures = 0;
    private stopped = false;
    // When the next check runs, for logs and tests
    nextCheckAt: number | undefined;

    constructor(private readonly o: AcmeOptions) {}

    private now(): number {
        return (this.o.now ?? Date.now)();
    }

    // Zero when there is no certificate or it lacks one of the names
    renewAt(): number {
        const pair = this.o.certs.current;
        if (!pair || !this.o.domains.every((d) => pair.names.includes(d))) return 0;
        const start = pair.notBefore.getTime();
        const end = pair.notAfter.getTime();
        return Math.max(end - this.o.renewBeforeMs, start + (end - start) / 2);
    }

    start(): void {
        this.schedule(0);
    }

    stop(): void {
        this.stopped = true;
        clearTimeout(this.timer);
        this.nextCheckAt = undefined;
    }

    // Orders when due, then schedules the next check
    check(): Promise<void> {
        this.running ??= this.run().finally(() => (this.running = undefined));
        return this.running;
    }

    private schedule(ms: number): void {
        clearTimeout(this.timer);
        if (this.stopped) return;
        this.nextCheckAt = this.now() + ms;
        this.timer = setTimeout(() => void this.check(), ms);
        this.timer.unref();
    }

    private async run(): Promise<void> {
        const wait = this.renewAt() - this.now();
        if (wait > 0) return this.schedule(Math.min(wait, maxSleepMs));
        try {
            await this.renew();
            const next = this.renewAt() - this.now();
            if (next <= 0) throw new Error("the new certificate is due for renewal already");
            this.failures = 0;
            this.schedule(Math.min(next, maxSleepMs));
        } catch (e) {
            this.failures += 1;
            const retry = Math.min(firstRetryMs * 2 ** (this.failures - 1), maxRetryMs);
            this.o.log.error("certificate order failed", {
                err: (e as Error).message,
                names: this.o.domains,
                retryInSeconds: retry / 1000,
            });
            this.schedule(retry);
        }
    }

    private async accountKey(): Promise<Buffer> {
        const file = join(this.o.dir, "account.key");
        if (existsSync(file)) return readFileSync(file);
        const key = await acmeCrypto.createPrivateEcdsaKey();
        writeAtomic(file, key, 0o600);
        this.o.log.info("ACME account key created", { file });
        return key;
    }

    private readonly challenges: Challenges = {
        answer: async (authz, keyAuthorization) => {
            const key = await acmeCrypto.createPrivateEcdsaKey();
            const [, cert] = await acmeCrypto.createAlpnCertificate(authz, keyAuthorization, key);
            this.o.certs.setChallenge(authz.identifier.value, secureContext(cert, key));
        },
        withdraw: (name) => this.o.certs.clearChallenge(name),
    };

    private async renew(): Promise<void> {
        const { dir, domains, certs, log } = this.o;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const accountKey = await this.accountKey();
        const certKey = await acmeCrypto.createPrivateEcdsaKey();
        const first = domains[0] as string;
        const [, csr] = await acmeCrypto.createCsr(
            { altNames: domains, ...(first.length <= 64 ? { commonName: first } : {}) },
            certKey,
        );
        log.info("ordering a certificate", { names: domains });
        const chain = await this.o.order({ accountKey, csr, challenges: this.challenges });
        loadPair(chain, certKey);
        writeAtomic(certs.keyFile, certKey, 0o600);
        writeAtomic(certs.certFile, chain, 0o644);
        log.info("certificate issued", describePair(certs.reload()));
    }
}
