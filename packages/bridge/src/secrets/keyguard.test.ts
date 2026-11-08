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
    expect(looksLikeSolanaKey(Buffer.from(k).toString("hex"))).toBe(true);
    expect(looksLikeSolanaKey(Buffer.from(k).toString("base64"))).toBe(true);
    expect(looksLikeSolanaKey(Array(12).fill("abandon").join(" "))).toBe(true);
    expect(looksLikeSolanaKey("hf_" + "a".repeat(34))).toBe(false);
    expect(looksLikeSolanaKey("sk-proj-" + "Ab1".repeat(30))).toBe(false);
});

it("spots key-like names", () => {
    for (const n of ["SOLANA_PRIVATE_KEY", "secret_key", "KEYPAIR", "Mnemonic", "WALLET_SEED"]) {
        expect(looksLikeKeyName(n), n).toBe(true);
    }
    expect(looksLikeKeyName("HF_TOKEN")).toBe(false);
});
