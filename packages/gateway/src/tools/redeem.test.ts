import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
    PlacementState,
    X402ServiceState,
    type CreatePlacementRequest,
    type EnableX402Request,
    type ExtendPlacementRequest,
} from "../gen/bugnet/router/v1/router_pb.ts";
import type {
    OrderRequest,
    OrderResult,
    PaidAllowanceOrder,
    RefusedOrder,
    X402Account,
    X402AccountService,
} from "../payments/port.ts";
import { signQuote } from "../quote.ts";
import { GatewayError } from "../router.ts";
import {
    callTool,
    connectTools,
    devOrder,
    fakeRouter,
    placement,
    recordingLog,
    routerError,
    testChatId,
    testChatUrl,
    testConfig,
    testDeps,
    testHandle,
    testNow,
    testPayments,
    testPayTo,
    testTerms,
    testTtsId,
    testTtsUrl,
    tokenClaims,
    x402Info,
    type RouterImpl,
    type TestPayments,
} from "../testing/harness.ts";
import { x402Lines, type X402View } from "../x402/render.ts";
import { handleHash, hashKey, type Deps } from "./common.ts";

const claim = "C".repeat(43);
const startTerms = {
    kind: "start",
    packageId: "small-30m",
    amountMicros: 250_000,
    description: "d",
} as const;
const extendTerms = {
    kind: "extend",
    packageId: "more-10m",
    amountMicros: 40_000,
    description: "d",
    handleSha256: handleHash(testHandle),
} as const;

function startRouter(created: CreatePlacementRequest[]): RouterImpl {
    return {
        createPlacement: (req) => {
            created.push(req);
            return { handle: testHandle, placement: placement(PlacementState.READY) };
        },
        getPlacement: () => ({ placement: placement(PlacementState.READY) }),
    };
}

function extendRouter(applied: ExtendPlacementRequest[]): RouterImpl {
    return {
        extendPlacement: (req) => {
            applied.push(req);
            return {
                placement: placement(PlacementState.READY, {
                    deadline: timestampFromMs(testNow + 20 * 60_000),
                }),
            };
        },
        checkExtendPlacement: () => {
            throw new Error("no check on a redeem");
        },
    };
}

async function setup(
    impl: RouterImpl,
    payments: TestPayments = testPayments(undefined, { requirePayment: true }),
) {
    const { log, lines } = recordingLog();
    const deps: Deps = testDeps({ router: fakeRouter(impl), payments, log });
    return { client: await connectTools(deps), deps, payments, lines };
}

const quote = (deps: Deps) =>
    signQuote(deps.config.secrets.quoteKey, {
        requirements: { ssh: true, preview: false, gpu: false, secrets: false },
        github: false,
        estimateId: "0f8b6c2e-41d7-4a3b-9c5e-7d2a1b3c4d5e",
        expiresAt: testNow - 60_000,
    });

