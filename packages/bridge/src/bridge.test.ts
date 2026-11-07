import { PlacementState } from "@bugnet/gateway/gen";
import {
    packageOption,
    placement,
    routerError,
    testPayments,
    type RouterImpl,
    type TestPayments,
} from "@bugnet/gateway/testing";
import {
    Client,
    ProtocolError as ClientProtocolError,
    ProtocolError as RemoteProtocolError,
    StreamableHTTPClientTransport,
    type CallToolResult,
    type Progress,
} from "@modelcontextprotocol/client";
import { Code } from "@connectrpc/connect";
import { CLIENT_CAPABILITIES_META_KEY, inputRequired } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkState, lostLinkText, paymentStepResult } from "./linkpay.ts";
import { afterPaymentText, spentOrderText, unpaidText, type PublicOrderState } from "./orders.ts";
import type { PayOutcome, PaymentStep } from "./pay.ts";
import type { X402PaymentRequired } from "./payment.ts";
import type { CallOptions, RemoteResult, RemoteTools } from "./remote.ts";
import type { BridgePay } from "./bridge.ts";
import {
    connectBridge,
    devPay,
    fakeGateway,
    grantRouter,
    payingPayer,
    testHandle,
    testNow,
    testPayOrigin,
    type BridgeSetup,
    type ConnectedBridge,
    type FakeGateway,
} from "./testing/harness.ts";

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const close of open.splice(0)) await close();
});

const required: X402PaymentRequired = {
    x402Version: 2,
    accepts: [
        { scheme: "exact", network: "solana", amount: "50000", payTo: "Pay1", asset: "USDC" },
    ],
};

const startRouter: RouterImpl = {
    ...grantRouter,
    estimate: () => ({ options: [packageOption("small-10m", 50_000n)] }),
    createPlacement: () => ({ handle: testHandle, placement: placement(PlacementState.READY) }),
    getPlacement: () => ({ placement: placement(PlacementState.READY) }),
};

// Payments that ask for an x402 payment until one is attached
function x402Payments(): TestPayments {
    return testPayments((req) =>
        req.payment === undefined
            ? {
                  status: "payment_required",
                  orderId: "o1",
                  payUrl: "https://pay.bugnet.sh/o/o1",
                  paymentRequired: required,
              }
            : {
                  status: "paid",
                  orderId: "o1",
                  orderToken: "order-token",
                  payer: "Payer1",
                  kind: "start",
                  packageId: "small-10m",
                  amountMicros: 50_000,
                  paymentResponse: { success: true },
              },
    );
}

async function gateway(
    payments = x402Payments(),
): Promise<FakeGateway & { payments: TestPayments }> {
    const gw = await fakeGateway(startRouter, { payments });
    open.push(gw.close);
    return { ...gw, payments };
}

async function direct(url: string): Promise<Client> {
    const client = new Client({ name: "direct", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    open.push(() => client.close());
    return client;
}

async function bridge(setup: BridgeSetup): Promise<ConnectedBridge> {
    const b = await connectBridge(setup);
    open.push(b.close);
    return b;
}

// What the bridge's client and a direct client must agree on, the connection's own stamp aside
function comparable(r: unknown): unknown {
    const copy = JSON.parse(JSON.stringify(r)) as { _meta?: Record<string, unknown> };
    if (copy._meta) {
        delete copy._meta["io.modelcontextprotocol/serverInfo"];
        if (Object.keys(copy._meta).length === 0) delete copy._meta;
    }
    return copy;
}

async function quoteId(client: Client): Promise<string> {
    const q = await client.callTool({ name: "bugnet_quote", arguments: { workload: "script" } });
    return (q.structuredContent as { quoteId: string }).quoteId;
}

const startArgs = (quote: string) => ({
    quoteId: quote,
    packageId: "small-10m",
    confirmPriceUsd: "0.05",
});

describe.each(["legacy", "modern"] as const)("the bridge, %s client", (era) => {
    it("lists the gateway's tools without the put grant tool, plus its own", async () => {
        const gw = await gateway();
        const b = await bridge({ gateway: gw.url, era });
        const mine = await b.client.listTools();
        const theirs = await (await direct(gw.url)).listTools();
        expect(theirs.tools.map((t) => t.name)).toContain("bugnet_secret_put_grant");
        const expected = theirs.tools.filter((t) => t.name !== "bugnet_secret_put_grant");
        expect(mine.tools.slice(0, -1)).toEqual(expected);
        expect(mine.tools.at(-1)?.name).toBe("bugnet_secret_from_env");
        expect(mine.tools.at(-1)?.description?.length).toBeLessThan(600);
        // A \p class in a pattern means something else to a validator without the u flag
        expect(JSON.stringify(mine.tools.at(-1)?.inputSchema)).not.toMatch(/\\\\p/);
    });

    it("forwards the gateway's instructions", async () => {
        const gw = await gateway();
        const b = await bridge({ gateway: gw.url, era });
        const instructions = (await direct(gw.url)).getInstructions();
        expect(instructions).toMatch(/^Bugnet runs code/);
        expect(b.client.getInstructions()).toBe(instructions);
    });

    it("returns a gateway result unchanged", async () => {
        const gw = await gateway();
        const b = await bridge({ gateway: gw.url, era });
        const viaBridge = await b.client.callTool({
            name: "bugnet_quote",
            arguments: { workload: "script" },
        });
        const viaDirect = await (
            await direct(gw.url)
        ).callTool({
            name: "bugnet_quote",
            arguments: { workload: "script" },
        });
        expect(viaBridge.isError).toBeFalsy();
        const strip = (r: unknown) => {
            const c = comparable(r) as { structuredContent: { quoteId?: string } };
            delete c.structuredContent.quoteId;
            return JSON.stringify(c).replace(/q2\.[A-Za-z0-9_.-]+/g, "q2.x");
        };
        expect(strip(viaBridge)).toBe(strip(viaDirect));
    });

    it("passes the payment step back unchanged when no signer is set", async () => {
        const gw = await gateway();
        const b = await bridge({ gateway: gw.url, era });
        const viaBridge = await b.client.callTool({
            name: "bugnet_start",
            arguments: startArgs(await quoteId(b.client)),
        });
        expect(viaBridge.isError).toBe(true);
        expect(viaBridge.structuredContent).toEqual(
            expect.objectContaining({ ...required, orderId: "o1" }),
        );
        const d = await direct(gw.url);
        const viaDirect = await d.callTool({
            name: "bugnet_start",
            arguments: startArgs(await quoteId(d)),
        });
        expect(comparable(viaBridge)).toEqual(comparable(viaDirect));
    });

    it("carries the client's x402 payment in _meta to Payments and back", async () => {
        const gw = await gateway();
        const b = await bridge({ gateway: gw.url, era });
        const payment = { x402Version: 2, payload: { transaction: "signed-tx" } };
        const r = await b.client.callTool({
            name: "bugnet_start",
            arguments: startArgs(await quoteId(b.client)),
            _meta: { "x402/payment": payment, "claudecode/toolUseId": "toolu_pay" },
        });
        expect(r.isError).toBeFalsy();
        expect((r.structuredContent as { handle: string }).handle).toBe(testHandle);
        expect(r._meta?.["x402/payment-response"]).toEqual({ success: true });
        expect(gw.payments.orders).toEqual([
            expect.objectContaining({ payment, idempotencyKey: "toolu_pay" }),
        ]);
    });
});

/* A gateway stand-in that records what reaches it */

interface FakeRemote extends RemoteTools {
    calls: { params: Record<string, unknown>; opts: CallOptions }[];
    up: boolean;
}

function fakeRemote(
    answer: (
        params: Record<string, unknown>,
        opts: CallOptions,
    ) => RemoteResult | Promise<RemoteResult>,
): FakeRemote {
    const remote: FakeRemote = {
        calls: [],
        up: true,
        instructions: () => "fake instructions",
        listTools: async () => {
            if (!remote.up) throw new Error("connect ECONNREFUSED 127.0.0.1:443");
            return [
                { name: "bugnet_status", inputSchema: { type: "object" } },
                { name: "bugnet_secret_put_grant", inputSchema: { type: "object" } },
            ];
        },
        callTool: async (params, opts) => {
            if (!remote.up) throw new Error("connect ECONNREFUSED 127.0.0.1:443");
            remote.calls.push({ params, opts });
            return answer(params, opts);
        },
    };
    return remote;
}

const done: CallToolResult = {
    content: [{ type: "text", text: "fine" }],
    structuredContent: { message: "fine" },
};

const requirePayments = () => testPayments(undefined, { requirePayment: true });
const key = "start\0small-10m";
const standInOrder = "ord_abcdefghijklmnopqrstuvwxyz";
const standInClaim = "Ab3_".repeat(10) + "xY-";
const standInArgs = { quoteId: "q", packageId: "small-10m", confirmPriceUsd: "0.05" };
const standInStep: PaymentStep = {
    tool: "bugnet_start",
    orderId: standInOrder,
    claim: standInClaim,
    payUrl: `${testPayOrigin}/o/${standInOrder}`,
    amountMicros: 50_000,
};

// The gateway's v2 payment step for the stand-in's order, with any field replaced
function stepResult(over: Record<string, unknown> = {}): CallToolResult {
    const due = {
        x402Version: 2,
        accepts: [{ scheme: "exact", amount: "50000", payTo: "P", extra: { memo: standInOrder } }],
    };
    return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(due) }],
        structuredContent: {
            ...due,
            message: "pay",
            orderId: standInOrder,
            claim: standInClaim,
            payUrl: `${testPayOrigin}/o/${standInOrder}`,
            ...over,
        },
    };
}

