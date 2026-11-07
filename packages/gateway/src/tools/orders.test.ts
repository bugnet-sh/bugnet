import { describe, expect, it } from "vitest";
import type {
    AwaitingPayment,
    PaidAllowanceOrder,
    RefusalReason,
    RefusedOrder,
} from "../payments/port.ts";
import { testHandle } from "../testing/harness.ts";
import { handleHash } from "./common.ts";
import {
    allowanceOrderError,
    claimInput,
    paidRetry,
    paymentRequiredResult,
    refusalError,
    retryCall,
    type OrderTool,
} from "./orders.ts";

const claim = "C".repeat(43);
const allowancePaid: PaidAllowanceOrder = {
    status: "paid",
    orderId: "ord_a",
    kind: "allowance",
    handleSha256: handleHash(testHandle),
    payer: "p",
    amountMicros: 1_003_000,
    allowanceMicros: 1_000_000,
    firstUse: true,
    x402: {
        state: "open",
        fundedMicros: 1_000_000,
        spentMicros: 0,
        heldMicros: 0,
        leftMicros: 1_000_000,
        allowanceRoomMicros: 4_000_000,
        paidCalls: 0,
        pendingCalls: 0,
        spendPerMinuteMicros: 500_000,
        services: [],
    },
};
const required = { x402Version: 2, accepts: [{ amount: "50000" }] };
const payUrl = "https://pay.bugnet.sh/o/ord_2";
const step = (over: Partial<AwaitingPayment> = {}): AwaitingPayment => ({
    status: "payment_required",
    orderId: "ord_2",
    payUrl,
    paymentRequired: required,
    ...over,
});
const show = "Show the user the link, since they pay in their own browser.";
const limit =
    "The x402 maxTimeoutSeconds limits a wallet's signed payment, not the user's time to pay.";
const next =
    `Next: pay at ${payUrl} with a Solana wallet holding USDC, then call bugnet_redeem ` +
    "with orderId and claim";

describe("claimInput and paidRetry", () => {
    it("takes a claim of 43 base64url characters only", () => {
        expect(claimInput.safeParse(claim).success).toBe(true);
        for (const bad of ["a".repeat(42), "a".repeat(44), "a".repeat(42) + "+"]) {
            const r = claimInput.safeParse(bad);
            expect(r.success).toBe(false);
            expect(r.error?.issues[0]?.message).toBe(
                "the 43-character claim from the payment step",
            );
        }
    });

    it("takes orderId with a claim or a payment as a paid retry", () => {
        expect(paidRetry({ orderId: "o", claim }, undefined, true)).toEqual({
            orderId: "o",
            claim,
        });
        expect(paidRetry({ orderId: "o", claim }, { p: 1 }, true)).toEqual({
            orderId: "o",
            payment: { p: 1 },
        });
        expect(paidRetry({ orderId: "o" }, { p: 1 }, true)).toEqual({
            orderId: "o",
            payment: { p: 1 },
        });
        expect(paidRetry({ claim }, { p: 1 }, true)).toBeNull();
        expect(paidRetry({ orderId: "o", claim }, { p: 1 }, false)).toBeNull();
        expect(paidRetry({ orderId: "o", claim }, undefined, false)).toEqual({
            orderId: "o",
            claim,
        });
        expect(paidRetry({ orderId: "o" }, undefined, true)).toBeNull();
    });

    it("names bugnet_x402_budget for a paid allowance order", () => {
        const e = allowanceOrderError(allowancePaid, "start", { claim, handle: true });
        expect(e.kind).toBe("invalid");
        expect(e.fields).toEqual({ orderId: "ord_a" });
        expect(e.message).toBe(
            `start: order ord_a adds x402 allowance to a sandbox, call bugnet_x402_budget with the handle, orderId "ord_a" and claim "${claim}"`,
        );
        expect(allowanceOrderError(allowancePaid, "extend", { payment: true }).message).toBe(
            'extend: order ord_a adds x402 allowance to a sandbox, call bugnet_x402_budget with orderId "ord_a" and the claim from its payment step',
        );
    });
});