describe("bugnet_redeem", () => {
    it("is free and carries no approval marker", async () => {
        const { client } = await setup({});
        const tool = (await client.listTools()).tools.find((t) => t.name === "bugnet_redeem");
        expect(tool?.title).toBe("Redeem a Bugnet order (free)");
        expect(tool?._meta?.["anthropic/requiresUserInteraction"]).toBeUndefined();
        expect(tool?.annotations).toEqual({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        });
    });

    it("starts a paid start order from an expired quote with orderId and claim only", async () => {
        const created: CreatePlacementRequest[] = [];
        const { client, deps, payments, lines } = await setup(startRouter(created));
        const { orderId, claim } = await devOrder(payments, startTerms);
        const r = await callTool(
            client,
            "bugnet_redeem",
            { orderId, claim, quoteId: quote(deps) },
            { toolUseId: "toolu_red" },
        );
        expect(r.isError).toBe(false);
        expect(r.structured).toEqual(expect.objectContaining({ handle: testHandle, orderId }));
        expect(r.text).toContain(
            `Paid $0.25 USDC for this sandbox (order ${orderId}). Tell the user what it cost.`,
        );
        expect(payments.orders).toEqual([{ orderId, claim }]);
        expect(created[0]?.requirements?.ssh).toBe(true);
        expect(created[0]?.estimateId).toBe("0f8b6c2e-41d7-4a3b-9c5e-7d2a1b3c4d5e");
        expect(tokenClaims(created[0]?.orderToken as string).order_id).toBe(orderId);
        expect(lines.join("\n")).not.toContain(claim);
    });

    it("asks for the quoteId when a start order comes without it", async () => {
        const created: CreatePlacementRequest[] = [];
        const { client, payments } = await setup(startRouter(created));
        const { orderId, claim } = await devOrder(payments, startTerms);
        const r = await callTool(client, "bugnet_redeem", { orderId, claim });
        expect(r.text).toBe(
            `redeem: order ${orderId} is paid and starts a new sandbox. Call bugnet_redeem again ` +
                `with orderId "${orderId}", claim "${claim}" and quoteId, the quoteId ` +
                "bugnet_start was called with.",
        );
        // A retry by claim may follow a payment, so a client reading fields gets the order too
        expect(r.structured).toEqual({ message: r.text, orderId });
        expect(created).toEqual([]);
    });

    it("refuses a handle on a start order", async () => {
        const { client, deps, payments } = await setup(startRouter([]));
        const { orderId, claim } = await devOrder(payments, startTerms);
        const r = await callTool(client, "bugnet_redeem", {
            orderId,
            claim,
            quoteId: quote(deps),
            handle: testHandle,
        });
        const text =
            `redeem: order ${orderId} is not for that sandbox. Check the handle, and leave it ` +
            "out when the order starts a new sandbox.";
        expect(r.text).toBe(text);
        expect(r.structured).toEqual({ message: text, orderId, refusal: "terms_mismatch" });
    });

    it("extends with the right handle from the stored order", async () => {
        const applied: ExtendPlacementRequest[] = [];
        const { client, payments, lines } = await setup(extendRouter(applied));
        const { orderId, claim } = await devOrder(payments, extendTerms);
        const r = await callTool(client, "bugnet_redeem", { orderId, claim, handle: testHandle });
        expect(r.structured).toEqual({
            message:
                "Extended with more-10m. New deadline 2026-11-05T12:20:00.000Z, time left 20 min.\n" +
                `Paid $0.04 USDC more for this sandbox (order ${orderId}). Tell the user what it cost.`,
            orderId,
            packageId: "more-10m",
            deadline: "2026-11-05T12:20:00.000Z",
            timeLeft: "20 min",
        });
        expect(payments.orders).toEqual([{ orderId, claim, handleSha256: handleHash(testHandle) }]);
        expect(applied).toHaveLength(1);
        expect(lines.join("\n")).not.toContain(claim);
    });

    it("sends an extend order without a handle to bugnet_extend, the same each time", async () => {
        const applied: ExtendPlacementRequest[] = [];
        const { client, payments } = await setup(extendRouter(applied));
        const { orderId, claim } = await devOrder(payments, extendTerms);
        const text =
            `redeem: order ${orderId} is paid and adds time to a sandbox. Call bugnet_extend ` +
            "with that sandbox's handle, the same packageId and confirmPriceUsd, orderId " +
            `"${orderId}" and claim "${claim}".`;
        expect((await callTool(client, "bugnet_redeem", { orderId, claim })).text).toBe(text);
        const again = await callTool(client, "bugnet_redeem", { orderId, claim });
        expect(again.text).toBe(text);
        expect(again.structured).toEqual({ message: text, orderId });
        expect(payments.orders).toEqual([
            { orderId, claim },
            { orderId, claim },
        ]);
        expect(applied).toEqual([]);
    });

    it("refuses a handle the paid order was not made for", async () => {
        const applied: ExtendPlacementRequest[] = [];
        const other = `sbx_${"b".repeat(26)}`;
        const payments = testPayments(() => ({
            status: "paid",
            orderId: "ord_w",
            orderToken: "t",
            payer: "P",
            kind: "extend",
            packageId: "more-10m",
            amountMicros: 40_000,
            handleSha256: handleHash(other),
        }));
        const { client } = await setup(extendRouter(applied), payments);
        const r = await callTool(client, "bugnet_redeem", {
            orderId: "ord_w",
            claim: "C".repeat(43),
            handle: testHandle,
        });
        expect(r.text).toBe("redeem: order ord_w is not for that sandbox, check the handle.");
        expect(r.structured).toEqual({ message: r.text, orderId: "ord_w" });
        expect(applied).toEqual([]);
    });

    it("asks to call again while the payment is still confirming", async () => {
        const payments = testPayments(() => ({
            status: "refused",
            orderId: "ord_s",
            reason: "settling",
            retryAfterSeconds: 2,
        }));
        const { client } = await setup({}, payments);
        const r = await callTool(client, "bugnet_redeem", {
            orderId: "ord_s",
            claim: "C".repeat(43),
        });
        expect(r.text).toBe(
            "redeem: the payment for order ord_s is still confirming. Call again with the same " +
                "orderId and claim, and do not pay again. Retry after 2 s.",
        );
    });

    it("gives two clients redeeming one order the same token and the same sandbox", async () => {
        const created: CreatePlacementRequest[] = [];
        const { client, deps, payments } = await setup(startRouter(created));
        const other = await connectTools(deps);
        const { orderId, claim } = await devOrder(payments, startTerms);
        const args = { orderId, claim, quoteId: quote(deps) };
        const a = await callTool<{ handle: string }>(client, "bugnet_redeem", args);
        const b = await callTool<{ handle: string }>(other, "bugnet_redeem", args);
        expect([a.structured.handle, b.structured.handle]).toEqual([testHandle, testHandle]);
        expect(created).toHaveLength(2);
        expect(created[1]?.orderToken).toBe(created[0]?.orderToken);
        expect(payments.abandoned).toEqual([]);
    });

    it("marks an order the router refused outright as abandoned", async () => {
        const refuse = () => {
            throw routerError(Code.PermissionDenied, "WALLET_BLOCKED");
        };
        const { client, deps, payments } = await setup({
            createPlacement: refuse,
            extendPlacement: refuse,
        });
        const started = await devOrder(payments, startTerms);
        const s = await callTool(client, "bugnet_redeem", {
            ...started,
            quoteId: quote(deps),
        });
        expect(s.structured).toEqual({
            message: s.text,
            orderId: started.orderId,
            refusal: "abandoned",
        });
        const extended = await devOrder(payments, extendTerms);
        const e = await callTool(client, "bugnet_redeem", { ...extended, handle: testHandle });
        expect(e.text).toMatch(/not applied and the payment is refunded/);
        expect(e.structured).toEqual({
            message: e.text,
            orderId: extended.orderId,
            refusal: "abandoned",
        });
        expect(payments.abandoned.map((a) => a.orderId)).toEqual([
            started.orderId,
            extended.orderId,
        ]);
    });

    it("keeps orderId and claim in a bad quoteId's answer and redeems nothing", async () => {
        const { client, payments } = await setup(startRouter([]));
        const { orderId, claim } = await devOrder(payments, startTerms);
        const r = await callTool(client, "bugnet_redeem", { orderId, claim, quoteId: "q3.bad" });
        expect(r.text).toBe(
            "malformed quote id, copy it in full or call bugnet_quote again. Keep orderId " +
                `"${orderId}" and claim "${claim}" on the next bugnet_redeem, so the order is not ` +
                "paid twice.",
        );
        expect(payments.orders).toEqual([]);
    });
});

