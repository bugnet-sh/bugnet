// Tool calls that name a sandbox go to its session record, for the map on the session page
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { Code, ConnectError } from "@connectrpc/connect";
import { failedKinds, handleTag, type Deps } from "./tools/common.ts";

const outcomeShape = /^[a-z][a-z0-9_]{0,31}$/;
const sendMs = 2_000;

// The sandbox a call is about: the one a start or redeem made, else its handle argument
function handleOf(name: string, args: unknown, result: CallToolResult | undefined): string | null {
    if ((name === "bugnet_start" || name === "bugnet_redeem") && !result?.isError) {
        const made = (result?.structuredContent as { handle?: unknown } | undefined)?.handle;
        if (typeof made === "string" && made !== "") return made;
    }
    const given = (args as { handle?: unknown } | undefined)?.handle;
    return typeof given === "string" && given !== "" ? given : null;
}

// Answers about the handle itself, which any client can cause, so they are no fault to log
const quiet = new Set([
    Code.Unimplemented,
    Code.NotFound,
    Code.FailedPrecondition,
    Code.PermissionDenied,
    Code.InvalidArgument,
]);

function outcomeOf(result: CallToolResult | undefined): string {
    if (result === undefined) return "internal";
    if (!result.isError) return "ok";
    const kind = failedKinds.get(result);
    if (kind !== undefined && outcomeShape.test(kind)) return kind;
    const fields = result.structuredContent as { payUrl?: unknown } | undefined;
    return typeof fields?.payUrl === "string" ? "payment_required" : "error";
}

// Sent after the answer is ready, on its own deadline, and never able to fail the call
export function recordToolCall(
    deps: Deps,
    name: string,
    args: unknown,
    startedMs: number,
    result: CallToolResult | undefined,
): void {
    const handle = handleOf(name, args, result);
    if (handle === null) return;
    const event = {
        at: timestampFromMs(startedMs),
        tool: name,
        outcome: outcomeOf(result),
        durationMs: Math.max(0, Math.round(deps.now() - startedMs)),
    };
    deps.router
        .appendSessionEvents({ handle, events: [event] }, { timeoutMs: sendMs })
        .then((res) => {
            if (res.rejected.length > 0) {
                deps.log.warn("session event rejected", { handle: handleTag(handle), tool: name });
            }
        })
        .catch((e: unknown) => {
            if (e instanceof ConnectError && quiet.has(e.code)) return;
            deps.log.warn("session event failed", {
                handle: handleTag(handle),
                tool: name,
                err: e instanceof ConnectError ? Code[e.code] : "error",
            });
        });
}
