// A wallet key must never leave as a sandbox secret, even when the user accepts the prompt
import { getBase58Encoder } from "@solana/kit";

export const walletKeyRefusal =
    "refused_wallet_key: this looks like a wallet private key or seed phrase, which the bridge " +
    "never sends";

const keyNames = /PRIVATE_KEY|SECRET_KEY|KEYPAIR|MNEMONIC|SEED/i;

export function looksLikeKeyName(name: string): boolean {
    return keyNames.test(name);
}

function base58Is64(v: string): boolean {
    if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(v)) return false;
    try {
        const bytes = getBase58Encoder().encode(v);
        return bytes.length === 64;
    } catch {
        return false;
    }
}

function base64Is64(v: string): boolean {
    if (!/^[A-Za-z0-9+/_-]{85,86}={0,2}$/.test(v)) return false;
    return Buffer.from(v, /[-_]/.test(v) ? "base64url" : "base64").length === 64;
}

function byteArray64(v: string): boolean {
    const m = /^\[([\d\s,]*)\]$/.exec(v);
    if (!m) return false;
    const parts = (m[1] as string).split(",").map((p) => p.trim());
    return parts.length === 64 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function seedPhrase(v: string): boolean {
    const words = v.split(/\s+/);
    return (
        [12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w))
    );
}

export function looksLikeSolanaKey(value: string): boolean {
    const v = value.trim();
    return (
        base58Is64(v) ||
        byteArray64(v) ||
        /^(0x)?[0-9a-fA-F]{128}$/.test(v) ||
        base64Is64(v) ||
        seedPhrase(v.toLowerCase())
    );
}
