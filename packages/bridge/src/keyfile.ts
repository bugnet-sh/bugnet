// The local wallet: a Solana CLI keypair file only its owner can read, never shown or logged
import { generateKeyPairSync } from "node:crypto";
import { constants, realpathSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createSignerFromKeyPair, getBase58Encoder, type KeyPairSigner } from "@solana/kit";
import { parseDotenv } from "./secrets/dotenv.ts";

// Messages are fixed per code, so no error can carry a key, a value or a file's text
const keyMessages = {
    no_home: "HOME is not set to an absolute path",
    folder_mode: "~/.config/bugnet must be a folder you own with mode 0700",
    inside_cwd: "the wallet file must not be inside the working folder",
    wallet_missing: "no wallet file, run: bugnet-mcp key new",
    wallet_mode: "~/.config/bugnet/wallet.json must be a file you own with mode 0600",
    wallet_exists: "~/.config/bugnet/wallet.json already exists and is never overwritten",
    wallet_unreadable: "the wallet file could not be read",
    wallet_format: "the wallet file is not a 64-byte Solana keypair",
    key_invalid: "the key is not a valid Solana keypair",
    from_unreadable: "the --from file could not be read",
    var_missing: "the --from file has no such variable",
    var_format: "the variable is not a 64-byte Solana key (base58 or JSON array)",
    wallet_env_missing: "the wallet_env variable is set neither in .env nor in the environment",
    wallet_env_invalid: "the wallet_env variable is not a 64-byte Solana keypair",
    wallet_env_file: "the .env in the working folder is a link, not a regular file, or over 64 KiB",
} as const;

export type KeyCode = keyof typeof keyMessages;

export class KeyError extends Error {
    readonly code: KeyCode;

    constructor(code: KeyCode) {
        super(`${code}: ${keyMessages[code]}`);
        this.code = code;
    }
}

const maxWalletBytes = 4096;
const maxDotenvBytes = 1024 * 1024;
const maxEnvFileBytes = 64 * 1024;
// PKCS#8 wrapping of a raw Ed25519 seed, so the import reads a buffer this module can zero
const pkcs8Prefix = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

export function bugnetDir(home: string | undefined): string {
    if (home === undefined || !isAbsolute(home)) throw new KeyError("no_home");
    return join(home, ".config", "bugnet");
}

export const walletPath = (home: string | undefined) => join(bugnetDir(home), "wallet.json");

function ownedPrivately(st: Stats): boolean {
    return st.uid === process.getuid?.() && (st.mode & 0o077) === 0;
}

function within(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// A folder the agent works in is a folder it can write. Only a working folder strictly below HOME
// counts: one started in /, in HOME or above it (desktop clients, a fresh terminal) holds no file
// of ~/.config/bugnet that the agent was pointed at
export function insideWorkingFolder(dir: string, cwd: string, home: string | undefined): boolean {
    if (home === undefined) return false;
    let realCwd: string;
    let realHome: string;
    let realDir: string;
    try {
        realCwd = realpathSync(cwd);
        realHome = realpathSync(home);
        realDir = realpathSync(dir);
    } catch {
        return false;
    }
    if (realCwd === realHome || !within(realHome, realCwd)) return false;
    return within(realCwd, realDir);
}

async function checkFolder(dir: string, cwd: string, home: string | undefined): Promise<void> {
    const st = await lstat(dir).catch(() => null);
    if (st === null || !st.isDirectory() || !ownedPrivately(st)) throw new KeyError("folder_mode");
    if (insideWorkingFolder(dir, cwd, home)) throw new KeyError("inside_cwd");
}

// Turns 64 keypair bytes into a non-extractable signer, checking the halves belong together
export async function signerFromBytes(bytes: Uint8Array): Promise<KeyPairSigner> {
    if (bytes.length !== 64) throw new KeyError("key_invalid");
    const pkcs8 = new Uint8Array(48);
    pkcs8.set(pkcs8Prefix);
    pkcs8.set(bytes.subarray(0, 32), 16);
    const pub = bytes.slice(32);
    try {
        const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, [
            "sign",
        ]);
        const publicKey = await crypto.subtle.importKey("raw", pub, "Ed25519", true, ["verify"]);
        const probe = crypto.getRandomValues(new Uint8Array(32));
        const sig = await crypto.subtle.sign("Ed25519", privateKey, probe);
        if (!(await crypto.subtle.verify("Ed25519", publicKey, sig, probe))) {
            throw new KeyError("key_invalid");
        }
        return await createSignerFromKeyPair({ privateKey, publicKey });
    } catch {
        throw new KeyError("key_invalid");
    } finally {
        pkcs8.fill(0);
    }
}

