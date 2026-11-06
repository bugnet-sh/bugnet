import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startHttp } from "./server.ts";
import { checkSettings, parseSettings } from "./config.ts";
import { testConfig, testDeps } from "./testing/harness.ts";

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
});
