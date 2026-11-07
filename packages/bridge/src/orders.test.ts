import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    afterPaymentText,
    orderKey,
    orderStatus,
    PaidOrders,
    paidOrderTtlMs,
    spentOrderText,
    spentRefusals,
    unpaidText,
    withAfterPayment,
} from "./orders.ts";
import type { PaymentStep } from "./pay.ts";
import { testHandle } from "./testing/harness.ts";

const claim = "Ab3_".repeat(10) + "xY-";
const orderId = "ord_abcdefghijklmnopqrstuvwxyz";
const step: PaymentStep = {
    tool: "bugnet_start",
    orderId,
    claim,
    payUrl: `https://pay.bugnet.sh/o/${orderId}`,
    amountMicros: 50_000,
};
const sig = () => AbortSignal.timeout(5_000);

it("keys a start by package and an extend by sandbox and package", () => {
    expect(orderKey("bugnet_start", { quoteId: "q", packageId: "small-10m" })).toBe(
        "start\0small-10m",
    );
    expect(orderKey("bugnet_extend", { handle: testHandle, packageId: "small-10m" })).toBe(
        `extend\0${testHandle}\0small-10m`,
    );
    expect(orderKey("bugnet_start", {})).toBeNull();
    expect(orderKey("bugnet_extend", { packageId: "small-10m" })).toBeNull();
    expect(orderKey("bugnet_status", { packageId: "small-10m" })).toBeNull();
});

it("holds a paid or unsure order for 30 minutes and an order it tried for as long", () => {
    let now = 1_000;
    const orders = new PaidOrders(() => now);
    orders.see("start\0small-10m", step);
    expect(orders.step(step.orderId)).toEqual(step);
    expect(orders.heldFor("start\0small-10m")).toBeUndefined();
    orders.markTried(step.orderId);
    orders.markPaid(step.orderId, "paid");
    expect(orders.tried(step.orderId)).toBe(true);
    expect(orders.heldFor("start\0small-10m")).toEqual({ ...step, state: "paid" });
    now += paidOrderTtlMs - 1;
    expect(orders.heldFor("start\0small-10m")?.state).toBe("paid");
    now += 1;
    expect(orders.heldFor("start\0small-10m")).toBeUndefined();
    expect(orders.step(step.orderId)).toBeUndefined();
    expect(orders.tried(step.orderId)).toBe(false);
    orders.see("start\0small-10m", step);
    orders.markPaid(step.orderId, "unknown");
    orders.drop(step.orderId);
    expect(orders.heldFor("start\0small-10m")).toBeUndefined();
    expect(paidOrderTtlMs).toBe(1_800_000);
});

it("holds a pay in flight and forgets an order without forgetting it was tried", async () => {
    const orders = new PaidOrders(() => 1_000);
    const k = "start\0small-10m";
    orders.see(k, step);
    const flight = Promise.resolve("done");
    orders.markPaying(step.orderId, flight);
    expect(orders.heldFor(k)).toEqual({ ...step, state: "paying" });
    expect(orders.flight(step.orderId)).toBe(flight);
    orders.forget(step.orderId);
    expect(orders.heldFor(k)).toBeUndefined();
    expect(orders.tried(step.orderId)).toBe(true);
    expect(orders.step(step.orderId)).toEqual(step);
});

describe("orderStatus", () => {
    const seen: { path: string; accept: string | undefined }[] = [];
    const answers: Record<string, [number, unknown]> = {
        "/o/ord_paid/status": [
            200,
            { orderId: "ord_paid", state: "paid", expiresAt: "2026-11-05T12:15:00.000Z" },
        ],
        "/o/ord_none/status": [404, { error: "order_unknown" }],
        "/o/ord_500/status": [500, { error: "internal" }],
        "/o/ord_429/status": [429, { error: "too_many_requests" }],
        "/o/ord_odd/status": [200, { orderId: "ord_odd", state: "odd" }],
    };
    let server: Server;
    let origin = "";
    beforeAll(async () => {
        server = createServer((req, res) => {
            const path = req.url ?? "";
            seen.push({ path, accept: req.headers.accept });
            const [status, body] = answers[path] ?? [404, { error: "order_unknown" }];
            res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("reads the public status route", async () => {
        expect(await orderStatus(origin, "ord_paid", sig())).toBe("paid");
        expect(seen[0]).toEqual({ path: "/o/ord_paid/status", accept: "application/json" });
        expect(await orderStatus(origin, "ord_none", sig())).toBeNull();
        await expect(orderStatus(origin, "ord_500", sig())).rejects.toThrow(
            "order status answered 500",
        );
        await expect(orderStatus(origin, "ord_429", sig())).rejects.toThrow(
            "order status answered 429",
        );
        await expect(orderStatus(origin, "ord_odd", sig())).rejects.toThrow(
            "order status answered 200",
        );
        await expect(orderStatus("http://127.0.0.1:9", "ord_paid", sig())).rejects.toThrow();
    });
});

it("says a paid order's id and claim and never to pay again", () => {
    expect(afterPaymentText({ tool: "bugnet_start", orderId: "ord_x", claim })).toBe(
        ` Order ord_x is paid: call bugnet_start again with orderId "ord_x" and claim "${claim}" ` +
            "to use it, and never pay it again.",
    );
    expect(spentOrderText({ orderId: "ord_x", claim })).toBe(
        ` Order ord_x (claim "${claim}") can no longer be used. If it was paid, it is refunded ` +
            "automatically, so do not pay it again.",
    );
    expect([...spentRefusals].sort()).toEqual([
        "claim_mismatch",
        "order_closed",
        "order_expired",
        "order_unknown",
        "payment_late",
        "terms_mismatch",
        "token_expired",
    ]);
});

it("words each unpaid outcome", () => {
    const s = {
        tool: "bugnet_start" as const,
        orderId: "ord_x",
        claim,
        payUrl: "https://pay.bugnet.sh/o/ord_x",
    };
    expect(unpaidText("timeout", s)).toBe(
        "Order ord_x is not paid yet. Once the user pays at https://pay.bugnet.sh/o/ord_x, call " +
            `bugnet_start again with orderId "ord_x" and claim "${claim}".`,
    );
    expect(unpaidText("expired", s)).toBe(
        "Order ord_x expired before it was paid, so nothing " +
            "was charged. Call bugnet_start again for a new order.",
    );
    expect(unpaidText("closed", s)).toBe(
        "Order ord_x is closed: its payment was refunded or is " +
            "being checked by hand. Tell the user before paying again.",
    );
    expect(unpaidText("unknown_order", s)).toBe(
        "Order ord_x is unknown to the payment page. " + "Call bugnet_start again for a new order.",
    );
});

it("appends the paid order's line to an error result's text and message", () => {
    const r = withAfterPayment(
        {
            isError: true,
            content: [{ type: "text", text: "start failed." }],
            structuredContent: { message: "start failed." },
        },
        step,
    );
    const g7 = afterPaymentText(step);
    expect(r.content).toEqual([{ type: "text", text: `start failed.${g7}` }]);
    expect(r.structuredContent).toEqual({ message: `start failed.${g7}` });
    expect(withAfterPayment({ isError: true, content: [] }, step).content).toEqual([
        { type: "text", text: g7.trimStart() },
    ]);
    const spent = withAfterPayment(
        {
            isError: true,
            content: [{ type: "text", text: "payment refused: order_expired." }],
        },
        step,
        true,
    );
    expect(spent.content).toEqual([
        { type: "text", text: `payment refused: order_expired.${spentOrderText(step)}` },
    ]);
});
