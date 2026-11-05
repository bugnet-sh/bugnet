import { createHmac, timingSafeEqual } from "node:crypto";

const context = "bugnet-quote-v2.";
const prefix = "q2.";
const flagOrder = [
    ["ssh", "s"],
    ["preview", "p"],
    ["gpu", "g"],
] as const;

export interface QuotedPackage {
    id: string;
    priceMicros: number;
    minutes: number;
    vcpu: number;
    memoryMib: number;
    diskGib: number;
    gpuCount: number;
}

export interface QuoteClaims {
    requirements: { ssh: boolean; preview: boolean; gpu: boolean };
    expiresAt: number;
}

export class QuoteError extends Error {}

// Agents copy the quoteId by hand, so it holds only the expiry, the needs and a short signature
function mac(key: Buffer, body: string): string {
    return createHmac("sha256", key)
        .update(context + body)
        .digest()
        .subarray(0, 12)
        .toString("base64url");
}

export function signQuote(key: Buffer, claims: QuoteClaims): string {
    const flags = flagOrder.map(([k, f]) => (claims.requirements[k] ? f : "")).join("") || "-";
    const body = `${Math.ceil(claims.expiresAt / 1000).toString(36)}.${flags}`;
    return `${prefix}${body}.${mac(key, body)}`;
}

export function verifyQuote(key: Buffer, token: string, now: number): QuoteClaims {
    const id = token.trim();
    if (!id.startsWith(prefix)) throw new QuoteError("not a quote id, call bugnet_quote");
    const [exp, flags, sig, extra] = id.slice(prefix.length).split(".");
    if (!exp || !flags || !sig || extra !== undefined || !/^(-|s?p?g?)$/.test(flags)) {
        throw new QuoteError("malformed quote id, copy it in full or call bugnet_quote again");
    }
    const want = Buffer.from(mac(key, `${exp}.${flags}`));
    const got = Buffer.from(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
        throw new QuoteError(
            "quote id does not verify, copy it in full or call bugnet_quote again",
        );
    }
    const expiresAt = Number.parseInt(exp, 36) * 1000;
    if (!Number.isFinite(expiresAt) || now >= expiresAt) {
        throw new QuoteError("quote expired, call bugnet_quote again");
    }
    const requirements = {
        ssh: flags.includes("s"),
        preview: flags.includes("p"),
        gpu: flags.includes("g"),
    };
    return { requirements, expiresAt };
}
