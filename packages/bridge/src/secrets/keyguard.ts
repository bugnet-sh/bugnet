// A wallet key must never leave as a sandbox secret, even when the user accepts the prompt
import { createPrivateKey, createPublicKey } from "node:crypto";
import { getBase58Encoder } from "@solana/kit";

export const walletKeyRefusal =
    "refused_wallet_key: this looks like a wallet private key or seed phrase, which the bridge " +
    "never sends";

// Names that only a wallet key goes by; SECRET_KEY, *_SEED and the like name ordinary secrets too
const keyNames =
    /^(?:SOLANA_PRIVATE_KEY|PRIVATE_KEY|(?:\w+_)?KEYPAIR|(?:\w+_)?WALLET_KEY|MNEMONIC|SEED_PHRASE)$/i;

export function looksLikeKeyName(name: string): boolean {
    return keyNames.test(name);
}

// Wider: a 32-byte value under one of these names is taken for an Ed25519 seed. Whole
// underscore tokens, so CONSOLE_API_KEY is not a SOL name, and no PUB token, so
// SOLANA_PUBLIC_KEY is not a private one
const seedNames =
    /(?:^|_)(?:SOL|SOLANA|WALLET|PAYER|SIGNER|KEYPAIR|PHANTOM)(?:_(?!PUB)[A-Z0-9]+)*_(?:PRIVATE_|SECRET_)?KEY$|(?:^|_)PRIVATE_?KEY$|KEYPAIR|MNEMONIC|SEED_?PHRASE/i;

export function looksLikeSeedName(name: string): boolean {
    return seedNames.test(name);
}

// A JSON field whose 32-byte value is a seed, as in {"secret_key": [...]}
const keyFields = /^(?:secret|private)_?key$/i;

// Ed25519 PKCS#8 DER in base64: v1 (seed only) and v2 (seed and public key)
const ed25519Der = /^(?:MC4CAQAwBQYDK2Vw|MFECAQEwBQYDK2Vw)/;
const pkcs8Seed = Buffer.from("302e020100300506032b657004220420", "hex");

// A Solana keypair is a seed followed by its own public key; 64 random bytes are not
function isKeypair(bytes: Uint8Array): boolean {
    if (bytes.length !== 64) return false;
    const der = Buffer.concat([pkcs8Seed, bytes.subarray(0, 32)]);
    try {
        const spki = createPublicKey(
            createPrivateKey({ key: der, format: "der", type: "pkcs8" }),
        ).export({ format: "der", type: "spki" });
        return Buffer.from(spki.subarray(-32)).equals(Buffer.from(bytes.subarray(32)));
    } catch {
        return false;
    } finally {
        der.fill(0);
    }
}

function base58Bytes(v: string): Uint8Array | undefined {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(v)) return undefined;
    try {
        return Uint8Array.from(getBase58Encoder().encode(v));
    } catch {
        return undefined;
    }
}

function base64Bytes(v: string): Uint8Array | undefined {
    const m = /^([A-Za-z0-9+/]+|[A-Za-z0-9_-]+)(={0,2})$/.exec(v);
    if (!m) return undefined;
    const body = m[1] as string;
    if (body.length !== 43 && body.length !== 86) return undefined;
    return Buffer.from(body, /[-_]/.test(body) ? "base64url" : "base64");
}

function byteArray(v: unknown[]): Uint8Array | undefined {
    if (!v.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 255)) {
        return undefined;
    }
    return Uint8Array.from(v as number[]);
}

function arrayBytes(v: string): Uint8Array | undefined {
    const m = /^\[([\d\s,]*)\]$/.exec(v);
    if (!m) return undefined;
    const parts = (m[1] as string).split(",").map((p) => p.trim());
    if (!parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
    return byteArray(parts.map(Number));
}

// 0x hex of either size, bare hex only as 64 or 128 digits
function hexBytes(v: string): Uint8Array | undefined {
    const m = /^(0x)?([0-9a-f]+)$/i.exec(v);
    if (!m) return undefined;
    const digits = m[2] as string;
    if (digits.length !== 64 && digits.length !== 128) return undefined;
    return Buffer.from(digits, "hex");
}

function refusedBytes(bytes: Uint8Array | undefined, seedName: boolean): boolean {
    if (bytes === undefined) return false;
    return isKeypair(bytes) || (bytes.length === 32 && seedName);
}

function pemBody(v: string, label: string): string | undefined {
    const m = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(v);
    // A .env value often carries the line breaks as \n
    return m ? (m[1] as string).replace(/\\n|\s/g, "") : undefined;
}

// Only Ed25519 private keys; RSA and EC keys, certificates and public keys go through
function ed25519Pem(v: string): boolean {
    const pkcs8 = pemBody(v, "PRIVATE KEY");
    if (pkcs8 !== undefined && ed25519Der.test(pkcs8)) return true;
    const openssh = pemBody(v, "OPENSSH PRIVATE KEY");
    return openssh !== undefined && Buffer.from(openssh, "base64").includes("ssh-ed25519");
}

function seedPhrase(v: string): boolean {
    const words = v.split(/\s+/);
    return (
        [12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w))
    );
}

const maxJsonNodes = 2_000;

// A wallet export such as {"publicKey": ..., "secretKey": [...]}, at any depth
function jsonKey(v: string, seedName: boolean, depth: number): boolean {
    if (!v.startsWith("{") && !v.startsWith("[")) return false;
    let doc: unknown;
    try {
        doc = JSON.parse(v);
    } catch {
        return false;
    }
    let budget = maxJsonNodes;
    const walk = (node: unknown, keyed: boolean, depth: number): boolean => {
        if (--budget < 0 || depth > 16) return false;
        if (typeof node === "string") return refused(node, keyed, depth + 1);
        if (Array.isArray(node)) {
            if (refusedBytes(byteArray(node), keyed)) return true;
            return node.some((n) => walk(n, keyed, depth + 1));
        }
        if (typeof node !== "object" || node === null) return false;
        return Object.entries(node).some(([k, n]) =>
            walk(n, keyFields.test(k) || looksLikeSeedName(k), depth + 1),
        );
    };
    return walk(doc, seedName, depth);
}

function refused(value: string, seedName: boolean, depth: number): boolean {
    const v = value.trim();
    if (ed25519Pem(v) || ed25519Der.test(v) || seedPhrase(v.toLowerCase())) return true;
    if (depth < 16 && jsonKey(v, seedName, depth)) return true;
    return [hexBytes(v), arrayBytes(v), base58Bytes(v), base64Bytes(v)].some((b) =>
        refusedBytes(b, seedName),
    );
}

// A 64-byte value is refused when its second half is the first half's Ed25519 public key. A
// 32-byte value is refused only under a wallet key name, since public addresses and random
// secrets share that size. Bare hex counts only as 64 or 128 digits
export function looksLikeSolanaKey(value: string, names: readonly string[] = []): boolean {
    return refused(value, names.some(looksLikeSeedName), 0);
}