describe("bugnet_redeem while the order waits for its payment", () => {
    // Each pause moves the gateway's clock, so a wait costs no real time
    async function waiting(
        impl: RouterImpl,
        payments = testPayments(undefined, { requirePayment: true }),
    ) {
        const clock = { now: testNow };
        const sleeps: number[] = [];
        const deps = testDeps({
            router: fakeRouter(impl),
            payments,
            now: () => clock.now,
            sleep: async (ms) => {
                sleeps.push(ms);
                clock.now += ms;
            },
        });
        return { client: await connectTools(deps), deps, payments, sleeps };
    }

    // Answers each look in turn from answers, the dev ledger once they run out
    function looks(payments: TestPayments, answers: ((req: OrderRequest) => OrderResult | void)[]) {
        const order = payments.order.bind(payments);
        let n = 0;
        payments.order = async (req, signal) => {
            const given = answers[n++]?.(req);
            if (given) {
                payments.orders.push(req);
                return given;
            }
            return order(req, signal);
        };
    }

    it("waits for the payment and starts the sandbox once it lands", async () => {
        const created: CreatePlacementRequest[] = [];
        const { client, deps, payments, sleeps } = await waiting(startRouter(created));
        const { orderId, claim } = await devOrder(payments, startTerms, { paid: false });
        // The user pays while the redeem waits, before its third look
        looks(payments, [() => {}, () => {}, () => void payments.dev.pay(orderId)]);
        const r = await callTool(client, "bugnet_redeem", { orderId, claim, quoteId: quote(deps) });
        expect(r.isError).toBe(false);
        expect(r.structured).toEqual(expect.objectContaining({ handle: testHandle, orderId }));
        expect(sleeps).toEqual([5_000, 5_000]);
        expect(payments.orders).toEqual([
            { orderId, claim },
            { orderId, claim },
            { orderId, claim },
        ]);
        expect(created).toHaveLength(1);
    });

    it.each([
        ["a new sandbox", "start", 4],
        ["more time", "extend", 3],
    ] as const)(
        "says the order is not paid yet once the budget runs low, for %s",
        async (_n, kind, pauses) => {
            const { client, deps, payments, sleeps } = await waiting(startRouter([]));
            const terms = kind === "start" ? startTerms : extendTerms;
            const { orderId, claim } = await devOrder(payments, terms, { paid: false });
            const quoteId = quote(deps);
            const extra = kind === "start" ? { quoteId } : { handle: testHandle };
            const r = await callTool(client, "bugnet_redeem", { orderId, claim, ...extra });
            expect(r.isError).toBe(true);
            expect(r.text.split("\n")[1]).toBe(
                `Order ${orderId} is not paid yet, and a payment can take a few seconds to ` +
                    "confirm. Show the user its pay link only if they have not seen it: " +
                    `http://127.0.0.1:8787/o/${orderId}. The x402 maxTimeoutSeconds limits a ` +
                    "wallet's signed payment, not the user's time to pay. Call bugnet_redeem " +
                    "again with the same arguments to keep waiting, for up to 10 minutes in all.",
            );
            // A sandbox start keeps 12 s and an extension 20 s, each after a 5 s look
            expect(sleeps).toEqual(Array(pauses).fill(5_000));
            const sent =
                kind === "start"
                    ? { orderId, claim }
                    : { orderId, claim, handleSha256: handleHash(testHandle) };
            expect(payments.orders).toEqual(Array(pauses + 1).fill(sent));
            expect(payments.dev.status(orderId).body.state).toBe("unpaid");
        },
    );

    it("keeps waiting while a payment confirms and goes on once it is paid", async () => {
        const created: CreatePlacementRequest[] = [];
        const { client, deps, payments, sleeps } = await waiting(startRouter(created));
        const { orderId, claim } = await devOrder(payments, startTerms, { paid: false });
        const settling = (): OrderResult => ({
            status: "refused",
            orderId,
            reason: "settling",
            retryAfterSeconds: 2,
        });
        looks(payments, [() => {}, settling, () => void payments.dev.pay(orderId)]);
        const r = await callTool(client, "bugnet_redeem", { orderId, claim, quoteId: quote(deps) });
        expect(r.isError).toBe(false);
        expect(r.structured).toEqual(expect.objectContaining({ handle: testHandle, orderId }));
        expect(sleeps).toEqual([5_000, 5_000]);
        expect(created).toHaveLength(1);
    });

    it("answers a refusal that lands during the wait as it answers one at once", async () => {
        for (const reason of ["order_expired", "order_closed", "payment_late"] as const) {
            const refused = (): OrderResult => ({ status: "refused", orderId: "ord_w", reason });
            const atOnce = await waiting(startRouter([]), testPayments(refused));
            const later = await waiting(startRouter([]));
            looks(later.payments, [
                () => ({
                    status: "payment_required",
                    orderId: "ord_w",
                    payUrl: "https://pay.bugnet.sh/o/ord_w",
                    paymentRequired: { x402Version: 2, accepts: [] },
                }),
                refused,
            ]);
            const args = { orderId: "ord_w", claim, quoteId: quote(atOnce.deps) };
            const a = await callTool(atOnce.client, "bugnet_redeem", args);
            const b = await callTool(later.client, "bugnet_redeem", args);
            expect(b.isError).toBe(true);
            expect([b.text, b.structured]).toEqual([a.text, a.structured]);
            expect(later.sleeps).toEqual([5_000]);
        }
    });

    it("stops looking once the client gives up", async () => {
        const { client, deps, payments } = await waiting(startRouter([]));
        const { orderId, claim } = await devOrder(payments, startTerms, { paid: false });
        const giveUp = new AbortController();
        let stopped = false;
        deps.sleep = (_ms, signal) =>
            new Promise((_resolve, reject) => {
                signal?.addEventListener(
                    "abort",
                    () => {
                        stopped = true;
                        reject(signal.reason);
                    },
                    { once: true },
                );
                giveUp.abort();
            });
        const call = client.callTool(
            { name: "bugnet_redeem", arguments: { orderId, claim, quoteId: quote(deps) } },
            { signal: giveUp.signal },
        );
        await expect(call).rejects.toThrow();
        await vi.waitFor(() => expect(stopped).toBe(true));
        await new Promise((r) => setTimeout(r, 20));
        expect(payments.orders).toEqual([{ orderId, claim }]);
    });

    it("sends progress while it waits", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        try {
            const { client, deps, payments } = await waiting(startRouter([]));
            const sleep = deps.sleep!;
            deps.sleep = async (ms, signal) => {
                await sleep(ms, signal);
                vi.advanceTimersByTime(ms);
            };
            const { orderId, claim } = await devOrder(payments, startTerms, { paid: false });
            looks(payments, [() => {}, () => void payments.dev.pay(orderId)]);
            const seen: string[] = [];
            const r = await client.callTool(
                { name: "bugnet_redeem", arguments: { orderId, claim, quoteId: quote(deps) } },
                { onprogress: (p) => seen.push(p.message ?? "") },
            );
            expect(r.isError).toBeFalsy();
            expect(seen).toContain("waiting for the payment");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("bugnet_redeem when Payments cannot answer", () => {
    const unchecked = (id: string) =>
        `redeem: Bugnet could not check order ${id} right now. Call bugnet_redeem again with orderId and claim in a minute, and do not pay again.`;
    const failures: unknown[] = [
        new Error("down"),
        new DOMException("timed out", "TimeoutError"),
        new GatewayError(
            "unavailable",
            "the payment service did not answer, try again in a minute",
        ),
    ];

    it("names the order, says to call again, and never says nothing was charged", async () => {
        for (const err of failures) {
            const { client, deps } = await setup(
                {},
                testPayments(() => Promise.reject(err)),
            );
            for (const extra of [{ quoteId: quote(deps) }, { handle: testHandle }, {}]) {
                const r = await callTool(client, "bugnet_redeem", {
                    orderId: "ord_r",
                    claim,
                    ...extra,
                });
                expect(r.isError).toBe(true);
                expect(r.text).toBe(unchecked("ord_r"));
                expect(r.structured).toEqual({ message: r.text, orderId: "ord_r" });
                expect(r.text).not.toContain("othing was charged");
            }
        }
    });
});

describe("bugnet_redeem with an allowance order", () => {
    const claim = "Cl4im".padEnd(43, "x");
    const orderId = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const otherHandle = "sbx_" + "b".repeat(26);
    const chat: X402AccountService = {
        serviceId: testChatId,
        method: "POST",
        host: "agent402.tools",
        prefix: "/v1/auto/",
        url: testChatUrl,
        paidPath: null,
        maxPriceMicros: 10_000,
        payTo: testPayTo,
        listed: "indexed",
        state: "enabled",
    };
    const account: X402Account = {
        state: "open",
        fundedMicros: 1_000_000,
        spentMicros: 0,
        heldMicros: 0,
        leftMicros: 1_000_000,
        allowanceRoomMicros: 4_000_000,
        paidCalls: 0,
        pendingCalls: 0,
        spendPerMinuteMicros: 500_000,
        services: [
            chat,
            { ...chat, serviceId: "xs_b3mm6u5x36em5pdt", method: "GET", state: "disabled" },
            {
                ...chat,
                serviceId: testTtsId,
                host: "tts.example.com",
                prefix: "/v1/",
                url: testTtsUrl,
                paidPath: "/v1/speech",
                listed: "unlisted",
                state: "unreliable",
            },
        ],
    };
    const paid = (over: Partial<PaidAllowanceOrder> = {}): PaidAllowanceOrder => ({
        status: "paid",
        orderId,
        kind: "allowance",
        handleSha256: handleHash(testHandle),
        payer: "payer",
        amountMicros: 1_003_000,
        allowanceMicros: 1_000_000,
        firstUse: true,
        x402: account,
        ...over,
    });
    const enabling = (enables: EnableX402Request[], fail?: () => never): RouterImpl => ({
        enableX402: (req) => {
            enables.push(req);
            if (fail) fail();
            return { services: [x402Info(testChatId, X402ServiceState.ACTIVE)] };
        },
    });
    const allowanceSetup = async (
        payments: TestPayments = testPayments(() => paid()),
        fail?: () => never,
    ) => {
        const enables: EnableX402Request[] = [];
        return { ...(await setup(enabling(enables, fail), payments)), enables };
    };
    type Redeemed = { handle: string; orderId: string; firstUse: boolean; x402: X402View };

    it("enables an allowance order's services with wait_active", async () => {
        const { client, payments, enables, lines } = await allowanceSetup();
        const r = await callTool<Redeemed>(
            client,
            "bugnet_redeem",
            { orderId, claim, handle: testHandle },
            { toolUseId: "toolu_redeem_allowance_01" },
        );
        expect(payments.orders).toEqual([{ orderId, claim, handleSha256: handleHash(testHandle) }]);
        expect(enables).toHaveLength(1);
        const e = enables[0]!;
        expect([e.handle, e.waitActive, e.requestId]).toEqual([
            testHandle,
            true,
            "toolu_redeem_allowance_01",
        ]);
        expect(
            e.add.map((a) => [
                a.method,
                a.host,
                a.prefix,
                a.maxPriceMicros,
                a.payTo,
                a.indexed,
                a.paidPath,
            ]),
        ).toEqual([["POST", "agent402.tools", "/v1/auto/", 10_000n, testPayTo, true, ""]]);
        expect(e.disable).toEqual(["xs_b3mm6u5x36em5pdt"]);
        expect(r.isError).toBe(false);
        expect(r.structured).toEqual(
            expect.objectContaining({ handle: testHandle, orderId, firstUse: true }),
        );
        expect(r.structured.x402.services[0]?.state).toBe("active");
        expect(r.text).toContain(
            "x402 for this sandbox: $1.00 paid in, $0.00 spent, $0.00 settling, $1.00 left.",
        );
        expect(r.text.startsWith("First x402 allowance for this wallet.")).toBe(true);
        expect(r.text).toBe(
            x402Lines(r.structured.x402, { firstUse: true, terms: testTerms() }).join("\n"),
        );
        expect(lines.some((l) => l.includes(claim))).toBe(false);
    });

    it("uses a hashed request id without a tool-use id", async () => {
        const { client, enables } = await allowanceSetup();
        await callTool(client, "bugnet_redeem", { orderId, claim, handle: testHandle });
        expect(enables[0]?.requestId).toBe(hashKey(["x402-redeem", orderId]));
    });

    it("points to bugnet_x402_budget when the handle is missing", async () => {
        const { client, payments, enables } = await allowanceSetup();
        const r = await callTool(client, "bugnet_redeem", { orderId, claim });
        expect(payments.orders).toEqual([{ orderId, claim }]);
        expect(enables).toEqual([]);
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            `redeem: order ${orderId} is paid and adds x402 allowance to a sandbox. Call bugnet_x402_budget with that sandbox's handle, the same amountUsd and confirmPriceUsd, orderId "${orderId}" and claim "${claim}".`,
        );
        expect(r.structured).toEqual({ message: r.text, orderId });
    });

    it("refuses an allowance order for another sandbox", async () => {
        const { client, enables } = await allowanceSetup(
            testPayments(() => paid({ handleSha256: handleHash(otherHandle) })),
        );
        const r = await callTool(client, "bugnet_redeem", { orderId, claim, handle: testHandle });
        expect(enables).toEqual([]);
        expect(r.text).toBe(`redeem: order ${orderId} is not for that sandbox, check the handle.`);
        expect(r.structured).toEqual({ message: r.text, orderId });
    });

    it("says the order is paid when the terms cannot be read", async () => {
        const { client, payments, enables } = await allowanceSetup(
            testPayments(() => paid(), {
                x402: { terms: () => Promise.reject(new Error("down")) },
            }),
        );
        const r = await callTool(client, "bugnet_redeem", { orderId, claim, handle: testHandle });
        expect(enables).toEqual([]);
        expect(payments.abandoned).toEqual([]);
        expect(r.text).toBe(
            `x402: order ${orderId} is paid, but Bugnet could not reach its payment service to apply it. Call bugnet_redeem with the handle, orderId "${orderId}" and claim "${claim}" in a minute.`,
        );
        expect(r.text).not.toContain("Nothing was charged");
        expect(r.structured).toEqual({ message: r.text, orderId });
    });

    it("applies a paid allowance while x402 is switched off", async () => {
        const { client, enables } = await allowanceSetup(
            testPayments(() => paid(), { terms: { enabled: false } }),
        );
        const r = await callTool(client, "bugnet_redeem", { orderId, claim, handle: testHandle });
        expect(enables).toHaveLength(1);
        expect(r.isError).toBe(false);
    });

    it("says a refund follows when the sandbox ended before enabling", async () => {
        const { client, payments } = await allowanceSetup(undefined, () => {
            throw routerError(Code.FailedPrecondition, "NOT_READY");
        });
        const r = await callTool(client, "bugnet_redeem", { orderId, claim, handle: testHandle });
        expect(r.text).toBe(
            "x402: the sandbox ended before the payment of $1.003 was applied, so it is refunded in full to the paying wallet within 10 minutes.",
        );
        expect(r.structured).toEqual({ message: r.text, orderId, refusal: "sandbox_ended" });
        expect(payments.abandoned).toEqual([]);
    });

    it("says how to finish for free when enabling fails", async () => {
        const freeRetry =
            "x402: the allowance is paid ($1.00), but the services were not enabled yet. Call bugnet_status with the handle; it finishes enabling them at no charge.";
        const fails = [
            routerError(Code.Unavailable),
            // NOT_READY under another code is no ended sandbox
            routerError(Code.InvalidArgument, "NOT_READY"),
        ];
        for (const err of fails) {
            const { client, payments } = await allowanceSetup(undefined, () => {
                throw err;
            });
            const r = await callTool(client, "bugnet_redeem", {
                orderId,
                claim,
                handle: testHandle,
            });
            expect(r.text).toBe(freeRetry);
            // No refusal word, so the bridge keeps the order
            expect(r.structured).toEqual({ message: r.text, orderId });
            expect(payments.abandoned).toEqual([]);
        }
    });

    it("words a paid allowance Payments refused after payment with the x402 rows", async () => {
        const refusing = (r: RefusedOrder) => allowanceSetup(testPayments(() => r));
        const ceiling = await refusing({
            status: "refused",
            orderId,
            reason: "allowance_ceiling",
            refundPending: true,
        });
        const c = await callTool(ceiling.client, "bugnet_redeem", {
            orderId,
            claim,
            handle: testHandle,
        });
        expect(c.text).toBe(
            "x402: the payment would pass Bugnet's x402 limits, so it is refunded in full to the paying wallet within 10 minutes and nothing was enabled.",
        );
        expect(c.structured).toEqual({ message: c.text, orderId, refusal: "allowance_ceiling" });
        const paused = await refusing({
            status: "refused",
            orderId,
            reason: "x402_paused",
            charged: false,
        });
        const p = await callTool(paused.client, "bugnet_redeem", {
            orderId,
            claim,
            handle: testHandle,
        });
        expect(p.text).toBe(
            "x402: Bugnet paused x402 payments right now. Nothing was charged. Try again later, or add the user's key with bugnet_secret_link.",
        );
        expect(p.structured).toEqual({ message: p.text, orderId, refusal: "x402_paused" });
        expect(ceiling.enables).toEqual([]);
        expect(paused.enables).toEqual([]);
        // A start with x402 redeemed by its quoteId is worded for start
        const started = await refusing({
            status: "refused",
            orderId,
            reason: "sandbox_ended",
            refundPending: false,
        });
        const s = await callTool(started.client, "bugnet_redeem", {
            orderId,
            claim,
            quoteId: quote(started.deps),
        });
        expect(s.text).toBe(
            "start: the sandbox ended before the payment was applied, so it was refunded.",
        );
        expect(s.structured).toEqual({ message: s.text, orderId, refusal: "sandbox_ended" });
    });

    it("redeems a budget order the user paid at its link", async () => {
        const enables: EnableX402Request[] = [];
        const { log, lines } = recordingLog();
        const payments = testPayments(undefined, { requirePayment: true });
        const client = await connectTools(
            testDeps({
                config: testConfig("[x402]\nenabled = true"),
                router: fakeRouter({ ...enabling(enables), checkX402: () => ({}) }),
                payments,
                log,
            }),
        );
        const r1 = await callTool<{ orderId: string; claim: string }>(
            client,
            "bugnet_x402_budget",
            { handle: testHandle, amountUsd: "1.00", confirmPriceUsd: "1.003" },
        );
        expect(r1.isError).toBe(true);
        const { orderId: id, claim: given } = r1.structured;
        expect([typeof id, typeof given]).toEqual(["string", "string"]);
        payments.dev.pay(id);
        const r2 = await callTool<Redeemed>(client, "bugnet_redeem", {
            orderId: id,
            claim: given,
            handle: testHandle,
        });
        expect(r2.isError).toBe(false);
        expect(r2.structured.orderId).toBe(id);
        expect(enables).toHaveLength(1);
        expect(enables[0]?.waitActive).toBe(true);
        expect(lines.some((l) => l.includes(given))).toBe(false);
    });
});
