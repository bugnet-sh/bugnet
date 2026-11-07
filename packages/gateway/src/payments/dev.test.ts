import { describe, expect, it } from "vitest";
import { tokenClaims } from "../testing/harness.ts";
import { DevPayments } from "./dev.ts";
import { claimPattern, refusalReasons } from "./port.ts";

const seed = Buffer.alloc(32, 9);
const testNow = Date.parse("2026-11-05T12:00:00Z");
const start = {
    kind: "start",
    packageId: "small-10m",
    amountMicros: 50_000,
    description: "Bugnet sandbox",
} as const;
const handleSha256 = "ab".repeat(32);
const extend = {
    kind: "extend",
    packageId: "more-10m",
    amountMicros: 40_000,
    description: "more time",
    handleSha256,
} as const;
const claim = "C".repeat(43);

describe("port v2 names", () => {
    it("lists the refusal reasons Payments sends, in its order", () => {
        expect([...refusalReasons]).toEqual([
            "order_unknown",
            "order_expired",
            "order_closed",
            "payment_malformed",
            "payment_invalid",
            "payment_replayed",
            "payment_order_mismatch",
            "payer_blocked",
            "payer_busy",
            "payer_rate_limited",
            "payer_invalid",
            "router_unavailable",
            "rpc_unavailable",
            "settlement_unavailable",
            "too_many_attempts",
            "bad_request",
            "unauthorized",
            "claim_mismatch",
            "terms_mismatch",
            "idempotency_conflict",
            "settling",
            "payment_late",
            "token_expired",
            "paid_claim_required",
        ]);
    });

    it("takes a claim of exactly 43 base64url characters", () => {
        expect(claimPattern.test(claim)).toBe(true);
        expect(claimPattern.test("a".repeat(42))).toBe(false);
        expect(claimPattern.test("a".repeat(44))).toBe(false);
        expect(claimPattern.test("a".repeat(42) + "=")).toBe(false);
    });
});

describe("DevPayments by default", () => {
    it("settles at once and answers with the order's terms", async () => {
        const dev = new DevPayments(seed, 600_000, () => testNow);
        expect(dev.requiresPayment).toBe(false);
        const r = await dev.order({ ...start, idempotencyKey: "toolu_1" });
        expect(r).toEqual({
            status: "paid",
            orderId: "toolu_1",
            orderToken: expect.stringMatching(/^v1\./),
            payer: "dev",
            kind: "start",
            packageId: "small-10m",
            amountMicros: 50_000,
        });
        expect(tokenClaims((r as { orderToken: string }).orderToken)).toEqual({
            order_id: "toolu_1",
            kind: "start",
            package_id: "small-10m",
            amount_micros: 50_000,
            expires_at: "2026-11-05T12:10:00.000Z",
        });
    });

    it("carries handleSha256 on extend orders", async () => {
        const dev = new DevPayments(seed, 600_000, () => testNow);
        const r = await dev.order({ ...extend, orderId: "o_ext" });
        expect(r).toEqual(expect.objectContaining({ kind: "extend", handleSha256 }));
        expect(tokenClaims((r as { orderToken: string }).orderToken).handle_sha256).toBe(
            handleSha256,
        );
    });

    it("answers a claim retry from the stored order and refuses an unknown orderId", async () => {
        const dev = new DevPayments(seed, 600_000, () => testNow);
        await dev.order({ ...start, orderId: "o1" });
        expect(await dev.order({ orderId: "o1", claim })).toEqual(
            expect.objectContaining({
                status: "paid",
                orderId: "o1",
                kind: "start",
                packageId: "small-10m",
                amountMicros: 50_000,
            }),
        );
        // Port §2, orderId only when the order is known
        expect(await dev.order({ orderId: "nope", claim })).toEqual({
            status: "refused",
            reason: "order_unknown",
        });
    });
});
