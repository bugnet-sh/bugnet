import { createPrivateKey, sign, type KeyObject } from "node:crypto";

// Matches bugnet-router/internal/ordertoken, which decodes these claims strictly
export interface OrderClaims {
    order_id: string;
    kind: "start" | "extend";
    package_id: string;
    amount_micros: number;
    allowance_micros?: number;
    expires_at: string;
    handle_sha256?: string;
}

const pkcs8Ed25519Prefix = Buffer.from("302e020100300506032b657004220420", "hex");

export function orderKey(seed: Buffer): KeyObject {
    if (seed.length !== 32) throw new Error("order key seed must be 32 bytes");
    return createPrivateKey({
        key: Buffer.concat([pkcs8Ed25519Prefix, seed]),
        format: "der",
        type: "pkcs8",
    });
}

export function signOrderToken(key: KeyObject, claims: OrderClaims): string {
    const seg = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = sign(null, Buffer.from(`bugnet-order-v1.${seg}`), key);
    return `v1.${seg}.${sig.toString("base64url")}`;
}
