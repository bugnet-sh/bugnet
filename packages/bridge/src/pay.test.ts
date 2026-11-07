import type { CallToolResult } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { paymentRequired } from "./payment.ts";
import {
    maxPaymentMicros,
    parsePayBody,
    payArgs,
    payEnv,
    paymentStep,
    payRefusal,
    payTimeoutMs,
    priceMicros,
    progressEveryMs,
    usdText,
} from "./pay.ts";

const claim = "Ab3_".repeat(10) + "xY-"; // 43 characters
const orderId = "ord_abcdefghijklmnopqrstuvwxyz";

function stepResult(over: Record<string, unknown> = {}, isError = true): CallToolResult {
    const required = {
        x402Version: 2,
        accepts: [{ scheme: "exact", amount: "50000", payTo: "P", extra: { memo: orderId } }],
    };
    return {
        isError,
        content: [{ type: "text", text: JSON.stringify(required) }],
        structuredContent: {
            ...required,
            message: "pay",
            orderId,
            claim,
            payUrl: `https://pay.bugnet.sh/o/${orderId}`,
            ...over,
        },
    };
}

describe("pay helpers", () => {
    it("starts pay with the origin, mainnet and the largest price as flags", () => {
        expect(payArgs("https://pay.bugnet.sh", 50_000)).toEqual([
            "mcp",
            "--allow-origin",
            "https://pay.bugnet.sh",
            "--allow-network",
            "mainnet",
            "--max-payment",
            "$0.05",
        ]);
        expect(maxPaymentMicros([50_000])).toBe(50_000);
        expect(maxPaymentMicros([50_000, 120_000, 10])).toBe(120_000);
        expect(() => maxPaymentMicros([])).toThrow(RangeError);
    });

    it("waits 300 s for pay and sends a progress note every 5 s (handoff 3540)", () => {
        expect([payTimeoutMs, progressEveryMs]).toEqual([300_000, 5_000]);
    });

    it("gives pay no PAY_ variable and no NO_DNA", () => {
        const env = {
            HOME: "/h",
            PATH: "/bin",
            PAY_SECRET: "s",
            pay_force_elicitation: "1",
            NO_DNA: "1",
            GONE: undefined,
        };
        expect(payEnv(env)).toEqual({ HOME: "/h", PATH: "/bin" });
    });

    it("writes exact dollar amounts", () => {
        expect([50_000, 1_000_000, 5_003_000, 1, 0, 1_234_567].map(usdText)).toEqual([
            "$0.05",
            "$1.00",
            "$5.003",
            "$0.000001",
            "$0.00",
            "$1.234567",
        ]);
    });

    it("reads confirmPriceUsd as exact micros", () => {
        expect(priceMicros("0.05")).toBe(50_000);
        expect(priceMicros("$0.05")).toBe(50_000);
        expect(priceMicros("1")).toBe(1_000_000);
        for (const bad of ["0.0500001", "abc", "", "-1", 0.05, undefined]) {
            expect(priceMicros(bad), String(bad)).toBeNull();
        }
    });

    it("reads a v2 payment step of the two paid tools only", () => {
        expect(paymentStep("bugnet_start", stepResult())).toEqual({
            tool: "bugnet_start",
            orderId,
            claim,
            payUrl: `https://pay.bugnet.sh/o/${orderId}`,
            amountMicros: 50_000,
        });
        expect(paymentStep("bugnet_extend", stepResult())?.tool).toBe("bugnet_extend");
        expect(paymentStep("bugnet_redeem", stepResult())).toBeNull();
        expect(paymentStep("bugnet_start", stepResult({}, false))).toBeNull();
        expect(paymentStep("bugnet_start", stepResult({ claim: claim.slice(1) }))).toBeNull();
        expect(paymentStep("bugnet_start", stepResult({ claim: undefined }))).toBeNull();
        expect(paymentStep("bugnet_start", stepResult({ payUrl: "not a url" }))).toBeNull();
        expect(paymentStep("bugnet_start", stepResult({ orderId: "ord/../x" }))).toBeNull();
        expect(
            paymentStep("bugnet_start", stepResult({ accepts: [{ amount: "5e4" }] })),
        ).toBeNull();
    });

    it("refuses a link off the origin, off the order's path, naming another memo or above the price", () => {
        const step = paymentStep("bugnet_start", stepResult())!;
        const required = paymentRequired(stepResult())!;
        const origin = "https://pay.bugnet.sh";
        expect(payRefusal(step, origin, 50_000, required)).toBeNull();
        expect(
            payRefusal(
                { ...step, payUrl: `https://pay.evil.example/o/${orderId}` },
                origin,
                50_000,
                required,
            ),
        ).toBe("origin");
        expect(
            payRefusal({ ...step, payUrl: `${origin}/o/ord_other` }, origin, 50_000, required),
        ).toBe("path");
        const otherMemo = { ...required, accepts: [{ amount: "50000", extra: { memo: "ord_x" } }] };
        expect(payRefusal(step, origin, 50_000, otherMemo)).toBe("memo");
        const noMemo = { ...required, accepts: [{ amount: "50000" }] };
        expect(payRefusal(step, origin, 50_000, noMemo)).toBeNull();
        expect(payRefusal(step, origin, 49_999, required)).toBe("price");
        expect(payRefusal(step, origin, null, required)).toBe("price");
    });

    it("finds the answer body in pay's curl text", () => {
        const paid = { paid: true, orderId };
        expect(parsePayBody(JSON.stringify(paid))).toEqual(paid);
        expect(
            parsePayBody(
                `HTTP/1.1 200 OK\ncontent-type: application/json\n\n${JSON.stringify(paid)}`,
            ),
        ).toEqual(paid);
        expect(parsePayBody(JSON.stringify({ status: 200, body: JSON.stringify(paid) }))).toEqual(
            paid,
        );
        expect(
            parsePayBody(JSON.stringify({ status: 402, body: { refused: "order_expired" } })),
        ).toEqual({ refused: "order_expired" });
        expect(parsePayBody("Touch ID was cancelled")).toBeNull();
        expect(parsePayBody("[1,2]")).toBeNull();
    });
});