describe.each(["legacy", "modern"] as const)("paying with pay, %s client", (era) => {
    it("pays a payment step once with pay and returns the sandbox", async () => {
        const gw = await gateway(requirePayments());
        const payer = payingPayer(gw.payments);
        const started = new Set<string>();
        const b = await bridge({
            gateway: gw.url,
            era,
            deps: { pay: devPay(gw.payments, payer), started },
        });
        const r = await b.client.callTool({
            name: "bugnet_start",
            arguments: startArgs(await quoteId(b.client)),
            _meta: { "claudecode/toolUseId": "toolu_pay1" },
        });
        expect(r.isError).toBeFalsy();
        expect((r.structuredContent as { handle: string }).handle).toBe(testHandle);
        expect(payer.calls).toHaveLength(1);
        const { step, maxMicros } = payer.calls[0]!;
        expect(maxMicros).toBe(50_000);
        expect(step).toMatchObject({
            tool: "bugnet_start",
            amountMicros: 50_000,
            payUrl: `${testPayOrigin}/o/${step.orderId}`,
        });
        expect(gw.payments.orders).toHaveLength(2);
        expect(gw.payments.orders[1]).toEqual({
            orderId: step.orderId,
            claim: step.claim,
            idempotencyKey: "toolu_pay1",
        });
        expect(started).toEqual(new Set([testHandle]));
        expect(b.lines.join("\n")).not.toContain(step.claim);
    });

    it("keeps a paid order whose start failed, says so with the claim, and uses it next time", async () => {
        let creates = 0;
        const router: RouterImpl = {
            ...startRouter,
            createPlacement: () => {
                if (creates++ === 0) throw routerError(Code.Unavailable);
                return { handle: testHandle, placement: placement(PlacementState.READY) };
            },
        };
        const payments = requirePayments();
        const gw = await fakeGateway(router, { payments });
        open.push(gw.close);
        const payer = payingPayer(payments);
        const pay = devPay(payments, payer);
        const b = await bridge({ gateway: gw.url, era, deps: { pay } });
        const args = startArgs(await quoteId(b.client));
        const first = await b.client.callTool({ name: "bugnet_start", arguments: args });
        const step = payer.calls[0]!.step;
        expect(first.isError).toBe(true);
        const texts = first.content as { type: string; text: string }[];
        expect(texts.at(-1)!.text.endsWith(afterPaymentText(step))).toBe(true);
        expect(pay.orders.heldFor(key)?.state).toBe("paid");
        const second = await b.client.callTool({ name: "bugnet_start", arguments: args });
        expect((second.structuredContent as { handle: string }).handle).toBe(testHandle);
        expect(payer.calls).toHaveLength(1);
        expect(payments.orders.slice(1).map((o) => [o.orderId, o.claim])).toEqual([
            [step.orderId, step.claim],
            [step.orderId, step.claim],
        ]);
        expect(pay.orders.heldFor(key)).toBeUndefined();
        // A held order from an earlier call is redeemed by claim, never by sending a payment
        expect(payments.orders.slice(1).every((o) => o.payment === undefined)).toBe(true);
        expect(b.lines.join("\n")).not.toContain(step.claim);
    });

    it("keeps the order when the client gives up while pay runs, and redeems it next call", async () => {
        const gw = await gateway(requirePayments());
        const payer = payingPayer(gw.payments, { delayMs: 200 });
        const pay = devPay(gw.payments, payer);
        const b = await bridge({ gateway: gw.url, era, deps: { pay } });
        const args = startArgs(await quoteId(b.client));
        const giveUp = new AbortController();
        const first = b.client.callTool(
            { name: "bugnet_start", arguments: args },
            { signal: giveUp.signal },
        );
        // Gives up only once pay runs, so the gateway's create never races the cancel
        await payer.started;
        giveUp.abort();
        await expect(first).rejects.toThrow();
        await vi.waitFor(() => expect(pay.orders.heldFor(key)?.state).toBe("paid"), {
            timeout: 2_000,
        });
        const r = await b.client.callTool({ name: "bugnet_start", arguments: args });
        expect((r.structuredContent as { handle: string }).handle).toBe(testHandle);
        expect(payer.calls).toHaveLength(1);
        expect(gw.payments.orders.filter((o) => o.orderId === undefined)).toHaveLength(1);
    });

    const inFlight = async (
        over: { outcome?: PayOutcome; pays?: boolean; status?: PublicOrderState } = {},
    ) => {
        const gw = await gateway(requirePayments());
        let release = () => {};
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const payer = payingPayer(gw.payments, { gate, ...over });
        const pay = devPay(gw.payments, payer, {
            ...(over.status ? { status: async () => over.status! } : {}),
        });
        const flights = vi.spyOn(pay.orders, "flight");
        const b = await bridge({ gateway: gw.url, era, deps: { pay } });
        const args = startArgs(await quoteId(b.client));
        const giveUp = new AbortController();
        const first = b.client.callTool(
            { name: "bugnet_start", arguments: args },
            { signal: giveUp.signal },
        );
        await payer.started;
        giveUp.abort();
        await expect(first).rejects.toThrow();
        // Done once the retry has found the pay running and waits on it
        const retryWaits = () => vi.waitFor(() => expect(flights).toHaveBeenCalled());
        return { gw, payer, pay, b, args, release, retryWaits };
    };

    it("waits for a pay still running instead of opening and paying a second order", async () => {
        const { gw, payer, b, args, release, retryWaits } = await inFlight();
        const retry = b.client.callTool({ name: "bugnet_start", arguments: args });
        await retryWaits();
        release();
        const r = await retry;
        expect((r.structuredContent as { handle: string }).handle).toBe(testHandle);
        expect(payer.calls).toHaveLength(1);
        const { step } = payer.calls[0]!;
        expect(gw.payments.orders.filter((o) => o.orderId === undefined)).toHaveLength(1);
        expect(gw.payments.orders.at(-1)).toMatchObject({
            orderId: step.orderId,
            claim: step.claim,
        });
        expect(gw.payments.orders.every((o) => o.payment === undefined)).toBe(true);
    });

    it("names the order when a retry's own client gives up while pay still runs", async () => {
        const { payer, pay, b, args, release, retryWaits } = await inFlight();
        const gone = new AbortController();
        const second = b.client.callTool(
            { name: "bugnet_start", arguments: args },
            { signal: gone.signal },
        );
        await retryWaits();
        gone.abort();
        await expect(second).rejects.toThrow();
        release();
        await vi.waitFor(() => expect(pay.orders.heldFor(key)?.state).toBe("paid"), {
            timeout: 2_000,
        });
        expect(payer.calls).toHaveLength(1);
    });

    it("never opens an order after a shared pay ends unsure and the page reads unpaid", async () => {
        const { gw, payer, b, args, release, retryWaits } = await inFlight({
            outcome: { kind: "unknown" },
            pays: false,
            status: "unpaid",
        });
        const retry = b.client.callTool({ name: "bugnet_start", arguments: args });
        await retryWaits();
        release();
        const r = await retry;
        expect(r.isError).toBe(true);
        const step = payer.calls[0]!.step;
        expect((r.content as { text: string }[]).at(-1)!.text).toBe(unpaidText("timeout", step));
        expect(payer.calls).toHaveLength(1);
        expect(gw.payments.orders.filter((o) => o.orderId === undefined)).toHaveLength(1);
    });

    it("never opens a new order while an unsure hold's payment is under review", async () => {
        const gw = await gateway(requirePayments());
        const payer = payingPayer(gw.payments, { outcome: { kind: "unknown" }, pays: false });
        const reads: string[] = ["settling", "review"];
        const pay = devPay(gw.payments, payer, {
            status: async () => (reads.shift() ?? "review") as PublicOrderState,
        });
        const b = await bridge({ gateway: gw.url, era, deps: { pay } });
        const args = startArgs(await quoteId(b.client));
        await b.client.callTool({ name: "bugnet_start", arguments: args });
        const r = await b.client.callTool({ name: "bugnet_start", arguments: args });
        const step = payer.calls[0]!.step;
        expect(r.isError).toBe(true);
        expect((r.content as { text: string }[]).at(-1)!.text).toBe(unpaidText("closed", step));
        expect(payer.calls).toHaveLength(1);
        expect(gw.payments.orders.filter((o) => o.orderId === undefined)).toHaveLength(1);
        expect(pay.orders.heldFor(key)?.state).toBe("unknown");
    });

    it("settles the hold when the model redeems with its own orderId and claim", async () => {
        let creates = 0;
        const router: RouterImpl = {
            ...startRouter,
            createPlacement: () => {
                if (creates++ === 0) throw routerError(Code.Unavailable);
                return { handle: testHandle, placement: placement(PlacementState.READY) };
            },
        };
        const payments = requirePayments();
        const gw = await fakeGateway(router, { payments });
        open.push(gw.close);
        const payer = payingPayer(payments);
        const pay = devPay(payments, payer);
        const b = await bridge({ gateway: gw.url, era, deps: { pay } });
        const args = startArgs(await quoteId(b.client));
        await b.client.callTool({ name: "bugnet_start", arguments: args });
        const old = payer.calls[0]!.step;
        expect(pay.orders.heldFor(key)?.state).toBe("paid");
        const explicit = await b.client.callTool({
            name: "bugnet_start",
            arguments: { ...args, orderId: old.orderId, claim: old.claim },
        });
        expect(explicit.isError).toBeFalsy();
        expect(pay.orders.heldFor(key)).toBeUndefined();
        await b.client.callTool({ name: "bugnet_start", arguments: args });
        expect(payments.orders.filter((o) => o.orderId === undefined)).toHaveLength(2);
        expect(payer.calls).toHaveLength(2);
        expect(payer.calls[1]!.step.orderId).not.toBe(old.orderId);
    });

    // The first call leaves an unsure hold, then the second call's page read decides
    it.each([
        ["paid", true],
        ["settling", true],
        ["throw", true],
    ] as const)("redeems an unsure hold when its page reads %s", async (second, pays) => {
        const gw = await gateway(requirePayments());
        const payer = payingPayer(gw.payments, { outcome: { kind: "unknown" }, pays });
        // The first read fails, so the first call ends unsure without polling
        const reads: string[] = ["throw", second];
        const pay = devPay(gw.payments, payer, {
            status: async () => {
                const s = reads.shift() ?? "paid";
                if (s === "throw") throw new Error("connect ECONNREFUSED 127.0.0.1:443");
                return s as PublicOrderState;
            },
        });
        const b = await bridge({ gateway: gw.url, era, deps: { pay } });
        const args = startArgs(await quoteId(b.client));
        const first = await b.client.callTool({ name: "bugnet_start", arguments: args });
        expect(first.isError).toBe(true);
        expect(pay.orders.heldFor(key)?.state).toBe("unknown");
        const r = await b.client.callTool({ name: "bugnet_start", arguments: args });
        expect((r.structuredContent as { handle: string }).handle).toBe(testHandle);
        expect(payer.calls).toHaveLength(1);
        expect(pay.orders.heldFor(key)).toBeUndefined();
    });

    it("never pays an order again after its unsure hold reads unpaid", async () => {
        const gw = await gateway(requirePayments());
        const payer = payingPayer(gw.payments, { outcome: { kind: "unknown" }, pays: false });
        const reads: string[] = ["throw", "unpaid", "unpaid"];
        const pay = devPay(gw.payments, payer, {
            status: async () => {
                const s = reads.shift() ?? "unpaid";
                if (s === "throw") throw new Error("connect ECONNREFUSED 127.0.0.1:443");
                return s as PublicOrderState;
            },
        });
        const b = await bridge({ gateway: gw.url, era, deps: { pay } });
        const args = startArgs(await quoteId(b.client));
        await b.client.callTool({ name: "bugnet_start", arguments: args });
        const old = payer.calls[0]!.step;
        // The hold reads unpaid, so a new order is made and paid
        await b.client.callTool({ name: "bugnet_start", arguments: args });
        expect(payer.calls).toHaveLength(2);
        expect(payer.calls[1]!.step.orderId).not.toBe(old.orderId);
        // The model calls again with the old order and claim, as the text told it to
        await b.client.callTool({
            name: "bugnet_start",
            arguments: { ...args, orderId: old.orderId, claim: old.claim },
        });
        expect(payer.calls.filter((c) => c.step.orderId === old.orderId)).toHaveLength(1);
    });

    it("relays progress while pay runs, with rising progress values", async () => {
        const gw = await gateway(requirePayments());
        const b = await bridge({
            gateway: gw.url,
            era,
            deps: { pay: devPay(gw.payments, payingPayer(gw.payments, { progress: 2 })) },
        });
        const seen: Progress[] = [];
        await b.client.callTool(
            { name: "bugnet_start", arguments: startArgs(await quoteId(b.client)) },
            { onprogress: (p) => seen.push(p) },
        );
        expect(
            seen.filter((p) => p.message === "waiting for the payment to be approved in pay"),
        ).toHaveLength(2);
        const values = seen.map((p) => p.progress);
        expect(values).toEqual([...values].sort((a, b) => a - b));
        expect(new Set(values).size).toBe(values.length);
    });

    // Each row's states are read in turn and the last one again, "throw" being a failed read
    it.each([
        ["the page says paid", ["paid"], true, "handle"],
        ["the page says unpaid", ["unpaid"], false, "step"],
        ["the page says expired", ["expired"], false, "expired"],
        ["the page says settling, then paid", ["settling", "paid"], true, "handle"],
        ["the page cannot be read", ["throw"], true, "timeout"],
    ] as const)("decides an unsure pay outcome when %s", async (_n, states, pays, answer) => {
        const gw = await gateway(requirePayments());
        const payer = payingPayer(gw.payments, { outcome: { kind: "unknown" }, pays });
        let reads = 0;
        const pay = devPay(gw.payments, payer, {
            status: async () => {
                const s = states[Math.min(reads++, states.length - 1)]!;
                if (s === "throw") throw new Error("connect ECONNREFUSED 127.0.0.1:443");
                return s as PublicOrderState;
            },
        });
        const b = await bridge({ gateway: gw.url, era, deps: { pay } });
        const r = await b.client.callTool({
            name: "bugnet_start",
            arguments: startArgs(await quoteId(b.client)),
        });
        expect(payer.calls).toHaveLength(1);
        const step = payer.calls[0]!.step;
        if (answer === "handle") {
            expect((r.structuredContent as { handle: string }).handle).toBe(testHandle);
            expect(pay.orders.heldFor(key)).toBeUndefined();
        } else if (answer === "step") {
            expect(r.isError).toBe(true);
            expect(r.structuredContent).toEqual(
                expect.objectContaining({
                    orderId: step.orderId,
                    payUrl: step.payUrl,
                    claim: step.claim,
                }),
            );
            expect(pay.orders.heldFor(key)).toBeUndefined();
        } else {
            expect(r.isError).toBe(true);
            expect((r.content as { text: string }[]).at(-1)!.text).toBe(unpaidText(answer, step));
            expect(pay.orders.heldFor(key)?.state).toBe(
                answer === "timeout" ? "unknown" : undefined,
            );
        }
    });

    it("returns the payment step unchanged when pay is missing, declines, or is turned off", async () => {
        const payers = [
            (p: TestPayments) =>
                payingPayer(p, { outcome: { kind: "unavailable", reason: "start" }, pays: false }),
            (p: TestPayments) =>
                payingPayer(p, {
                    outcome: { kind: "declined", reason: "payer_blocked" },
                    pays: false,
                }),
            () => null,
        ];
        for (const make of payers) {
            const gw = await gateway(requirePayments());
            const b = await bridge({
                gateway: gw.url,
                era,
                deps: { pay: devPay(gw.payments, make(gw.payments)) },
            });
            const r = await b.client.callTool({
                name: "bugnet_start",
                arguments: startArgs(await quoteId(b.client)),
            });
            const s = r.structuredContent as { orderId: string; payUrl: string; claim: string };
            expect(r.isError).toBe(true);
            expect(s.payUrl).toBe(`${testPayOrigin}/o/${s.orderId}`);
            expect(s.claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(gw.payments.orders).toHaveLength(1);
        }
    });
});

describe("paying with pay, the gateway stand-in", () => {
    it("never pays a link off the origin, off the order's path, naming another memo or above the price", async () => {
        for (const over of [
            { payUrl: `https://pay.evil.example/o/${standInOrder}` },
            { payUrl: `${testPayOrigin}/o/ord_other` },
            { accepts: [{ amount: "50000", extra: { memo: "ord_other" } }] },
            { accepts: [{ amount: "60000", extra: { memo: standInOrder } }] },
        ]) {
            const remote = fakeRemote(() => stepResult(over));
            const payer = payingPayer(testPayments());
            const b = await bridge({ remote, deps: { pay: devPay(testPayments(), payer) } });
            const r = await b.client.callTool({ name: "bugnet_start", arguments: standInArgs });
            expect(r.structuredContent).toEqual(stepResult(over).structuredContent);
            expect(payer.calls).toEqual([]);
            expect(b.lines.some((l) => JSON.parse(l).msg === "pay link refused")).toBe(true);
        }
    });

    it("never pays for a call that brings its own payment", async () => {
        for (const call of [
            { name: "bugnet_start", arguments: { ...standInArgs, payment: { x402Version: 2 } } },
            { name: "bugnet_start", arguments: standInArgs, _meta: { "x402/payment": {} } },
        ]) {
            const remote = fakeRemote(() => stepResult());
            const payer = payingPayer(testPayments());
            const b = await bridge({ remote, deps: { pay: devPay(testPayments(), payer) } });
            const r = await b.client.callTool(call);
            expect(r.structuredContent).toEqual(stepResult().structuredContent);
            expect(payer.calls).toEqual([]);
            expect(remote.calls).toHaveLength(1);
        }
    });

    it("pays an order at most once", async () => {
        const remote = fakeRemote(() => stepResult());
        const payer = payingPayer(testPayments(), {
            outcome: { kind: "declined", reason: "payer_blocked" },
            pays: false,
        });
        const b = await bridge({ remote, deps: { pay: devPay(testPayments(), payer) } });
        const first = await b.client.callTool({ name: "bugnet_start", arguments: standInArgs });
        const second = await b.client.callTool({ name: "bugnet_start", arguments: standInArgs });
        expect(payer.calls).toHaveLength(1);
        expect(first.structuredContent).toEqual(stepResult().structuredContent);
        expect(second.structuredContent).toEqual(stepResult().structuredContent);
        expect(remote.calls).toHaveLength(2);
    });

    it("reads the status page when pay's refusal names a spent order", async () => {
        const remote = fakeRemote(() => stepResult());
        const payer = payingPayer(testPayments(), {
            outcome: { kind: "declined", reason: "order_expired" },
            pays: false,
        });
        const b = await bridge({
            remote,
            deps: { pay: devPay(testPayments(), payer, { status: async () => "expired" }) },
        });
        const r = await b.client.callTool({ name: "bugnet_start", arguments: standInArgs });
        expect(r.isError).toBe(true);
        expect((r.content as { text: string }[])[0]!.text).toBe(unpaidText("expired", standInStep));
        expect(remote.calls).toHaveLength(1);
    });

    it("forgets a held order the gateway calls spent, and still names it in the error", async () => {
        const spent: CallToolResult = {
            isError: true,
            content: [{ type: "text", text: "payment refused: order_expired." }],
            structuredContent: {
                message: "payment refused: order_expired.",
                refusal: "order_expired",
            },
        };
        const remote = fakeRemote((params) =>
            (params.arguments as { claim?: string }).claim === undefined ? stepResult() : spent,
        );
        const pay = devPay(testPayments(), payingPayer(testPayments(), { pays: false }));
        const b = await bridge({ remote, deps: { pay } });
        const r = await b.client.callTool({ name: "bugnet_start", arguments: standInArgs });
        expect(r.isError).toBe(true);
        expect((r.content as { text: string }[]).at(-1)!.text).toBe(
            `payment refused: order_expired.${spentOrderText(standInStep)}`,
        );
        expect(pay.orders.heldFor(key)).toBeUndefined();
        expect(remote.calls.map((c) => (c.params.arguments as { claim?: string }).claim)).toEqual([
            undefined,
            standInClaim,
        ]);
    });
});

describe("pass-through", () => {
    it("forwards name, arguments and _meta as given, with the client's capabilities", async () => {
        const remote = fakeRemote(() => done);
        const b = await bridge({ remote, elicit: () => ({ action: "accept", content: {} }) });
        const meta = { "claudecode/toolUseId": "toolu_9", "x402/payment": { p: 1 }, other: "x" };
        const args = { handle: testHandle, nested: { a: [1, 2] } };
        const r = await b.client.callTool({ name: "bugnet_status", arguments: args, _meta: meta });
        expect(r.structuredContent).toEqual({ message: "fine" });
        const sent = remote.calls[0]!.params;
        expect(sent.name).toBe("bugnet_status");
        expect(sent.arguments).toEqual(args);
        const sentMeta = sent._meta as Record<string, unknown>;
        expect(sentMeta).toMatchObject(meta);
        expect(sentMeta[CLIENT_CAPABILITIES_META_KEY]).toMatchObject({ elicitation: { form: {} } });
        expect(sentMeta.progressToken).toBeUndefined();
        expect(sent.inputResponses).toBeUndefined();
        expect(sent.requestState).toBeUndefined();
    });

    it("relays the gateway's progress under the caller's token", async () => {
        const remote = fakeRemote(async (_p, opts) => {
            opts.onprogress?.({ progress: 1, message: "starting" });
            opts.onprogress?.({ progress: 2, message: "still starting" });
            await new Promise((r) => setTimeout(r, 20));
            return done;
        });
        const b = await bridge({ remote });
        const seen: Progress[] = [];
        await b.client.callTool(
            { name: "bugnet_status", arguments: {} },
            { onprogress: (p) => seen.push(p) },
        );
        expect(seen.map((p) => p.message)).toEqual(["starting", "still starting"]);
        expect(remote.calls[0]!.opts.onprogress).toBeTypeOf("function");
    });

    it("answers a gateway that cannot be reached with a short tool error", async () => {
        const remote = fakeRemote(() => done);
        remote.up = false;
        const b = await bridge({ remote });
        const r = await b.client.callTool({ name: "bugnet_status", arguments: {} });
        expect(r).toMatchObject({
            isError: true,
            content: [{ type: "text", text: "Bugnet's gateway did not answer, a retry may work." }],
        });
        expect(b.lines.join("\n")).not.toMatch(/sbx_/);
    });

    it("lists only its own tool while the gateway is down, then says when it is back", async () => {
        const remote = fakeRemote(() => done);
        remote.up = false;
        const b = await bridge({ remote, deps: { relistMs: 10 } });
        expect((await b.client.listTools()).tools.map((t) => t.name)).toEqual([
            "bugnet_secret_from_env",
        ]);
        const changed = new Promise<void>((resolve) =>
            b.client.setNotificationHandler("notifications/tools/list_changed", () => resolve()),
        );
        remote.up = true;
        await changed;
        expect((await b.client.listTools()).tools.map((t) => t.name)).toEqual([
            "bugnet_status",
            "bugnet_secret_from_env",
        ]);
    });

    it("passes a JSON-RPC error from the gateway on as the same error", async () => {
        const remote = fakeRemote(() => {
            throw new RemoteProtocolError(-32602, "Unknown tool: bugnet_nope");
        });
        const b = await bridge({ remote });
        const err = await b.client
            .callTool({ name: "bugnet_nope", arguments: {} })
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ClientProtocolError);
        expect((err as ClientProtocolError).code).toBe(-32602);
        expect((err as Error).message).toMatch(/Unknown tool: bugnet_nope/);
    });

    it("keeps bugnet_secret_put_grant for itself", async () => {
        const remote = fakeRemote(() => done);
        const b = await bridge({ remote });
        const r = await b.client.callTool({
            name: "bugnet_secret_put_grant",
            arguments: { handle: testHandle },
        });
        expect(r.isError).toBe(true);
        expect(remote.calls).toEqual([]);
    });

    it("drops the gateway's own connection stamp but keeps the rest of its _meta", async () => {
        const remote = fakeRemote(() => ({
            ...done,
            _meta: {
                "io.modelcontextprotocol/serverInfo": { name: "bugnet", version: "1" },
                "x402/x": 1,
            },
        }));
        const b = await bridge({ remote });
        const r = await b.client.callTool({ name: "bugnet_status", arguments: {} });
        expect(r._meta).toEqual({ "x402/x": 1 });
    });

    it("remembers a sandbox only from a successful bugnet_start result", async () => {
        const named = (handle: string, isError = false): CallToolResult => ({
            ...done,
            structuredContent: { message: "fine", handle },
            ...(isError ? { isError } : {}),
        });
        const handles = {
            status: "sbx_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            failed: "sbx_bbbbbbbbbbbbbbbbbbbbbbbbbb",
            started: "sbx_cccccccccccccccccccccccccc",
        };
        const remote = fakeRemote((params) => {
            if (params.name === "bugnet_status") return named(handles.status);
            if ((params.arguments as { fail?: boolean }).fail) return named(handles.failed, true);
            return named(handles.started);
        });
        const started = new Set<string>();
        const b = await bridge({ remote, deps: { started } });
        await b.client.callTool({ name: "bugnet_status", arguments: {} });
        await b.client.callTool({ name: "bugnet_start", arguments: { fail: true } });
        expect(started).toEqual(new Set());
        await b.client.callTool({ name: "bugnet_start", arguments: {} });
        expect(started).toEqual(new Set([handles.started]));
    });

    it("never counts a start of an order it did not relay, which an injected agent could name", async () => {
        const mine = "sbx_dddddddddddddddddddddddddd";
        const theirs = "sbx_zzzzzzzzzzzzzzzzzzzzzzzzzz";
        const remote = fakeRemote((params) => {
            const args = params.arguments as { orderId?: string; payment?: unknown };
            if (args.orderId === undefined && args.payment === undefined) {
                return {
                    isError: true,
                    content: [{ type: "text", text: JSON.stringify(required) }],
                    structuredContent: { ...required, message: "pay", orderId: "o_mine" },
                };
            }
            const handle = args.orderId === "o_mine" ? mine : theirs;
            return { ...done, structuredContent: { message: "fine", handle } };
        });
        const started = new Set<string>();
        const b = await bridge({ remote, deps: { started } });
        const payment = { x402Version: 2, payload: { transaction: "attacker-signed" } };
        for (const args of [
            { orderId: "ord_attacker_paid_this", payment },
            { orderId: "ord_attacker_paid_this" },
            { payment },
        ]) {
            await b.client.callTool({ name: "bugnet_start", arguments: args });
        }
        expect(started).toEqual(new Set());
        await b.client.callTool({ name: "bugnet_start", arguments: {} });
        await b.client.callTool({ name: "bugnet_start", arguments: { orderId: "o_mine" } });
        expect(started).toEqual(new Set([mine]));
    });

    for (const era of ["legacy", "modern"] as const) {
        it(`hands the gateway's input requests to a ${era} client and back`, async () => {
            const remote = fakeRemote((params) => {
                if (!params.inputResponses) {
                    return inputRequired({
                        inputRequests: {
                            pay: inputRequired.elicit({
                                message: "Pay $0.05?",
                                requestedSchema: { type: "object", properties: {} },
                            }),
                        },
                        requestState: "gateway-state-1",
                    });
                }
                return done;
            });
            const b = await bridge({
                remote,
                era,
                elicit: () => ({ action: "accept", content: {} }),
            });
            const r = await b.client.callTool({ name: "bugnet_start", arguments: { a: 1 } });
            expect(r.structuredContent).toEqual({ message: "fine" });
            expect(b.prompts).toEqual(["Pay $0.05?"]);
            expect(remote.calls).toHaveLength(2);
            const retry = remote.calls[1]!.params;
            expect(retry.arguments).toEqual({ a: 1 });
            expect(retry.requestState).toBe("gateway-state-1");
            expect(retry.inputResponses).toEqual({ pay: { action: "accept", content: {} } });
        });
    }
});

