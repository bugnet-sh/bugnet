/**
 * Gateway settings and secrets.
 *
 * Settings come from a TOML file decoded strictly, so an unknown or misspelt key is an error that
 * names it. Secrets come only from the environment and never appear in an error message.
 * config/example.toml lists every setting with its default.
 */
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import { isLoopbackRange, parseCidr } from "./ratelimit.ts";

const duration = z
    .string()
    .regex(/^\d+(ms|s|m|h)$/, "a duration such as 500ms, 30s, 10m or 1h")
    .transform(parseDuration);

const cidr = z.string().refine((s) => parseCidr(s) !== null, "a CIDR range such as 10.0.0.0/8");

const settingsSchema = z
    .object({
        listen_addr: z.string().default("127.0.0.1:8787"),
        public_url: z.url().default("http://127.0.0.1:8787"),
        allowed_hosts: z.array(z.string()).default([]),
        router: z
            .object({
                url: z.url().default("http://127.0.0.1:8080"),
                timeout: duration.prefault("20s"),
                links_domain: z
                    .string()
                    .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "a lower-case domain such as bugnet.sh")
                    .default("bugnet.sh"),
            })
            .strict()
            .prefault({}),
        payments: z
            .object({
                mode: z.enum(["dev", "http"]).default("http"),
                url: z.string().default(""),
                order_token_ttl: duration.prefault("10m"),
            })
            .strict()
            .prefault({}),
        limits: z
            .object({
                max_wait_seconds: z.int().min(1).max(45).default(45),
                default_wait_seconds: z.int().min(0).max(45).default(25),
                output_tail_bytes: z.int().min(256).max(65536).default(8192),
                read_file_max_bytes: z.int().min(1).max(262144).default(262144),
                write_file_max_bytes: z.int().min(1).max(262144).default(262144),
                quote_ttl: duration.prefault("10m"),
                quotes_per_minute: z.int().min(1).max(100_000).default(12),
                quote_burst: z.int().min(1).max(100_000).default(10),
                shared_ranges: z.array(cidr).max(100).default(["160.79.104.0/21"]),
                shared_quotes_per_minute: z.int().min(1).max(1_000_000).default(120),
                shared_quote_burst: z.int().min(1).max(1_000_000).default(40),
                quote_v6_block_multiple: z.int().min(1).max(65536).default(4),
            })
            .strict()
            .prefault({}),
        tools: z
            .object({
                require_user_approval: z.boolean().default(true),
                confirm_transfers: z.boolean().default(true),
            })
            .strict()
            .prefault({}),
        assess: z
            .object({
                github_api: z.url().default("https://api.github.com"),
                github_raw: z.url().default("https://raw.githubusercontent.com"),
                huggingface: z.url().default("https://huggingface.co"),
                fetch_timeout: duration.prefault("4s"),
                cache_ttl: duration.prefault("10m"),
                max_file_bytes: z.int().min(1024).max(1048576).default(262144),
                scan_urls: z.boolean().default(true),
            })
            .strict()
            .prefault({}),
        telemetry: z
            .object({
                traces: z.boolean().default(false),
                otlp_endpoint: z.url().or(z.literal("")).default(""),
                sample_ratio: z.number().min(0).max(1).default(1),
                environment: z
                    .string()
                    .regex(/^[a-z0-9-]{1,64}$/, "lowercase letters, digits and hyphens")
                    .default("main"),
                export_timeout: duration.prefault("10s"),
                batch_timeout: duration.prefault("5s"),
                batch_size: z.int().min(1).max(65536).default(512),
                queue_size: z.int().min(1).max(65536).default(2048),
            })
            .strict()
            .prefault({}),
        front: z
            .object({
                tls_addr: z.string().default(""),
                proxy_protocol: z.boolean().default(true),
                proxy_protocol_from: z.array(cidr).max(100).default(["127.0.0.1/32", "::1/128"]),
                proxy_timeout: duration.prefault("3s"),
                proxy_max_bytes: z.int().min(52).max(65551).default(536),
                handshake_timeout: duration.prefault("10s"),
                cert_file: z.string().default(""),
                key_file: z.string().default(""),
                acme_directory: z.url().or(z.literal("")).default(""),
                acme_accept_terms: z.boolean().default(false),
                acme_email: z.string().default(""),
                acme_domains: z.array(z.string()).default([]),
                acme_dir: z.string().default(""),
                acme_renew_before: duration.prefault("720h"),
            })
            .strict()
            .prefault({}),
    })
    .strict();

