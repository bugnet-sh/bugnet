import { timestampMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { signQuote } from "./quote.ts";
import type { AppendSessionEventsRequest } from "./gen/bugnet/router/v1/router_pb.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    packageOption,
    placement,
    recordingLog,
    routerError,
    testDeps,
    testHandle,
    testNow,
    testPayments,
    type RouterImpl,
} from "./testing/harness.ts";
import type { Deps, Register } from "./tools/common.ts";
import { handleTag } from "./tools/common.ts";
import { recordToolCall } from "./sessionevents.ts";

function setup(impl: RouterImpl, append?: RouterImpl["appendSessionEvents"]) {
    const sent: AppendSessionEventsRequest[] = [];
    const { log, lines } = recordingLog();
    const deps = testDeps({
        router: fakeRouter({
            ...impl,
            ...(append === undefined
                ? {
                      appendSessionEvents: (req: AppendSessionEventsRequest) => {
                          sent.push(req);
                          return { rejected: [] };
                      },
                  }
                : { appendSessionEvents: append }),
        }),
        log,
    });
    return { deps, sent, lines };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("session events", () => {
    it("sends one event for a call that names a sandbox, with no arguments in it", async () => {
        const { deps, sent } = setup({ getPlacement: () => ({ placement: placement() }) });
        const r = await callTool(await connectTools(deps), "bugnet_status", { handle: testHandle });
        expect(r.isError).toBe(false);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        await settle();
        expect(sent).toHaveLength(1);
        const req = sent[0] as AppendSessionEventsRequest;
        expect(req.handle).toBe(testHandle);
        expect(req.events).toHaveLength(1);
        const ev = req.events[0];
        expect(ev?.tool).toBe("bugnet_status");
        expect(ev?.outcome).toBe("ok");
        expect(ev?.at && timestampMs(ev.at)).toBe(testNow);
        expect(Object.keys(ev ?? {}).sort()).toEqual(
            ["$typeName", "at", "durationMs", "outcome", "tool"].sort(),
        );
    });

    it("sends the gateway's error kind as the outcome of a failed call", async () => {
        const { deps, sent } = setup({
            getPlacement: () => {
                throw routerError(Code.PermissionDenied);
            },
        });
        const r = await callTool(await connectTools(deps), "bugnet_status", { handle: testHandle });
        expect(r.isError).toBe(true);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        const outcome = sent[0]?.events[0]?.outcome ?? "";
        expect(outcome).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
        expect(outcome).not.toBe("ok");
        expect(outcome).not.toBe("error");
    });

    it("takes a start's handle from its answer, once the sandbox exists", async () => {
        const { deps, sent } = setup({});
        const made = { content: [], structuredContent: { handle: testHandle } };
        recordToolCall(deps, "bugnet_start", { quoteId: "q" }, testNow, made);
        recordToolCall(deps, "bugnet_start", { quoteId: "q" }, testNow, {
            content: [],
            isError: true,
            structuredContent: { payUrl: "https://pay.bugnet.sh/o/ord_1" },
        });
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]?.handle).toBe(testHandle);
    });

    it("sends one internal event for a handler that throws, and keeps its error", async () => {
        const { deps, sent } = setup({});
        const boom: Register = (server) => {
            const input = z.object({ handle: z.string() });
            server.registerTool("test_throws", { description: "x", inputSchema: input }, () => {
                throw new Error("handler broke");
            });
        };
        const client = await connectTools(deps, [boom]);
        const r = await client
            .callTool({ name: "test_throws", arguments: { handle: testHandle } })
            .catch((e: unknown) => e);
        expect(JSON.stringify(r)).toContain("handler broke");
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        await settle();
        expect(sent).toHaveLength(1);
        expect(sent[0]?.events[0]?.outcome).toBe("internal");
    });

    function startDeps(paid: boolean): { deps: Deps; sent: AppendSessionEventsRequest[] } {
        const { deps, sent } = setup({
            estimate: () => ({ options: [packageOption("small-10m", 50_000n)] }),
            createPlacement: () => ({ handle: testHandle, placement: placement() }),
            getPlacement: () => ({ placement: placement() }),
        });
        deps.payments = testPayments(undefined, { requirePayment: !paid });
        return { deps, sent };
    }
    const startArgs = (deps: Deps) => ({
        quoteId: signQuote(deps.config.secrets.quoteKey, {
            requirements: { ssh: false, preview: false, gpu: false, secrets: false },
            github: false,
            estimateId: null,
            expiresAt: testNow + 5 * 60_000,
        }),
        packageId: "small-10m",
        confirmPriceUsd: "0.05",
    });

    it("sends a started sandbox's event to the handle the start made", async () => {
        const { deps, sent } = startDeps(true);
        const r = await callTool(await connectTools(deps), "bugnet_start", startArgs(deps));
        expect(r.isError).toBe(false);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        await settle();
        expect(sent).toHaveLength(1);
        expect(sent[0]?.handle).toBe(testHandle);
        expect(sent[0]?.events[0]?.tool).toBe("bugnet_start");
    });

    it("sends nothing for a start that answers with a payment step", async () => {
        const { deps, sent } = startDeps(false);
        const r = await callTool(await connectTools(deps), "bugnet_start", startArgs(deps));
        expect(r.isError).toBe(true);
        await settle();
        expect(sent).toHaveLength(0);
    });

    it("prefers the handle a redeem made over a handle it was given", async () => {
        const { deps, sent } = setup({});
        const made = { content: [], structuredContent: { handle: "sbx_made" } };
        recordToolCall(deps, "bugnet_redeem", { handle: testHandle }, testNow, made);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]?.handle).toBe("sbx_made");
    });

    it("sends nothing for free tools that take no handle", async () => {
        const { deps, sent } = setup({});
        const client = await connectTools(deps);
        await callTool(client, "bugnet_quote", { workload: "script" });
        await new Promise((r) => setTimeout(r, 50));
        expect(sent).toHaveLength(0);
    });

    it("logs a failed send with the handle tag only, and leaves the answer alone", async () => {
        const { deps, lines } = setup({ getPlacement: () => ({ placement: placement() }) }, () => {
            throw routerError(Code.Unavailable);
        });
        const r = await callTool(await connectTools(deps), "bugnet_status", { handle: testHandle });
        expect(r.isError).toBe(false);
        await vi.waitFor(() => expect(lines.join("\n")).toContain("session event failed"));
        const all = lines.join("\n");
        expect(all).toContain(handleTag(testHandle));
        expect(all).not.toContain(testHandle);
    });

    for (const code of [Code.Unimplemented, Code.NotFound, Code.FailedPrecondition]) {
        it(`stays quiet when the router answers ${Code[code]} about the handle`, async () => {
            const { deps, lines } = setup(
                { getPlacement: () => ({ placement: placement() }) },
                () => {
                    throw routerError(code);
                },
            );
            await callTool(await connectTools(deps), "bugnet_status", { handle: testHandle });
            await settle();
            expect(lines.join("\n")).not.toContain("session event");
        });
    }
});