/* Paying by link */

// Answers the queued states in turn, the last one again, and pays the dev order before "paid"
function queued(payments: TestPayments, states: PublicOrderState[]): BridgePay["status"] {
    let i = 0;
    return async (id) => {
        const s = states[Math.min(i++, states.length - 1)]!;
        if (s === "paid") payments.dev.pay(id);
        return s;
    };
}

// The stand-in's paid retry starts a sandbox, its first call answers the payment step
const handled = (p: Record<string, unknown>): CallToolResult =>
    (p.arguments as { claim?: string }).claim === undefined
        ? stepResult()
        : {
              content: [{ type: "text", text: "fine" }],
              structuredContent: { message: "fine", handle: testHandle },
          };

describe.each(["legacy", "modern"] as const)("paying by link, %s client", (era) => {
    it("opens the pay link, polls the payment page and finishes the order", async () => {
        const gw = await gateway(requirePayments());
        const started = new Set<string>();
        const b = await bridge({
            gateway: gw.url,
            era,
            elicitUrl: () => ({ action: "accept" }),
            deps: {
                started,
                pay: devPay(gw.payments, null, {
                    status: queued(gw.payments, ["unpaid", "unpaid", "paid"]),
                }),
            },
        });
        const r = await b.client.callTool({
            name: "bugnet_start",
            arguments: startArgs(await quoteId(b.client)),
        });
        expect((r.structuredContent as { handle: string }).handle).toBe(testHandle);
        const create = gw.payments.orders[0]!;
        const redeem = gw.payments.orders[1]!;
        expect(gw.payments.orders).toHaveLength(2);
        expect(b.urls).toEqual([`${testPayOrigin}/o/${redeem.orderId}`]);
        expect(b.prompts).toEqual([
            `Pay $0.05 USDC for Bugnet order ${redeem.orderId} with a Solana ` +
                "wallet in your browser. The agent goes on once it is paid.",
        ]);
        expect(create.orderId).toBeUndefined();
        expect(redeem.claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(started).toEqual(new Set([testHandle]));
    });

    it("falls back to the pay link when pay is unavailable", async () => {
        const gw = await gateway(requirePayments());
        const payer = payingPayer(gw.payments, {
            outcome: { kind: "unavailable", reason: "start" },
            pays: false,
        });
        const b = await bridge({
            gateway: gw.url,
            era,
            elicitUrl: () => ({ action: "accept" }),
            deps: { pay: devPay(gw.payments, payer, { status: queued(gw.payments, ["paid"]) }) },
        });
        const r = await b.client.callTool({
            name: "bugnet_start",
            arguments: startArgs(await quoteId(b.client)),
        });
        expect((r.structuredContent as { handle: string }).handle).toBe(testHandle);
        expect(payer.calls).toHaveLength(1);
        expect(b.urls).toEqual([payer.calls[0]!.step.payUrl]);
    });

    it("polls a payment pay left settling, without asking the user", async () => {
        const gw = await gateway(requirePayments());
        const payer = payingPayer(gw.payments, { outcome: { kind: "unknown" }, pays: false });
        const status = queued(gw.payments, ["settling", "settling", "paid"]);
        const b = await bridge({
            gateway: gw.url,
            era,
            elicitUrl: () => ({ action: "accept" }),
            deps: { pay: devPay(gw.payments, payer, { status }) },
        });
        const r = await b.client.callTool({
            name: "bugnet_start",
            arguments: startArgs(await quoteId(b.client)),
        });
        expect((r.structuredContent as { handle: string }).handle).toBe(testHandle);
        expect(b.urls).toEqual([]);
    });

    it("keeps a link order the client gave up on, and redeems it next call once paid", async () => {
        const gw = await gateway(requirePayments());
        let reads = 0;
        const pay = devPay(gw.payments, null, {
            status: async (id) => {
                reads += 1;
                const a = gw.payments.dev.status(id);
                return a.status === 404 ? null : (a.body.state as PublicOrderState);
            },
            // The harness clock stands still, so the poll ends only when the client gives up
            sleep: (_ms, signal) =>
                new Promise<void>((resolve, reject) => {
                    if (signal.aborted) return reject(signal.reason);
                    const t = setTimeout(resolve, 20);
                    signal.addEventListener(
                        "abort",
                        () => {
                            clearTimeout(t);
                            reject(signal.reason);
                        },
                        { once: true },
                    );
                }),
        });
        const b = await bridge({
            gateway: gw.url,
            era,
            elicitUrl: () => ({ action: "accept" }),
            deps: { pay },
        });
        const args = startArgs(await quoteId(b.client));
        const giveUp = new AbortController();
        const first = b.client.callTool(
            { name: "bugnet_start", arguments: args },
            { signal: giveUp.signal },
        );
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: 2_000 });
        giveUp.abort();
        await expect(first).rejects.toThrow();
        await vi.waitFor(() => expect(pay.orders.heldFor(key)?.state).toBe("unknown"), {
            timeout: 2_000,
        });
        gw.payments.dev.pay(b.urls[0]!.split("/o/")[1]!);
        const r = await b.client.callTool({ name: "bugnet_start", arguments: args });
        expect((r.structuredContent as { handle: string }).handle).toBe(testHandle);
        expect(b.urls).toHaveLength(1);
        expect(gw.payments.orders.filter((o) => o.orderId === undefined)).toHaveLength(1);
    });

    // The poll reads the dev page for real, slowed by a short real sleep so a test can step in
    const slowPay = (gw: { payments: TestPayments }, over: Partial<BridgePay> = {}) =>
        devPay(gw.payments, null, {
            status: async (id) => {
                const a = gw.payments.dev.status(id);
                return a.status === 404 ? null : (a.body.state as PublicOrderState);
            },
            sleep: (_ms, signal) =>
                new Promise<void>((resolve, reject) => {
                    if (signal.aborted) return reject(signal.reason);
                    const t = setTimeout(resolve, 20);
                    signal.addEventListener(
                        "abort",
                        () => {
                            clearTimeout(t);
                            reject(signal.reason);
                        },
                        { once: true },
                    );
                }),
            ...over,
        });

    it("makes a second call for the package wait for the link poll and redeem by claim", async () => {
        const gw = await gateway(requirePayments());
        let reads = 0;
        const base = slowPay(gw);
        const pay = {
            ...base,
            status: async (id: string, s: AbortSignal) => (reads++, base.status(id, s)),
        };
        const b = await bridge({
            gateway: gw.url,
            era,
            elicitUrl: () => ({ action: "accept" }),
            deps: { pay },
        });
        const args = startArgs(await quoteId(b.client));
        const first = b.client.callTool({ name: "bugnet_start", arguments: args });
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: 2_000 });
        const second = b.client.callTool({ name: "bugnet_start", arguments: args });
        await new Promise((r) => setTimeout(r, 100));
        expect(gw.payments.orders.filter((o) => o.orderId === undefined)).toHaveLength(1);
        gw.payments.dev.pay(b.urls[0]!.split("/o/")[1]!);
        const [a, c] = await Promise.all([first, second]);
        expect((a.structuredContent as { handle: string }).handle).toBe(testHandle);
        expect((c.structuredContent as { handle: string }).handle).toBe(testHandle);
        expect(gw.payments.orders.filter((o) => o.orderId === undefined)).toHaveLength(1);
        expect(b.urls).toHaveLength(1);
    });

    it("gives the same order's link back when the client gave up and the page reads unpaid", async () => {
        const gw = await gateway(requirePayments());
        let reads = 0;
        const base = slowPay(gw);
        const pay = {
            ...base,
            status: async (id: string, s: AbortSignal) => (reads++, base.status(id, s)),
        };
        let answers = 0;
        const b = await bridge({
            gateway: gw.url,
            era,
            elicitUrl: () => ({ action: answers++ === 0 ? "accept" : "decline" }),
            deps: { pay },
        });
        const args = startArgs(await quoteId(b.client));
        const giveUp = new AbortController();
        const first = b.client.callTool(
            { name: "bugnet_start", arguments: args },
            { signal: giveUp.signal },
        );
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: 2_000 });
        giveUp.abort();
        await expect(first).rejects.toThrow();
        await vi.waitFor(() => expect(pay.orders.heldFor(key)?.state).toBe("unknown"), {
            timeout: 2_000,
        });
        const id = b.urls[0]!.split("/o/")[1]!;
        const r = await b.client.callTool({ name: "bugnet_start", arguments: args });
        expect(r.structuredContent).toEqual(expect.objectContaining({ orderId: id }));
        expect(b.urls).toEqual([`${testPayOrigin}/o/${id}`, `${testPayOrigin}/o/${id}`]);
        expect(gw.payments.orders.filter((o) => o.orderId === undefined)).toHaveLength(1);
    });

    it("holds an order whose page reads review straight after an unsure pay", async () => {
        const gw = await gateway(requirePayments());
        const payer = payingPayer(gw.payments, { outcome: { kind: "unknown" }, pays: false });
        const pay = devPay(gw.payments, payer, { status: async () => "review" });
        const b = await bridge({ gateway: gw.url, era, deps: { pay } });
        const r = await b.client.callTool({
            name: "bugnet_start",
            arguments: startArgs(await quoteId(b.client)),
        });
        expect(r.isError).toBe(true);
        expect((r.content as { text: string }[]).at(-1)!.text).toBe(
            unpaidText("closed", payer.calls[0]!.step),
        );
        expect(pay.orders.heldFor(key)?.state).toBe("unknown");
    });

    it("never opens a link whose url is off the pay origin, even for a tried order", async () => {
        const evil = `https://pay.evil.example/o/${standInOrder}`;
        let n = 0;
        const remote = fakeRemote(() => stepResult(n++ === 0 ? {} : { payUrl: evil }));
        const payer = payingPayer(testPayments(), {
            outcome: { kind: "unavailable", reason: "start" },
            pays: false,
        });
        const b = await bridge({
            remote,
            era,
            elicitUrl: () => ({ action: "decline" }),
            deps: { pay: devPay(testPayments(), payer) },
        });
        await b.client.callTool({ name: "bugnet_start", arguments: standInArgs });
        expect(b.urls).toEqual([`${testPayOrigin}/o/${standInOrder}`]);
        const r = await b.client.callTool({ name: "bugnet_start", arguments: standInArgs });
        expect(r.structuredContent).toEqual(stepResult({ payUrl: evil }).structuredContent);
        expect(b.urls).toHaveLength(1);
    });

    it("forwards neither the link state nor the answer to the gateway", async () => {
        const remote = fakeRemote(handled);
        const b = await bridge({
            remote,
            era,
            elicitUrl: () => ({ action: "accept" }),
            deps: { pay: devPay(testPayments(), null, { status: async () => "paid" }) },
        });
        const r = await b.client.callTool({ name: "bugnet_start", arguments: standInArgs });
        expect((r.structuredContent as { handle: string }).handle).toBe(testHandle);
        expect(remote.calls).toHaveLength(2);
        const retry = remote.calls[1]!.params;
        expect(retry.arguments).toEqual({
            ...standInArgs,
            orderId: standInOrder,
            claim: standInClaim,
        });
        expect(retry.inputResponses).toBeUndefined();
        expect(retry.requestState).toBeUndefined();
    });

    it("returns the payment step unchanged to a client that cannot open links", async () => {
        const remote = fakeRemote(handled);
        const b = await bridge({
            remote,
            era,
            deps: { pay: devPay(testPayments(), null, { status: async () => "paid" }) },
        });
        const r = await b.client.callTool({ name: "bugnet_start", arguments: standInArgs });
        expect(r.structuredContent).toEqual(stepResult().structuredContent);
        expect(remote.calls).toHaveLength(1);
    });

    it.each([
        ["timeout", "unpaid"],
        ["expired", "expired"],
        ["closed", "refunded"],
        ["unknown_order", null],
    ] as const)("words a %s link outcome", async (outcome, state) => {
        // deps.now and pay.sleep share one clock, so the 600_000 ms of a timeout pass at once
        const clock = { t: testNow };
        const remote = fakeRemote(handled);
        const b = await bridge({
            remote,
            era,
            elicitUrl: () => ({ action: "accept" }),
            deps: {
                now: () => clock.t,
                pay: devPay(testPayments(), null, {
                    status: async () => state,
                    sleep: async (ms) => {
                        clock.t += ms;
                    },
                }),
            },
        });
        const r = await b.client.callTool({ name: "bugnet_start", arguments: standInArgs });
        expect(r.isError).toBe(true);
        expect((r.content as { text: string }[])[0]!.text).toBe(unpaidText(outcome, standInStep));
        expect(remote.calls).toHaveLength(1);
    });

    it("answers a declined link with the payment step and forwards nothing", async () => {
        const remote = fakeRemote(handled);
        const b = await bridge({
            remote,
            era,
            elicitUrl: () => ({ action: "decline" }),
            deps: { pay: devPay(testPayments(), null, { status: async () => "paid" }) },
        });
        const r = await b.client.callTool({ name: "bugnet_start", arguments: standInArgs });
        expect(r).toEqual(expect.objectContaining(paymentStepResult(standInStep, "q")));
        expect(remote.calls).toHaveLength(1);
    });
});

