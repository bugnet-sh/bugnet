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

it("spots a Solana key in every encoding and leaves ordinary tokens alone", () => {
    const k = keyBytes();
    expect(looksLikeSolanaKey(getBase58Decoder().decode(k))).toBe(true);
    expect(looksLikeSolanaKey(`[${Array.from(k).join(", ")}]`)).toBe(true);
    expect(looksLikeSolanaKey("0x" + Buffer.from(k).toString("hex"))).toBe(true);
    expect(looksLikeSolanaKey(Buffer.from(k).toString("base64"))).toBe(true);
    expect(looksLikeSolanaKey(Array(12).fill("abandon").join(" "))).toBe(true);
    expect(looksLikeSolanaKey("hf_" + "a".repeat(34))).toBe(false);
    expect(looksLikeSolanaKey("sk-proj-" + "Ab1".repeat(30))).toBe(false);
});

it("spots a 32-byte seed, a wallet export and a PEM or PKCS#8 key", () => {
    const k = keyBytes();
    const seed = k.subarray(0, 32);
    const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
    const der = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" });
    for (const v of [
        getBase58Decoder().decode(seed),
        `[${Array.from(seed).join(",")}]`,
        "0X" + Buffer.from(seed).toString("hex"),
        "0x" + Buffer.from(k).toString("hex").toUpperCase(),
        Buffer.from(seed).toString("base64"),
        Buffer.from(seed).toString("base64url"),
        Buffer.from(k).toString("base64url"),
        JSON.stringify({ publicKey: "x", secretKey: Array.from(k) }),
        JSON.stringify({ privateKey: getBase58Decoder().decode(k) }),
        pem.toString(),
        der.toString("base64"),
    ]) {
        expect(looksLikeSolanaKey(v), v.slice(0, 12)).toBe(true);
    }
});

it("lets common secrets through: a Stripe key, a Rails key base, a bare hex token", () => {
    const hex = (n: number) => Buffer.from(keyBytes().subarray(0, n)).toString("hex");
    for (const v of ["sk_live_" + "51HxYzAbCdEfGhIjKlMnOpQr".repeat(4), hex(32), hex(64)]) {
        expect(looksLikeSolanaKey(v), v).toBe(false);
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
