import { generateKeyPairSync, randomBytes } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { expect, it } from "vitest";
import { looksLikeKeyName, looksLikeSeedName, looksLikeSolanaKey } from "./keyguard.ts";

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
        b.toString("hex"),
    ];
}

const ordinaryNames = ["API_URL", "NEXTAUTH_SECRET", "TREASURY_ADDRESS", "HF_TOKEN", ""];

// The openssh-key-v1 layout, enough to carry the key type as ssh-keygen writes it
function openssh(type: string): string {
    const str = (b: Buffer | string) => {
        const buf = Buffer.from(b);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(buf.length);
        return Buffer.concat([len, buf]);
    };
    const pub = Buffer.concat([str(type), str(randomBytes(32))]);
    const priv = Buffer.concat([
        randomBytes(8),
        str(type),
        str(randomBytes(32)),
        str(randomBytes(64)),
    ]);
    const one = Buffer.alloc(4);
    one.writeUInt32BE(1);
    const blob = Buffer.concat([
        Buffer.from("openssh-key-v1\0"),
        str("none"),
        str("none"),
        str(""),
        one,
        str(pub),
        str(priv),
    ]);
    const body = blob.toString("base64").replace(/.{70}/g, "$&\n");
    return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

it("refuses a Solana keypair in every 64-byte form under any name", () => {
    const k = keyBytes();
    for (const v of forms(k)) {
        for (const n of [...ordinaryNames, "SOLANA_PRIVATE_KEY"]) {
            expect(looksLikeSolanaKey(v, [n]), `${n} ${v.slice(0, 12)}`).toBe(true);
        }
        expect(looksLikeSolanaKey(v), v.slice(0, 12)).toBe(true);
    }
});

it("lets 64 random bytes through in every form, such as a JWT secret", () => {
    const r = Uint8Array.from(randomBytes(64));
    for (const v of forms(r)) {
        expect(looksLikeSolanaKey(v, ["JWT_SECRET"]), v.slice(0, 12)).toBe(false);
    }
    // A keypair whose halves do not belong together is not one
    const k = keyBytes();
    k.set(randomBytes(32), 32);
    for (const v of forms(k)) expect(looksLikeSolanaKey(v, ["JWT_SECRET"])).toBe(false);
});

it("refuses Ed25519 private keys as PEM, PKCS#8 and OpenSSH, and lets other keys through", () => {
    const ed = generateKeyPairSync("ed25519");
    const pem = ed.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const der = ed.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const derHex = ed.privateKey.export({ format: "der", type: "pkcs8" }).toString("hex");
    for (const v of [
        pem,
        pem.replace(/\n/g, "\\n"),
        pem.replace(/\n/g, "\\r\\n"),
        pem.replace(/\n/g, "\r\n"),
        der,
        derHex,
        "0x" + derHex,
        "0X" + derHex.toUpperCase(),
        // v2 with the public key, as some tools write it
        "3051020101300506032b6570042204" + "20" + "ab".repeat(32) + "8121" + "00" + "cd".repeat(32),
        openssh("ssh-ed25519"),
        openssh("ssh-ed25519").replace(/\n/g, "\\r\\n"),
    ]) {
        expect(looksLikeSolanaKey(v, ["API_URL"]), v.slice(0, 40)).toBe(true);
    }
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const cert =
        "-----BEGIN CERTIFICATE-----\n" +
        randomBytes(600).toString("base64").replace(/.{64}/g, "$&\n") +
        "\n-----END CERTIFICATE-----\n";
    for (const v of [
        rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        rsa.privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
        ec.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        ec.privateKey.export({ format: "pem", type: "sec1" }).toString(),
        rsa.publicKey.export({ format: "pem", type: "spki" }).toString(),
        ed.publicKey.export({ format: "pem", type: "spki" }).toString(),
        openssh("ssh-rsa"),
        cert,
        rsa.privateKey.export({ format: "der", type: "pkcs8" }).toString("hex"),
        ec.privateKey.export({ format: "der", type: "pkcs8" }).toString("hex"),
        ed.publicKey.export({ format: "der", type: "spki" }).toString("hex"),
    ]) {
        expect(looksLikeSolanaKey(v, ["GITHUB_APP_PRIVATE_KEY"]), v.slice(0, 40)).toBe(false);
    }
});

it("refuses a wallet export with a keypair at any depth, or a seed under a key field", () => {
    const k = keyBytes();
    const seed = Array.from(k.subarray(0, 32));
    for (const v of [
        JSON.stringify({ publicKey: "x", secretKey: Array.from(k) }),
        JSON.stringify({ secret_key: Array.from(k) }),
        JSON.stringify({ wallet: { keys: [{ private_key: getBase58Decoder().decode(k) }] } }),
        JSON.stringify({ anything: Buffer.from(k).toString("base64") }),
        JSON.stringify({ privateKey: getBase58Decoder().decode(k.subarray(0, 32)) }),
        JSON.stringify({ secretKey: seed }),
        JSON.stringify({ nested: { secret_key: seed } }),
        JSON.stringify({ deep: [{ PRIVATE_KEY: "0x" + Buffer.from(seed).toString("hex") }] }),
        Array(12).fill("abandon").join(" "),
        Array(24).fill("Zoo").join(" "),
    ]) {
        expect(looksLikeSolanaKey(v, ["API_URL"]), v.slice(0, 30)).toBe(true);
    }
    for (const v of [
        JSON.stringify({ secret_key: "sk_live_" + "a".repeat(40) }),
        JSON.stringify({ secret_key: Array.from(randomBytes(64)) }),
        JSON.stringify({ token: seed }),
        JSON.stringify({ client_secret: Buffer.from(seed).toString("base64") }),
    ]) {
        expect(looksLikeSolanaKey(v, ["API_URL"]), v.slice(0, 30)).toBe(false);
    }
});

it("refuses JSON past its node or depth limit, and judges a byte array whole", () => {
    const k = Array.from(keyBytes());
    let deep: unknown = "x";
    for (let i = 0; i < 20; i++) deep = { a: deep };
    for (const v of [
        // A long byte array before the key no longer uses up the walk
        JSON.stringify({ pad: Array(5_000).fill(7), secretKey: k }),
        JSON.stringify({ pad: Array(5_000).fill("x"), secretKey: k }),
        JSON.stringify({ pad: Array(5_000).fill(1_000) }),
        JSON.stringify(deep),
        JSON.stringify({ inner: JSON.stringify({ pad: Array(5_000).fill("x") }) }),
    ]) {
        expect(looksLikeSolanaKey(v, ["API_URL"]), v.slice(0, 30)).toBe(true);
    }
    let shallow: unknown = "x";
    for (let i = 0; i < 15; i++) shallow = { a: shallow };
    for (const v of [
        JSON.stringify({ pad: Array(5_000).fill(7), other: "x" }),
        JSON.stringify({ pad: Array(1_500).fill("x") }),
        JSON.stringify(shallow),
    ]) {
        expect(looksLikeSolanaKey(v, ["API_URL"]), v.slice(0, 30)).toBe(false);
    }
});

const seedNameCases = [
    "SOLANA_PRIVATE_KEY",
    "SOL_PRIVATE_KEY",
    "WALLET_PRIVATE_KEY",
    "SOLANA_SECRET_KEY",
    "PAYER_PRIVATE_KEY",
    "SIGNER_KEY",
    "PHANTOM_KEY",
    "deployer_keypair",
    "WALLET_KEY",
    "PRIVATE_KEY",
    "mnemonic",
    "SEED_PHRASE",
];

it("refuses a 32-byte form only under a wallet key name", () => {
    const seed = keyBytes().subarray(0, 32);
    for (const v of forms(seed)) {
        for (const n of [...ordinaryNames, "STRIPE_SECRET_KEY", "CLERK_SECRET_KEY"]) {
            expect(looksLikeSolanaKey(v, [n]), `${n} ${v.slice(0, 12)}`).toBe(false);
        }
        for (const n of seedNameCases) {
            expect(looksLikeSolanaKey(v, ["HF_TOKEN", n]), `${n} ${v.slice(0, 12)}`).toBe(true);
        }
    }
    for (const n of seedNameCases) expect(looksLikeSeedName(n), n).toBe(true);
    for (const n of ["STRIPE_SECRET_KEY", "NEXTAUTH_SECRET", "HF_TOKEN", "API_URL"]) {
        expect(looksLikeSeedName(n), n).toBe(false);
    }
});

it("reads wallet names as whole underscore tokens and passes public key names", () => {
    const seed = keyBytes().subarray(0, 32);
    const passing = [
        "CONSOLE_API_KEY",
        "SOLR_API_KEY",
        "RESOLVER_KEY",
        "SOLANA_PUBLIC_KEY",
        "WALLET_PUBKEY",
    ];
    for (const n of passing) {
        expect(looksLikeSeedName(n), n).toBe(false);
        for (const v of forms(seed)) {
            expect(looksLikeSolanaKey(v, [n]), `${n} ${v.slice(0, 12)}`).toBe(false);
        }
    }
    const refused = [
        "SOL_PRIVATE_KEY",
        "WALLET_PRIVATE_KEY",
        "SOLANA_SECRET_KEY",
        "PAYER_PRIVATE_KEY",
        "PRIVATE_KEY",
        "MY_KEYPAIR",
    ];
    for (const n of refused) {
        expect(looksLikeSeedName(n), n).toBe(true);
        for (const v of forms(seed)) {
            expect(looksLikeSolanaKey(v, [n]), `${n} ${v.slice(0, 12)}`).toBe(true);
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

it("lets common secrets through: a Stripe key, a Rails key base, random hex", () => {
    const hex = (n: number) => randomBytes(n).toString("hex");
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

it("refuses outright only names that a wallet key alone goes by", () => {
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
