import { describe, expect, it } from "vitest";
import { QuoteError, isEstimateId, signQuote, verifyQuote, type QuoteClaims } from "./quote.ts";

const key = Buffer.alloc(32, 7);
const estimateId = "0f8b6c2e-41d7-4a3b-9c5e-7d2a1b3c4d5e";
const expiresAt = Date.parse("2026-11-05T12:10:00Z");
const before = expiresAt - 60_000;

const claims: QuoteClaims = {
    requirements: { ssh: true, preview: false, gpu: false, secrets: true },
    github: true,
    estimateId,
    expiresAt,
};

function fields(id: string): string[] {
    return id.split(".");
}

describe("quote ids", () => {
    it("round-trip every claim and stay near 51 characters", () => {
        const id = signQuote(key, claims);
        expect(id).toMatch(/^q3\.[0-9a-z]+\.sxr\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{16}$/);
        expect(id.length).toBeLessThanOrEqual(54);
        expect(verifyQuote(key, ` ${id}\n`, before)).toEqual(claims);
    });

    it("keep the plainest quote at 51 characters", () => {
        const plain: QuoteClaims = {
            requirements: { ssh: false, preview: false, gpu: false, secrets: false },
            github: false,
            estimateId,
            expiresAt,
        };
        const id = signQuote(key, plain);
        expect(fields(id)[2]).toBe("-");
        expect(id).toHaveLength(51);
        expect(verifyQuote(key, id, before)).toEqual(plain);
    });

    it("carry every flag in a fixed order", () => {
        const all: QuoteClaims = {
            requirements: { ssh: true, preview: true, gpu: true, secrets: true },
            github: true,
            estimateId,
            expiresAt,
        };
        const id = signQuote(key, all);
        expect(fields(id)[2]).toBe("spgxr");
        expect(verifyQuote(key, id, before)).toEqual(all);
    });

    it("mark a GitHub repo the router will not place apart from one it will", () => {
        const unplaced: QuoteClaims = {
            ...claims,
            github: false,
            githubUnplaced: true,
            estimateId: null,
        };
        const id = signQuote(key, unplaced);
        expect(fields(id)[2]).toMatch(/h$/);
        expect(verifyQuote(key, id, before)).toEqual(unplaced);
    });

    it("mark a quote without an estimate with a dash", () => {
        const none = { ...claims, estimateId: null };
        const id = signQuote(key, none);
        expect(fields(id)[3]).toBe("-");
        expect(id.length).toBeLessThan(35);
        expect(verifyQuote(key, id, before)).toEqual(none);
    });

    it("give the estimate back as a lower-case UUID", () => {
        const id = signQuote(key, { ...claims, estimateId: estimateId.toUpperCase() });
        expect(verifyQuote(key, id, before).estimateId).toBe(estimateId);
    });

    it("refuse to sign an estimate id that is not a UUID", () => {
        expect(isEstimateId(estimateId)).toBe(true);
        expect(isEstimateId("est_123")).toBe(false);
        expect(() => signQuote(key, { ...claims, estimateId: "est_123" })).toThrow(QuoteError);
    });

    it("expire at the signed time", () => {
        const id = signQuote(key, claims);
        expect(() => verifyQuote(key, id, expiresAt)).toThrow(
            "quote expired, call bugnet_quote again",
        );
        expect(() => verifyQuote(key, id, expiresAt - 1)).not.toThrow();
    });

    it("refuse another key", () => {
        const id = signQuote(Buffer.alloc(32, 8), claims);
        expect(() => verifyQuote(key, id, before)).toThrow(/does not verify/);
    });

    it("refuse a change to any one field", () => {
        const id = signQuote(key, claims);
        const [p, exp, flags, est, sig] = fields(id) as [string, string, string, string, string];
        const other = signQuote(key, {
            ...claims,
            estimateId: "11111111-2222-4333-8444-555555555555",
        });
        const tampered = [
            [p, (Number.parseInt(exp, 36) + 3600).toString(36), flags, est, sig],
            [p, exp, "spgxr", est, sig],
            [p, exp, "sx", est, sig],
            [p, exp, "-", est, sig],
            [p, exp, flags, "-", sig],
            [p, exp, flags, fields(other)[3], sig],
            [p, exp, flags, est, fields(other)[4]],
        ];
        for (const parts of tampered) {
            expect(() => verifyQuote(key, parts.join("."), before)).toThrow(/does not verify/);
        }
    });

    it("refuse every one-character typo", () => {
        const id = signQuote(key, claims);
        for (let i = 3; i < id.length; i++) {
            if (id[i] === ".") continue;
            const typo = id.slice(0, i) + (id[i] === "A" ? "B" : "A") + id.slice(i + 1);
            expect(() => verifyQuote(key, typo, before)).toThrow(QuoteError);
            expect(() => verifyQuote(key, typo, before)).toThrow(/copy it in full/);
        }
    });

    it("refuse a quote id cut short or with parts missing", () => {
        const id = signQuote(key, claims);
        expect(() => verifyQuote(key, id.slice(0, -3), before)).toThrow(/copy it in full/);
        const [p, exp, flags, , sig] = fields(id);
        expect(() => verifyQuote(key, [p, exp, flags, sig].join("."), before)).toThrow(/malformed/);
        expect(() => verifyQuote(key, `${id}.extra`, before)).toThrow(/malformed/);
        expect(() => verifyQuote(key, [p, exp, "q", "-", sig].join("."), before)).toThrow(
            /malformed/,
        );
        expect(() => verifyQuote(key, [p, exp, "rs", "-", sig].join("."), before)).toThrow(
            /malformed/,
        );
    });

    it("refuse the older q2 and q1 formats with a clear message", () => {
        const q2 = "q2.tmxw5c.g.AbCdEfGhIjKlMnOp";
        for (const old of [q2, "q1.eyJ4IjoxfQ.sig"]) {
            expect(() => verifyQuote(key, old, before)).toThrow(
                "this quote id is from an older Bugnet version, call bugnet_quote again",
            );
        }
        expect(() => verifyQuote(key, "sbx_abcdefghijklmnopqrstuvwxyz", before)).toThrow(
            "not a quote id, call bugnet_quote",
        );
    });
});
