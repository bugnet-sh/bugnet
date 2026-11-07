import { Code } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
    X402ServiceState,
    type CheckX402Request,
    type EnableX402Request,
} from "../gen/bugnet/router/v1/router_pb.ts";
import type { PaidAllowanceOrder, X402Account, X402AccountService } from "../payments/port.ts";
import { withClientAddress } from "../request.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    otherPayTo,
    recordingLog,
    routerError,
    sellerFetch,
    testChatId,
    testChatLine,
    testChatUrl,
    testConfig,
    testDeps,
    testHandle,
    testNow,
    testPayTo,
    testPayments,
    testTerms,
    testTtsId,
    testTtsLine,
    testTtsUrl,
    testX402Index,
    x402Info,
    type RouterImpl,
    type SellerPrice,
    type TestPayments,
    type TestPaymentsOptions,
} from "../testing/harness.ts";
import { lineCut, payToShort, serviceId, type X402Method } from "../x402/lines.ts";
import { probeWords } from "../x402/probe.ts";
import { x402Text } from "../x402/render.ts";
import { failureText, failureWords, pinToServiceSpec, routerReasonText } from "../x402/router.ts";
import { handleHash, hashKey } from "./common.ts";
import { budgetDescription, configureRequestId } from "./x402.ts";

interface Seen {
    checks: CheckX402Request[];
    enables: EnableX402Request[];
    urls: string[];
}

async function setup(
    o: {
        payments?: TestPayments;
        router?: RouterImpl;
        prices?: Record<string, SellerPrice>;
        toml?: string;
    } = {},
) {
    const seen: Seen = { checks: [], enables: [], urls: [] };
    const clock = { now: testNow };
    const payments = o.payments ?? testPayments();
    const rec = recordingLog();
    const prices = o.prices ?? {
        [testChatUrl]: { payTo: testPayTo, amountMicros: 10_000 },
        [testTtsUrl]: { payTo: otherPayTo, amountMicros: 20_000 },
    };
    const deps = testDeps({
        config: testConfig(`[x402]\nenabled = true\n${o.toml ?? ""}`),
        router: fakeRouter({
            checkX402: (req) => {
                seen.checks.push(req);
                return {};
            },
            enableX402: (req) => {
                seen.enables.push(req);
                return {
                    services: req.add.map((s) =>
                        x402Info(
                            serviceId(s.method as X402Method, s.host, s.prefix),
                            X402ServiceState.ACTIVE,
                        ),
                    ),
                };
            },
            ...o.router,
        }),
        payments,
        log: rec.log,
        now: () => clock.now,
        x402Fetch: sellerFetch(prices, seen.urls),
        x402Index: testX402Index(),
    });
    return {
        client: await connectTools(deps),
        deps,
        payments,
        seen,
        clock,
        prices,
        lines: rec.lines,
    };
}

const args = (p: Record<string, unknown> = {}) => ({
    handle: testHandle,
    amountUsd: "1.00",
    confirmPriceUsd: "1.003",
    services: [testChatLine],
    ...p,
});
const h = handleHash(testHandle);
const claim = "c".repeat(43);
const budget = "bugnet_x402_budget";

function service(line: "chat" | "tts", state: X402AccountService["state"]): X402AccountService {
    return line === "chat"
        ? {
              serviceId: testChatId,
              method: "POST",
              host: "agent402.tools",
              prefix: "/v1/auto/",
              url: testChatUrl,
              paidPath: null,
              maxPriceMicros: 10_000,
              payTo: testPayTo,
              listed: "indexed",
              state,
          }
        : {
              serviceId: testTtsId,
              method: "POST",
              host: "tts.example.com",
              prefix: "/v1/",
              url: testTtsUrl,
              paidPath: "/v1/speech",
              maxPriceMicros: 20_000,
              payTo: otherPayTo,
              listed: "unlisted",
              state,
          };
}

function accountOf(services: X402AccountService[], patch: Partial<X402Account> = {}): X402Account {
    return {
        state: "open",
        fundedMicros: 1_000_000,
        spentMicros: 0,
        heldMicros: 0,
        leftMicros: 1_000_000,
        allowanceRoomMicros: 4_000_000,
        paidCalls: 0,
        pendingCalls: 0,
        spendPerMinuteMicros: 500_000,
        services,
        ...patch,
    };
}

function paidOrder(x402: X402Account, patch: Partial<PaidAllowanceOrder> = {}): PaidAllowanceOrder {
    return {
        status: "paid",
        orderId: "ord_paid",
        kind: "allowance",
        handleSha256: h,
        payer: "dev",
        amountMicros: 1_003_000,
        allowanceMicros: 1_000_000,
        firstUse: false,
        x402,
        ...patch,
    };
}

function withAccount(x402: X402Account | null, feeDue = false, opts: TestPaymentsOptions = {}) {
    return testPayments(undefined, {
        ...opts,
        x402: { ...opts.x402, account: async () => ({ x402, feeDue }) },
    });
}

