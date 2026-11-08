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

// Each returns the byte length a value decodes to: 64 is a Solana keypair, 32 an Ed25519 seed
// or, just as often, a public address or a random secret such as openssl rand -base64 32
function base58Length(v: string): number | undefined {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(v)) return undefined;
    try {
        return getBase58Encoder().encode(v).length;
    } catch {
        return undefined;
    }
}

function base64Length(v: string): number | undefined {
    const m = /^([A-Za-z0-9+/]+|[A-Za-z0-9_-]+)(={0,2})$/.exec(v);
    if (!m) return undefined;
    const body = m[1] as string;
    if (body.length !== 43 && body.length !== 86) return undefined;
    return Buffer.from(body, /[-_]/.test(body) ? "base64url" : "base64").length;
}

function byteArrayLength(v: string): number | undefined {
    const m = /^\[([\d\s,]*)\]$/.exec(v);
    if (!m) return undefined;
    const parts = (m[1] as string).split(",").map((p) => p.trim());
    if (!parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return undefined;
    return parts.length;
}

function hexLength(v: string): number | undefined {
    const m = /^0x([0-9a-f]+)$/i.exec(v);
    return m ? (m[1] as string).length / 2 : undefined;
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

// A 64-byte form is always refused. A 32-byte form is refused only under a wallet key name,
// since public addresses and random secrets share it. Bare hex is left alone: API tokens take
// that form far more often than keys do
export function looksLikeSolanaKey(value: string, names: readonly string[] = []): boolean {
    const v = value.trim();
    if (
        v.startsWith("-----BEGIN") ||
        // An Ed25519 PKCS#8 key in DER, base64 without the PEM lines
        v.startsWith("MC4CAQAwBQYDK2Vw") ||
        keyObject(v) ||
        seedPhrase(v.toLowerCase())
    ) {
        return true;
    }
    const walletName = names.some(looksLikeKeyName);
    return [hexLength(v), byteArrayLength(v), base58Length(v), base64Length(v)].some(
        (n) => n === 64 || (n === 32 && walletName),
    );
}
