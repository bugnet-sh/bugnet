import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { PlacementState } from "../gen/bugnet/router/v1/router_pb.ts";
import { urlPromptClient } from "../request.ts";
import { startHttp } from "../server.ts";
import {
    callTool,
    fakeRouter,
    packageOption,
    placement,
    testConfig,
    testDeps,
    testHandle,
    testNow,
    testPayments,
    type TestPayments,
} from "../testing/harness.ts";
import { promptId } from "./payprompt.ts";

const claudeCode = "claude-code/2.1.326 (cli)";

describe("urlPromptClient", () => {
    it("holds only for Claude Code on protocol 2025-11-25 or later", () => {
        expect(urlPromptClient(claudeCode, "2025-11-25")).toBe(true);
        expect(urlPromptClient(claudeCode, "2025-06-18")).toBe(false);
        expect(urlPromptClient(claudeCode, undefined)).toBe(false);
        expect(urlPromptClient("node", "2025-11-25")).toBe(false);
        expect(urlPromptClient(undefined, "2025-11-25")).toBe(false);
    });
});

interface Run {
    client: Client;
    payments: TestPayments;
    asked: { url: string; message: string; elicitationId: string }[];
    closed: string[];
}

const servers: Server[] = [];
afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

// The gateway on a local port, called as Claude Code or as another client
async function run(
    userAgent: string,
    onPrompt: (payments: TestPayments, id: string) => void,
): Promise<Run> {
    const payments = testPayments(undefined, { requirePayment: true });
    const clock = { now: testNow };
    const deps = testDeps({
        config: testConfig('listen_addr = "127.0.0.1:0"\npublic_url = "http://127.0.0.1"\n'),
        router: fakeRouter({
            estimate: () => ({ options: [packageOption("small-10m", 50_000n)] }),
            createPlacement: () => ({
                handle: testHandle,
                placement: placement(PlacementState.PLACING),
            }),
            getPlacement: () => ({ placement: placement(PlacementState.READY) }),
        }),
        payments,
        now: () => clock.now,
        // Each look moves the clock on, so the wait for a payment that never lands ends
        sleep: async (ms) => {
            clock.now += ms;
            await new Promise((r) => setImmediate(r));
        },
    });
    const http = await startHttp(deps);
    servers.push(http);
    const port = (http.address() as AddressInfo).port;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        fetch: (url, init) => {
            const headers = new Headers(init?.headers);
            headers.set("user-agent", userAgent);
            return fetch(url, { ...init, headers });
        },
    });
    const client = new Client(
        { name: "test", version: "0" },
        { capabilities: { elicitation: { url: {} } } },
    );
    const asked: Run["asked"] = [];
    const closed: string[] = [];
    client.setRequestHandler("elicitation/create", async (req) => {
        const p = req.params as { url: string; message: string; elicitationId: string };
        asked.push({ url: p.url, message: p.message, elicitationId: p.elicitationId });
        onPrompt(payments, p.url.split("/o/")[1] ?? "");
        return { action: "accept" };
    });
    client.setNotificationHandler("notifications/elicitation/complete", (n) => {
        closed.push((n.params as { elicitationId: string }).elicitationId);
    });
    await client.connect(transport);
    return { client, payments, asked, closed };
}

async function start(r: Run) {
    const q = await callTool<{ quoteId: string }>(r.client, "bugnet_quote", { workload: "script" });
    return callTool<Record<string, unknown>>(r.client, "bugnet_start", {
        quoteId: q.structured.quoteId,
        packageId: "small-10m",
        confirmPriceUsd: "0.05",
    });
}

const startOrders = (p: TestPayments) => p.orders.filter((o) => "kind" in o && o.kind === "start");

describe("bugnet_start in Claude Code", () => {
    it("shows the pay link as a prompt, closes it once paid and starts the sandbox", async () => {
        const r = await run(claudeCode, (payments, id) => void payments.dev.pay(id));
        const res = await start(r);
        const id = r.asked[0]?.url.split("/o/")[1] ?? "";
        expect(r.asked).toEqual([
            {
                url: `http://127.0.0.1:8787/o/${id}`,
                message: "Pay $0.05 USDC to start your Bugnet sandbox",
                elicitationId: promptId(id),
            },
        ]);
        expect(r.closed).toEqual([promptId(id)]);
        expect(res.isError).toBe(false);
        expect(res.structured).toEqual(expect.objectContaining({ handle: testHandle }));
        expect(startOrders(r.payments)).toHaveLength(1);
    });

    it("closes the prompt and names the order when the wait runs out unpaid", async () => {
        const r = await run(claudeCode, () => {});
        const res = await start(r);
        const id = r.asked[0]?.url.split("/o/")[1] ?? "";
        expect(r.closed).toEqual([promptId(id)]);
        expect(res.isError).toBe(true);
        expect(res.text).toContain(
            `Order ${id} is not paid yet, and a payment can take a few seconds to confirm. The ` +
                `user has its pay link from a prompt: http://127.0.0.1:8787/o/${id}. Call ` +
                `bugnet_redeem with orderId and claim (orderId "${id}", claim "`,
        );
        expect(startOrders(r.payments)).toHaveLength(1);
    });

    it("gives any other client the payment step at once, with no prompt", async () => {
        const r = await run("node", (payments, id) => void payments.dev.pay(id));
        const res = await start(r);
        expect(r.asked).toEqual([]);
        expect(res.isError).toBe(true);
        expect(res.text).toMatch(/Next: show the user this link to pay/);
    });
});
