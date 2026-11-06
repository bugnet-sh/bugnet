import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlacementState, type ExtendPlacementRequest } from "../gen/bugnet/router/v1/router_pb.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    packageOption,
    placement,
    routerError,
    testDeps,
    testHandle,
    testNow,
    testPayments,
    type RouterImpl,
    type TestPayments,
} from "../testing/harness.ts";
import { handleHash, type Deps } from "./common.ts";

const more = packageOption("more-10m", 40_000n);
const extended = placement(PlacementState.READY, {
    deadline: timestampFromMs(testNow + 20 * 60_000),
});

async function connect(impl: RouterImpl): Promise<{ client: Client; payments: TestPayments }> {
    const payments = testPayments();
    const deps = testDeps({ router: fakeRouter(impl), payments });
    return { client: await connectTools(deps), payments };
}

const args = (price = "0.04") => ({
    handle: testHandle,
    packageId: "more-10m",
    confirmPriceUsd: price,
});

const checked: RouterImpl = {
    checkExtendPlacement: () => ({ placement: placement(), package: more }),
    listExtensions: () => ({ options: [more] }),
};

afterEach(() => {
    vi.restoreAllMocks();
});

// A clock that runs with real time, which a step can move forward to spend the plan
function skewed(deps: Deps): { by: number } {
    const skew = { by: 0 };
    deps.now = () => Date.now() + skew.by;
    return skew;
}

