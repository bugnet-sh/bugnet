// Calls reach the gateway unchanged, _meta and input requests included, so both protocol eras work
import {
    ProtocolError as RemoteProtocolError,
    type Progress,
    type Tool,
} from "@modelcontextprotocol/client";
import {
    CLIENT_CAPABILITIES_META_KEY,
    ProtocolError,
    Server,
    isInputRequiredResult,
    type CallToolRequest,
    type CallToolResult,
    type ClientCapabilities,
    type InputRequiredResult,
    type ServerContext,
} from "@modelcontextprotocol/server";
import type { PinnedKey } from "@bugnet/seal";
import pkg from "../package.json" with { type: "json" };
import type { Log } from "./log.ts";
import { paymentMetaKey, paymentRequired, type PaymentSigner } from "./payment.ts";
import type { RemoteResult, RemoteTools } from "./remote.ts";
import type { RouteOptions } from "./secrets/route.ts";
import type { SourceDeps } from "./secrets/sources.ts";
import {
    putGrantToolName,
    secretFromEnv,
    secretFromEnvName,
    secretFromEnvTool,
} from "./secrets/tool.ts";

// The bundle inlines it at build time, so --version and clientInfo follow every release bump
export const version: string = pkg.version;

export interface BridgeDeps {
    remote: RemoteTools;
    route: RouteOptions;
    pinned: readonly PinnedKey[];
    sources: SourceDeps;
    log: Log;
    now: () => number;
    // One set for the process, which bugnet_secret_from_env trusts when no one can be asked
    started: Set<string>;
    paymentSigner?: PaymentSigner;
    // How long to wait before listing the gateway's tools again after a failed listing
    relistMs?: number;
}

function toolError(text: string): CallToolResult {
    return { content: [{ type: "text", text }], isError: true };
}

const handlePattern = /^sbx_[a-z2-7]{26}$/;

// Only a start's result names a sandbox the user paid for, a status call echoes any handle given
function noteStarted(
    req: CallToolRequest,
    result: RemoteResult,
    started: Set<string>,
    relayed: Set<string>,
): void {
    if (req.params.name !== "bugnet_start" || isInputRequiredResult(result)) return;
    const r = result as CallToolResult;
    const due = paymentRequired(r);
    const orderId = (r.structuredContent as { orderId?: unknown } | undefined)?.orderId;
    if (due && typeof orderId === "string") relayed.add(orderId);
    // The handle follows the order, so an order or payment the agent named may be anyone's sandbox
    const args = (req.params.arguments ?? {}) as { orderId?: unknown; payment?: unknown };
    const own =
        typeof args.orderId === "string"
            ? relayed.has(args.orderId)
            : args.orderId === undefined && args.payment === undefined;
    const handle = (r.structuredContent as { handle?: unknown } | undefined)?.handle;
    if (own && !r.isError && typeof handle === "string" && handlePattern.test(handle)) {
        started.add(handle);
    }
}

function errText(e: unknown): string {
    return e instanceof Error ? e.message.split("\n")[0]!.slice(0, 200) : "unknown error";
}

// The SDK lifts a request's envelope and input responses out of params, so they are put back
function forwardParams(
    req: CallToolRequest,
    ctx: ServerContext,
    caps: ClientCapabilities | undefined,
): Record<string, unknown> {
    const params: Record<string, unknown> = { ...req.params };
    for (const lifted of ["_meta", "inputResponses", "requestState"]) delete params[lifted];
    const meta: Record<string, unknown> = { ...ctx.mcpReq._meta };
    // The bridge's client asks for progress itself and relays it under the caller's token
    delete meta.progressToken;
    if (caps) meta[CLIENT_CAPABILITIES_META_KEY] = caps;
    params._meta = meta;
    if (ctx.mcpReq.inputResponses) params.inputResponses = ctx.mcpReq.inputResponses;
    const state = ctx.mcpReq.requestState();
    if (typeof state === "string") params.requestState = state;
    return params;
}

// The gateway's reserved io.modelcontextprotocol keys describe its connection, not the bridge's
function withoutEnvelope(result: RemoteResult): RemoteResult {
    const meta = result._meta as Record<string, unknown> | undefined;
    if (!meta) return result;
    const kept = Object.entries(meta).filter(([k]) => !k.startsWith("io.modelcontextprotocol/"));
    const rest: Record<string, unknown> = { ...result };
    delete rest._meta;
    if (kept.length > 0) rest._meta = Object.fromEntries(kept);
    return rest as RemoteResult;
}

