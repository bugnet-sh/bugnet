import { createHmac, timingSafeEqual } from "node:crypto";

const context = "bugnet-quote-v3.";
const prefix = "q3.";
const oldPrefixes = ["q2.", "q1."];
const flagOrder = [
    ["ssh", "s"],
    ["preview", "p"],
    ["gpu", "g"],
    ["secrets", "x"],
] as const;
const githubFlag = "r";
const flagsPattern = /^(-|s?p?g?x?r?)$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const packedPattern = /^[A-Za-z0-9_-]{22}$/;

export interface QuotedPackage {
    id: string;
    priceMicros: number;
    minutes: number;
    vcpu: number;
    memoryMib: number;
    diskGib: number;
    gpuCount: number;
}

export interface QuoteRequirements {
    ssh: boolean;
    preview: boolean;
    gpu: boolean;
    secrets: boolean;
}

export interface QuoteClaims {
    requirements: QuoteRequirements;
    // The router resolved the source to a GitHub repository it can put in the sandbox
    github: boolean;
    // The router's estimate as a lower-case UUID, null when it gave none
    estimateId: string | null;
    expiresAt: number;
}

export class QuoteError extends Error {}

export function isEstimateId(id: string): boolean {
    return uuidPattern.test(id);
}

function packEstimate(id: string | null): string {
    if (id === null) return "-";
    if (!isEstimateId(id)) throw new QuoteError("estimate id is not a UUID");
    return Buffer.from(id.replace(/-/g, ""), "hex").toString("base64url");
}

function unpackEstimate(packed: string): string | null {
    if (packed === "-") return null;
    const hex = Buffer.from(packed, "base64url").toString("hex");
    return [0, 8, 12, 16, 20].map((at, i, all) => hex.slice(at, all[i + 1] ?? 32)).join("-");
}

// Agents copy the quoteId by hand, so every field is packed short and the signature is 96 bits
function mac(key: Buffer, body: string): string {
    return createHmac("sha256", key)
        .update(context + body)
        .digest()
        .subarray(0, 12)
        .toString("base64url");
}

export function signQuote(key: Buffer, claims: QuoteClaims): string {
    const needs = flagOrder.map(([k, f]) => (claims.requirements[k] ? f : "")).join("");
    const flags = needs + (claims.github ? githubFlag : "") || "-";
    const exp = Math.ceil(claims.expiresAt / 1000).toString(36);
    const body = `${exp}.${flags}.${packEstimate(claims.estimateId)}`;
    return `${prefix}${body}.${mac(key, body)}`;
}

export function verifyQuote(key: Buffer, token: string, now: number): QuoteClaims {
    const id = token.trim();
    if (oldPrefixes.some((p) => id.startsWith(p))) {
        throw new QuoteError(
            "this quote id is from an older Bugnet version, call bugnet_quote again",
        );
    }
    if (!id.startsWith(prefix)) throw new QuoteError("not a quote id, call bugnet_quote");
    const [exp, flags, est, sig, extra] = id.slice(prefix.length).split(".");
    const wellFormed =
        exp !== undefined &&
        /^[0-9a-z]{1,10}$/.test(exp) &&
        flags !== undefined &&
        flagsPattern.test(flags) &&
        est !== undefined &&
        (est === "-" || packedPattern.test(est)) &&
        sig !== undefined &&
        sig.length > 0 &&
        extra === undefined;
    if (!wellFormed) {
        throw new QuoteError("malformed quote id, copy it in full or call bugnet_quote again");
    }
    const want = Buffer.from(mac(key, `${exp}.${flags}.${est}`));
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
        secrets: flags.includes("x"),
    };
    return {
        requirements,
        github: flags.includes(githubFlag),
        estimateId: unpackEstimate(est),
        expiresAt,
    };
}
