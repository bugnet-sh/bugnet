import { timestampMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import type { AppendSessionEventsRequest } from "./gen/bugnet/router/v1/router_pb.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    placement,
    recordingLog,
    routerError,
    testDeps,
    testHandle,
    testNow,
    type RouterImpl,
} from "./testing/harness.ts";
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

describe("session events", () => {
    it("sends one event for a call that names a sandbox, with no arguments in it", async () => {
        const { deps, sent } = setup({ getPlacement: () => ({ placement: placement() }) });
        const r = await callTool(await connectTools(deps), "bugnet_status", { handle: testHandle });
        expect(r.isError).toBe(false);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
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

    it("stays quiet when the router has no session records", async () => {
        const { deps, lines } = setup({ getPlacement: () => ({ placement: placement() }) }, () => {
            throw routerError(Code.Unimplemented);
        });
        await callTool(await connectTools(deps), "bugnet_status", { handle: testHandle });
        await new Promise((r) => setTimeout(r, 50));
        expect(lines.join("\n")).not.toContain("session event");
    });
});
