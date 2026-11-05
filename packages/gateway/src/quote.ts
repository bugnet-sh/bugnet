import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const context = "bugnet-quote-v1.";
const prefix = "q1.";

const quotedPackage = z.object({
    id: z.string(),
    priceMicros: z.number().int(),
    minutes: z.number().int(),
    vcpu: z.number().int(),
    memoryMib: z.number().int(),
    diskGib: z.number().int(),
    gpuCount: z.number().int(),
});

const claimsSchema = z.object({
    packages: z.array(quotedPackage),
    requirements: z.object({ ssh: z.boolean(), preview: z.boolean(), gpu: z.boolean() }),
    source: z.string(),
    expiresAt: z.number().int(),
});

export type QuotedPackage = z.infer<typeof quotedPackage>;
export type QuoteClaims = z.infer<typeof claimsSchema>;

export class QuoteError extends Error {}

function mac(key: Buffer, seg: string): Buffer {
    return createHmac("sha256", key)
        .update(context + seg)
        .digest();
}

// A quote is a signed claim the gateway hands out and gets back, so no replica stores it
export function signQuote(key: Buffer, claims: QuoteClaims): string {
    const seg = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${prefix}${seg}.${mac(key, seg).toString("base64url")}`;
}

export function verifyQuote(key: Buffer, token: string, now: number): QuoteClaims {
    if (!token.startsWith(prefix)) throw new QuoteError("not a quote id");
    const [seg, sig, extra] = token.slice(prefix.length).split(".");
    if (!seg || !sig || extra !== undefined) throw new QuoteError("malformed quote id");
    const want = mac(key, seg);
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
        throw new QuoteError("quote id does not verify");
    }
    let claims: QuoteClaims;
    try {
        claims = claimsSchema.parse(JSON.parse(Buffer.from(seg, "base64url").toString("utf8")));
    } catch {
        throw new QuoteError("malformed quote id");
    }
    if (now >= claims.expiresAt) throw new QuoteError("quote expired, call bugnet_quote again");
    return claims;
}
