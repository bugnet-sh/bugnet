import { generateKeyPairSync } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { expect, it } from "vitest";
import { looksLikeKeyName, looksLikeSolanaKey } from "./keyguard.ts";

function keyBytes(): Uint8Array {
    const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const bytes = new Uint8Array(64);
    bytes.set(Buffer.from(jwk.d as string, "base64url"));
    bytes.set(Buffer.from(jwk.x as string, "base64url"), 32);
    return bytes;
}

function forms(bytes: Uint8Array): string[] {
    const b = Buffer.from(bytes);
    return [
        getBase58Decoder().decode(bytes),
        b.toString("base64"),
        b.toString("base64").replace(/=+$/, ""),
        b.toString("base64url"),
        `[${Array.from(bytes).join(", ")}]`,
        `[${Array.from(bytes).join(",")}]`,
        "0x" + b.toString("hex"),
        "0X" + b.toString("hex").toUpperCase(),
    ];
}

const ordinaryNames = ["API_URL", "NEXTAUTH_SECRET", "TREASURY_ADDRESS", "HF_TOKEN", ""];

it("refuses every 64-byte form under any name", () => {
    const k = keyBytes();
    for (const v of forms(k)) {
        for (const n of [...ordinaryNames, "SOLANA_PRIVATE_KEY"]) {
            expect(looksLikeSolanaKey(v, [n]), `${n} ${v.slice(0, 12)}`).toBe(true);
        }
        expect(looksLikeSolanaKey(v), v.slice(0, 12)).toBe(true);
    }
});

it("refuses a wallet export, a PEM or PKCS#8 key and a seed phrase under any name", () => {
    const k = keyBytes();
    const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
    const der = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" });
    for (const v of [
        JSON.stringify({ publicKey: "x", secretKey: Array.from(k) }),
        JSON.stringify({ privateKey: getBase58Decoder().decode(k.subarray(0, 32)) }),
        JSON.stringify({ secretKey: Array.from(k.subarray(0, 32)) }),
        pem.toString(),
        der.toString("base64"),
        Array(12).fill("abandon").join(" "),
        Array(24).fill("Zoo").join(" "),
    ]) {
        expect(looksLikeSolanaKey(v, ["API_URL"]), v.slice(0, 12)).toBe(true);
    }
});

it("refuses a 32-byte form only under a wallet key name", () => {
    const seed = keyBytes().subarray(0, 32);
    for (const v of forms(seed)) {
        for (const n of ordinaryNames) {
            expect(looksLikeSolanaKey(v, [n]), `${n} ${v.slice(0, 12)}`).toBe(false);
        }
        for (const n of ["SOLANA_PRIVATE_KEY", "deployer_keypair", "WALLET_KEY"]) {
            expect(looksLikeSolanaKey(v, ["HF_TOKEN", n]), `${n} ${v.slice(0, 12)}`).toBe(true);
        }
    }
});

it("lets a NEXTAUTH_SECRET and a Solana address through under ordinary names", () => {
    // openssl rand -base64 32
    const nextauth = Buffer.from(keyBytes().subarray(32)).toString("base64");
    expect(nextauth).toHaveLength(44);
    expect(looksLikeSolanaKey(nextauth, ["NEXTAUTH_SECRET"])).toBe(false);
    const address = getBase58Decoder().decode(keyBytes().subarray(32));
    for (const n of ["API_URL", "SOLANA_API_URL", "PAY_TO_ADDRESS"]) {
        expect(looksLikeSolanaKey(address, [n]), n).toBe(false);
    }
    expect(looksLikeSolanaKey(nextauth, ["SOLANA_PRIVATE_KEY"])).toBe(true);
    expect(looksLikeSolanaKey(address, ["SOLANA_PRIVATE_KEY"])).toBe(true);
});

it("lets common secrets through: a Stripe key, a Rails key base, bare hex", () => {
    const hex = (n: number) => Buffer.from(keyBytes().subarray(0, n)).toString("hex");
    for (const v of [
        "sk_live_" + "51HxYzAbCdEfGhIjKlMnOpQr".repeat(4),
        "hf_" + "a".repeat(34),
        "sk-proj-" + "Ab1".repeat(30),
        hex(32),
        hex(64),
    ]) {
        expect(looksLikeSolanaKey(v, ["SECRET_KEY_BASE"]), v).toBe(false);
    }
    for (const n of ["STRIPE_SECRET_KEY", "CLERK_SECRET_KEY", "SECRET_KEY", "SECRET_KEY_BASE"]) {
        expect(looksLikeKeyName(n), n).toBe(false);
    }
    expect(looksLikeKeyName("WALLET_SEED")).toBe(false);
});

it("spots wallet key names only", () => {
    for (const n of [
        "SOLANA_PRIVATE_KEY",
        "private_key",
        "KEYPAIR",
        "deployer_keypair",
        "WALLET_KEY",
        "HOT_WALLET_KEY",
        "Mnemonic",
        "SEED_PHRASE",
    ]) {
        expect(looksLikeKeyName(n), n).toBe(true);
    }
    for (const n of ["HF_TOKEN", "GITHUB_PRIVATE_KEY_PATH", "MY_PRIVATE_KEY"]) {
        expect(looksLikeKeyName(n), n).toBe(false);
    }
});
