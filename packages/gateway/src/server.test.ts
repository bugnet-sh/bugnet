import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startHttp } from "./server.ts";
import { checkSettings, parseSettings } from "./config.ts";
import type { AwaitingPayment, Payments } from "./payments/port.ts";
import { connectTools, testConfig, testDeps, testPayments } from "./testing/harness.ts";

const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

describe("the /mcp endpoint's browser rules", () => {
    const stops: (() => Promise<void>)[] = [];
    afterEach(async () => {
        for (const stop of stops.splice(0)) await stop();
    });

    async function post(headers: Record<string, string>, toml = ""): Promise<Response> {
        const deps = testDeps({ config: testConfig(`listen_addr = "127.0.0.1:0"\n${toml}`) });
        const http = await startHttp(deps);
        stops.push(() => new Promise((r) => http.close(() => r())));
        const { port } = http.address() as AddressInfo;
        return fetch(`http://127.0.0.1:${port}/mcp`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": "2025-06-18",
                ...headers,
            },
            body: JSON.stringify(list),
        });
    }

    it("answers a client that sends no Origin, and forbids framing", async () => {
        const r = await post({});
        expect(r.status).toBe(200);
        expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    });

    it("accepts its own origin", async () => {
        const r = await post({ origin: "http://127.0.0.1:8787", "sec-fetch-site": "same-origin" });
        expect(r.status).toBe(200);
    });

    it.each([
        [{ origin: "https://abcdefghijklmnop.preview.bugnet.sh", "sec-fetch-site": "same-site" }],
        [{ origin: "https://evil.example" }],
        [{ "sec-fetch-site": "same-site" }],
        [{ "sec-fetch-site": "cross-site" }],
    ])("refuses a browser request from another site %#", async (headers) => {
        const r = await post(headers);
        expect(r.status).toBe(403);
        expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    });

    it.each(["https://claude.ai", "https://claude.ai/"])(
        "answers the hosted client origin %s, as claude.ai's connector sends it",
        async (origin) => {
            const r = await post({ origin });
            expect(r.status).toBe(200);
        },
    );

    it.each([
        [{ origin: "null" }],
        [{ origin: "https://claude.ai", "sec-fetch-site": "cross-site" }],
        [{ origin: "https://claude.ai.evil.example" }],
        [{ origin: "http://claude.ai" }],
        [{ origin: "https://abcdefghijklmnop.preview.bugnet.sh" }],
    ])("still refuses an origin outside allowed_origins %#", async (headers) => {
        const r = await post(headers);
        expect(r.status).toBe(403);
    });

    it("refuses claude.ai once allowed_origins is emptied", async () => {
        const r = await post({ origin: "https://claude.ai" }, "allowed_origins = []");
        expect(r.status).toBe(403);
    });

    it("refuses an allowed origin that is not https or sits under links_domain", () => {
        const at = (list: string) => () =>
            checkSettings(
                parseSettings(
                    `[payments]\nmode = "dev"\n`.replace(/^/, `allowed_origins = ${list}\n`),
                ),
            );
        expect(at('["https://claude.ai", "https://chatgpt.com/"]')).not.toThrow();
        for (const bad of [
            '["http://claude.ai"]',
            '["https://claude.ai/path"]',
            '["https://x.preview.bugnet.sh"]',
            '["https://bugnet.sh"]',
            '["null"]',
        ]) {
            expect(at(bad), bad).toThrow(/allowed_origins/);
        }
    });

    it("ignores a cookie jar larger than node's default header limit", async () => {
        const cookie = Array.from({ length: 40 }, (_, i) => `c${i}=${"x".repeat(1000)}`).join("; ");
        const r = await post({ cookie });
        expect(r.status).toBe(200);
    });

    it("asks to clear bugnet.sh cookies when the jar is past the header limit", async () => {
        const cookie = Array.from({ length: 90 }, (_, i) => `c${i}=${"x".repeat(1000)}`).join("; ");
        const r = await post({ cookie });
        expect(r.status).toBe(431);
        expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
        expect(await r.text()).toMatch(/clear the cookies for bugnet\.sh/i);
    });
});