describe("bugnet_x402_budget", () => {
    it("registers only with [x402] enabled, as a paid, approved, deferred tool", async () => {
        const off = await connectTools(testDeps());
        expect((await off.listTools()).tools.map((t) => t.name)).not.toContain(budget);
        const { client } = await setup();
        const t = (await client.listTools()).tools.find((x) => x.name === budget);
        expect(t?.title).toBe("Fund x402 calls in a Bugnet sandbox (paid)");
        expect(t?.annotations).toEqual({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true,
        });
        expect(t?._meta).toEqual({ "anthropic/requiresUserInteraction": true });
        expect(t?.description).toBe(budgetDescription);
        const props = t?.inputSchema.properties as Record<string, { description?: string }>;
        expect(
            Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.description])),
        ).toEqual({
            handle: undefined,
            amountUsd:
                "Allowance to add, at least 0.10 and up to 5.00 in all for the sandbox, or 0 to re-price, disable or change the minute limit only",
            confirmPriceUsd:
                "The total you told the user, charged now and shown in the approval prompt: amountUsd, plus 0.003 on the sandbox's first allowance, or 0",
            services:
                "Services to enable or re-price, each line from bugnet_x402_find or bugnet_status",
            allowUnlisted: "true only when the user agreed to a service Bugnet has not reviewed",
            disable: "Service ids to stop paying",
            spendPerMinuteUsd: "New spending limit a minute, 0.01 to 5.00",
            orderId: "orderId from an earlier payment step",
            claim: "claim from an earlier payment step, as bugnet_extend takes it",
            payment: undefined,
        });
        expect(budgetDescription).toBe(
            "Paid. Adds USDC to this sandbox's x402 allowance and enables pay-per-call API services that code in the sandbox may pay from it, or changes those services and the spending limit. Only call it after the user agreed, in this conversation, to each service, its price per call, the amount and the total charged. A new service always needs an amount of at least 0.10, so the user approves it in their wallet. Copy service lines from bugnet_x402_find or bugnet_status; to re-price, change only max=. Set allowUnlisted only when the user agreed to a service Bugnet has not reviewed. Bugnet reads the traffic to these hosts to pay for it. Unspent money of $0.01 or more goes back to the paying wallet when the sandbox ends. Returns the allowance and services, or a payment step to complete first.",
        );
    });

    it("refuses a claim without its orderId before any call", async () => {
        const { client, payments, seen } = await setup();
        const r = await callTool(client, budget, args({ claim }));
        expect(r.isError).toBe(true);
        expect(r.text).toContain("claim goes with the orderId of its payment step");
        expect(payments.orders).toEqual([]);
        expect(seen.checks).toEqual([]);
        expect(seen.urls).toEqual([]);
    });

    it("refuses a service line copied with extra characters before any call", async () => {
        const { client, payments, seen } = await setup();
        for (const line of [
            `${testChatLine} `,
            `${testChatLine}\n`,
            testChatLine.replace(" max=", " max="),
            `"${testChatLine}"`,
        ]) {
            const r = await callTool(client, budget, args({ services: [line] }));
            expect(r.isError).toBe(true);
            expect(r.text).toContain(
                "a service line from bugnet_x402_find or bugnet_status; to re-price, change only max=",
            );
        }
        expect(payments.orders).toEqual([]);
        expect(seen.checks).toEqual([]);
        expect(seen.urls).toEqual([]);
    });

    it("funds a first allowance with the fee, enables its services and waits for them", async () => {
        const { client, payments, seen } = await setup();
        const r = await callTool(client, budget, args(), { toolUseId: "toolu_budget_0001" });
        expect(r.isError).toBe(false);
        expect(payments.orders[0]).toEqual({
            kind: "allowance",
            packageId: "x402-allowance",
            amountMicros: 1_003_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            description: "Bugnet x402 $1.00 + $0.003 fee: agent402.tools/v1/auto/ up to $0.01",
            handleSha256: h,
            x402: {
                services: [
                    expect.objectContaining({
                        serviceId: testChatId,
                        maxPriceMicros: 10_000,
                        payTo: testPayTo,
                        listed: "indexed",
                        pinnedFrom: "probe",
                        probe: expect.objectContaining({ status: 402 }),
                    }),
                ],
            },
            idempotencyKey: "toolu_budget_0001",
        });
        expect(seen.checks[0]).toEqual(
            expect.objectContaining({
                handle: testHandle,
                disable: [],
                add: [
                    expect.objectContaining({
                        host: "agent402.tools",
                        prefix: "/v1/auto/",
                        maxPriceMicros: 10_000n,
                        payTo: testPayTo,
                        indexed: true,
                        paidPath: "",
                    }),
                ],
            }),
        );
        expect(seen.enables[0]).toEqual(
            expect.objectContaining({
                handle: testHandle,
                waitActive: true,
                requestId: "toolu_budget_0001",
                disable: [],
            }),
        );
        expect(seen.enables[0]?.add).toHaveLength(1);
        expect(r.structured).toEqual(
            expect.objectContaining({
                handle: testHandle,
                orderId: "toolu_budget_0001",
                firstUse: true,
                x402: expect.objectContaining({ paidInUsd: "$1.00", feeDue: false }),
            }),
        );
        expect(r.text).toContain(
            "x402 for this sandbox: $1.00 paid in, $0.00 spent, $0.00 settling, $1.00 left.",
        );
        expect(r.text).toContain(`: active. Service line: ${testChatLine}`);
    });

    it("charges the fee once per sandbox", async () => {
        const { client, payments } = await setup();
        expect((await callTool(client, budget, args())).isError).toBe(false);
        const top = args({ amountUsd: "0.50", confirmPriceUsd: "0.50", services: undefined });
        expect((await callTool(client, budget, top)).isError).toBe(false);
        expect(payments.orders[1]).toEqual(
            expect.objectContaining({
                feeMicros: 0,
                amountMicros: 500_000,
                allowanceMicros: 500_000,
                description: "Bugnet x402 $0.50",
            }),
        );
        const r = await callTool(client, budget, { ...top, confirmPriceUsd: "0.503" });
        expect(r.text).toBe(
            "x402: this charges $0.50. Tell the user that total and pass it as confirmPriceUsd.",
        );
        expect(payments.orders).toHaveLength(2);
    });

    it("checks the confirmed price before any probe or charge", async () => {
        const { client, payments, seen } = await setup();
        const r = await callTool(client, budget, args({ confirmPriceUsd: "1.00" }));
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "x402: this charges $1.003: $1.00 of allowance plus a one-time $0.003 fee that covers the refund. Tell the user that total and pass it as confirmPriceUsd.",
        );
        expect(seen.urls).toEqual([]);
        expect(seen.checks).toEqual([]);
        expect(payments.orders).toEqual([]);
    });

    it("accepts either price on a resend that carries a payment", async () => {
        const { client, payments } = await setup({ payments: withAccount(null, false) });
        await callTool(client, budget, args({ payment: { x402Version: 2 } }));
        expect(payments.orders[0]).toEqual(
            expect.objectContaining({
                feeMicros: 3_000,
                amountMicros: 1_003_000,
                payment: { x402Version: 2 },
            }),
        );
        expect(payments.orders[0]).not.toHaveProperty("claim");
        await callTool(
            client,
            budget,
            args({ confirmPriceUsd: "1.00", payment: { x402Version: 2 } }),
        );
        expect(payments.orders[1]).toEqual(
            expect.objectContaining({ feeMicros: 0, amountMicros: 1_000_000 }),
        );
        const wrong = await callTool(
            client,
            budget,
            args({ confirmPriceUsd: "1.01", payment: { x402Version: 2 } }),
        );
        expect(wrong.text).toBe(
            "x402: this charges $1.00. Tell the user that total and pass it as confirmPriceUsd.",
        );
        expect(payments.orders).toHaveLength(2);
    });

    it("passes the payment step through with the claim and the budget sentence", async () => {
        const { client } = await setup({
            payments: testPayments(undefined, { requirePayment: true }),
        });
        const r = await callTool<{ claim: string; orderId: string }>(client, budget, args());
        expect(r.isError).toBe(true);
        expect(r.structured.claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const id = r.structured.orderId;
        expect(r.text).toContain(
            `then call bugnet_redeem with orderId and claim (orderId "${id}", claim "${r.structured.claim}" and this sandbox's handle).`,
        );
        expect(r.text).toContain(
            "Calling bugnet_x402_budget again without this orderId opens a new order the user would pay again.",
        );
    });

    it("answers a paid retry from the stored order, skipping the price, probes and CheckX402", async () => {
        const { client, payments, seen, prices } = await setup({
            payments: testPayments(undefined, { requirePayment: true }),
        });
        const first = await callTool<{ claim: string; orderId: string }>(client, budget, args());
        const { orderId, claim: given } = first.structured;
        payments.dev.pay(orderId);
        (prices[testChatUrl] as SellerPrice).payTo = otherPayTo;
        const urls = seen.urls.length;
        const checks = seen.checks.length;
        const r = await callTool(
            client,
            budget,
            args({ orderId, claim: given, confirmPriceUsd: "9.99" }),
            { toolUseId: "toolu_r" },
        );
        expect(r.isError).toBe(false);
        expect(payments.orders[1]).toEqual({
            orderId,
            claim: given,
            handleSha256: h,
            idempotencyKey: "toolu_r",
        });
        expect(seen.urls).toHaveLength(urls);
        expect(seen.checks).toHaveLength(checks);
        expect(seen.enables[0]?.waitActive).toBe(true);
        expect(seen.enables[0]?.add.map((s) => s.host)).toEqual(["agent402.tools"]);
        expect(r.structured).toEqual(expect.objectContaining({ orderId, firstUse: true }));
    });

    it("enables only the view's enabled services on a paid retry and keeps disabled ones disabled", async () => {
        const third = {
            ...service("chat", "unreliable"),
            serviceId: serviceId("POST", "third.example.com", "/v1/"),
            host: "third.example.com",
            prefix: "/v1/",
            url: "https://third.example.com/v1/run",
        };
        const view = accountOf([service("chat", "enabled"), service("tts", "disabled"), third]);
        const { client, seen } = await setup({
            payments: testPayments(() => paidOrder(view)),
        });
        const r = await callTool(client, budget, args({ orderId: "ord_paid", claim }));
        expect(r.isError).toBe(false);
        expect(seen.enables[0]?.add).toEqual([
            expect.objectContaining(pinToServiceSpec(service("chat", "enabled"))),
        ]);
        expect(seen.enables[0]?.add).toHaveLength(1);
        expect(seen.enables[0]?.disable).toEqual([testTtsId]);
    });

    it("tells the model to call again when a paid retry cannot read the terms", async () => {
        const { client, payments } = await setup({
            payments: testPayments(undefined, {
                x402: { terms: () => Promise.reject(new Error("down")) },
            }),
        });
        const r = await callTool(client, budget, args({ orderId: "ord_paid", claim }));
        expect(r.text).toBe(
            `x402: order ord_paid is paid, but Bugnet could not reach its payment service to apply it. Call bugnet_x402_budget with the handle, orderId "ord_paid" and claim "${claim}" in a minute.`,
        );
        expect(payments.orders).toEqual([]);
    });

    it("tells the model to call again when a paid retry cannot reach Payments", async () => {
        const { client } = await setup({
            payments: testPayments(() => Promise.reject(new Error("down"))),
        });
        const r = await callTool(client, budget, args({ orderId: "ord_paid", claim }));
        expect(r.text).toBe(
            `x402: order ord_paid is paid, but Bugnet could not reach its payment service to apply it. Call bugnet_x402_budget with the handle, orderId "ord_paid" and claim "${claim}" in a minute.`,
        );
        expect(r.text).not.toContain("Nothing was charged");
    });

    it("still sends a paid retry when the terms say off", async () => {
        const view = accountOf([service("chat", "enabled")]);
        const { client, payments, seen } = await setup({
            payments: testPayments(() => paidOrder(view), { terms: { enabled: false } }),
        });
        const r = await callTool(client, budget, args({ orderId: "ord_paid", claim }));
        expect(r.isError).toBe(false);
        expect(seen.enables).toHaveLength(1);
        const off = await callTool(client, budget, args());
        expect(off.text).toBe(
            "x402: Bugnet's pay-per-call APIs are switched off right now. Nothing was charged.",
        );
        expect(payments.orders).toHaveLength(1);
    });

    it("redeems by the claim once a payment resend gets paid_claim_required", async () => {
        const view = accountOf([service("chat", "enabled")]);
        const { client, payments } = await setup({
            payments: testPayments((req) =>
                req.payment !== undefined
                    ? { status: "refused", orderId: "ord_paid", reason: "paid_claim_required" }
                    : paidOrder(view),
            ),
        });
        const r = await callTool(
            client,
            budget,
            args({ orderId: "ord_paid", claim, payment: { x402Version: 2 } }),
            { toolUseId: "toolu_claimed01" },
        );
        expect(r.isError).toBe(false);
        expect(payments.orders).toEqual([
            {
                orderId: "ord_paid",
                payment: { x402Version: 2 },
                handleSha256: h,
                idempotencyKey: "toolu_claimed01",
            },
            { orderId: "ord_paid", claim, handleSha256: h, idempotencyKey: "toolu_claimed01" },
        ]);
    });

    it("names no amount when a paid retry is refused at the paid check", async () => {
        for (const sent of [{ claim }, { payment: { x402Version: 2 } }]) {
            const { client } = await setup({
                payments: testPayments(() => ({
                    status: "refused",
                    orderId: "ord_paid",
                    reason: "allowance_ceiling",
                    refundPending: true,
                })),
            });
            const r = await callTool(
                client,
                budget,
                args({ orderId: "ord_paid", confirmPriceUsd: "9.99", ...sent }),
            );
            expect(r.text).toBe(
                "x402: the payment would pass Bugnet's x402 limits, so it is refunded in full to the paying wallet within 10 minutes and nothing was enabled.",
            );
        }
    });

    it("answers unreachable terms before anything is charged", async () => {
        const { client, payments, seen } = await setup({
            payments: testPayments(undefined, {
                x402: { terms: () => Promise.reject(new Error("down")) },
            }),
        });
        const r = await callTool(client, budget, args());
        expect(r.text).toBe(
            "x402: Bugnet could not reach its payment service, so nothing was charged. Try again in a minute.",
        );
        expect(payments.orders).toEqual([]);
        expect(seen.urls).toEqual([]);
        const account = await setup({
            payments: testPayments(undefined, {
                x402: { account: () => Promise.reject(new Error("down")) },
            }),
        });
        expect((await callTool(account.client, budget, args())).text).toBe(r.text);
    });

    it("says nothing was charged only when an order that failed carried no payment", async () => {
        const down = () =>
            setup({ payments: testPayments(() => Promise.reject(new Error("down"))) });
        const plain = await down();
        expect((await callTool(plain.client, budget, args())).text).toBe(
            "x402: Bugnet could not reach its payment service, so nothing was charged. Try again in a minute.",
        );
        expect(plain.seen.enables).toEqual([]);
        const paid = await down();
        const r = await callTool(paid.client, budget, args({ payment: { x402Version: 2 } }));
        expect(r.isError).toBe(true);
        expect(r.text).not.toContain("nothing was charged");
        expect(paid.seen.enables).toEqual([]);
    });

    it("refuses an unlisted service without the flag and enables it with the flag", async () => {
        const { client, seen } = await setup();
        const r = await callTool(client, budget, args({ services: [testTtsLine] }));
        expect(r.text).toBe(
            "x402: tts.example.com is not reviewed by Bugnet. Enable it only if the user agreed to an unreviewed service, with allowUnlisted true.",
        );
        const ok = await callTool(
            client,
            budget,
            args({ services: [testTtsLine], allowUnlisted: true }),
        );
        expect(ok.isError).toBe(false);
        expect(seen.checks[0]?.add[0]).toEqual(
            expect.objectContaining({ paidPath: "/v1/speech", indexed: false }),
        );
        expect(ok.text).toContain("paid only on /v1/speech");
    });

    it("refuses a live payTo change before payment", async () => {
        const { client, payments, prices } = await setup();
        (prices[testChatUrl] as SellerPrice).payTo = otherPayTo;
        const r = await callTool(client, budget, args());
        expect(r.text).toBe(
            `x402: agent402.tools now pays a different address (${payToShort(otherPayTo)}) than the one the user approved (${payToShort(testPayTo)}). Run bugnet_x402_find again and ask the user before enabling it.`,
        );
        expect(payments.orders).toEqual([]);
    });

    it("refuses amount 0 with a new service or a new payTo", async () => {
        const { client, payments } = await setup();
        const free = { amountUsd: "0", confirmPriceUsd: "0" };
        expect((await callTool(client, budget, args(free))).text).toBe(
            "x402: this sandbox has no allowance yet. Pass amountUsd, such as 1.00, with the services.",
        );
        expect((await callTool(client, budget, args())).isError).toBe(false);
        const tts = await callTool(
            client,
            budget,
            args({ ...free, services: [testTtsLine], allowUnlisted: true }),
        );
        expect(tts.text).toBe(
            "x402: adding tts.example.com, or changing who it pays, needs an allowance payment of at least $0.10, so the user approves it in their wallet. Pass amountUsd, such as 0.50, with the service line, and the total as confirmPriceUsd.",
        );
        const repin = await callTool(
            client,
            budget,
            args({
                ...free,
                services: [testChatLine.replace(testPayTo, otherPayTo)],
                allowUnlisted: true,
            }),
        );
        expect(repin.text).toBe(
            x402Text.needsPayment("x402", { terms: testTerms(), host: "agent402.tools" }) + ".",
        );
        const charged = await callTool(
            client,
            budget,
            args({ ...free, confirmPriceUsd: "0.50", services: undefined }),
        );
        expect(charged.text).toBe(
            "x402: this charges $0.00. Tell the user that total and pass it as confirmPriceUsd.",
        );
        expect(payments.configures).toEqual([]);
    });

    it("re-prices for free when only max= changed, probing again past the cache", async () => {
        const one = await setup();
        expect((await callTool(one.client, budget, args())).isError).toBe(false);
        one.clock.now += 121_000;
        const reprice = args({
            amountUsd: "0",
            confirmPriceUsd: "0",
            services: [testChatLine.replace("max=0.01", "max=0.02")],
        });
        const r = await callTool(one.client, budget, reprice);
        expect(r.isError).toBe(false);
        expect(one.payments.orders).toHaveLength(1);
        expect(one.payments.configures[0]?.setup.services?.[0]?.maxPriceMicros).toBe(20_000);
        expect(one.seen.urls.filter((u) => u === testChatUrl)).toHaveLength(2);
        expect(r.text).toContain("at most $0.02 a call");
        expect(r.structured).toEqual(expect.objectContaining({ firstUse: false }));
        expect(r.structured).not.toHaveProperty("orderId");

        const two = await setup();
        expect((await callTool(two.client, budget, args())).isError).toBe(false);
        two.clock.now += 121_000;
        (two.prices[testChatUrl] as SellerPrice).payTo = otherPayTo;
        const moved = await callTool(two.client, budget, reprice);
        expect(moved.text).toBe(
            x402Text.payToChanged("x402", {
                host: "agent402.tools",
                livePayTo: otherPayTo,
                linePayTo: testPayTo,
            }) + ".",
        );
        expect(two.payments.configures).toEqual([]);
    });

    it("makes the 5.8 changes with the calls 5.8 names", async () => {
        const { client, payments, seen } = await setup();
        expect((await callTool(client, budget, args())).isError).toBe(false);
        const more = await callTool(
            client,
            budget,
            args({ amountUsd: "2.00", confirmPriceUsd: "2.00", services: undefined }),
        );
        expect(more.isError).toBe(false);
        expect(payments.orders[1]).toEqual(
            expect.objectContaining({
                amountMicros: 2_000_000,
                allowanceMicros: 2_000_000,
                feeMicros: 0,
            }),
        );
        const free = { amountUsd: "0", confirmPriceUsd: "0", services: undefined };
        const rate = await callTool(client, budget, args({ ...free, spendPerMinuteUsd: "2.00" }));
        expect(rate.isError).toBe(false);
        expect(payments.configures[0]?.setup).toEqual({ spendPerMinuteMicros: 2_000_000 });
        expect(rate.text).toContain("Spending is capped at $2.00 a minute.");
        const stop = await callTool(client, budget, args({ ...free, disable: [testChatId] }));
        expect(stop.isError).toBe(false);
        expect(payments.configures[1]?.setup).toEqual({ disable: [testChatId] });
        expect(seen.enables.at(-1)?.disable).toEqual([testChatId]);
        expect(seen.enables.at(-1)?.add).toEqual([]);
        expect(stop.text).not.toContain("agent402.tools/v1/auto/ at most");
        const tts = await callTool(
            client,
            budget,
            args({
                amountUsd: "0.50",
                confirmPriceUsd: "0.50",
                services: [testTtsLine],
                allowUnlisted: true,
            }),
        );
        expect(tts.isError).toBe(false);
        expect(payments.orders[2]).toEqual(
            expect.objectContaining({
                allowanceMicros: 500_000,
                x402: { services: [expect.objectContaining({ serviceId: testTtsId })] },
            }),
        );
        expect(payments.orders).toHaveLength(3);
    });

    it("sends configure the tool-use id or a fresh random id", async () => {
        const { client, payments } = await setup();
        expect((await callTool(client, budget, args())).isError).toBe(false);
        const free = args({ amountUsd: "0", confirmPriceUsd: "0", services: undefined });
        await callTool(client, budget, free, { toolUseId: "toolu_configure01" });
        expect(payments.configures[0]?.requestId).toBe("toolu_configure01");
        await callTool(client, budget, free);
        await callTool(client, budget, free);
        const [a, b] = [payments.configures[1]?.requestId, payments.configures[2]?.requestId];
        expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(b).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(a).not.toBe(b);
        await callTool(client, budget, free, { toolUseId: "toolu_short0001" });
        expect(payments.configures[3]?.requestId).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(payments.configures[3]?.requestId).not.toBe("toolu_short0001");
        const ctx = (id: unknown) =>
            ({ mcpReq: { _meta: { "claudecode/toolUseId": id } } }) as unknown as Parameters<
                typeof configureRequestId
            >[0];
        expect(configureRequestId(ctx("t".repeat(128)))).toBe("t".repeat(128));
        expect(configureRequestId(ctx("t".repeat(129)))).toHaveLength(22);
    });

    it("refuses the ceilings with their texts", async () => {
        const nothingSent = (s: Awaited<ReturnType<typeof setup>>) => {
            expect(s.payments.orders).toEqual([]);
            expect(s.payments.configures).toEqual([]);
        };
        const refuse = async (
            text: string,
            a: Record<string, unknown>,
            payments?: TestPayments,
        ) => {
            const s = await setup(payments ? { payments } : {});
            const r = await callTool(s.client, budget, args(a));
            expect(r.isError).toBe(true);
            expect(r.text).toBe(text);
            nothingSent(s);
        };
        const chatOnly = accountOf([service("chat", "enabled")]);
        await refuse(
            "x402: $2.00 would bring this sandbox's allowance to $5.50, past the $5.00 limit for one sandbox. At most $1.50 more can be added.",
            { amountUsd: "2.00", confirmPriceUsd: "2.00" },
            withAccount({ ...chatOnly, allowanceRoomMicros: 1_500_000 }),
        );
        await refuse(
            "x402: this sandbox has reached its $5.00 allowance limit ($0.05 is left, under the $0.10 minimum order). Add the user's key with bugnet_secret_link, or start a new sandbox.",
            { amountUsd: "0.50", confirmPriceUsd: "0.50" },
            withAccount({ ...chatOnly, allowanceRoomMicros: 50_000 }),
        );
        await refuse(
            `x402: amountUsd is at least $0.10, or "0" to re-price, disable or change the minute limit only.`,
            { amountUsd: "0.05", confirmPriceUsd: "0.053" },
        );
        const high = testChatLine.replace("max=0.01", "max=0.6");
        await refuse(
            `x402: max= in "${lineCut(high)}" is above $0.50, the most Bugnet pays a call. Lower max= to 0.50 or less, with the user's yes.`,
            { services: [high] },
        );
        const five = [1, 2, 3, 4, 5].map((i) => ({
            ...service("tts", "enabled"),
            serviceId: serviceId("POST", `s${i}.example.com`, "/v1/"),
            host: `s${i}.example.com`,
            url: `https://s${i}.example.com/v1/run`,
        }));
        await refuse(
            "x402: a sandbox takes at most 5 services. Disable one first, bugnet_status lists their ids.",
            { confirmPriceUsd: "1.00" },
            withAccount(accountOf(five)),
        );
        await refuse("x402: spendPerMinuteUsd is between $0.01 and $5.00.", {
            spendPerMinuteUsd: "5.01",
        });
        await refuse(
            "x402: spendPerMinuteUsd $0.10 is under agent402.tools's $0.20 a call, so no call to it could ever be paid. Raise the limit to at least $0.20, or lower that service's max=, with the user's yes.",
            { services: [testChatLine.replace("max=0.01", "max=0.20")], spendPerMinuteUsd: "0.10" },
        );
        await refuse(
            "x402: the wallet cannot show this many new services in one payment, so nothing was charged. Enable at most 1 new services in this call, then add the rest with another bugnet_x402_budget call.",
            { services: [testChatLine, testTtsLine], allowUnlisted: true },
            testPayments(undefined, { terms: { maxNewServicesPerOrder: 1 } }),
        );
        await refuse(
            "x402: spendPerMinuteUsd $0.30 is under agent402.tools's $0.40 a call, so no call to it could ever be paid. Raise the limit to at least $0.40, or lower that service's max=, with the user's yes.",
            {
                amountUsd: "0",
                confirmPriceUsd: "0",
                services: undefined,
                spendPerMinuteUsd: "0.30",
            },
            withAccount(accountOf([{ ...service("chat", "enabled"), maxPriceMicros: 400_000 }])),
        );
    });

    it("renders each router reason of CheckX402 with its words and the host the router names", async () => {
        const two = args({
            services: [testChatLine, testTtsLine],
            allowUnlisted: true,
            amountUsd: "1.00",
            confirmPriceUsd: "1.003",
        });
        const refusing = async (err: Error, a = two) => {
            const s = await setup({
                router: {
                    checkX402: () => {
                        throw err;
                    },
                },
            });
            const r = await callTool(s.client, budget, a);
            expect(r.isError).toBe(true);
            expect(s.payments.orders).toEqual([]);
            expect(s.payments.configures).toEqual([]);
            return r.text;
        };
        const perService: [string, Code][] = [
            ["HOST_REFUSED", Code.InvalidArgument],
            ["HOST_NOT_ALLOWED", Code.FailedPrecondition],
            ["HOST_IN_USE", Code.FailedPrecondition],
            ["PREFIX_REFUSED", Code.InvalidArgument],
            ["SERVICE_DUPLICATE", Code.InvalidArgument],
            ["METHOD_REFUSED", Code.InvalidArgument],
            ["PRICE_REFUSED", Code.InvalidArgument],
            ["PAYTO_REFUSED", Code.InvalidArgument],
            ["SOMETHING_NEW", Code.InvalidArgument],
        ];
        for (const [reason, code] of perService) {
            const text = await refusing(
                routerError(code, reason, {
                    metadata: { service_id: testTtsId, host: "tts.example.com" },
                }),
            );
            expect(text).toBe(
                `x402: tts.example.com cannot be enabled (${routerReasonText(reason)}). Nothing was charged.`,
            );
            expect(text).not.toContain("agent402.tools");
        }
        expect(routerReasonText("SOMETHING_NEW")).toBe("Bugnet's rule SOMETHING_NEW");
        expect(await refusing(routerError(Code.ResourceExhausted, "TOO_MANY_SECRETS"))).toBe(
            "x402: agent402.tools, tts.example.com cannot be enabled (the sandbox already routes 32 hosts). Nothing was charged.",
        );
        expect(await refusing(routerError(Code.FailedPrecondition, "X402_DISABLED"))).toBe(
            x402Text.switchedOff("x402", {}) + ".",
        );
        expect(await refusing(routerError(Code.FailedPrecondition, "FEATURE_UNAVAILABLE"))).toBe(
            x402Text.notCapable("x402", {}) + ".",
        );
        expect(await refusing(routerError(Code.FailedPrecondition, "NOT_READY"))).toBe(
            x402Text.ended("x402", {}) + ".",
        );

        let refuse: Error | null = null;
        const s = await setup({
            router: {
                checkX402: () => {
                    if (refuse) throw refuse;
                    return {};
                },
            },
        });
        expect((await callTool(s.client, budget, args())).isError).toBe(false);
        refuse = routerError(Code.NotFound, "SERVICE_UNKNOWN", {
            metadata: { service_id: testChatId },
        });
        const r = await callTool(
            s.client,
            budget,
            args({
                amountUsd: "0",
                confirmPriceUsd: "0",
                services: undefined,
                disable: [testChatId],
            }),
        );
        expect(r.text).toBe(
            "x402: Bugnet cannot make this change (no service with that id in this sandbox). Nothing was charged.",
        );
        expect(s.payments.orders).toHaveLength(1);
        expect(s.payments.configures).toEqual([]);
    });

    it("renders each failure code of a FAILED service with its words", async () => {
        for (const code of [...Object.keys(failureWords), "OTHER"]) {
            const { client } = await setup({
                router: {
                    enableX402: () => ({
                        services: [
                            x402Info(testChatId, X402ServiceState.FAILED, { failureReason: code }),
                        ],
                    }),
                },
            });
            const r = await callTool(client, budget, args());
            expect(r.isError).toBe(false);
            expect(r.text).toContain(
                `: failed, ${failureText(code)}. Service line: ${testChatLine}`,
            );
        }
    });

    it("renders a row still applying after the wait as usable within a few seconds", async () => {
        const { client } = await setup({
            router: {
                enableX402: () => ({
                    services: [x402Info(testChatId, X402ServiceState.APPLYING)],
                }),
            },
        });
        const r = await callTool(client, budget, args());
        expect(r.text).toContain(
            `: applying, usable within a few seconds. Service line: ${testChatLine}`,
        );
    });

    it("gives the free-retry text when EnableX402 fails after the payment", async () => {
        const failing = async (err: Error, a = args()) => {
            const s = await setup({
                router: {
                    enableX402: () => {
                        throw err;
                    },
                },
            });
            return (await callTool(s.client, budget, a)).text;
        };
        expect(await failing(routerError(Code.Unavailable))).toBe(
            "x402: the allowance is paid ($1.00), but the services were not enabled yet. Call bugnet_status with the handle; it finishes enabling them at no charge.",
        );
        expect(await failing(routerError(Code.FailedPrecondition, "NOT_READY"))).toBe(
            "x402: the sandbox ended before the payment of $1.003 was applied, so it is refunded in full to the paying wallet within 10 minutes.",
        );
        // NOT_READY under another code is no ended sandbox
        expect(await failing(routerError(Code.InvalidArgument, "NOT_READY"))).toBe(
            "x402: the allowance is paid ($1.00), but the services were not enabled yet. Call bugnet_status with the handle; it finishes enabling them at no charge.",
        );
        const view = accountOf([service("chat", "enabled")]);
        const s = await setup({
            payments: testPayments(() => paidOrder(view)),
            router: {
                enableX402: () => {
                    throw routerError(Code.FailedPrecondition, "NOT_READY");
                },
            },
        });
        const retry = await callTool(s.client, budget, args({ orderId: "ord_paid", claim }));
        expect(retry.text).toBe(
            "x402: the sandbox ended before the payment of $1.003 was applied, so it is refunded in full to the paying wallet within 10 minutes.",
        );
    });

    it("words an EnableX402 failure after a free change as the router's refusal", async () => {
        let fail = false;
        const s = await setup({
            router: {
                enableX402: (req) => {
                    if (fail) throw routerError(Code.FailedPrecondition, "NOT_READY");
                    return {
                        services: req.add.map((x) =>
                            x402Info(
                                serviceId(x.method as X402Method, x.host, x.prefix),
                                X402ServiceState.ACTIVE,
                            ),
                        ),
                    };
                },
            },
        });
        expect((await callTool(s.client, budget, args())).isError).toBe(false);
        fail = true;
        const r = await callTool(
            s.client,
            budget,
            args({ amountUsd: "0", confirmPriceUsd: "0", services: undefined }),
        );
        expect(r.text).toBe(x402Text.ended("x402", {}) + ".");
    });

    it("uses hashKey for EnableX402's request_id when the tool-use id cannot be one", async () => {
        for (const id of ["t".repeat(200), "toolu_ü0000000000"]) {
            const { client, seen } = await setup();
            await callTool(client, budget, args(), { toolUseId: id });
            expect(seen.enables[0]?.requestId).toBe(
                hashKey(["x402-budget", testHandle, testChatLine]),
            );
        }
    });

    it("maps Payments refusals to the S 5.3 texts", async () => {
        const refused = async (set: (p: TestPayments) => void) => {
            const s = await setup();
            set(s.payments);
            return (await callTool(s.client, budget, args())).text;
        };
        expect(
            await refused((p) =>
                p.dev.x402.refuseNextOrder({
                    reason: "pin_refused",
                    serviceId: testChatId,
                    pinReason: "payee_no_usdc_account",
                }),
            ),
        ).toBe(
            `x402: Bugnet cannot pay agent402.tools (${probeWords.payee_no_usdc_account}). Nothing was charged. Pick another service from bugnet_x402_find.`,
        );
        expect(
            await refused((p) =>
                p.dev.x402.refuseNextOrder({ reason: "allowance_ceiling", refundPending: true }),
            ),
        ).toBe(
            "x402: the payment of $1.003 would pass Bugnet's x402 limits, so it is refunded in full to the paying wallet within 10 minutes and nothing was enabled.",
        );
        expect(
            await refused((p) =>
                p.dev.x402.refuseNextOrder({ reason: "x402_paused", charged: false }),
            ),
        ).toBe(x402Text.paused("x402", {}) + ".");
        expect(await refused((p) => p.dev.x402.refuseNextOrder({ reason: "sandbox_ended" }))).toBe(
            x402Text.ended("x402", {}) + ".",
        );
        const s = await setup();
        expect((await callTool(s.client, budget, args())).isError).toBe(false);
        s.payments.dev.x402.refuseNextConfigure({ reason: "idempotency_conflict" });
        const r = await callTool(
            s.client,
            budget,
            args({ amountUsd: "0", confirmPriceUsd: "0", services: undefined }),
        );
        expect(r.text).toBe(x402Text.idempotencyConflict("x402", {}) + ".");
        expect(s.seen.enables).toHaveLength(1);
    });

    it("shows the first-use text exactly once per wallet", async () => {
        const { client } = await setup();
        const first = await callTool(client, budget, args());
        expect(first.text.startsWith("First x402 allowance for this wallet.")).toBe(true);
        const second = await callTool(
            client,
            budget,
            args({ amountUsd: "0.50", confirmPriceUsd: "0.50" }),
        );
        expect(second.isError).toBe(false);
        expect(second.text).not.toContain("First x402 allowance");
        expect(second.structured).toEqual(expect.objectContaining({ firstUse: false }));
        const free = await callTool(
            client,
            budget,
            args({ amountUsd: "0", confirmPriceUsd: "0", services: undefined }),
        );
        expect(free.text).not.toContain("First x402 allowance");
        expect(free.structured).toEqual(expect.objectContaining({ firstUse: false }));
    });

    it("never shows the payer's address", async () => {
        const payer = "PayerAddr1111111111111111111111111111111111";
        const view = accountOf([service("chat", "enabled")]);
        const { client } = await setup({
            payments: testPayments(() => paidOrder(view, { payer, firstUse: true })),
        });
        const r = await callTool(client, budget, args());
        expect(r.isError).toBe(false);
        expect(r.text).not.toContain(payer);
        expect(JSON.stringify(r.structured)).not.toContain(payer);
    });

    it("gives two calls at once their own orders, and Payments' fee check decides the second", async () => {
        // Both account reads answer only once both arrived, so each call quotes the fee
        let reads = 0;
        let release: () => void = () => {};
        const both = new Promise<void>((resolve) => (release = resolve));
        const payments = testPayments(undefined, {
            x402: {
                account: async () => {
                    reads += 1;
                    if (reads === 2) release();
                    await both;
                    return { x402: null, feeDue: true };
                },
            },
        });
        const { client } = await setup({ payments });
        const ids = ["toolu_together_a1", "toolu_together_b1"];
        const results = await Promise.all(
            ids.map((id) => callTool(client, budget, args(), { toolUseId: id })),
        );
        expect(payments.orders.map((o) => o.idempotencyKey).sort()).toEqual(ids);
        expect(payments.orders.every((o) => o.feeMicros === 3_000)).toBe(true);
        const ok = results.filter((r) => !r.isError);
        const refused = results.filter((r) => r.isError);
        expect(ok).toHaveLength(1);
        expect(refused.map((r) => r.text)).toEqual([
            "x402: this charges $1.00. Tell the user that total and pass it as confirmPriceUsd.",
        ]);
        const winner = ids[results.indexOf(ok[0] as (typeof results)[number])];
        expect(ok[0]?.structured).toEqual(expect.objectContaining({ orderId: winner }));
    });

    it("limits calls in the quote bucket", async () => {
        const { client } = await setup({ toml: "[limits]\nquote_burst = 1" });
        const call = () =>
            withClientAddress("198.51.100.4", () => callTool(client, budget, args()));
        expect((await call()).isError).toBe(false);
        expect((await call()).text).toBe(
            "x402: too many quotes and checks from this address for now. Retry after 5 s.",
        );
    });

    it("never logs a payTo, a claim or a payment", async () => {
        const { client, payments, lines } = await setup({
            payments: testPayments(undefined, { requirePayment: true }),
        });
        const first = await callTool<{ claim: string; orderId: string }>(client, budget, args());
        payments.dev.pay(first.structured.orderId);
        const retry = await callTool(
            client,
            budget,
            args({ orderId: first.structured.orderId, claim: first.structured.claim }),
        );
        expect(retry.isError).toBe(false);
        await callTool(client, budget, args({ payment: { marker: "pay-secret" } }));
        const log = lines.join("\n");
        expect(lines.some((l) => l.includes("x402 budget applied"))).toBe(true);
        expect(log).not.toContain(testPayTo);
        expect(log).not.toContain(first.structured.claim);
        expect(log).not.toContain("pay-secret");
        expect(log).not.toContain(testHandle);
    });
});
