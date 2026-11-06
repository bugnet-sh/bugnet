import { Code, ConnectError } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
    ExtendPlacementResponseSchema,
    GetPlacementResponseSchema,
    PlacementState,
    WatchJobResponseSchema,
} from "./gen/bugnet/router/v1/router_pb.ts";
import { checkSettings, parseSettings } from "./config.ts";
import { createRouterClient, type RouterClient } from "./router.ts";
import { withToolCall } from "./request.ts";
import {
    callTool,
    connectTools,
    placement,
    testConfig,
    testDeps,
    testHandle,
    type RouterImpl,
} from "./testing/harness.ts";
import { stall, startRouterServer } from "./testing/router-server.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
});

async function routerAt(impl: RouterImpl, timeout: string): Promise<RouterClient> {
    const server = await startRouterServer(impl);
    cleanups.push(() => server.close());
    const config = testConfig(`[router]\nurl = "${server.url}"\ntimeout = "${timeout}"`);
    return createRouterClient(config);
}

// Settles p, or fails once ms pass, so a hung call fails fast instead of at the test timeout
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
    });
    try {
        return await Promise.race([p, late]);
    } finally {
        clearTimeout(timer);
    }
}

describe("router client deadline", () => {
    it("ends a call that sets no deadline at router.timeout", async () => {
        const cancelled: string[] = [];
        const router = await routerAt(
            { createPreview: stall(cancelled, "createPreview") },
            "200ms",
        );
        const started = Date.now();
        const err = await within(
            router.createPreview({ handle: testHandle, port: 3000 }).catch((e: unknown) => e),
            2000,
        );
        expect(ConnectError.from(err).code).toBe(Code.DeadlineExceeded);
        expect(Date.now() - started).toBeLessThan(1500);
    });

    it("turns a stalled router into a tool error well inside 45 s", async () => {
        const cancelled: string[] = [];
        const router = await routerAt(
            { createPreview: stall(cancelled, "createPreview") },
            "200ms",
        );
        const client = await connectTools(testDeps({ router }));
        const r = await within(
            callTool(client, "bugnet_preview", { handle: testHandle, port: 3000 }),
            2000,
        );
        expect(r.isError).toBe(true);
    });

    it("ends every tool call within limits.tool_budget, whatever the router does", async () => {
        const cancelled: string[] = [];
        const router = await routerAt({ getPlacement: stall(cancelled, "getPlacement") }, "30s");
        const config = testConfig('[limits]\ntool_budget = "300ms"\nmax_wait_seconds = 1');
        const client = await connectTools(testDeps({ router, config }));
        const started = Date.now();
        const r = await within(callTool(client, "bugnet_status", { handle: testHandle }), 3000);
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/timed out/);
        expect(Date.now() - started).toBeLessThan(2000);
    });

    it("lets a call set a longer deadline of its own", async () => {
        const router = await routerAt(
            {
                getPlacement: async () => {
                    await new Promise((r) => setTimeout(r, 400));
                    return create(GetPlacementResponseSchema, { placement: placement() });
                },
            },
            "200ms",
        );
        const res = await router.getPlacement({ handle: testHandle }, { timeoutMs: 2000 });
        expect(res.placement?.state).toBe(PlacementState.READY);
    });

    it("keeps bugnet_status's wait past router.timeout", async () => {
        const router = await routerAt(
            {
                getPlacement: async (req) => {
                    if (req.waitMs === 0) {
                        return create(GetPlacementResponseSchema, {
                            placement: placement(PlacementState.PLACING),
                        });
                    }
                    await new Promise((r) => setTimeout(r, 600));
                    return create(GetPlacementResponseSchema, { placement: placement() });
                },
            },
            "200ms",
        );
        const client = await connectTools(testDeps({ router }));
        const r = await callTool(client, "bugnet_status", { handle: testHandle, waitSeconds: 1 });
        expect(r.isError).toBe(false);
        expect(r.text).toMatch(/ready/i);
    });

    it("keeps bugnet_job's follow past router.timeout", async () => {
        const router = await routerAt(
            {
                async *watchJob(_req, ctx) {
                    yield create(WatchJobResponseSchema, { cursor: "c1" });
                    await new Promise((r) => ctx.signal.addEventListener("abort", r));
                },
            },
            "200ms",
        );
        const client = await connectTools(testDeps({ router }));
        const r = await callTool(client, "bugnet_job", {
            handle: testHandle,
            jobId: "j_abcdefghijklmnopqrstuvwxyz",
            waitSeconds: 1,
        });
        expect(r.isError).toBe(false);
        expect(r.structured.state).toBe("running");
    });
});

