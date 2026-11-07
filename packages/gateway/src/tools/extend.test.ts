import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlacementState, type ExtendPlacementRequest } from "../gen/bugnet/router/v1/router_pb.ts";
import type { PaidAllowanceOrder, PaidOrder } from "../payments/port.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    packageOption,
    placement,
    routerError,
    testConfig,
    testDeps,
    testHandle,
    testNow,
    devOrder,
    recordingLog,
    testPayments,
    tokenClaims,
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
const extendTerms = {
    kind: "extend",
    packageId: "more-10m",
    amountMicros: 40_000,
    description: "d",
    handleSha256: handleHash(testHandle),
} as const;

async function paidSetup(impl: RouterImpl) {
    const payments = testPayments(undefined, { requirePayment: true });
    const deps = testDeps({ router: fakeRouter(impl), payments });
    const client = await connectTools(deps);
    return { client, deps, payments, ...(await devOrder(payments, extendTerms)) };
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
            payUrl: "https://pay.bugnet.sh/o/ord_x",
            paymentRequired: { x402Version: 2, accepts: [{ amount: "40000" }] },
        }));
        const deps = testDeps({ router: fakeRouter(checked), payments });
        const client = await connectTools(deps);
        const first = await callTool(client, "bugnet_extend", args());
        expect(first.text).toMatch(/\nPayment required for order ord_x\. /);
        const again = await callTool(client, "bugnet_extend", { ...args(), orderId: "ord_x" });
        expect(again.isError).toBe(true);
        expect(again.text).toMatch(/\nOrder ord_x is not paid yet/);
        expect(again.text).toMatch(
            /then call bugnet_redeem with orderId and claim \(orderId "ord_x" and the claim from its first payment step\)\./,
        );
        expect(again.text).toMatch(/Calling bugnet_extend again without this orderId/);
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
        // The bridge reads the refusal, so it never keeps an abandoned order as paid
        expect(r.structured).toEqual({
            message: r.text,
            orderId: "toolu_x",
            refusal: "abandoned",
        });
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
        const started = performance.now();
        const r = await callTool(client, "bugnet_extend", args());
        const took = performance.now() - started;
        expect(calls).toBe(3);
        expect(took).toBeGreaterThanOrEqual(2_900);
        expect(took).toBeLessThan(4_500);
        expect(r.text).toMatch(/^extend: the sandbox service did not confirm the extension/);
    }, 10_000);

    it("extends a paid order from its stored terms without checking the price", async () => {
        let checks = 0;
        const applied: ExtendPlacementRequest[] = [];
        const { client, deps, payments, orderId, claim } = await paidSetup({
            checkExtendPlacement: () => {
                checks += 1;
                return { placement: placement(), package: more };
            },
            extendPlacement: (req) => {
                applied.push(req);
                return { placement: extended };
            },
        });
        const { log, lines } = recordingLog();
        deps.log = log;
        const r = await callTool(
            client,
            "bugnet_extend",
            { ...args("9"), orderId, claim },
            { toolUseId: "toolu_e" },
        );
        expect(r.structured).toEqual({
            message:
                "Extended with more-10m. New deadline 2026-11-05T12:20:00.000Z, time left 20 min.",
            orderId,
            packageId: "more-10m",
            deadline: "2026-11-05T12:20:00.000Z",
            timeLeft: "20 min",
        });
        expect(payments.orders).toEqual([
            { orderId, claim, handleSha256: handleHash(testHandle), idempotencyKey: "toolu_e" },
        ]);
        expect(checks).toBe(0);
        expect(tokenClaims(applied[0]?.orderToken as string).package_id).toBe("more-10m");
        expect(lines.join("\n")).not.toContain(claim);
    });

    it("with x402 on, an extend retry with orderId and a payment sends no terms", async () => {
        const applied: ExtendPlacementRequest[] = [];
        const payments = testPayments(() => ({
            status: "paid",
            orderId: "ord_p",
            orderToken: "v1.tok",
            payer: "p",
            kind: "extend",
            packageId: "small",
            amountMicros: 250_000,
            handleSha256: handleHash(testHandle),
        }));
        const deps = testDeps({
            config: testConfig("[x402]\nenabled = true\n"),
            router: fakeRouter({
                checkExtendPlacement: () => {
                    throw new Error("no check");
                },
                extendPlacement: (req) => {
                    applied.push(req);
                    return { placement: extended };
                },
            }),
            payments,
        });
        const client = await connectTools(deps);
        const r = await callTool(
            client,
            "bugnet_extend",
            { handle: testHandle, packageId: "small", confirmPriceUsd: "9.99", orderId: "ord_p" },
            { toolUseId: "toolu_p", meta: { "x402/payment": { p: 1 } } },
        );
        expect(r.isError).toBe(false);
        expect(applied).toHaveLength(1);
        expect(payments.orders).toEqual([
            {
                orderId: "ord_p",
                payment: { p: 1 },
                handleSha256: handleHash(testHandle),
                idempotencyKey: "toolu_p",
            },
        ]);
    });

    it("with x402 off, an extend payment retry sends all four terms", async () => {
        const { client, payments, orderId } = await paidSetup({
            ...checked,
            extendPlacement: () => ({ placement: extended }),
        });
        const payment = { accepted: { extra: { memo: orderId } }, payload: { tx: "late" } };
        await callTool(client, "bugnet_extend", { ...args(), orderId, payment });
        expect(payments.orders[0]).toMatchObject({
            kind: "extend",
            packageId: "more-10m",
            amountMicros: 40_000,
            orderId,
            payment,
        });
    });

    it("a paid allowance order answers bugnet_extend with the bugnet_x402_budget call", async () => {
        let extendCalls = 0;
        const payments = testPayments(() => allowancePaid);
        const deps = testDeps({
            router: fakeRouter({
                extendPlacement: () => {
                    extendCalls += 1;
                    return { placement: extended };
                },
            }),
            payments,
        });
        const client = await connectTools(deps);
        const r = await callTool(client, "bugnet_extend", {
            handle: testHandle,
            packageId: "small",
            confirmPriceUsd: "9.99",
            orderId: "ord_a",
            claim,
        });
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            `extend: order ord_a adds x402 allowance to a sandbox, call bugnet_x402_budget with the handle, orderId "ord_a" and claim "${claim}".`,
        );
        expect(r.structured).toEqual({ message: r.text, orderId: "ord_a" });
        expect(extendCalls).toBe(0);
    });

    it("abandons a paid order whose sandbox ended and says it is refunded", async () => {
        const { client, payments, orderId, claim } = await paidSetup({
            extendPlacement() {
                throw routerError(Code.FailedPrecondition, "NOT_READY");
            },
            getPlacement: () => ({ placement: placement(PlacementState.TERMINATED) }),
        });
        const r = await callTool(client, "bugnet_extend", { ...args(), orderId, claim });
        expect(r.text).toBe(
            "extend: the sandbox is not ready, bugnet_status shows its state. The extension was " +
                "not applied and the payment is refunded.",
        );
        expect(payments.abandoned).toEqual([{ orderId, reason: "not_applied" }]);
        expect(r.structured).toEqual({ message: r.text, orderId, refusal: "abandoned" });
    });

    it("redeems by the claim sent beside a payment once Payments asks for it", async () => {
        const {
            client,
            payments,
            orderId,
            claim: own,
        } = await paidSetup({
            ...checked,
            extendPlacement: () => ({ placement: extended }),
        });
        const payment = { accepted: { extra: { memo: orderId } }, payload: { tx: "late" } };
        const r = await callTool(client, "bugnet_extend", {
            ...args(),
            orderId,
            claim: own,
            payment,
        });
        expect(r.isError).toBe(false);
        expect(r.text).toMatch(/^Extended by 10 min\./);
        expect(payments.orders).toHaveLength(2);
        expect(payments.orders[0]).not.toHaveProperty("claim");
        expect(payments.orders[1]).toEqual({
            orderId,
            claim: own,
            handleSha256: handleHash(testHandle),
        });
    });

    it("points a paid retry naming a start order to bugnet_redeem", async () => {
        const { client, payments } = await paidSetup({});
        const { orderId, claim } = await devOrder(payments, {
            kind: "start",
            packageId: "small-10m",
            amountMicros: 50_000,
            description: "d",
        });
        const r = await callTool(client, "bugnet_extend", { ...args(), orderId, claim });
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            `extend: order ${orderId} is not for this sandbox. If it starts a new sandbox, call ` +
                `bugnet_redeem with orderId "${orderId}" and claim "${claim}", plus the quoteId ` +
                "bugnet_start was called with. Otherwise check the handle.",
        );
        expect(r.structured).toEqual(
            expect.objectContaining({ orderId, refusal: "terms_mismatch" }),
        );
    });

    // Skew numbers as in the stalled and unsent extension tests above
    it("names the claim when a stalled paid extension may still apply", async () => {
        let calls = 0;
        const payments = testPayments(undefined, { requirePayment: true });
        const deps = testDeps({
            payments,
            router: fakeRouter({
                extendPlacement: async (_req, ctx) => {
                    calls += 1;
                    await new Promise((r) => ctx.signal.addEventListener("abort", r));
                    throw routerError(Code.DeadlineExceeded);
                },
            }),
        });
        const { orderId, claim } = await devOrder(payments, extendTerms);
        const skew = skewed(deps);
        const order = payments.order.bind(payments);
        payments.order = (req, signal) => {
            skew.by += 38_500;
            return order(req, signal);
        };
        const client = await connectTools(deps);
        const started = Date.now();
        const stalled = await callTool(client, "bugnet_extend", { ...args(), orderId, claim });
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(calls).toBe(1);
        expect(stalled.isError).toBe(true);
        expect(stalled.text).toBe(
            "extend: the sandbox service did not confirm the extension. Check the deadline with " +
                "bugnet_status before paying again, and if it did not move, bugnet_extend with " +
                `orderId "${orderId}" and claim "${claim}" applies the paid order.`,
        );
        expect(payments.abandoned).toEqual([]);
    });

    it("names the claim when no time is left to apply a paid order", async () => {
        let calls = 0;
        const payments = testPayments(undefined, { requirePayment: true });
        const deps = testDeps({
            payments,
            router: fakeRouter({
                extendPlacement: () => {
                    calls += 1;
                    return { placement: extended };
                },
            }),
        });
        const { orderId, claim } = await devOrder(payments, extendTerms);
        const skew = skewed(deps);
        const order = payments.order.bind(payments);
        payments.order = (req, signal) => {
            skew.by += 40_000;
            return order(req, signal);
        };
        const client = await connectTools(deps);
        const unsent = await callTool(client, "bugnet_extend", { ...args(), orderId, claim });
        expect(calls).toBe(0);
        expect(unsent.text).toBe(
            `extend: order ${orderId} is paid, but too little time was left to apply it. ` +
                `bugnet_extend with orderId "${orderId}" and claim "${claim}" applies it.`,
        );
        expect(payments.abandoned).toEqual([]);
    });

    it("refuses a paid order that starts a sandbox or is for another one", async () => {
        let applied = 0;
        const router = () =>
            fakeRouter({
                extendPlacement: () => {
                    applied += 1;
                    return { placement: extended };
                },
            });
        const paidAs = (over: Partial<PaidOrder>) =>
            testPayments(() => ({
                status: "paid",
                orderId: "ord_k",
                orderToken: "t",
                payer: "P",
                kind: "extend",
                packageId: "more-10m",
                amountMicros: 40_000,
                handleSha256: handleHash(testHandle),
                ...over,
            }));
        const start = await connectTools(
            testDeps({
                router: router(),
                payments: paidAs({ kind: "start", handleSha256: undefined }),
            }),
        );
        expect(
            (await callTool(start, "bugnet_extend", { ...args(), orderId: "ord_k", claim })).text,
        ).toBe(
            'extend: order ord_k starts a new sandbox, call bugnet_redeem with orderId "ord_k" ' +
                `and claim "${claim}", plus the quoteId bugnet_start was called with.`,
        );
        const other = await connectTools(
            testDeps({ router: router(), payments: paidAs({ handleSha256: "ab".repeat(32) }) }),
        );
        expect(
            (await callTool(other, "bugnet_extend", { ...args(), orderId: "ord_k", claim })).text,
        ).toBe("extend: order ord_k is not for that sandbox, check the handle.");
        expect(applied).toBe(0);
    });

    it("checks a claim's shape and that its orderId comes with it", async () => {
        const { client, payments } = await connect(checked);
        const alone = await callTool(client, "bugnet_extend", { ...args(), claim });
        expect(alone.isError).toBe(true);
        expect(alone.text).toMatch(/claim goes with the orderId of its payment step/);
        const short = await callTool(client, "bugnet_extend", {
            ...args(),
            orderId: "ord_1",
            claim: "a".repeat(42),
        });
        expect(short.text).toMatch(/the 43-character claim from the payment step/);
        expect(payments.orders).toEqual([]);
    });
});