export type Settings = z.infer<typeof settingsSchema>;

export interface Secrets {
    internalToken: string;
    quoteKey: Buffer;
    orderPrivateKey: Buffer | null;
    paymentsToken: string;
    githubToken: string;
    huggingfaceToken: string;
    // The whole Authorization header value for the trace backend, empty for a local collector
    otlpAuthorization?: string;
}

export interface Config extends Settings {
    secrets: Secrets;
}

export class ConfigError extends Error {}

export function parseDuration(s: string): number {
    const m = /^(\d+)(ms|s|m|h)$/.exec(s);
    if (!m) throw new ConfigError(`bad duration ${JSON.stringify(s)}`);
    const n = Number(m[1]);
    const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
    return n * unit;
}

export function parseSettings(text: string, source = "settings"): Settings {
    let doc: unknown;
    try {
        doc = parse(text);
    } catch (e) {
        throw new ConfigError(`${source}: ${(e as Error).message}`);
    }
    const r = settingsSchema.safeParse(doc);
    if (!r.success) {
        const issues = r.error.issues.map((i) => {
            const at = i.path.join(".");
            if (i.code === "unrecognized_keys") {
                const keys = i.keys.map((k) => (at ? `${at}.${k}` : k));
                return `unknown key ${keys.join(", ")}`;
            }
            return `${at || "(root)"}: ${i.message}`;
        });
        throw new ConfigError(`${source}: ${issues.join("; ")}`);
    }
    return r.data;
}

function base64Key(env: NodeJS.ProcessEnv, name: string, minBytes: number): Buffer | null {
    const v = env[name];
    if (!v) return null;
    const b = Buffer.from(v, "base64");
    if (b.length < minBytes) throw new ConfigError(`${name} must be base64 of ${minBytes}+ bytes`);
    return b;
}

export function readSecrets(env: NodeJS.ProcessEnv, settings: Settings): Secrets {
    const internalToken = env.BUGNET_INTERNAL_TOKEN ?? "";
    if (internalToken.length < 32) {
        throw new ConfigError("BUGNET_INTERNAL_TOKEN must be set, 32 characters or more");
    }
    const quoteKey = base64Key(env, "BUGNET_QUOTE_KEY", 32);
    if (!quoteKey) throw new ConfigError("BUGNET_QUOTE_KEY must be set, base64 of 32+ bytes");
    const orderPrivateKey = base64Key(env, "BUGNET_ORDER_PRIVATE_KEY", 32);
    if (orderPrivateKey && orderPrivateKey.length !== 32) {
        throw new ConfigError("BUGNET_ORDER_PRIVATE_KEY must be base64 of a 32-byte Ed25519 seed");
    }
    if (settings.payments.mode === "dev" && !orderPrivateKey) {
        throw new ConfigError("payments.mode dev needs BUGNET_ORDER_PRIVATE_KEY");
    }
    const paymentsToken = env.BUGNET_PAYMENTS_TOKEN ?? "";
    if (settings.payments.mode === "http" && !paymentsToken) {
        throw new ConfigError("payments.mode http needs BUGNET_PAYMENTS_TOKEN");
    }
    return {
        internalToken,
        quoteKey,
        orderPrivateKey,
        paymentsToken,
        githubToken: env.GITHUB_TOKEN ?? "",
        huggingfaceToken: env.HF_TOKEN ?? "",
        otlpAuthorization: env.BUGNET_OTLP_AUTHORIZATION ?? "",
    };
}

function isLoopback(url: string): boolean {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

export function hostPort(addr: string, setting: string): { host: string; port: number } {
    const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]\s]*):(\d{1,5})$/.exec(addr);
    const port = Number(m?.[2]);
    if (!m || port > 65535) {
        throw new ConfigError(`${setting}: ${JSON.stringify(addr)} is not host:port`);
    }
    return { host: (m[1] as string).replace(/^\[|\]$/g, ""), port };
}

const dnsName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

// The names on the ACME certificate, the public URL's host unless set
export function acmeDomains(s: Settings): string[] {
    if (s.front.acme_domains.length > 0) return s.front.acme_domains;
    return [new URL(s.public_url).hostname];
}