describe("the gateway's other paths", () => {
    const stops: (() => Promise<void>)[] = [];
    afterEach(async () => {
        for (const stop of stops.splice(0)) await stop();
    });

    async function request(method: string, path: string, toml = ""): Promise<Response> {
        const deps = testDeps({ config: testConfig(`listen_addr = "127.0.0.1:0"\n${toml}`) });
        const http = await startHttp(deps);
        stops.push(() => new Promise((r) => http.close(() => r())));
        const { port } = http.address() as AddressInfo;
        return fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: "manual" });
    }

    it.each(["GET", "HEAD"])("sends %s / to the home page", async (method) => {
        const r = await request(method, "/");
        expect(r.status).toBe(302);
        expect(r.headers.get("location")).toBe("https://bugnet.sh/");
        expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    });

    it("sends / to the home_url setting, and answers not found when it is empty", async () => {
        const dev = await request("GET", "/?x=1", `home_url = "https://dev.bugnet.sh/"`);
        expect(dev.headers.get("location")).toBe("https://dev.bugnet.sh/");
        expect((await request("GET", "/", `home_url = ""`)).status).toBe(404);
    });

    it("answers not found for other paths and methods", async () => {
        expect((await request("POST", "/")).status).toBe(404);
        expect((await request("GET", "/index.html")).status).toBe(404);
        expect((await request("GET", "/healthz")).status).toBe(200);
    });
});

describe("dev pay links", () => {
    const stops: (() => Promise<void>)[] = [];
    afterEach(async () => {
        for (const stop of stops.splice(0)) await stop();
    });

    async function serve(payments: Payments): Promise<string> {
        const deps = testDeps({ config: testConfig('listen_addr = "127.0.0.1:0"'), payments });
        const http = await startHttp(deps);
        stops.push(() => new Promise((r) => http.close(() => r())));
        return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    }

    it("marks a dev order paid at its pay link and reports it at /status", async () => {
        const tp = testPayments(undefined, { requirePayment: true });
        const base = await serve(tp.dev);
        const r = (await tp.dev.order({
            kind: "start",
            packageId: "small-10m",
            amountMicros: 50_000,
            description: "d",
        })) as AwaitingPayment;
        const before = await fetch(`${base}/o/${r.orderId}/status`);
        expect(before.status).toBe(200);
        expect(before.headers.get("content-type")).toBe("application/json");
        expect(await before.json()).toEqual({
            orderId: r.orderId,
            state: "unpaid",
            expiresAt: "2026-11-05T12:15:00.000Z",
        });
        const paid = await fetch(`${base}/o/${r.orderId}`);
        expect(paid.status).toBe(200);
        expect(await paid.json()).toEqual({ paid: true, orderId: r.orderId });
        const posted = await fetch(`${base}/o/${r.orderId}`, { method: "POST" });
        expect(await posted.json()).toEqual({ paid: true, orderId: r.orderId });
        const after = await fetch(`${base}/o/${r.orderId}/status`);
        expect(((await after.json()) as { state: string }).state).toBe("paid");
        const unknown = await fetch(`${base}/o/ord_${"a".repeat(26)}`);
        expect(unknown.status).toBe(404);
        expect(await unknown.json()).toEqual({ error: "order_unknown" });
    });

    it("answers not found at /o/ unless dev payments ask for payment", async () => {
        for (const payments of [testPayments(), testPayments().dev]) {
            const base = await serve(payments);
            for (const path of ["/o/ord_x", "/o/ord_x/status"]) {
                const r = await fetch(`${base}${path}`);
                expect(r.status).toBe(404);
                expect(await r.text()).toBe("not found\n");
            }
        }
    });
});

describe("x402 tools", () => {
    it("registers bugnet_x402_find only when [x402] enabled is true", async () => {
        const names = async (toml: string) =>
            (
                await (await connectTools(testDeps({ config: testConfig(toml) }))).listTools()
            ).tools.map((t) => t.name);
        expect(await names("")).not.toContain("bugnet_x402_find");
        expect(await names("[x402]\nenabled = true")).toContain("bugnet_x402_find");
    });
});
