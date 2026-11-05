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

const duration = z
    .string()
    .regex(/^\d+(ms|s|m|h)$/, "a duration such as 500ms, 30s, 10m or 1h")
    .transform(parseDuration);

const settingsSchema = z
    .object({
        listen_addr: z.string().default("127.0.0.1:8787"),
        public_url: z.url().default("http://127.0.0.1:8787"),
        allowed_hosts: z.array(z.string()).default([]),
        router: z
            .object({
                url: z.url().default("http://127.0.0.1:8080"),
                timeout: duration.prefault("50s"),
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
            })
            .strict()
            .prefault({}),
        tools: z
            .object({
                require_user_approval: z.boolean().default(true),
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
    };
}

function isLoopback(url: string): boolean {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
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
    if (s.payments.mode === "http" && !s.payments.url) {
        throw new ConfigError("payments.mode http needs payments.url");
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
