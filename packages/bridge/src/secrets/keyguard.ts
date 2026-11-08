// A wallet key must never leave as a sandbox secret, even when the user accepts the prompt
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

// An Ed25519 seed is 32 bytes, a Solana keypair 64
const keyLength = (n: number) => n === 32 || n === 64;

function base58Key(v: string): boolean {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(v)) return false;
    try {
        return keyLength(getBase58Encoder().encode(v).length);
    } catch {
        return false;
    }
}

function base64Key(v: string): boolean {
    const m = /^([A-Za-z0-9+/]+|[A-Za-z0-9_-]+)(={0,2})$/.exec(v);
    if (!m) return false;
    const body = m[1] as string;
    if (body.length !== 43 && body.length !== 86) return false;
    return keyLength(Buffer.from(body, /[-_]/.test(body) ? "base64url" : "base64").length);
}

function byteArray(v: string): boolean {
    const m = /^\[([\d\s,]*)\]$/.exec(v);
    if (!m) return false;
    const parts = (m[1] as string).split(",").map((p) => p.trim());
    return keyLength(parts.length) && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// A wallet export such as {"publicKey": ..., "secretKey": [...]}
function keyObject(v: string): boolean {
    if (!v.startsWith("{")) return false;
    let doc: unknown;
    try {
        doc = JSON.parse(v);
    } catch {
        return false;
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return false;
    return Object.keys(doc).some((k) => /^(?:secretKey|privateKey)$/i.test(k));
}

function seedPhrase(v: string): boolean {
    const words = v.split(/\s+/);
    return (
        [12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w))
    );
}

// A bare 64-hex value is left alone: API tokens take that form far more often than keys do
export function looksLikeSolanaKey(value: string): boolean {
    const v = value.trim();
    return (
        v.startsWith("-----BEGIN") ||
        // An Ed25519 PKCS#8 key in DER, base64 without the PEM lines
        v.startsWith("MC4CAQAwBQYDK2Vw") ||
        /^0x(?:[0-9a-f]{64}|[0-9a-f]{128})$/i.test(v) ||
        byteArray(v) ||
        keyObject(v) ||
        base58Key(v) ||
        base64Key(v) ||
        seedPhrase(v.toLowerCase())
    );
}
