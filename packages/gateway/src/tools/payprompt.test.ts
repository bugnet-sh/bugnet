import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, type ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { PlacementState, type CreatePlacementRequest } from "../gen/bugnet/router/v1/router_pb.ts";
import { buildMcpServer } from "../server.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    packageOption,
    placement,
    testDeps,
    testHandle,
    testNow,
    testPayments,
    type TestPayments,
} from "../testing/harness.ts";
import type { Deps } from "./common.ts";
import { signPromptState, takesUrlPrompt, verifyPromptState } from "./payprompt.ts";

const key = Buffer.alloc(32, 7);
const orderId = "ord_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const claim = "C".repeat(43);

function withEnvelope(caps: unknown, client = "claude-code"): ServerContext {
    return {
        mcpReq: {
            envelope: {
                "io.modelcontextprotocol/clientCapabilities": caps,
                "io.modelcontextprotocol/clientInfo": { name: client, version: "1" },
            },
        },
    } as unknown as ServerContext;
}

describe("the pay prompt's state", () => {
    it("comes back only signed by this key, unchanged and before it expires", () => {
        const state = signPromptState(key, testNow, orderId, claim);
        expect(verifyPromptState(key, testNow, state)).toEqual({ orderId, claim });
        expect(verifyPromptState(Buffer.alloc(32, 8), testNow, state)).toBeNull();
        const other = state.replace(orderId, "ord_bbbbbbbbbbbbbbbbbbbbbbbbbb");
        expect(verifyPromptState(key, testNow, other)).toBeNull();
        expect(verifyPromptState(key, testNow + 31 * 60_000, state)).toBeNull();
        expect(verifyPromptState(key, testNow, "p1.x.y.z")).toBeNull();
    });
});

describe("takesUrlPrompt", () => {
    it("holds only for a request that declares URL elicitation", () => {
        expect(takesUrlPrompt(withEnvelope({ elicitation: { form: {}, url: {} } }))).toBe(true);
        expect(takesUrlPrompt(withEnvelope({ elicitation: { form: {} } }))).toBe(false);
        expect(takesUrlPrompt(withEnvelope({ elicitation: {} }))).toBe(false);
        expect(takesUrlPrompt(withEnvelope(undefined))).toBe(false);
        expect(takesUrlPrompt({ mcpReq: {} } as unknown as ServerContext)).toBe(false);
        const url = { elicitation: { url: {} } };
        expect(takesUrlPrompt(withEnvelope(url, "bugnet-bridge"))).toBe(false);
    });
});

type Answer = "accept" | "decline" | "cancel";

interface Prompted {
    client: Client;
    deps: Deps;
    payments: TestPayments;
    asked: { url: string; message: string }[];
}

// A client on the 2026-07-28 protocol that shows URL prompts, as Claude Code does
async function promptingClient(
    answer: (payments: TestPayments, url: string) => Answer,
): Promise<Prompted> {
    const payments = testPayments(undefined, { requirePayment: true });
    const deps = testDeps({
        router: fakeRouter({
            estimate: () => ({ options: [packageOption("small-10m", 50_000n)] }),
            createPlacement: (_req: CreatePlacementRequest) => ({
                handle: testHandle,
                placement: placement(PlacementState.PLACING),
            }),
            getPlacement: () => ({ placement: placement(PlacementState.READY) }),
        }),
        payments,
        sleep: async () => {},
    });
    // The gateway's own stateless HTTP handler, reached without a socket
    const handler = createMcpHandler(() => buildMcpServer(deps), { legacy: "stateless" });
    const transport = new StreamableHTTPClientTransport(new URL("http://gateway.test/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const client = new Client(
        { name: "test", version: "0" },
        {
            capabilities: { elicitation: { url: {} } },
            versionNegotiation: { mode: { pin: "2026-07-28" } },
        },
    );
    const asked: { url: string; message: string }[] = [];
    client.setRequestHandler("elicitation/create", async (req) => {
        const p = req.params as { url: string; message: string };
        asked.push({ url: p.url, message: p.message });
        return { action: answer(payments, p.url) };
    });
    await client.connect(transport);
    return { client, deps, payments, asked };
}

async function start(c: Prompted) {
    const q = await callTool<{ quoteId: string }>(c.client, "bugnet_quote", {
        workload: "script",
    });
    const id = q.structured.quoteId;
    return callTool<Record<string, unknown>>(c.client, "bugnet_start", {
        quoteId: id,
        packageId: "small-10m",
        confirmPriceUsd: "0.05",
    });
}

function lastOrder(p: TestPayments): string {
    const id = (p.orders.at(-1) as { orderId?: string } | undefined)?.orderId;
    if (id) return id;
    throw new Error("no order with an id was asked for");
}

describe("bugnet_start on a client that shows URL prompts", () => {
    it("shows the pay link as a prompt and starts the sandbox once it is paid", async () => {
        let paid = "";
        const c = await promptingClient((payments, url) => {
            // The user pays in the browser, then goes on from the prompt
            paid = url.split("/o/")[1] ?? "";
            payments.dev.pay(paid);
            return "accept";
        });
        const r = await start(c);
        expect(c.asked).toEqual([
            {
                url: `http://127.0.0.1:8787/o/${paid}`,
                message: "Pay $0.05 USDC to start your Bugnet sandbox",
            },
        ]);
        expect(r.isError).toBe(false);
        expect(r.structured).toEqual(expect.objectContaining({ handle: testHandle }));
        const kinds = c.payments.orders.map((o) => ("kind" in o ? o.kind : "claim"));
        // One order is made, and the repeated call only reads it by its claim
        expect(kinds.filter((k) => k === "start")).toHaveLength(1);
        expect(lastOrder(c.payments)).toBe(paid);
    });

    it("keeps the order and names it when the payment has not landed", async () => {
        const c = await promptingClient(() => "accept");
        const r = await start(c);
        expect(r.isError).toBe(true);
        const id = c.asked[0]?.url.split("/o/")[1] ?? "";
        expect(r.text).toContain(
            `Order ${id} is not paid yet, and a payment can take a few seconds to confirm. The ` +
                `user has its pay link from a prompt: http://127.0.0.1:8787/o/${id}. Call ` +
                `bugnet_redeem with orderId and claim (orderId "${id}", claim "`,
        );
        expect(c.payments.orders.filter((o) => "kind" in o && o.kind === "start")).toHaveLength(1);
    });

    it("asks the agent to check with the user when the prompt is closed", async () => {
        for (const answer of ["decline", "cancel"] as const) {
            const c = await promptingClient(() => answer);
            const r = await start(c);
            expect(r.isError).toBe(true);
            expect(r.text).toMatch(/Order ord_\w+ is not paid, and the user closed the pay prompt/);
            expect(r.text).toMatch(/Ask whether they still want the sandbox/);
        }
    });

    it("gives a client without URL prompts the payment step as before", async () => {
        const payments = testPayments(undefined, { requirePayment: true });
        const deps = testDeps({
            router: fakeRouter({
                estimate: () => ({ options: [packageOption("small-10m", 50_000n)] }),
            }),
            payments,
        });
        const client = await connectTools(deps);
        const q = await callTool<{ quoteId: string }>(client, "bugnet_quote", {
            workload: "script",
        });
        const r = await callTool(client, "bugnet_start", {
            quoteId: q.structured.quoteId,
            packageId: "small-10m",
            confirmPriceUsd: "0.05",
        });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/Next: show the user this link to pay/);
    });
});
