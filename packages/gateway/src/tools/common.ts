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

// Claude Code refuses tools marked this way in every unattended mode, so test gateways can drop it
export function approvalMeta(deps: Deps): Record<string, unknown> | undefined {
    return deps.config.tools.require_user_approval
        ? { "anthropic/requiresUserInteraction": true }
        : undefined;
}

export function handleHash(handle: string): string {
    return createHash("sha256").update(handle).digest("hex");
}

// Logs carry a short hash, since the handle itself is the sandbox's only credential
export function handleTag(handle: string): string {
    return `h:${handleHash(handle).slice(0, 12)}`;
}

// Exact to the micro, since bugnet_start and bugnet_extend accept only the exact price back
export function usd(micros: number | bigint): string {
    const m = typeof micros === "bigint" ? micros : BigInt(Math.round(micros));
    const abs = m < 0n ? -m : m;
    const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return `${m < 0n ? "-" : ""}$${abs / 1_000_000n}.${frac.padEnd(2, "0")}`;
}

// Claude Code shows the model only structuredContent, so the text leads it as message
export function ok(
    text: string,
    structuredContent: Record<string, unknown> & { message?: never },
    meta?: Record<string, unknown>,
): CallToolResult {
    return {
        content: [{ type: "text", text }],
        structuredContent: { message: text, ...structuredContent },
        ...(meta ? { _meta: meta } : {}),
    };
}

export function failure(err: unknown, what: string): CallToolResult {
    const e = err instanceof GatewayError ? err : fromRouter(err, what);
    const retry =
        e.retryAfterMs !== null ? ` Retry after ${Math.ceil(e.retryAfterMs / 1000)} s.` : "";
    return { content: [{ type: "text", text: `${e.message}.${retry}` }], isError: true };
}

// A bare NotFound is a missing thing on a live sandbox, or an unknown handle on older routers
async function notFound(
    deps: Deps,
    handle: string,
    e: GatewayError,
    what: string,
    missing: string,
): Promise<CallToolResult> {
    try {
        await deps.router.getPlacement({ handle });
    } catch {
        return failure(e, what);
    }
    return failure(new GatewayError("not_found", `${what}: this sandbox has ${missing}`), what);
}

// The router answers NOT_READY for both a starting and an ended sandbox, the placement tells which
export async function sandboxFailure(
    deps: Deps,
    handle: string,
    err: unknown,
    what: string,
    missing?: string,
): Promise<CallToolResult> {
    const e = err instanceof GatewayError ? err : fromRouter(err, what);
    if (e.kind === "not_found" && e.reason === null && missing !== undefined) {
        return notFound(deps, handle, e, what, missing);
    }
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

// Stable across a client's retries of one call, and never starting with _, which the router keeps
export function idempotencyKey(ctx: ServerContext, parts: readonly string[]): string {
    const id = toolUseId(ctx);
    if (id && !id.startsWith("_")) return id;
    return "k1" + createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
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