const isSpace = (b: number | undefined) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

// A JSON array of exactly 64 integers 0-255, read byte by byte so the key never becomes a JS
// string, and never quoted in an error
function keypairFromBytes(buf: Uint8Array): Uint8Array | null {
    const out = new Uint8Array(64);
    let i = 0;
    let n = 0;
    const skip = () => {
        while (isSpace(buf[i])) i++;
    };
    const fail = () => {
        out.fill(0);
        return null;
    };
    skip();
    if (buf[i++] !== 0x5b) return fail();
    for (;;) {
        skip();
        let digits = 0;
        let value = 0;
        for (let b = buf[i]; b !== undefined && b >= 0x30 && b <= 0x39; b = buf[++i]) {
            value = value * 10 + (b - 0x30);
            digits++;
        }
        if (digits === 0 || digits > 3 || value > 255 || n === 64) return fail();
        out[n++] = value;
        skip();
        const sep = buf[i++];
        if (sep === 0x5d) break;
        if (sep !== 0x2c) return fail();
    }
    skip();
    if (i !== buf.length || n !== 64) return fail();
    return out;
}

export async function loadWallet(home: string | undefined, cwd: string): Promise<KeyPairSigner> {
    const dir = bugnetDir(home);
    await checkFolder(dir, cwd, home);
    let fh;
    try {
        fh = await open(join(dir, "wallet.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        throw new KeyError(code === "ENOENT" ? "wallet_missing" : "wallet_mode");
    }
    const buf = Buffer.alloc(maxWalletBytes);
    let bytes: Uint8Array | null = null;
    try {
        const st = await fh.stat();
        if (!st.isFile() || !ownedPrivately(st)) throw new KeyError("wallet_mode");
        if (st.size > maxWalletBytes) throw new KeyError("wallet_format");
        const { bytesRead } = await fh.read(buf, 0, maxWalletBytes, 0).catch(() => {
            throw new KeyError("wallet_unreadable");
        });
        bytes = keypairFromBytes(buf.subarray(0, bytesRead));
        if (bytes === null) throw new KeyError("wallet_format");
        return await signerFromBytes(bytes);
    } finally {
        buf.fill(0);
        bytes?.fill(0);
        await fh.close();
    }
}

// The Solana CLI's form, written digit by digit so the key never becomes a JS string
function keypairText(bytes: Uint8Array): Buffer {
    const out = Buffer.alloc(2 + bytes.length * 4);
    let i = 0;
    out[i++] = 0x5b;
    for (let k = 0; k < bytes.length; k++) {
        if (k > 0) out[i++] = 0x2c;
        const b = bytes[k] as number;
        if (b >= 100) out[i++] = 0x30 + Math.floor(b / 100);
        if (b >= 10) out[i++] = 0x30 + (Math.floor(b / 10) % 10);
        out[i++] = 0x30 + (b % 10);
    }
    out[i++] = 0x5d;
    out[i++] = 0x0a;
    return out.subarray(0, i);
}

async function writeWallet(home: string | undefined, cwd: string, bytes: Uint8Array) {
    const dir = bugnetDir(home);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await checkFolder(dir, cwd, home);
    let fh;
    try {
        fh = await open(
            join(dir, "wallet.json"),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        throw new KeyError(code === "EEXIST" || code === "ELOOP" ? "wallet_exists" : "folder_mode");
    }
    const text = keypairText(bytes);
    try {
        await fh.writeFile(text);
        await fh.sync();
    } finally {
        text.fill(0);
        await fh.close();
    }
}

export async function keyNew(home: string | undefined, cwd: string): Promise<string> {
    const pair = generateKeyPairSync("ed25519");
    // PKCS#8 and SPKI in DER end with the 32-byte seed and the 32-byte public key
    const der = pair.privateKey.export({ format: "der", type: "pkcs8" });
    const spki = pair.publicKey.export({ format: "der", type: "spki" });
    const bytes = new Uint8Array(64);
    bytes.set(der.subarray(der.length - 32));
    bytes.set(spki.subarray(spki.length - 32), 32);
    der.fill(0);
    try {
        const signer = await signerFromBytes(bytes);
        await writeWallet(home, cwd, bytes);
        return signer.address;
    } finally {
        bytes.fill(0);
    }
}

// The value as base58 or a JSON array, never quoted back in an error
function keyFromValue(value: string): Uint8Array {
    const v = value.trim();
    if (v.startsWith("[")) {
        const raw = Buffer.from(v);
        const bytes = keypairFromBytes(raw);
        raw.fill(0);
        if (bytes === null) throw new KeyError("var_format");
        return bytes;
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(v)) throw new KeyError("var_format");
    let decoded: Uint8Array;
    try {
        decoded = new Uint8Array(getBase58Encoder().encode(v));
    } catch {
        throw new KeyError("var_format");
    }
    if (decoded.length !== 64) {
        decoded.fill(0);
        throw new KeyError("var_format");
    }
    return decoded;
}

export async function keyImport(
    home: string | undefined,
    cwd: string,
    from: string,
    variable: string,
): Promise<string> {
    let raw: Buffer;
    try {
        raw = await readFile(from);
    } catch {
        throw new KeyError("from_unreadable");
    }
    if (raw.length > maxDotenvBytes) throw new KeyError("from_unreadable");
    const value = parseDotenv(raw.toString("utf8")).get(variable);
    raw.fill(0);
    if (value === undefined || value === "") throw new KeyError("var_missing");
    const bytes = keyFromValue(value);
    try {
        const signer = await signerFromBytes(bytes);
        await writeWallet(home, cwd, bytes);
        return signer.address;
    } finally {
        bytes.fill(0);
    }
}

// The project's .env, refused when it is a link, not a regular file or too big to be one
async function envFileValue(cwd: string, name: string): Promise<string | undefined> {
    const path = join(cwd, ".env");
    const st = await lstat(path).catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new KeyError("wallet_env_file");
    });
    if (st === null) return undefined;
    if (!st.isFile() || st.size > maxEnvFileBytes) throw new KeyError("wallet_env_file");
    let fh;
    try {
        fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
        throw new KeyError("wallet_env_file");
    }
    const buf = Buffer.alloc(maxEnvFileBytes + 1);
    try {
        const now = await fh.stat();
        if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) {
            throw new KeyError("wallet_env_file");
        }
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0).catch(() => {
            throw new KeyError("wallet_env_file");
        });
        if (bytesRead > maxEnvFileBytes) throw new KeyError("wallet_env_file");
        return parseDotenv(buf.toString("utf8", 0, bytesRead)).get(name);
    } finally {
        buf.fill(0);
        await fh.close();
    }
}

