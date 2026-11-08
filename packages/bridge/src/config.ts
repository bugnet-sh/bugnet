// Decoded strictly so a misspelt key is an error naming it, and the bridge holds no secrets
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { isAddress } from "@solana/kit";
import { parse } from "smol-toml";
import { z } from "zod";
import { insideWorkingFolder, type KeyCommand } from "./keyfile.ts";

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
        pay_command: z.string().max(4096).default("pay"),
        pay_origin: secureUrl
            .refine((s) => {
                const u = new URL(s);
                return (
                    u.pathname === "/" &&
                    u.search === "" &&
                    u.hash === "" &&
                    u.username === "" &&
                    u.password === ""
                );
            }, "an origin such as https://pay.bugnet.sh, with no path")
            .transform((s) => new URL(s).origin)
            .prefault("https://pay.bugnet.sh"),
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

// Read only from the fixed file by loadSignerSettings, so --config can never loosen them
const signerKeys = [
    "pay_signer",
    "max_payment_usd",
    "daily_usd",
    "pay_to",
    "fee_payer",
    "key_pays_allowances",
    "allowance_pay_to",
];

function withoutSignerKeys(doc: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(doc).filter(([k]) => !signerKeys.includes(k)));
}

export function parseSettings(text: string, source = "settings"): Settings {
    return decode(withoutSignerKeys(parseToml(text, source)), source);
}

// Compiled in: the settings file can only lower them
export const paymentCeilingUsd = 20;
export const dailyCeilingUsd = 100;

const pinned = z
    .array(z.string().refine((s): boolean => isAddress(s), "a Solana address"))
    .max(16)
    .default([]);

const signerSchema = z
    .object({
        pay_signer: z.enum(["key", "pay"]).default("pay"),
        max_payment_usd: z.number().positive().max(paymentCeilingUsd).default(1),
        daily_usd: z.number().positive().max(dailyCeilingUsd).default(5),
        pay_to: pinned,
        fee_payer: pinned,
        // The allowance wallet later pays sellers the agent picked; false sends it to pay instead
        key_pays_allowances: z.boolean().default(true),
        allowance_pay_to: pinned,
    })
    .refine((s) => !s.pay_to.some((a) => s.allowance_pay_to.includes(a)), {
        path: ["allowance_pay_to"],
        message: "must not repeat a pay_to wallet",
    })
    .transform((s) => ({
        paySigner: s.pay_signer,
        maxPaymentMicros: Math.round(s.max_payment_usd * 1_000_000),
        dailyMicros: Math.round(s.daily_usd * 1_000_000),
        payTo: s.pay_to,
        feePayer: s.fee_payer,
        keyPaysAllowances: s.key_pays_allowances,
        allowancePayTo: s.allowance_pay_to,
    }));

export type SignerSettings = z.infer<typeof signerSchema>;

export const defaultSignerSettings: SignerSettings = signerSchema.parse({});

export function signerSettingsPath(home: string): string {
    return join(home, ".config", "bugnet", "mcp.toml");
}

function pickSignerKeys(doc: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(doc).filter(([k]) => signerKeys.includes(k)));
}

// Only $HOME/.config/bugnet/mcp.toml. A file that sets no signer key is not checked further, so a
// bridge that never uses the key starts as before; one that does must be a regular file owned by
// the user, not writable by group or others, and outside the working folder
export function loadSignerSettings(
    home: string | undefined,
    cwd: string = process.cwd(),
): SignerSettings {
    if (home === undefined || !isAbsolute(home)) return defaultSignerSettings;
    const path = signerSettingsPath(home);
    let loose: string;
    try {
        loose = readFileSync(path, "utf8");
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return defaultSignerSettings;
        throw new ConfigError(`read ${path}: ${(e as Error).message}`);
    }
    if (Object.keys(pickSignerKeys(parseToml(loose, path))).length === 0) {
        return defaultSignerSettings;
    }
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
        throw new ConfigError(`${path}: must be a regular file you own, not a link`);
    }
    let text: string;
    try {
        if (insideWorkingFolder(dirname(path), cwd, home)) {
            throw new ConfigError(`${path}: must not be inside the working folder`);
        }
        const st = fstatSync(fd);
        if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o022) !== 0) {
            throw new ConfigError(
                `${path}: must be a file you own, not writable by group or others`,
            );
        }
        text = readFileSync(fd, "utf8");
    } finally {
        closeSync(fd);
    }
    const r = signerSchema.safeParse(pickSignerKeys(parseToml(text, path)));
    if (r.success) return r.data;
    const issues = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`${path}: ${issues.join("; ")}`);
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
    const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(base, "bugnet", "mcp.toml");
}

export const usage = `Usage: bugnet-mcp [--gateway URL] [--config FILE]
       bugnet-mcp key new
       bugnet-mcp key import --from FILE --var NAME

Serves the Bugnet MCP gateway to a local agent over stdio, and adds bugnet_secret_from_env.

  --gateway URL   remote gateway, default https://mcp.bugnet.sh/mcp
  --config FILE   settings file, default ~/.config/bugnet/mcp.toml when it exists
  --help          this text
  --version       the bridge version

  key new         creates ~/.config/bugnet/wallet.json and prints its address
  key import      moves a key from a dotenv file into the wallet file
`;

export type Command =
    | { kind: "serve"; settings: Settings; signer: SignerSettings }
    | { kind: "help" }
    | { kind: "version" }
    | KeyCommand;

function keyCommand(argv: string[]): KeyCommand {
    const [sub, ...rest] = argv;
    if (sub === "new" && rest.length === 0) return { kind: "key-new" };
    if (sub !== "import") throw new ConfigError("key takes new, or import --from FILE --var NAME");
    let values;
    try {
        ({ values } = parseArgs({
            args: rest,
            options: { from: { type: "string" }, var: { type: "string" } },
            strict: true,
            allowPositionals: false,
        }));
    } catch (e) {
        throw new ConfigError((e as Error).message);
    }
    if (!values.from || !values.var || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(values.var)) {
        throw new ConfigError("key import needs --from FILE and --var NAME");
    }
    return { kind: "key-import", from: values.from, variable: values.var };
}

// The default file is optional, a file named with --config must exist
export function loadCommand(
    argv: string[],
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): Command {
    if (argv[0] === "key") return keyCommand(argv.slice(1));
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
    const parsed = text ? parseToml(text, path) : {};
    const signerKey = Object.keys(parsed).find((k) => signerKeys.includes(k));
    const fixed = env.HOME && isAbsolute(env.HOME) ? signerSettingsPath(env.HOME) : null;
    if (signerKey !== undefined && path !== fixed) {
        throw new ConfigError(`${path}: ${signerKey} is read only from ~/.config/bugnet/mcp.toml`);
    }
    const fromFile = withoutSignerKeys(parsed);
    const doc = values.gateway ? { ...fromFile, gateway_url: values.gateway } : fromFile;
    return {
        kind: "serve",
        settings: decode(doc, text ? path : "settings"),
        signer: loadSignerSettings(env.HOME, cwd),
    };
}
