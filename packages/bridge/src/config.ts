// Decoded strictly so a misspelt key is an error naming it, and the bridge holds no secrets
import { readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "smol-toml";
import { z } from "zod";

export class ConfigError extends Error {}

export function parseDuration(s: string): number {
    const m = /^(\d+)(ms|s|m|h)$/.exec(s);
    if (!m) throw new ConfigError(`bad duration ${JSON.stringify(s)}`);
    const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
    return Number(m[1]) * unit;
}

const duration = z
    .string()
    .regex(/^\d+(ms|s|m|h)$/, "a duration such as 500ms, 30s, 10m or 1h")
    .transform(parseDuration);

// The URL parser has already turned forms such as 127.1 into dotted quads
function isLoopback(url: URL): boolean {
    const host = url.hostname;
    return host === "localhost" || host === "[::1]" || (isIPv4(host) && host.startsWith("127."));
}

// A handle or a put grant over plain HTTP would cross the network readable, loopback aside
const secureUrl = z.url().refine((s) => {
    const u = new URL(s);
    return u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u));
}, "an https URL, or http on loopback");

const settingsSchema = z
    .object({
        gateway_url: secureUrl.default("https://mcp.bugnet.sh/mcp"),
        secrets_url: secureUrl.default("https://secrets.bugnet.sh"),
        connect_timeout: duration.prefault("5s"),
        call_timeout: duration.prefault("5m"),
        secrets_timeout: duration.prefault("30s"),
    })
    .strict();

export type Settings = z.infer<typeof settingsSchema>;

function decode(doc: unknown, source: string): Settings {
    const r = settingsSchema.safeParse(doc);
    if (r.success) return r.data;
    const issues = r.error.issues.map((i) => {
        if (i.code === "unrecognized_keys") return `unknown key ${i.keys.join(", ")}`;
        return `${i.path.join(".") || "(root)"}: ${i.message}`;
    });
    throw new ConfigError(`${source}: ${issues.join("; ")}`);
}

function parseToml(text: string, source: string): Record<string, unknown> {
    try {
        return parse(text);
    } catch (e) {
        throw new ConfigError(`${source}: ${(e as Error).message}`);
    }
}

export function parseSettings(text: string, source = "settings"): Settings {
    return decode(parseToml(text, source), source);
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
    const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(base, "bugnet", "mcp.toml");
}

export const usage = `Usage: bugnet-mcp [--gateway URL] [--config FILE]

Serves the Bugnet MCP gateway to a local agent over stdio, and adds bugnet_secret_from_env.

  --gateway URL   remote gateway, default https://mcp.bugnet.sh/mcp
  --config FILE   settings file, default ~/.config/bugnet/mcp.toml when it exists
  --help          this text
  --version       the bridge version
`;

export type Command =
    { kind: "serve"; settings: Settings } | { kind: "help" } | { kind: "version" };

// The default file is optional, a file named with --config must exist
export function loadCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Command {
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                gateway: { type: "string" },
                config: { type: "string" },
                help: { type: "boolean" },
                version: { type: "boolean" },
            },
            strict: true,
            allowPositionals: false,
        }));
    } catch (e) {
        throw new ConfigError((e as Error).message);
    }
    if (values.help) return { kind: "help" };
    if (values.version) return { kind: "version" };
    const path = values.config ?? defaultConfigPath(env);
    let text = "";
    try {
        text = readFileSync(path, "utf8");
    } catch (e) {
        const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
        if (values.config || !missing) {
            throw new ConfigError(`read ${path}: ${(e as Error).message}`);
        }
    }
    const fromFile = text ? parseToml(text, path) : {};
    const doc = values.gateway ? { ...fromFile, gateway_url: values.gateway } : fromFile;
    return { kind: "serve", settings: decode(doc, text ? path : "settings") };
}