function checkProxyPeers(ranges: string[], loopbackFront: boolean): void {
    const parsed = ranges.map((r) => parseCidr(r) as NonNullable<ReturnType<typeof parseCidr>>);
    if (parsed.length === 0) {
        throw new ConfigError("front.proxy_protocol_from is empty, so no proxy could connect");
    }
    if (parsed.some((c) => c.prefix === 0)) {
        throw new ConfigError("front.proxy_protocol_from must not trust every address");
    }
    // A front reachable beyond this machine must name the proxy, or any peer could name a client
    if (!loopbackFront && parsed.every(isLoopbackRange)) {
        throw new ConfigError(
            "front.tls_addr is not loopback, so front.proxy_protocol_from must name the proxy",
        );
    }
}

function checkFront(s: Settings): void {
    const f = s.front;
    const acme = f.acme_directory !== "";
    if (!f.tls_addr) {
        if (acme || f.cert_file || f.key_file) {
            throw new ConfigError("front.cert_file, key_file and acme_directory need tls_addr");
        }
        return;
    }
    const { host } = hostPort(f.tls_addr, "front.tls_addr");
    if (Boolean(f.cert_file) !== Boolean(f.key_file)) {
        throw new ConfigError("front.cert_file and front.key_file go together");
    }
    if (acme === Boolean(f.cert_file)) {
        throw new ConfigError(
            "front.tls_addr needs either cert_file and key_file or acme_directory",
        );
    }
    if (acme) {
        if (!f.acme_accept_terms) {
            throw new ConfigError(
                "front.acme_directory needs acme_accept_terms = true, the CA's subscriber agreement",
            );
        }
        if (!f.acme_dir) throw new ConfigError("front.acme_directory needs front.acme_dir");
        for (const d of acmeDomains(s)) {
            if (!dnsName.test(d)) {
                throw new ConfigError(`front.acme_domains: ${JSON.stringify(d)} is no DNS name`);
            }
        }
    }
    const loopback = host === "localhost" || host === "::1" || /^127\./.test(host);
    if (f.proxy_protocol) checkProxyPeers(f.proxy_protocol_from, loopback);
    // A PROXY header means a proxy relays strangers, which dev payments must never serve
    if (s.payments.mode === "dev" && (f.proxy_protocol || !loopback)) {
        throw new ConfigError(
            "payments.mode dev needs a loopback front.tls_addr, no proxy_protocol",
        );
    }
}

function checkTelemetry(t: Settings["telemetry"]): void {
    if (t.batch_size > t.queue_size) {
        throw new ConfigError("telemetry.batch_size is over telemetry.queue_size");
    }
    if (!t.traces) return;
    if (!t.otlp_endpoint) throw new ConfigError("telemetry.traces needs telemetry.otlp_endpoint");
    const url = new URL(t.otlp_endpoint);
    if (url.username || url.password) {
        throw new ConfigError("telemetry.otlp_endpoint must not hold a user or password");
    }
    // Spans may only cross the network encrypted, plain http stays on this machine
    const plainOk = url.protocol === "http:" && isLoopback(t.otlp_endpoint);
    if (url.protocol !== "https:" && !plainOk) {
        throw new ConfigError("telemetry.otlp_endpoint must be https, or http to a loopback host");
    }
}

export function checkSettings(s: Settings): void {
    const listenHost = s.listen_addr.slice(0, s.listen_addr.lastIndexOf(":"));
    if (s.payments.mode === "dev") {
        // Dev payments start sandboxes for free, so they never serve anything but this machine
        const loopbackListen = ["127.0.0.1", "localhost", "[::1]"].includes(listenHost);
        if (!loopbackListen || !isLoopback(s.public_url)) {
            throw new ConfigError("payments.mode dev needs a loopback listen_addr and public_url");
        }
    }
    checkFront(s);
    checkTelemetry(s.telemetry);
    if (s.payments.mode === "http" && !s.payments.url) {
        throw new ConfigError("payments.mode http needs payments.url");
    }
    if (s.router.timeout < 1000 || s.router.timeout >= 45_000) {
        throw new ConfigError("router.timeout must be 1s or more and under 45s, the tool limit");
    }
    if (s.limits.default_wait_seconds > s.limits.max_wait_seconds) {
        throw new ConfigError("limits.default_wait_seconds is over limits.max_wait_seconds");
    }
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (e) {
        throw new ConfigError(`read ${path}: ${(e as Error).message}`);
    }
    const settings = parseSettings(text, path);
    checkSettings(settings);
    return { ...settings, secrets: readSecrets(env, settings) };
}

export function allowedHosts(s: Settings): string[] {
    if (s.allowed_hosts.length > 0) return s.allowed_hosts;
    return [new URL(s.public_url).hostname];
}
