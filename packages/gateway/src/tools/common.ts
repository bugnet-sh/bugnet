import { createHash, randomBytes } from "node:crypto";
import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Payments } from "../payments/port.ts";
import { PlacementState } from "../gen/bugnet/router/v1/router_pb.ts";
import { GatewayError, errorReason, fromRouter, type RouterClient } from "../router.ts";
import type { Fetcher } from "../assess/fetch.ts";
import type { Assessor } from "../assess/assessor.ts";
import type { Log } from "../log.ts";
import type { Tracing } from "../trace.ts";
import type { X402Index } from "../x402/index.ts";

export interface Deps {
    config: Config;
    router: RouterClient;
    payments: Payments;
    assessor: Assessor;
    log: Log;
    now: () => number;
    tracing?: Tracing;
    // Tests replace the safe fetcher that x402 probes and searches use
    x402Fetch?: Fetcher;
    // Tests replace the built-in x402 index
    x402Index?: X402Index;
    // Tests replace the pause between looks at an order that waits for its payment
    sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

export type Register = (server: McpServer, deps: Deps) => void;

export const handlePattern = /^sbx_[a-z2-7]{26}$/;
// Data-plane 9.2, bn- and 10 lower-case base32 characters
export const sshAliasPattern = /^bn-[a-z2-7]{10}$/;

export const handleInput = z.string().regex(handlePattern, "a sandbox handle starting with sbx_");

export function iso(t: Timestamp | undefined): string | null {
    return t ? timestampDate(t).toISOString() : null;
}

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

export { usd } from "../money.ts";

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

// The body sits in a structured field, so the message only sums it up and no byte goes twice
export function okBody(
    text: string,
    summary: string,
    structuredContent: Record<string, unknown> & { message?: never },
): CallToolResult {
    return {
        content: [{ type: "text", text }],
        structuredContent: { message: summary, ...structuredContent },
    };
}

// The router resolves a relative path from the exec user's home and reads ~ as a folder name
export function homePath(path: string): string {
    if (path === "~") return ".";
    return path.startsWith("~/") ? path.slice(2) || "." : path;
}

// The error kind of each failed answer, kept off the result the client sees
export const failedKinds = new WeakMap<object, string>();

export function failure(err: unknown, what: string): CallToolResult {
    const e = err instanceof GatewayError ? err : fromRouter(err, what);
    const retry =
        e.retryAfterMs !== null ? ` Retry after ${Math.ceil(e.retryAfterMs / 1000)} s.` : "";
    const text = `${e.message}.${retry}`;
    const result: CallToolResult = {
        content: [{ type: "text", text }],
        isError: true,
        ...(e.fields ? { structuredContent: { message: text, ...e.fields } } : {}),
    };
    failedKinds.set(result, e.kind);
    return result;
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
            const url =
                p.state === PlacementState.TERMINATED
                    ? sessionLink(deps, p.sessionUrl, handle)
                    : null;
            const at = p.endedAt ? timestampDate(p.endedAt) : undefined;
            return failure(
                new GatewayError(
                    "expired",
                    `${what}: this sandbox has ended and everything in it was deleted. Quote and ` +
                        "start a new one" +
                        (url ? `. ${summaryLine(url, at, false)}` : ""),
                    null,
                    null,
                    url ? { sessionUrl: url } : null,
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

// The router keeps keys starting with _ for its own jobs and refuses them from callers
export function callKey(ctx: ServerContext): string | undefined {
    const id = toolUseId(ctx);
    return id && !id.startsWith("_") ? id : undefined;
}

export function hashKey(parts: readonly string[]): string {
    return "k1" + createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

// Stable across a client's retries of one call, for tools whose same arguments mean the same thing
export function idempotencyKey(ctx: ServerContext, parts: readonly string[]): string {
    return callKey(ctx) ?? hashKey(parts);
}

const spentReasons = new Set(["TOKEN_USED", "TOKEN_EXPIRED", "LINK_LOCKED"]);

// A repeated key names a link that is already spent, so one retry under a new key makes a live one
export async function withFreshKey<T>(key: string, call: (key: string) => Promise<T>): Promise<T> {
    try {
        return await call(key);
    } catch (e) {
        const spent =
            e instanceof ConnectError &&
            e.code === Code.FailedPrecondition &&
            spentReasons.has(errorReason(e) ?? "");
        if (!spent) throw e;
        return call(`k1${randomBytes(16).toString("hex")}`);
    }
}

// The domain every host a router link names sits under, so a link never sends a file elsewhere
export function underDomain(deps: Deps, host: string): boolean {
    const domain = deps.config.router.links_domain;
    return host === domain || host.endsWith(`.${domain}`);
}

export type LinkKind = "preview" | "transfer" | "secrets";

// Data-plane 8.2.1, 8.3.1 and 10.3 give each link one host, so a preview never serves a secret link
function linkHost(deps: Deps, kind: LinkKind, host: string): boolean {
    const domain = deps.config.router.links_domain;
    if (kind !== "preview") return host === `${kind}.${domain}`;
    const suffix = `.preview.${domain}`;
    return host.endsWith(suffix) && /^[a-z2-7]{16}$/.test(host.slice(0, -suffix.length));
}

// A session summary lives this long after the sandbox ends
export const sessionKeepMs = 48 * 3_600_000;

// The summary link only in the contract's exact shape, else null and a fault naming the handle's tag
export function sessionLink(deps: Deps, raw: string, handle: string): string | null {
    if (raw === "") return null;
    const host = deps.config.router.links_domain.replaceAll(".", "\\.");
    const shape = new RegExp(`^https://sessions\\.${host}/s/[a-z2-7]{16}#k=bnk_[A-Za-z0-9_-]{43}$`);
    if (shape.test(raw)) return raw;
    deps.log.warn("session link contract fault", { handle: handleTag(handle) });
    return null;
}

// The time as year-month-day hours and minutes in UTC
export function whenText(d: Date): string {
    return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// The summary line, where full false drops the last full stop for a sentence that adds one
export function summaryLine(url: string, endedAt: Date | undefined, full = true): string {
    const until = endedAt
        ? ` (until ${whenText(new Date(endedAt.getTime() + sessionKeepMs))})`
        : "";
    return `Summary and logs: ${url}${until}. Show this link to the user${full ? "." : ""}`;
}

// Router links reach the user's shell only in the shape the contract gives them
export function routerLink(
    deps: Deps,
    raw: string,
    kind: LinkKind,
    path: RegExp,
    query = "",
): URL | null {
    const href = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return null;
    }
    const plain =
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        url.hash === "" &&
        (url.search === "" || (query !== "" && url.search === query));
    return plain && linkHost(deps, kind, url.hostname) && path.test(url.pathname) ? url : null;
}

// One shell word, so no character of s can end the word or run a command
export function shellQuoted(s: string): string {
    return `'${s.replaceAll("'", `'\\''`)}'`;
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

// What a tool call keeps after its plan to answer before limits.tool_budget cuts it off
export const answerReserveMs = 4_000;

// A tool call's plan on the gateway's clock, ending answerReserveMs before limits.tool_budget
export class Budget {
    private readonly until: number;
    constructor(private readonly deps: Pick<Deps, "config" | "now">) {
        this.until = deps.now() + deps.config.limits.tool_budget - answerReserveMs;
    }
    left(): number {
        return Math.max(0, this.until - this.deps.now());
    }
    // One step's time, cut to its own cap and to what the plan has left after keepMs
    ms(capMs: number, keepMs = 0): number {
        return Math.max(1, Math.min(capMs, this.left() - keepMs));
    }
    signal(capMs: number, keepMs = 0): AbortSignal {
        return AbortSignal.timeout(this.ms(capMs, keepMs));
    }
    // A refund must not be skipped, so it may use all but a second of the answer's reserve
    lastSignal(capMs: number): AbortSignal {
        return AbortSignal.timeout(this.ms(capMs, 1_000 - answerReserveMs));
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
