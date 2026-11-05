import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callTool, connectTools, testDeps } from "../testing/harness.ts";
import { idempotencyKey, ok, type Register } from "./common.ts";

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