// The key named by wallet_env, read afresh for each payment from the working folder's .env, then
// from the bridge's own environment, with only fixed codes coming out and never the value
export async function loadEnvWallet(
    name: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
): Promise<KeyPairSigner> {
    let value = await envFileValue(cwd, name);
    if (value === undefined || value === "") value = env[name];
    if (value === undefined || value === "") throw new KeyError("wallet_env_missing");
    let bytes: Uint8Array | undefined;
    try {
        bytes = keyFromValue(value);
        return await signerFromBytes(bytes);
    } catch {
        throw new KeyError("wallet_env_invalid");
    } finally {
        bytes?.fill(0);
    }
}

// The signer for each payment, wallet_env when set, else the wallet file kept once loaded
export function keySigner(
    walletEnv: string | null,
    home: string | undefined,
    cwd: () => string,
    env: NodeJS.ProcessEnv,
): () => Promise<KeyPairSigner> {
    if (walletEnv !== null) return () => loadEnvWallet(walletEnv, cwd(), env);
    let wallet: Promise<KeyPairSigner> | undefined;
    return () => {
        wallet ??= loadWallet(home, cwd()).catch((e: unknown) => {
            wallet = undefined;
            throw e;
        });
        return wallet;
    };
}

export type KeyCommand =
    { kind: "key-new" } | { kind: "key-import"; from: string; variable: string };

export const importWarning =
    "bugnet-mcp: warning: a key that sat in a project .env may already be exposed (agents can " +
    "read .env, transcripts keep what they read, and git history may hold it). Prefer " +
    "bugnet-mcp key new and a fresh wallet.\n";

// What the command prints: the address and a hint, or a fixed error line
export async function runKeyCommand(
    cmd: KeyCommand,
    home: string | undefined,
    cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
        if (cmd.kind === "key-new") {
            const address = await keyNew(home, cwd);
            return {
                code: 0,
                stdout: `${address}\nFund this address with a small amount of USDC on Solana; no SOL is needed.\n`,
                stderr: "",
            };
        }
        const address = await keyImport(home, cwd, cmd.from, cmd.variable);
        return {
            code: 0,
            stdout: `${address}\ndelete ${cmd.variable} from ${cmd.from} now\n`,
            stderr: importWarning,
        };
    } catch (e) {
        const text = e instanceof KeyError ? e.message : "key_failed: the key command failed";
        return { code: 1, stdout: "", stderr: `bugnet-mcp: ${text}\n` };
    }
}