describe("bugnet_extend", () => {
    it("pays for the extension and returns the new deadline", async () => {
        const applied: ExtendPlacementRequest[] = [];
        const { client, payments } = await connect({
            ...checked,
            extendPlacement: (req) => {
                applied.push(req);
                return { placement: extended };
            },
        });
        const r = await callTool<{ deadline: string; timeLeft: string; orderId: string }>(
            client,
            "bugnet_extend",
            args(),
            { toolUseId: "toolu_ext" },
        );
        expect(r.isError).toBe(false);
        expect(r.structured).toEqual({
            message: "Extended by 10 min. New deadline 2026-11-05T12:20:00.000Z, time left 20 min.",
            orderId: "toolu_ext",
            packageId: "more-10m",
            deadline: "2026-11-05T12:20:00.000Z",
            timeLeft: "20 min",
        });
        expect(payments.orders).toEqual([
            expect.objectContaining({
                kind: "extend",
                packageId: "more-10m",
                amountMicros: 40_000,
                handleSha256: handleHash(testHandle),
                idempotencyKey: "toolu_ext",
            }),
        ]);
        expect(applied).toHaveLength(1);
        expect(applied[0]?.orderToken).toBeTruthy();
    });

    it("refuses a price other than the extension's before any order", async () => {
        const { client, payments } = await connect(checked);
        const r = await callTool(client, "bugnet_extend", args("0.4"));
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "extend: more-10m costs $0.04, tell the user that price and pass it as " +
                "confirmPriceUsd.",
        );
        expect(payments.orders).toEqual([]);
    });

    it("says a retried extension order is not paid yet", async () => {
        const payments = testPayments(() => ({
            status: "payment_required",
            orderId: "ord_x",
            paymentRequired: { x402Version: 2, accepts: [{ amount: "40000" }] },
        }));
        const deps = testDeps({ router: fakeRouter(checked), payments });
        const client = await connectTools(deps);
        const first = await callTool(client, "bugnet_extend", args());
        expect(first.text).toMatch(/\nPayment required for order ord_x\. /);
        const again = await callTool(client, "bugnet_extend", { ...args(), orderId: "ord_x" });
        expect(again.isError).toBe(true);
        expect(again.text).toMatch(/\nOrder ord_x is not paid yet/);
        expect(again.text).toMatch(/call the same tool again with orderId "ord_x"/);
    });

    it("lists the options for a package that does not extend this sandbox", async () => {
        const { client } = await connect({
            ...checked,
            checkExtendPlacement() {
                throw routerError(Code.InvalidArgument);
            },
        });
        const r = await callTool(client, "bugnet_extend", { ...args(), packageId: "small-10m" });
        expect(r.text).toBe(
            "extend: small-10m does not extend this sandbox, the options are more-10m ($0.04).",
        );
    });

    it("says when an extension would pass the longest lifetime", async () => {
        const { client } = await connect({
            checkExtendPlacement() {
                throw routerError(Code.FailedPrecondition, "EXCEEDS_LIFETIME");
            },
        });
        const r = await callTool(client, "bugnet_extend", args());
        expect(r.text).toMatch(/^extend: that would pass the longest time a sandbox can run/);
    });

    it("reports NOT_READY on an ended sandbox as expired", async () => {
        const { client, payments } = await connect({
            checkExtendPlacement() {
                throw routerError(Code.FailedPrecondition, "NOT_READY");
            },
            getPlacement: () => ({ placement: placement(PlacementState.TERMINATED) }),
        });
        const r = await callTool(client, "bugnet_extend", args());
        expect(r.text).toMatch(/^extend: this sandbox has ended/);
        expect(payments.orders).toEqual([]);
    });

    it("abandons the order when the router refuses the extension outright", async () => {
        const { client, payments } = await connect({
            ...checked,
            extendPlacement() {
                throw routerError(Code.PermissionDenied, "WALLET_BLOCKED");
            },
        });
        const r = await callTool(client, "bugnet_extend", args(), { toolUseId: "toolu_x" });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/^extend: the paying wallet is blocked/);
        expect(r.text).toMatch(/not applied and the payment is refunded/);
        expect(payments.abandoned).toEqual([{ orderId: "toolu_x", reason: "not_applied" }]);
    });

    it("keeps the refund wording when the refusal is a bare NotFound", async () => {
        const { client, payments } = await connect({
            ...checked,
            extendPlacement() {
                throw routerError(Code.NotFound);
            },
            getPlacement: () => ({ placement: placement() }),
        });
        const r = await callTool(client, "bugnet_extend", args());
        expect(r.text).toMatch(/not applied and the payment is refunded/);
        expect(payments.abandoned).toHaveLength(1);
    });

    it("retries an extension whose answer was lost", async () => {
        let calls = 0;
        const { client, payments } = await connect({
            ...checked,
            extendPlacement() {
                calls += 1;
                if (calls === 1) throw routerError(Code.Unavailable);
                return { placement: extended };
            },
        });
        const r = await callTool<{ timeLeft: string }>(client, "bugnet_extend", args());
        expect(r.structured.timeLeft).toBe("20 min");
        expect(calls).toBe(2);
        expect(payments.abandoned).toEqual([]);
    });

    it("ends a stalled extension inside its plan and names the paid order", async () => {
        let calls = 0;
        const payments = testPayments();
        const deps = testDeps({
            payments,
            router: fakeRouter({
                ...checked,
                extendPlacement: async (_req, ctx) => {
                    calls += 1;
                    await new Promise((r) => ctx.signal.addEventListener("abort", r));
                    throw routerError(Code.DeadlineExceeded);
                },
            }),
        });
        const skew = skewed(deps);
        const order = payments.order.bind(payments);
        payments.order = (req, signal) => {
            skew.by += 38_500;
            return order(req, signal);
        };
        const client = await connectTools(deps);
        const started = Date.now();
        const r = await callTool(client, "bugnet_extend", args(), { toolUseId: "toolu_s" });
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(calls).toBe(1);
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "extend: the sandbox service did not confirm the extension. Check the deadline with " +
                "bugnet_status before paying again, and if it did not move, bugnet_extend with " +
                'orderId "toolu_s" applies the paid order.',
        );
        expect(payments.abandoned).toEqual([]);
    });

    it("says the order is paid when no time is left to apply it, and never sends it", async () => {
        let calls = 0;
        const payments = testPayments();
        const deps = testDeps({
            payments,
            router: fakeRouter({
                ...checked,
                extendPlacement: () => {
                    calls += 1;
                    return { placement: extended };
                },
            }),
        });
        const skew = skewed(deps);
        const order = payments.order.bind(payments);
        payments.order = (req, signal) => {
            skew.by += 40_000;
            return order(req, signal);
        };
        const client = await connectTools(deps);
        const r = await callTool(client, "bugnet_extend", args(), { toolUseId: "toolu_u" });
        expect(calls).toBe(0);
        expect(r.text).toBe(
            "extend: order toolu_u is paid, but too little time was left to apply it. " +
                'bugnet_extend with orderId "toolu_u" applies it.',
        );
        expect(payments.abandoned).toEqual([]);
    });

    it("charges nothing when the check leaves too little time to pay and apply", async () => {
        const payments = testPayments();
        const clock = { now: testNow };
        const deps = testDeps({
            payments,
            now: () => clock.now,
            router: fakeRouter({
                ...checked,
                checkExtendPlacement: () => {
                    clock.now += 30_000;
                    return { placement: placement(), package: more };
                },
            }),
        });
        const client = await connectTools(deps);
        const r = await callTool(client, "bugnet_extend", args());
        expect(r.text).toBe(
            "extend: Bugnet answered slowly, so nothing was charged. Calling bugnet_extend " +
                "again extends it.",
        );
        expect(payments.orders).toEqual([]);
    });

    it("caps the payment so ExtendPlacement keeps its reserve", async () => {
        const real = AbortSignal.timeout.bind(AbortSignal);
        const given = new WeakMap<AbortSignal, number>();
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
            const signal = real(ms);
            given.set(signal, ms);
            return signal;
        });
        const caps: (number | undefined)[] = [];
        let applyMs: number | undefined;
        const payments = testPayments();
        const clock = { now: testNow };
        const deps = testDeps({
            payments,
            now: () => clock.now,
            router: fakeRouter({
                ...checked,
                checkExtendPlacement: (_req, ctx) => {
                    caps.push(ctx.timeoutMs());
                    clock.now += 20_000;
                    return { placement: placement(), package: more };
                },
                extendPlacement: (_req, ctx) => {
                    applyMs = ctx.timeoutMs();
                    return { placement: extended };
                },
            }),
        });
        const order = payments.order.bind(payments);
        payments.order = (req, signal) => {
            caps.push(given.get(signal));
            clock.now += 3_000;
            return order(req, signal);
        };
        const client = await connectTools(deps);
        const r = await callTool(client, "bugnet_extend", args());
        expect(r.isError).toBe(false);
        expect(caps[0]).toBeGreaterThan(14_000);
        expect(caps[0]).toBeLessThanOrEqual(15_000);
        expect(caps[1]).toBe(20_000 - 8_000);
        expect(applyMs).toBeGreaterThan(16_000);
        expect(applyMs).toBeLessThanOrEqual(17_000);
    });

    it("sleeps between retries but never after the last one", async () => {
        let calls = 0;
        const { client } = await connect({
            ...checked,
            extendPlacement() {
                calls += 1;
                throw routerError(Code.Unavailable);
            },
        });
        const started = Date.now();
        const r = await callTool(client, "bugnet_extend", args());
        const took = Date.now() - started;
        expect(calls).toBe(3);
        expect(took).toBeGreaterThanOrEqual(2_900);
        expect(took).toBeLessThan(4_500);
        expect(r.text).toMatch(/^extend: the sandbox service did not confirm the extension/);
    }, 10_000);
});