describe("paymentRequiredResult", () => {
    it("names the pay link, the claim and the quote for a new start order", () => {
        const r = paymentRequiredResult(step({ claim }), { tool: "bugnet_start", quoteId: "q3.x" });
        const guide = [
            "Payment required for order ord_2.",
            `${next} (orderId "ord_2", claim "${claim}", quoteId "q3.x").`,
            show,
            "Calling bugnet_start again without this orderId opens a new order the user would " +
                "pay again.",
            limit,
        ].join(" ");
        expect(r).toEqual({
            isError: true,
            content: [
                { type: "text", text: JSON.stringify(required) },
                { type: "text", text: guide },
            ],
            structuredContent: {
                ...required,
                message: guide,
                orderId: "ord_2",
                payUrl,
                claim,
                quoteId: "q3.x",
            },
        });
        expect(JSON.stringify(r)).not.toMatch(/x402-capable|pays automatically/);
    });

    it("names the handle for an extend order", () => {
        const r = paymentRequiredResult(step({ claim }), {
            tool: "bugnet_extend",
            withHandle: true,
        });
        expect(r.content?.[1]).toEqual({
            type: "text",
            text: [
                "Payment required for order ord_2.",
                `${next} (orderId "ord_2", claim "${claim}" and this sandbox's handle).`,
                show,
                "Calling bugnet_extend again without this orderId opens a new order the user " +
                    "would pay again.",
                limit,
            ].join(" "),
        });
        expect(r.structuredContent).not.toHaveProperty("quoteId");
    });

    it("says a redeemed order is not paid yet, with the claim the call sent", () => {
        const r = paymentRequiredResult(step(), {
            tool: "bugnet_redeem",
            sentOrderId: "ord_2",
            sentClaim: claim,
        });
        expect(r.content?.[1]).toEqual({
            type: "text",
            text: [
                "Order ord_2 is not paid yet, and a payment can take a few seconds to confirm.",
                `${next} (orderId "ord_2", claim "${claim}").`,
                show,
                limit,
            ].join(" "),
        });
        expect(r.structuredContent).toEqual(expect.objectContaining({ claim }));
    });

    it("points at the first payment step when no claim is known", () => {
        const r = paymentRequiredResult(step(), { tool: "bugnet_start", sentOrderId: "ord_2" });
        expect((r.content?.[1] as { text: string }).text).toContain(
            `${next} (orderId "ord_2" and the claim from its first payment step).`,
        );
        expect(r.structuredContent).not.toHaveProperty("claim");
    });

    it("names no quoteId it was not given", () => {
        const r = paymentRequiredResult(step({ claim }), { tool: "bugnet_start" });
        expect((r.content?.[1] as { text: string }).text).toContain(
            `${next} (orderId "ord_2", claim "${claim}").`,
        );
        expect(r.structuredContent).not.toHaveProperty("quoteId");
    });

    it("warns bugnet_x402_budget against a second order too", () => {
        const r = paymentRequiredResult(
            {
                status: "payment_required",
                orderId: "ord_a",
                claim: "c".repeat(43),
                payUrl: "https://pay.bugnet.sh/o/ord_a",
                paymentRequired: { x402Version: 2, accepts: [] },
            },
            { tool: "bugnet_x402_budget", withHandle: true },
        );
        expect((r.structuredContent as { message?: string } | undefined)?.message).toContain(
            "Calling bugnet_x402_budget again without this orderId opens a new order the user would pay again.",
        );
    });
});

