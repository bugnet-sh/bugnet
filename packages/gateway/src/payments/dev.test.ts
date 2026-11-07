import { beforeEach, describe, expect, it } from "vitest";
import { testConfig, tokenClaims } from "../testing/harness.ts";
import { DevPayments, devUnpaidTtlMs } from "./dev.ts";
import { paymentsFor } from "./index.ts";
import { claimPattern, refusalReasons, type AwaitingPayment, type OrderRequest } from "./port.ts";

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

const solana = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const key16 = "k".repeat(16);

function requiring(c: { now: number }): DevPayments {
    return new DevPayments(seed, 600_000, () => c.now, {
        requirePayment: true,
        payBaseUrl: "http://127.0.0.1:8787",
    });
}

function created(r: { status: string }): AwaitingPayment {
    expect(r.status).toBe("payment_required");
    return r as AwaitingPayment;
}

describe("DevPayments asking for payment", () => {
    const clock = { now: testNow };
    beforeEach(() => {
        clock.now = testNow;
    });

    it("creates an order with a claim and a loopback pay link", async () => {
        const dev = requiring(clock);
        expect(dev.requiresPayment).toBe(true);
        const r = created(await dev.order(start));
        expect(r.orderId).toMatch(/^ord_[a-z2-7]{26}$/);
        expect(r.claim).toMatch(claimPattern);
        expect(r.payUrl).toBe(`http://127.0.0.1:8787/o/${r.orderId}`);
        expect(r.paymentRequired).toEqual({
            x402Version: 2,
            resource: {
                url: r.payUrl,
                description: "Bugnet sandbox",
                mimeType: "application/json",
            },
            accepts: [
                {
                    scheme: "exact",
                    network: solana,
                    asset: usdc,
                    amount: "50000",
                    payTo: "BugnetDevPayee",
                    maxTimeoutSeconds: 300,
                    extra: { memo: r.orderId },
                },
            ],
        });
    });

    it("replays an idempotency key of 16 characters and ignores one of 15", async () => {
        const dev = requiring(clock);
        const a = created(await dev.order({ ...start, idempotencyKey: key16 }));
        const b = created(await dev.order({ ...start, idempotencyKey: key16 }));
        expect([b.orderId, b.claim]).toEqual([a.orderId, a.claim]);
        const c = created(await dev.order({ ...start, idempotencyKey: "k".repeat(15) }));
        const d = created(await dev.order({ ...start, idempotencyKey: "k".repeat(15) }));
        expect(d.orderId).not.toBe(c.orderId);
    });

    it("refuses other terms under a used key or orderId", async () => {
        const dev = requiring(clock);
        const a = created(await dev.order({ ...start, idempotencyKey: key16 }));
        expect(await dev.order({ ...start, amountMicros: 60_000, idempotencyKey: key16 })).toEqual({
            status: "refused",
            orderId: a.orderId,
            reason: "idempotency_conflict",
        });
        expect(await dev.order({ ...start, packageId: "small-30m", orderId: a.orderId })).toEqual({
            status: "refused",
            orderId: a.orderId,
            reason: "terms_mismatch",
        });
        expect(await dev.order({ orderId: a.orderId, claim: a.claim!, handleSha256 })).toEqual({
            status: "refused",
            orderId: a.orderId,
            reason: "terms_mismatch",
        });
    });

    it("answers an unpaid order with its pay link and no claim, until 15 minutes pass", async () => {
        const dev = requiring(clock);
        const a = created(await dev.order(start));
        const again = await dev.order({ ...start, orderId: a.orderId });
        expect(again).toEqual(
            expect.objectContaining({ status: "payment_required", orderId: a.orderId }),
        );
        expect(again).not.toHaveProperty("claim");
        expect(await dev.order({ orderId: a.orderId, claim: a.claim! })).not.toHaveProperty(
            "claim",
        );
        clock.now += devUnpaidTtlMs;
        const expired = { status: "refused", orderId: a.orderId, reason: "order_expired" };
        expect(await dev.order({ orderId: a.orderId, claim: a.claim! })).toEqual(expired);
        expect(await dev.order({ ...start, orderId: a.orderId })).toEqual(expired);
    });

    it("is paid at its pay link and redeems only with the claim", async () => {
        const dev = requiring(clock);
        const a = created(await dev.order(start));
        expect(dev.pay(a.orderId)).toEqual({
            status: 200,
            body: { paid: true, orderId: a.orderId },
        });
        expect(await dev.order({ ...start, orderId: a.orderId })).toEqual({
            status: "refused",
            orderId: a.orderId,
            reason: "paid_claim_required",
        });
        expect(await dev.order({ orderId: a.orderId, claim: "x".repeat(43) })).toEqual({
            status: "refused",
            orderId: a.orderId,
            reason: "claim_mismatch",
        });
        const r = await dev.order({ orderId: a.orderId, claim: a.claim! });
        expect(r).toEqual({
            status: "paid",
            orderId: a.orderId,
            orderToken: expect.stringMatching(/^v1\./),
            payer: "dev",
            kind: "start",
            packageId: "small-10m",
            amountMicros: 50_000,
        });
        expect(tokenClaims((r as { orderToken: string }).orderToken).expires_at).toBe(
            "2026-11-05T12:10:00.000Z",
        );
    });

    it("gives the identical token on a repeat redeem until it expires", async () => {
        const dev = requiring(clock);
        const a = created(await dev.order(start));
        dev.pay(a.orderId);
        const first = await dev.order({ orderId: a.orderId, claim: a.claim! });
        clock.now += 60_000;
        expect(await dev.order({ orderId: a.orderId, claim: a.claim! })).toEqual(first);
        clock.now = testNow + 600_000;
        expect(await dev.order({ orderId: a.orderId, claim: a.claim! })).toEqual({
            status: "refused",
            orderId: a.orderId,
            reason: "token_expired",
        });
    });

    it("redeems with a payment whose memo names the order, without the claim", async () => {
        const dev = requiring(clock);
        const a = created(await dev.order(start));
        const payment = { accepted: { extra: { memo: a.orderId } } };
        expect(await dev.order({ ...start, payment })).toEqual(
            expect.objectContaining({ status: "paid", orderId: a.orderId }),
        );
        expect(dev.status(a.orderId).body.state).toBe("paid");
    });

    it("makes a new order for a payment without an order memo and ignores the payment", async () => {
        const dev = requiring(clock);
        const r = created(
            await dev.order({ ...start, payment: { accepted: { extra: { memo: "x" } } } }),
        );
        expect(r.claim).toMatch(claimPattern);
        expect(dev.status(r.orderId).body.state).toBe("unpaid");
    });

    it("refuses a payment without an order memo on a replay, and one for another order", async () => {
        const dev = requiring(clock);
        const a = created(await dev.order({ ...start, idempotencyKey: key16 }));
        // Port §2, a memo-less payment on an idempotency replay is checked against that order
        expect(
            await dev.order({
                ...start,
                idempotencyKey: key16,
                payment: { accepted: { extra: {} } },
            }),
        ).toEqual({ status: "refused", orderId: a.orderId, reason: "payment_order_mismatch" });
        expect(dev.status(a.orderId).body.state).toBe("unpaid");
        // As Payments' pay route, which checks the memo of any payment for an unpaid order
        expect(
            await dev.order({ ...start, orderId: a.orderId, payment: { accepted: { extra: {} } } }),
        ).toEqual({ status: "refused", orderId: a.orderId, reason: "payment_order_mismatch" });
        expect(dev.status(a.orderId).body.state).toBe("unpaid");
        const elsewhere = { accepted: { extra: { memo: `ord_${"c".repeat(26)}` } } };
        expect(await dev.order({ ...start, orderId: a.orderId, payment: elsewhere })).toEqual({
            status: "refused",
            orderId: a.orderId,
            reason: "payment_order_mismatch",
        });
    });

    it("settles a payment before it checks a claim sent beside it (port §2)", async () => {
        const dev = requiring(clock);
        const a = created(await dev.order(start));
        const payment = { accepted: { extra: { memo: a.orderId } } };
        // The gateway's types never send both, Payments still answers them in this order
        const both = {
            orderId: a.orderId,
            claim: "x".repeat(43),
            payment,
            idempotencyKey: key16,
        } as unknown as OrderRequest;
        expect(await dev.order(both)).toEqual({
            status: "refused",
            orderId: a.orderId,
            reason: "claim_mismatch",
        });
        expect(dev.status(a.orderId).body.state).toBe("paid");
        expect(await dev.order({ ...start, orderId: a.orderId, payment })).toEqual({
            status: "refused",
            orderId: a.orderId,
            reason: "paid_claim_required",
        });
        expect(
            await dev.order({ ...start, orderId: a.orderId, payment, idempotencyKey: key16 }),
        ).toEqual(expect.objectContaining({ status: "paid", orderId: a.orderId }));
    });

    it("gives the token to the claim, or a payment shown under its key (port §2)", async () => {
        const dev = requiring(clock);
        const a = created(await dev.order(start));
        const first = { accepted: { extra: { memo: a.orderId } }, payload: { tx: "one" } };
        const other = { accepted: { extra: { memo: a.orderId } }, payload: { tx: "two" } };
        const paid = await dev.order({ ...start, payment: first, idempotencyKey: key16 });
        expect(paid).toEqual(expect.objectContaining({ status: "paid", orderId: a.orderId }));
        const refusedAgain = {
            status: "refused",
            orderId: a.orderId,
            reason: "paid_claim_required",
        };
        expect(await dev.order({ ...start, payment: other, idempotencyKey: key16 })).toEqual(
            refusedAgain,
        );
        expect(await dev.order({ ...start, payment: first })).toEqual(refusedAgain);
        expect(
            await dev.order({ ...start, payment: first, idempotencyKey: "j".repeat(16) }),
        ).toEqual(refusedAgain);
        expect(await dev.order({ ...start, payment: first, idempotencyKey: key16 })).toEqual(paid);
        expect(await dev.order({ orderId: a.orderId, claim: a.claim! })).toEqual(paid);
        // A payment that paid under no key has no key to show again
        const c = created(await dev.order(start));
        const unkeyed = { accepted: { extra: { memo: c.orderId } }, payload: { tx: "three" } };
        expect(await dev.order({ ...start, payment: unkeyed })).toEqual(
            expect.objectContaining({ status: "paid", orderId: c.orderId }),
        );
        expect(await dev.order({ ...start, payment: unkeyed })).toEqual({
            status: "refused",
            orderId: c.orderId,
            reason: "paid_claim_required",
        });
        const b = created(await dev.order(start));
        dev.pay(b.orderId);
        expect(
            await dev.order({ ...start, payment: { accepted: { extra: { memo: b.orderId } } } }),
        ).toEqual({ status: "refused", orderId: b.orderId, reason: "paid_claim_required" });
    });

    it("refuses an orderId or memo it does not know", async () => {
        const dev = requiring(clock);
        const memo = `ord_${"a".repeat(26)}`;
        expect(await dev.order({ ...start, payment: { accepted: { extra: { memo } } } })).toEqual({
            status: "refused",
            orderId: memo,
            reason: "order_unknown",
        });
        expect(await dev.order({ orderId: `ord_${"b".repeat(26)}`, claim })).toEqual({
            status: "refused",
            orderId: `ord_${"b".repeat(26)}`,
            reason: "order_unknown",
        });
    });

    it("keeps an extend order's handle in its paid answer and token", async () => {
        const dev = requiring(clock);
        const a = created(await dev.order(extend));
        dev.pay(a.orderId);
        const r = await dev.order({ orderId: a.orderId, claim: a.claim!, handleSha256 });
        expect(r).toEqual(
            expect.objectContaining({ status: "paid", kind: "extend", handleSha256 }),
        );
        expect(tokenClaims((r as { orderToken: string }).orderToken).handle_sha256).toBe(
            handleSha256,
        );
    });

    it("answers the pay link and status routes", async () => {
        const dev = requiring(clock);
        const unknown = { status: 404, body: { error: "order_unknown" } };
        expect(dev.pay("ord_none")).toEqual(unknown);
        expect(dev.status("ord_none")).toEqual(unknown);
        const a = created(await dev.order(start));
        expect(dev.status(a.orderId)).toEqual({
            status: 200,
            body: { orderId: a.orderId, state: "unpaid", expiresAt: "2026-11-05T12:15:00.000Z" },
        });
        clock.now += devUnpaidTtlMs;
        expect(dev.pay(a.orderId)).toEqual({
            status: 410,
            body: { error: "order_expired", orderId: a.orderId },
        });
        expect(dev.status(a.orderId).body.state).toBe("expired");
    });

    it("shows a redeemed order as paid", async () => {
        const dev = requiring(clock);
        const a = created(await dev.order(start));
        dev.pay(a.orderId);
        await dev.order({ orderId: a.orderId, claim: a.claim! });
        expect(dev.status(a.orderId).body.state).toBe("paid");
        expect(dev.pay(a.orderId)).toEqual({
            status: 200,
            body: { paid: true, orderId: a.orderId },
        });
    });
});

describe("paymentsFor", () => {
    it("puts dev pay links on public_url's origin and calls Payments otherwise", async () => {
        const dev = paymentsFor(
            testConfig(
                'public_url = "http://127.0.0.1:8787/base"\n' +
                    '[payments]\nmode = "dev"\ndev_require_payment = true',
            ),
        );
        expect(dev).toBeInstanceOf(DevPayments);
        expect((dev as DevPayments).requiresPayment).toBe(true);
        const r = await dev.order(start, AbortSignal.timeout(5_000));
        expect((r as AwaitingPayment).payUrl).toMatch(
            /^http:\/\/127\.0\.0\.1:8787\/o\/ord_[a-z2-7]{26}$/,
        );
        const off = paymentsFor(testConfig('[payments]\nmode = "dev"'));
        expect((off as DevPayments).requiresPayment).toBe(false);
        expect(paymentsFor(testConfig('[payments]\nurl = "http://127.0.0.1:8450"')).mode).toBe(
            "http",
        );
    });
});
