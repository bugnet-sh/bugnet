import { createHash } from "node:crypto";
import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Config } from "../config.ts";
import type { Payments } from "../payments/port.ts";
import { PlacementState } from "../gen/bugnet/router/v1/router_pb.ts";
import { GatewayError, fromRouter, type RouterClient } from "../router.ts";
import type { Assessor } from "../assess/assessor.ts";
import type { Log } from "../log.ts";

export interface Deps {
    config: Config;
    router: RouterClient;
    payments: Payments;
    assessor: Assessor;
    log: Log;
    now: () => number;
}

export type Register = (server: McpServer, deps: Deps) => void;

export const handlePattern = /^sbx_[a-z2-7]{26}$/;

export function handleHash(handle: string): string {
    return createHash("sha256").update(handle).digest("hex");
}

// Logs carry a short hash, since the handle itself is the sandbox's only credential
export function handleTag(handle: string): string {
    return `h:${handleHash(handle).slice(0, 12)}`;
}

export function usd(micros: number | bigint): string {
    const n = Number(micros) / 1e6;
    return `$${n.toFixed(n < 1 ? 3 : 2).replace(/0$/, "")}`;
}

export function ok(
    text: string,
    structuredContent: Record<string, unknown>,
    meta?: Record<string, unknown>,
): CallToolResult {
    return {
        content: [{ type: "text", text }],
        structuredContent,
        ...(meta ? { _meta: meta } : {}),
    };
}

export function failure(err: unknown, what: string): CallToolResult {
    const e = err instanceof GatewayError ? err : fromRouter(err, what);
    const retry =
        e.retryAfterMs !== null ? ` Retry after ${Math.ceil(e.retryAfterMs / 1000)} s.` : "";
    return { content: [{ type: "text", text: `${e.message}.${retry}` }], isError: true };
}

// The router answers NOT_READY for both a starting and an ended sandbox, the placement tells which
export async function sandboxFailure(
    deps: Deps,
    handle: string,
    err: unknown,
    what: string,
): Promise<CallToolResult> {
    const e = err instanceof GatewayError ? err : fromRouter(err, what);
    if (e.kind !== "not_ready") return failure(e, what);
    try {
        const p = (await deps.router.getPlacement({ handle })).placement;
        if (p?.state === PlacementState.TERMINATED || p?.state === PlacementState.FAILED) {
            return failure(
                new GatewayError(
                    "expired",
                    `${what}: this sandbox has ended and everything in it was deleted. Quote and ` +
                        "start a new one",
                ),
                what,
            );
        }
        if (p?.state === PlacementState.PLACING) {
            return failure(
                new GatewayError(
                    "not_ready",
                    `${what}: the sandbox is still starting, wait with bugnet_status`,
                ),
                what,
            );
        }
    } catch {
        // The original refusal still explains the failure when the lookup fails too
    }
    return failure(e, what);
}

export function toolUseId(ctx: ServerContext): string | undefined {
    const v = ctx.mcpReq._meta?.["claudecode/toolUseId"];
    return typeof v === "string" && v.length <= 200 ? v : undefined;
}

// Sends progress every few seconds while work runs, so clients keep the call alive
export async function withProgress<T>(
    ctx: ServerContext,
    message: string,
    work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const token = ctx.mcpReq._meta?.progressToken;
    const stop = new AbortController();
    let tick = 0;
    const timer =
        token === undefined
            ? undefined
            : setInterval(() => {
                  tick += 1;
                  ctx.mcpReq
                      .notify({
                          method: "notifications/progress",
                          params: { progressToken: token, progress: tick, message },
                      })
                      .catch(() => {});
              }, 5000);
    try {
        return await work(stop.signal);
    } finally {
        if (timer) clearInterval(timer);
        stop.abort();
    }
}

export function waitMs(deps: Deps, waitSeconds: number | undefined): number {
    const { default_wait_seconds, max_wait_seconds } = deps.config.limits;
    const s = waitSeconds ?? default_wait_seconds;
    return Math.max(0, Math.min(s, max_wait_seconds)) * 1000;
}

export function timeLeft(deadline: Date | undefined, now: number): string {
    if (!deadline) return "not started";
    const s = Math.round((deadline.getTime() - now) / 1000);
    if (s <= 0) return "expired";
    return s >= 120 ? `${Math.floor(s / 60)} min` : `${s} s`;
}