describe("router client cancellation", () => {
    it("cancels the router call when the client cancels the tool call", async () => {
        const cancelled: string[] = [];
        const router = await routerAt({ createPreview: stall(cancelled, "createPreview") }, "20s");
        const client = await connectTools(testDeps({ router }));
        const stop = new AbortController();
        const call = client
            .callTool(
                { name: "bugnet_preview", arguments: { handle: testHandle, port: 3000 } },
                { signal: stop.signal },
            )
            .catch(() => undefined);
        await new Promise((r) => setTimeout(r, 200));
        stop.abort();
        await call;
        await expect.poll(() => cancelled, { timeout: 1000 }).toEqual(["createPreview"]);
    });
});

describe("router calls after the tool call ended", () => {
    it.each([true, false])("never reach the router, first call %s", async (first) => {
        let ran = 0;
        const router = await routerAt(
            {
                extendPlacement: () => {
                    ran += 1;
                    return create(ExtendPlacementResponseSchema, { placement: placement() });
                },
            },
            "5s",
        );
        const limit = new AbortController();
        const errors: Code[] = [];
        await withToolCall(limit.signal, async () => {
            if (!first) await router.extendPlacement({ handle: testHandle, orderToken: "t" });
            limit.abort(new ConnectError("tool time limit", Code.DeadlineExceeded));
            for (let i = 0; i < 3; i++) {
                await router
                    .extendPlacement({ handle: testHandle, orderToken: "t" })
                    .catch((e: unknown) => errors.push(ConnectError.from(e).code));
            }
        });
        await new Promise((r) => setTimeout(r, 200));
        expect(ran).toBe(first ? 0 : 1);
        expect(errors).toEqual([
            Code.DeadlineExceeded,
            Code.DeadlineExceeded,
            Code.DeadlineExceeded,
        ]);
    });
});

describe("router.timeout setting", () => {
    it("defaults under the 45 s tool limit and refuses one at or over it", () => {
        expect(testConfig().router.timeout).toBe(20_000);
        const at = (t: string) => () =>
            checkSettings(parseSettings(`[payments]\nmode = "dev"\n[router]\ntimeout = "${t}"`));
        expect(at("44s")).not.toThrow();
        for (const bad of ["45s", "50s", "500ms"]) expect(at(bad)).toThrow(/router\.timeout/);
    });
});

describe("limits.tool_budget setting", () => {
    const at = (budget: string, wait: number) => () =>
        checkSettings(
            parseSettings(
                `[payments]\nmode = "dev"\n[limits]\ntool_budget = "${budget}"\n` +
                    `max_wait_seconds = ${wait}\ndefault_wait_seconds = 1`,
            ),
        );

    it("accepts the time bugnet_start's plan needs, up to the 45 s tool limit", () => {
        expect(at("25s", 19)).not.toThrow();
        expect(at("45s", 38)).not.toThrow();
        for (const [budget, wait] of [
            ["5s", 1],
            ["7s", 1],
            ["24999ms", 1],
            ["46s", 38],
        ] as const) {
            expect(at(budget, wait), budget).toThrow(/limits\.tool_budget must be 25s to 45s/);
        }
    });
});