describe("retryCall", () => {
    it("names what the retry carries", () => {
        expect(retryCall("bugnet_redeem", "ord_1", { claim, quoteId: "q" })).toBe(
            `bugnet_redeem with orderId "ord_1", claim "${claim}" and quoteId "q"`,
        );
        expect(retryCall("bugnet_extend", "ord_1", { claim, handle: true })).toBe(
            `bugnet_extend with the handle, orderId "ord_1" and claim "${claim}"`,
        );
        expect(retryCall("bugnet_start", "ord_1", { claim })).toBe(
            `bugnet_start with orderId "ord_1" and claim "${claim}"`,
        );
        // Port §2, a payment shown again by another call is no proof
        expect(retryCall("bugnet_start", "ord_1", { payment: true })).toBe(
            'bugnet_start with orderId "ord_1" and the claim from its payment step',
        );
        expect(retryCall("bugnet_extend", "ord_1", {})).toBe('bugnet_extend with orderId "ord_1"');
    });
});

describe("refusalError", () => {
    const refused = (reason: RefusalReason, over: Partial<RefusedOrder> = {}): RefusedOrder => ({
        status: "refused",
        orderId: "ord_1",
        reason,
        ...over,
    });

    it("tells the model to bring the claim and never pay again", () => {
        const e = refusalError(refused("paid_claim_required"), "start", "bugnet_start");
        expect([e.kind, e.message, e.fields]).toEqual([
            "precondition",
            'start: order ord_1 is already paid. Call bugnet_start again with orderId "ord_1" ' +
                "and the claim from its payment step, and do not pay it again. If the claim is " +
                "lost, the payment is refunded automatically",
            { orderId: "ord_1", refusal: "paid_claim_required" },
        ]);
    });

    it("words a wrong claim, a settling payment and other terms", () => {
        const wrong = refusalError(refused("claim_mismatch"), "redeem", "bugnet_redeem");
        expect([wrong.kind, wrong.message]).toEqual([
            "invalid",
            "redeem: that claim does not belong to order ord_1, copy the claim from its payment " +
                "step exactly",
        ]);
        const settling = refusalError(refused("settling"), "extend", "bugnet_extend");
        expect([settling.kind, settling.retryAfterMs, settling.message]).toEqual([
            "unavailable",
            3000,
            "extend: the payment for order ord_1 is still confirming. Call again with the same " +
                "orderId and claim, and do not pay again",
        ]);
        expect(
            refusalError(refused("settling", { retryAfterSeconds: 5 }), "start", "bugnet_start")
                .retryAfterMs,
        ).toBe(5000);
        // Port §2, a payment shown again by another call is no proof
        expect(
            refusalError(refused("settling"), "start", "bugnet_start", { paymentSent: true })
                .message,
        ).toBe(
            "start: the payment for order ord_1 is still confirming. Call again with the same " +
                "orderId and its claim, and do not pay again",
        );
        expect(
            refusalError(refused("terms_mismatch"), "redeem", "bugnet_redeem", { handleSent: true })
                .message,
        ).toBe(
            "redeem: order ord_1 is not for that sandbox. Check the handle, and leave it out " +
                "when the order starts a new sandbox",
        );
        const terms = refusalError(refused("terms_mismatch"), "start", "bugnet_start");
        expect([terms.kind, terms.message]).toEqual([
            "invalid",
            "start: order ord_1 is for another package or sandbox",
        ]);
    });

    it("gives a spent order's refusal a next step", () => {
        const fresh =
            "Start a new order with bugnet_start and no orderId, once the user agrees to its price";
        const check =
            "Check that the orderId was copied exactly from the payment step. If it was, ";
        const words = (reason: RefusalReason, tool: OrderTool = "bugnet_start") => {
            const e = refusalError(refused(reason), "start", tool);
            return [e.kind, e.message, e.fields];
        };
        expect(words("order_expired")).toEqual([
            "denied",
            `payment refused: order_expired. Order ord_1 can no longer be paid. ${fresh}`,
            { orderId: "ord_1", refusal: "order_expired" },
        ]);
        expect(words("order_unknown")[1]).toBe(
            `payment refused: order_unknown. ${check}order ord_1 can no longer be paid. ${fresh}`,
        );
        expect(words("order_unknown", "bugnet_redeem")[1]).toBe(
            `payment refused: order_unknown. ${check}order ord_1 can no longer be paid. Start a new ` +
                "order with bugnet_start or bugnet_extend and no orderId, once the user agrees " +
                "to its price",
        );
        expect(words("payment_late")[1]).toBe(
            "payment refused: payment_late. Order ord_1 expired before its payment landed, so " +
                `that payment is refunded automatically. Do not pay it again. ${fresh}`,
        );
        expect(words("token_expired")[1]).toBe(
            "payment refused: token_expired. Order ord_1 was already used and can no longer be " +
                "redeemed. If it was paid and never started a sandbox or added time, it is " +
                "refunded automatically, so do not pay it again",
        );
        expect(words("order_closed")[1]).toBe(
            "payment refused: order_closed. Order ord_1 is closed: its payment was refunded or " +
                "is being checked by hand. Do not pay it again, and tell the user before " +
                "starting a new order",
        );
        const none = refusalError(
            { status: "refused", reason: "order_unknown" },
            "start",
            "bugnet_start",
        );
        expect(none.message).toBe(
            `payment refused: order_unknown. ${check}this order can no longer be paid. ${fresh}`,
        );
    });

    it("asks for a retry in a few seconds while Payments cannot settle (port §2)", () => {
        for (const reason of [
            "router_unavailable",
            "rpc_unavailable",
            "settlement_unavailable",
        ] as const) {
            const e = refusalError(refused(reason), "start", "bugnet_start");
            expect([e.kind, e.message, e.retryAfterMs, e.fields], reason).toEqual([
                "unavailable",
                `payment refused: ${reason}, retry in a few seconds`,
                null,
                { orderId: "ord_1", refusal: reason },
            ]);
        }
    });

    it("points a paid extend retry on a start order to bugnet_redeem", () => {
        const e = refusalError(refused("terms_mismatch"), "extend", "bugnet_extend", {
            sentClaim: claim,
        });
        expect([e.kind, e.message, e.fields]).toEqual([
            "invalid",
            "extend: order ord_1 is not for this sandbox. If it starts a new sandbox, call " +
                `bugnet_redeem with orderId "ord_1" and claim "${claim}", plus the quoteId ` +
                "bugnet_start was called with. Otherwise check the handle",
            { orderId: "ord_1", refusal: "terms_mismatch" },
        ]);
    });

    it("keeps today's words for every other reason", () => {
        const blocked = refusalError(refused("payer_blocked"), "start", "bugnet_start");
        expect([blocked.kind, blocked.message, blocked.retryAfterMs, blocked.fields]).toEqual([
            "denied",
            "payment refused: payer_blocked",
            null,
            { orderId: "ord_1", refusal: "payer_blocked" },
        ]);
        const limited = refusalError(
            refused("payer_rate_limited", { retryAfterSeconds: 30 }),
            "start",
            "bugnet_start",
        );
        expect([limited.kind, limited.retryAfterMs]).toEqual(["rate_limited", 30_000]);
        const bare = refusalError(
            { status: "refused", reason: "bad_request" },
            "start",
            "bugnet_start",
        );
        expect(bare.fields).toEqual({ refusal: "bad_request" });
    });

    it("uses the orderId the call sent when the refusal has none", () => {
        const e = refusalError(
            { status: "refused", reason: "claim_mismatch" },
            "start",
            "bugnet_start",
            {
                sentOrderId: "ord_9",
            },
        );
        expect(e.message).toMatch(/order ord_9,/);
        expect(e.fields).toEqual({ orderId: "ord_9", refusal: "claim_mismatch" });
        const none = refusalError(
            { status: "refused", reason: "paid_claim_required" },
            "start",
            "bugnet_start",
        );
        expect(none.message).toBe("payment refused: paid_claim_required");
    });
});
