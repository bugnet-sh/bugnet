import { createHash } from "node:crypto";
import { Code } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    callTool,
    connectTools,
    fakeRouter,
    placement,
    routerError,
    testDeps,
    testHandle,
    type RouterImpl,
} from "../testing/harness.ts";
import { idempotencyKey, ok, usd, type Register } from "./common.ts";

const keyTool: Register = (server) => {
    server.registerTool(
        "test_key",
        { description: "Returns the idempotency key", inputSchema: z.object({ path: z.string() }) },
        async (args, ctx) =>
            ok("key", { key: idempotencyKey(ctx, ["sbx_x", "upload", args.path]) }),
    );
};

async function keyFor(path: string, toolUseId?: string): Promise<string> {
    const client = await connectTools(testDeps(), [keyTool]);
    const r = await callTool<{ key: string }>(client, "test_key", { path }, { toolUseId });
    return r.structured.key;
}

describe("ok", () => {
    it("leads the structured result with the text as message", () => {
        const r = ok("Sandbox ready.", { handle: "h", state: "ready" }, { m: 1 });
        expect(Object.keys(r.structuredContent as object)).toEqual(["message", "handle", "state"]);
        expect(r.structuredContent).toEqual({
            message: "Sandbox ready.",
            handle: "h",
            state: "ready",
        });
        expect(r.content).toEqual([{ type: "text", text: "Sandbox ready." }]);
        expect(r._meta).toEqual({ m: 1 });
        expect(ok("x", {})._meta).toBeUndefined();
    });
});

describe("usd", () => {
    it("shows the exact price, so the price shown is the price accepted", () => {
        expect(usd(50_000)).toBe("$0.05");
        expect(usd(52_500)).toBe("$0.0525");
        expect(usd(10_500n)).toBe("$0.0105");
        expect(usd(1_234_000)).toBe("$1.234");
        expect(usd(1_200_000)).toBe("$1.20");
        expect(usd(1)).toBe("$0.000001");
        expect(usd(0)).toBe("$0.00");
    });
});

describe("idempotencyKey", () => {
    it("uses Claude Code's tool use id when the call carries one", async () => {
        expect(await keyFor("a.txt", "toolu_01ABC")).toBe("toolu_01ABC");
    });

    it("hashes the parts otherwise, the same parts giving the same key", async () => {
        const want =
            "k1" + createHash("sha256").update("sbx_x\0upload\0a.txt").digest("hex").slice(0, 32);
        const key = await keyFor("a.txt");
        expect(key).toBe(want);
        expect(key).toMatch(/^k1[0-9a-f]{32}$/);
        expect(await keyFor("a.txt")).toBe(key);
        expect(await keyFor("b.txt")).not.toBe(key);
    });

    it("never hands the router a key starting with an underscore", async () => {
        expect(await keyFor("a.txt", "_router_job")).toMatch(/^k1/);
    });
});

describe("NotFound answers", () => {
    async function answer(tool: string, args: Record<string, unknown>, impl: RouterImpl) {
        const lookups: string[] = [];
        const client = await connectTools(
            testDeps({
                router: fakeRouter({
                    getPlacement: (req) => {
                        lookups.push(req.handle);
                        return { placement: placement() };
                    },
                    ...impl,
                }),
            }),
        );
        const r = await callTool(client, tool, { handle: testHandle, ...args });
        return { text: r.text, lookups: lookups.length };
    }

    const job = { jobId: "j9" };

    it("names an unknown job from JOB_UNKNOWN without looking the sandbox up", async () => {
        const r = await answer("bugnet_cancel_job", job, {
            cancelJob() {
                throw routerError(Code.NotFound, "JOB_UNKNOWN");
            },
        });
        expect(r.text).toBe(
            "cancel: this sandbox has no job with that id, bugnet_exec gives the jobId of each " +
                "command.",
        );
        expect(r.lookups).toBe(0);
    });

    it("names an unknown handle from HANDLE_UNKNOWN without looking it up", async () => {
        const r = await answer("bugnet_cancel_job", job, {
            cancelJob() {
                throw routerError(Code.NotFound, "HANDLE_UNKNOWN");
            },
        });
        expect(r.text).toBe(
            "cancel: no sandbox has this handle. Check it was copied in full, or quote and " +
                "start a new one.",
        );
        expect(r.lookups).toBe(0);
    });

    it("looks the sandbox up on a bare NotFound, as older routers send it", async () => {
        const r = await answer(
            "bugnet_read_file",
            { path: "a.txt" },
            {
                readFile() {
                    throw routerError(Code.NotFound);
                },
            },
        );
        expect(r.text).toBe("read file: this sandbox has no file or directory at that path.");
        expect(r.lookups).toBe(1);
    });

    it.each([
        ["bugnet_preview", { port: 3000 }, "createPreview", "preview"],
        ["bugnet_fetch_source", {}, "fetchSource", "fetch source"],
        ["bugnet_secret_link", { name: "HF_TOKEN" }, "createSecretLink", "secret link"],
        ["bugnet_secrets", {}, "listSecrets", "secrets"],
    ])("words a bare NotFound from %s as an unknown handle", async (tool, args, rpc, what) => {
        const r = await answer(tool, args, {
            [rpc]() {
                throw routerError(Code.NotFound);
            },
        });
        expect(r.text).toBe(
            `${what}: no sandbox has this handle. Check it was copied in full, or quote and ` +
                "start a new one.",
        );
    });
});