export function buildBridgeServer(deps: BridgeDeps): Server {
    const instructions = deps.remote.instructions();
    const server = new Server(
        { name: "bugnet-bridge", title: "Bugnet sandboxes", version },
        {
            capabilities: { tools: { listChanged: true } },
            ...(instructions ? { instructions } : {}),
        },
    );
    const clientCapabilities = (ctx: ServerContext): ClientCapabilities | undefined =>
        ((ctx.mcpReq.envelope as Record<string, unknown> | undefined)?.[
            CLIENT_CAPABILITIES_META_KEY
        ] as ClientCapabilities | undefined) ?? server.getClientCapabilities();
    const secretDeps = { ...deps, clientCapabilities };
    // Orders whose payment step this bridge passed on, the only ones a start may name as its own
    const relayed = new Set<string>();

    let relist: NodeJS.Timeout | undefined;
    // After a listing without the gateway's tools, keep trying and tell the client once it works
    const scheduleRelist = () => {
        if (relist) return;
        relist = setTimeout(async () => {
            relist = undefined;
            try {
                await deps.remote.listTools(AbortSignal.timeout(30_000));
                await server.sendToolListChanged().catch(() => {});
            } catch {
                scheduleRelist();
            }
        }, deps.relistMs ?? 15_000);
        relist.unref();
    };
    server.onclose = () => clearTimeout(relist);

    server.setRequestHandler("tools/list", async (_req, ctx) => {
        let remote: Tool[] = [];
        try {
            remote = await deps.remote.listTools(ctx.mcpReq.signal);
        } catch (e) {
            deps.log.warn("gateway tools unavailable", { err: errText(e) });
            scheduleRelist();
        }
        const passed = remote.filter(
            (t) => t.name !== putGrantToolName && t.name !== secretFromEnvName,
        );
        return { tools: [...passed, secretFromEnvTool] };
    });

    const call = async (params: Record<string, unknown>, ctx: ServerContext) => {
        const token = ctx.mcpReq._meta?.progressToken;
        const onprogress =
            token === undefined
                ? undefined
                : (p: Progress) => {
                      ctx.mcpReq
                          .notify({
                              method: "notifications/progress",
                              params: { ...p, progressToken: token },
                          })
                          .catch(() => {});
                  };
        return deps.remote.callTool(params, {
            signal: ctx.mcpReq.signal,
            ...(onprogress ? { onprogress } : {}),
        });
    };

    const passThrough = async (
        req: CallToolRequest,
        ctx: ServerContext,
    ): Promise<CallToolResult | InputRequiredResult> => {
        const params = forwardParams(req, ctx, clientCapabilities(ctx));
        let result: RemoteResult;
        try {
            result = await call(params, ctx);
            if (deps.paymentSigner && !isInputRequiredResult(result)) {
                const required = paymentRequired(result as CallToolResult);
                const payment = required
                    ? await deps.paymentSigner
                          .sign(
                              required,
                              { tool: req.params.name, arguments: req.params.arguments ?? {} },
                              ctx.mcpReq.signal,
                          )
                          .catch((e: unknown) => {
                              deps.log.warn("payment signer failed", { err: errText(e) });
                              return null;
                          })
                    : null;
                if (payment !== null && payment !== undefined) {
                    const meta = { ...(params._meta as object), [paymentMetaKey]: payment };
                    result = await call({ ...params, _meta: meta }, ctx);
                }
            }
        } catch (e) {
            if (ctx.mcpReq.signal.aborted) throw e;
            // A JSON-RPC error from the gateway reaches the local client as the same error
            if (e instanceof RemoteProtocolError)
                throw new ProtocolError(e.code, e.message, e.data);
            deps.log.warn("gateway call failed", { tool: req.params.name, err: errText(e) });
            return toolError("Bugnet's gateway did not answer, a retry may work.");
        }
        noteStarted(req, result, deps.started, relayed);
        return withoutEnvelope(result) as CallToolResult | InputRequiredResult;
    };

    server.setRequestHandler("tools/call", async (req, ctx) => {
        const name = req.params.name;
        if (name === secretFromEnvName) {
            return secretFromEnv(req.params.arguments, ctx, secretDeps);
        }
        if (name === putGrantToolName) {
            return toolError(`${putGrantToolName} is for the bridge itself.`);
        }
        return passThrough(req, ctx);
    });
    return server;
}
