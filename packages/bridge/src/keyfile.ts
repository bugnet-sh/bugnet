// The local wallet: a Solana CLI keypair file only its owner can read, never shown or logged
import { generateKeyPairSync } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
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

async function checkFolder(dir: string, cwd: string): Promise<void> {
    const st = await lstat(dir).catch(() => null);
    if (st === null || !st.isDirectory() || !ownedPrivately(st)) throw new KeyError("folder_mode");
    const rel = relative(await realpath(cwd), await realpath(dir));
    if (!rel.startsWith("..") && !isAbsolute(rel)) throw new KeyError("inside_cwd");
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

// A JSON array of exactly 64 integers 0-255, parsed without JSON.parse, whose errors quote text
function keypairArray(text: string): Uint8Array | null {
    const m = /^\s*\[([\d\s,]*)\]\s*$/.exec(text);
    if (!m) return null;
    const parts = (m[1] as string).split(",");
    if (parts.length !== 64) return null;
    const out = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
        const p = (parts[i] as string).trim();
        if (!/^\d{1,3}$/.test(p) || Number(p) > 255) {
            out.fill(0);
            return null;
        }
        out[i] = Number(p);
    }
    return out;
}

export async function loadWallet(home: string | undefined, cwd: string): Promise<KeyPairSigner> {
    const dir = bugnetDir(home);
    await checkFolder(dir, cwd);
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
        bytes = keypairArray(buf.toString("utf8", 0, bytesRead));
        if (bytes === null) throw new KeyError("wallet_format");
        return await signerFromBytes(bytes);
    } finally {
        buf.fill(0);
        bytes?.fill(0);
        await fh.close();
    }
}

async function writeWallet(home: string | undefined, cwd: string, bytes: Uint8Array) {
    const dir = bugnetDir(home);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await checkFolder(dir, cwd);
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
    const text = Buffer.from(`[${Array.from(bytes).join(",")}]\n`);
    try {
        await fh.writeFile(text);
        await fh.sync();
    } finally {
        text.fill(0);
        await fh.close();
    }
}

export async function keyNew(home: string | undefined, cwd: string): Promise<string> {
    const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const seed = Buffer.from(jwk.d as string, "base64url");
    const pub = Buffer.from(jwk.x as string, "base64url");
    const bytes = new Uint8Array(64);
    bytes.set(seed);
    bytes.set(pub, 32);
    seed.fill(0);
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
        const bytes = keypairArray(v);
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