describe("paying by link, the gateway stand-in", () => {
    it("answers a link state it did not sign or no longer holds, and forwards it to nobody", async () => {
        const remote = fakeRemote(handled);
        const b = await bridge({
            remote,
            era: "modern",
            deps: { pay: devPay(testPayments(), null) },
        });
        // A client that cannot open links gets the step back, and the bridge has seen it
        await b.client.callTool({ name: "bugnet_start", arguments: standInArgs });
        const forged = linkState(standInStep, testNow).replace(/[0-9a-f]{64}$/, "0".repeat(64));
        const unseen = linkState(
            { ...standInStep, orderId: "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb" },
            testNow,
        );
        const call = (requestState: string) =>
            b.client.request({
                method: "tools/call",
                params: {
                    name: "bugnet_start",
                    arguments: standInArgs,
                    inputResponses: { pay: { action: "accept" } },
                    requestState,
                },
            });
        expect(await call(forged)).toEqual(
            expect.objectContaining(paymentStepResult(standInStep, "q")),
        );
        expect(await call(unseen)).toEqual(
            expect.objectContaining({
                isError: true,
                content: [{ type: "text", text: lostLinkText("bugnet_start") }],
            }),
        );
        expect(remote.calls).toHaveLength(1);
        expect(JSON.stringify(remote.calls.map((c) => c.params))).not.toContain("p1.");
    });

    it("counts a redeemed start of an order it relayed as its own", async () => {
        const mine = "sbx_dddddddddddddddddddddddddd";
        const theirs = "sbx_zzzzzzzzzzzzzzzzzzzzzzzzzz";
        const remote = fakeRemote((p) => {
            if (p.name === "bugnet_start") return stepResult();
            const id = (p.arguments as { orderId: string }).orderId;
            return {
                content: [{ type: "text", text: "fine" }],
                structuredContent: { message: "fine", handle: id === standInOrder ? mine : theirs },
            };
        });
        const started = new Set<string>();
        const b = await bridge({ remote, deps: { started, pay: devPay(testPayments(), null) } });
        await b.client.callTool({ name: "bugnet_start", arguments: standInArgs });
        await b.client.callTool({
            name: "bugnet_redeem",
            arguments: { orderId: "ord_cccccccccccccccccccccccccc", claim: standInClaim },
        });
        expect(started).toEqual(new Set());
        await b.client.callTool({
            name: "bugnet_redeem",
            arguments: { orderId: standInOrder, claim: standInClaim },
        });
        expect(started).toEqual(new Set([mine]));
    });
});
