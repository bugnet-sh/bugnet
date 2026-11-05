import { PlacementState } from "@bugnet/gateway/gen";
import {
    packageOption,
    placement,
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
import { CLIENT_CAPABILITIES_META_KEY, inputRequired } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import type { PaymentSigner, X402PaymentRequired } from "./payment.ts";
import type { CallOptions, RemoteResult, RemoteTools } from "./remote.ts";
import {
    connectBridge,
    fakeGateway,
    grantRouter,
    testHandle,
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
            ? { status: "payment_required", orderId: "o1", paymentRequired: required }
            : {
                  status: "paid",
                  orderId: "o1",
                  orderToken: "order-token",
                  payer: "Payer1",
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
        expect(viaBridge.structuredContent).toEqual(required);
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

    it("lets a payment signer pay once and retries the same call", async () => {
        const gw = await gateway();
        const signed: { required: unknown; tool: string; args: unknown }[] = [];
        const paymentSigner: PaymentSigner = {
            async sign(req, call) {
                signed.push({ required: req, tool: call.tool, args: call.arguments });
                return { x402Version: 2, payload: { transaction: "by-signer" } };
            },
        };
        const b = await bridge({ gateway: gw.url, era, deps: { paymentSigner } });
        const args = startArgs(await quoteId(b.client));
        const r = await b.client.callTool({
            name: "bugnet_start",
            arguments: args,
            _meta: { "claudecode/toolUseId": "toolu_signed" },
        });
        expect(r.isError).toBeFalsy();
        expect(signed).toEqual([{ required, tool: "bugnet_start", args }]);
        expect(gw.payments.orders.map((o) => [o.idempotencyKey, o.payment])).toEqual([
            ["toolu_signed", undefined],
            ["toolu_signed", { x402Version: 2, payload: { transaction: "by-signer" } }],
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

    it("lists only its own tool while the gateway is down, then says when that changes", async () => {
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

    for (const era of ["legacy", "modern"] as const) {
        it(`hands the gateway's input requests to a ${era} client and returns its answer`, async () => {
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
