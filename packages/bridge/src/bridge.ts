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
    inputResponse,
    isInputRequiredResult,
    type CallToolRequest,
    type CallToolResult,
    type ClientCapabilities,
    type InputRequiredResult,
    type ServerContext,
} from "@modelcontextprotocol/server";
import type { PinnedKey } from "@bugnet/seal";
import pkg from "../package.json" with { type: "json" };
import {
    canElicitUrl,
    lostLinkText,
    linkStateOrderId,
    payLinkRequest,
    paymentStepResult,
    readLinkState,
    waitPaid,
    type LinkOutcome,
} from "./linkpay.ts";
import type { Log } from "./log.ts";
import {
    orderKey,
    spentRefusals,
    unpaidText,
    afterPaymentText,
    withAfterPayment,
    type PaidOrders,
    type PublicOrderState,
} from "./orders.ts";
import {
    maxPaymentMicros,
    paymentStep,
    payRefusal,
    priceMicros,
    type OrderPayer,
    type PayOutcome,
    type PaymentStep,
} from "./pay.ts";
import { paymentRequired } from "./payment.ts";
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

export interface BridgePay {
    origin: string;
    payer: OrderPayer | null;
    orders: PaidOrders;
    status: (orderId: string, signal: AbortSignal) => Promise<PublicOrderState | null>;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface BridgeDeps {
    remote: RemoteTools;
    route: RouteOptions;
    pinned: readonly PinnedKey[];
    sources: SourceDeps;
    log: Log;
    now: () => number;
    // One set for the process, which bugnet_secret_from_env trusts when no one can be asked
    started: Set<string>;
    // Pays a payment step with pay or by link, absent in tests that need neither
    pay?: BridgePay;
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
    const tool = req.params.name;
    if ((tool !== "bugnet_start" && tool !== "bugnet_redeem") || isInputRequiredResult(result)) {
        return;
    }
    const r = result as CallToolResult;
    const due = paymentRequired(r);
    const orderId = (r.structuredContent as { orderId?: unknown } | undefined)?.orderId;
    if (tool === "bugnet_start" && due && typeof orderId === "string") relayed.add(orderId);
    // The handle follows the order, so an order or payment the agent named may be anyone's sandbox
    const args = (req.params.arguments ?? {}) as { orderId?: unknown; payment?: unknown };
    const own =
        typeof args.orderId === "string"
            ? relayed.has(args.orderId)
            : tool === "bugnet_start" && args.orderId === undefined && args.payment === undefined;
    const handle = (r.structuredContent as { handle?: unknown } | undefined)?.handle;
    if (own && !r.isError && typeof handle === "string" && handlePattern.test(handle)) {
        started.add(handle);
    }
}

function errText(e: unknown): string {
    return e instanceof Error ? e.message.split("\n")[0]!.slice(0, 200) : "unknown error";
}

function isLinkState(state: unknown): state is string {
    return typeof state === "string" && state.startsWith("p1.");
}

function quoteIdOf(args: Record<string, unknown>): string | undefined {
    return typeof args.quoteId === "string" ? args.quoteId : undefined;
}

// The SDK lifts a request's envelope and input responses out of params, so they are put back
function forwardParams(
    req: CallToolRequest,
    ctx: ServerContext,
    caps: ClientCapabilities | undefined,
): Record<string, unknown> {
    const params: Record<string, unknown> = { ...req.params };
    for (const lifted of ["_meta", "inputResponses", "requestState"]) delete params[lifted];
    const state = ctx.mcpReq.requestState();
    const meta: Record<string, unknown> = { ...ctx.mcpReq._meta };
    // The bridge's client asks for progress itself and relays it under the caller's token
    delete meta.progressToken;
    if (caps) meta[CLIENT_CAPABILITIES_META_KEY] = caps;
    params._meta = meta;
    // A link state and its answer are the bridge's own, the gateway never sees them
    if (isLinkState(state)) return params;
    if (ctx.mcpReq.inputResponses) params.inputResponses = ctx.mcpReq.inputResponses;
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

const lastingRefusals: ReadonlySet<string> = new Set([
    "payer_blocked",
    "payer_invalid",
    "payment_malformed",
    "payment_replayed",
    "payment_order_mismatch",
]);

const waitingInPay = "waiting for the payment to be approved in pay";

function isPaidTool(name: string): boolean {
    return name === "bugnet_start" || name === "bugnet_extend";
}

// The client never sees an answer that lands after it gave up, so its order stays held
function unseen(result: RemoteResult, signal: AbortSignal): boolean {
    return signal.aborted || isInputRequiredResult(result);
}

// An order a call names is used up once the call succeeds or the gateway abandoned it
function dropUsed(
    req: CallToolRequest,
    result: RemoteResult,
    orders: PaidOrders,
    signal: AbortSignal,
): void {
    const name = req.params.name;
    const orderId = (req.params.arguments as { orderId?: unknown } | undefined)?.orderId;
    if (!isPaidTool(name) && name !== "bugnet_redeem") return;
    if (typeof orderId !== "string" || unseen(result, signal)) return;
    const r = result as CallToolResult;
    const refusal = (r.structuredContent as { refusal?: unknown } | undefined)?.refusal;
    if (!r.isError || refusal === "abandoned") orders.drop(orderId);
}

// One counter per call, so progress rises across the bridge's own notes and the gateway's
function progressFor(ctx: ServerContext): {
    note: (message: string) => void;
    relay: ((p: Progress) => void) | undefined;
} {
    const token = ctx.mcpReq._meta?.progressToken;
    let count = 0;
    const note = (message: string) => {
        if (token === undefined) return;
        count += 1;
        ctx.mcpReq
            .notify({
                method: "notifications/progress",
                params: { progress: count, message, progressToken: token },
            })
            .catch(() => {});
    };
    return { note, relay: token === undefined ? undefined : (p) => note(p.message ?? "") };
}

// Returns the result of the call that redeemed a paid order, dropping the order when it is spent
function settle(
    orders: PaidOrders,
    result: RemoteResult,
    step: PaymentStep,
    signal: AbortSignal,
): RemoteResult {
    if (unseen(result, signal)) return result;
    const r = result as CallToolResult;
    if (!r.isError) {
        orders.drop(step.orderId);
        return result;
    }
    const refusal = (r.structuredContent as { refusal?: unknown } | undefined)?.refusal;
    // A wrong claim says nothing about the order, which may be paid and still redeemable
    if (typeof refusal === "string" && refusal !== "claim_mismatch" && spentRefusals.has(refusal)) {
        orders.drop(step.orderId);
        return withAfterPayment(r, step, true);
    }
    return withAfterPayment(r, step);
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
    // A client that can open links gets the pay link, any other the payment step as it is
    const linkPath = (
        step: PaymentStep,
        result: RemoteResult,
        ctx: ServerContext,
        orders: PaidOrders,
    ): RemoteResult => {
        orders.holdLink(step.orderId);
        return canElicitUrl(clientCapabilities(ctx)) ? payLinkRequest(step, deps.now()) : result;
    };
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

    const call = (
        params: Record<string, unknown>,
        ctx: ServerContext,
        relay: ((p: Progress) => void) | undefined,
    ) =>
        deps.remote.callTool(params, {
            signal: ctx.mcpReq.signal,
            ...(relay ? { onprogress: relay } : {}),
        });

    // Pays a payment step of bugnet_start or bugnet_extend and redeems the order it names
    const payFlow = async (
        req: CallToolRequest,
        ctx: ServerContext,
        params: Record<string, unknown>,
        pay: BridgePay,
        progress: ReturnType<typeof progressFor>,
    ): Promise<RemoteResult> => {
        const { orders } = pay;
        const name = req.params.name;
        const args: Record<string, unknown> = { ...req.params.arguments };
        const ownPayment =
            args.payment !== undefined || ctx.mcpReq._meta?.["x402/payment"] !== undefined;
        const key = orderKey(name, args);
        // Redeems an order paid by pay, at its link or found paid, and settles its hold
        const redeemOrder = async (paid: PaymentStep): Promise<RemoteResult> => {
            let again: RemoteResult;
            try {
                again = await call(
                    { ...params, arguments: { ...args, orderId: paid.orderId, claim: paid.claim } },
                    ctx,
                    progress.relay,
                );
            } catch (e) {
                if (ctx.mcpReq.signal.aborted) throw e;
                deps.log.warn("gateway call failed", { tool: name, err: errText(e) });
                return toolError(
                    "Bugnet's gateway did not answer, a retry may work." + afterPaymentText(paid),
                );
            }
            return settle(orders, again, paid, ctx.mcpReq.signal);
        };
        // Polls the order's page until it is paid, and redeems it then
        const waitAndRedeem = async (paid: PaymentStep, link: boolean): Promise<RemoteResult> => {
            // The hold is set inside the poll before it ends, as a pay's outcome is
            const poll = waitPaid(
                paid.orderId,
                { status: pay.status, ...(pay.sleep ? { sleep: pay.sleep } : {}), now: deps.now },
                ctx.mcpReq.signal,
                () => progress.note(`waiting for order ${paid.orderId} to be paid`),
            ).then(
                (o) => {
                    // A timeout or review may still be paid, a refunded one goes on its next read
                    if (o === "paid") orders.markPaid(paid.orderId, "paid");
                    else if (o === "timeout" || o === "closed")
                        orders.markPaid(paid.orderId, "unknown");
                    else orders.forget(paid.orderId);
                    return o;
                },
                (e: unknown) => {
                    // The client gave up, so the next call reads the page and redeems if paid
                    orders.markPaid(paid.orderId, "unknown");
                    throw e;
                },
            );
            if (link) orders.markLink(paid.orderId);
            orders.markPaying(
                paid.orderId,
                poll.catch(() => {}),
            );
            const outcome: LinkOutcome = await poll;
            if (outcome === "paid") return redeemOrder(paid);
            return toolError(unpaidText(outcome, paid));
        };
        // The same order's link again, since the user can still pay it in their browser
        const sameLink = (held: PaymentStep): RemoteResult =>
            canElicitUrl(clientCapabilities(ctx))
                ? payLinkRequest(held, deps.now())
                : paymentStepResult(held, quoteIdOf(args));
        const linkReturn = ctx.mcpReq.requestState();
        if (isLinkState(linkReturn)) {
            const link = readLinkState(linkReturn, name, deps.now());
            const known = orders.step(link?.orderId ?? linkStateOrderId(linkReturn) ?? "");
            const step = known?.tool === name ? known : undefined;
            if (!link) {
                return step
                    ? paymentStepResult(step, quoteIdOf(args))
                    : toolError(lostLinkText(name));
            }
            if (!step) return toolError(lostLinkText(name));
            const answer = inputResponse(ctx.mcpReq.inputResponses, "pay");
            if (answer.kind !== "elicit" || answer.action !== "accept") {
                return paymentStepResult(step, quoteIdOf(args));
            }
            return waitAndRedeem(step, true);
        }
        let held: PaymentStep | undefined;
        let forwarded = params;
        let holding =
            !ownPayment && args.orderId === undefined && key !== null
                ? orders.heldFor(key)
                : undefined;
        // A call that waited on a pay never opens an order, the held one is all it may use
        let waited = false;
        if (holding?.state === "paying") {
            // A pay for this package is still running, so no second order is opened or paid
            const flight = orders.flight(holding.orderId);
            const aborted = new Promise<void>((resolve) => {
                if (ctx.mcpReq.signal.aborted) resolve();
                ctx.mcpReq.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            if (flight) await Promise.race([flight, aborted]);
            const after = ctx.mcpReq.signal.aborted ? undefined : orders.heldFor(key!);
            if (!after || after.orderId !== holding.orderId || after.state === "paying") {
                return toolError(unpaidText("timeout", holding));
            }
            holding = after;
            waited = true;
        }
        if (holding && holding.state !== "paying") {
            let use = holding.state === "paid";
            if (!use) {
                const state = await pay.status(holding.orderId, ctx.mcpReq.signal).catch(() => "?");
                if (state === "?" || state === "paid" || state === "settling") use = true;
                // A payment under manual review may still land, so no new order is opened
                else if (state === "review") return toolError(unpaidText("closed", holding));
                else if (waited) {
                    // The pay may still settle, so the hold stays and nothing is created
                    if (state === "unpaid") return toolError(unpaidText("timeout", holding));
                    orders.forget(holding.orderId);
                    if (state === "expired") return toolError(unpaidText("expired", holding));
                    if (state === null) return toolError(unpaidText("unknown_order", holding));
                    return toolError(unpaidText("closed", holding));
                } else if (orders.linkOpened(holding.orderId) && state === "unpaid")
                    return sameLink(holding);
                else orders.forget(holding.orderId);
            }
            if (use) {
                held = holding;
                forwarded = {
                    ...params,
                    arguments: { ...args, orderId: holding.orderId, claim: holding.claim },
                };
            }
        }
        const result = await call(forwarded, ctx, progress.relay);
        const step = ownPayment || isInputRequiredResult(result) ? null : paymentStep(name, result);
        // An orderId and claim the model sends itself settle the order's hold the same way
        const named =
            typeof args.orderId === "string" && key !== null
                ? orders.held(args.orderId, key)
                : undefined;
        const mine = named?.state !== "paying" ? named : undefined;
        const settling: PaymentStep | undefined = held ?? mine;
        if (!step) return settling ? settle(orders, result, settling, ctx.mcpReq.signal) : result;
        const paid: PaymentStep = step;
        orders.see(key, paid);
        if (name === "bugnet_start") relayed.add(paid.orderId);
        const confirmed = priceMicros(args.confirmPriceUsd);
        const why = payRefusal(
            paid,
            pay.origin,
            confirmed,
            paymentRequired(result as CallToolResult)!,
        );
        if (why !== null) {
            deps.log.warn("pay link refused", { orderId: paid.orderId, why });
            return result;
        }
        if (orders.tried(paid.orderId)) return linkPath(paid, result, ctx, orders);
        if (!pay.payer) return linkPath(paid, result, ctx, orders);
        orders.markTried(paid.orderId);
        // Never raced against the client's signal, since pay may have paid by the time it gives up
        // The outcome is recorded as it lands, even when this call is already gone
        const flight = pay.payer
            .pay(paid, maxPaymentMicros([confirmed!]), () => progress.note(waitingInPay))
            .catch((): PayOutcome => ({ kind: "unknown" }))
            .then((o) => {
                record(o);
                return o;
            });
        orders.markPaying(paid.orderId, flight);
        return afterPay(await flight);

        function record(outcome: PayOutcome): void {
            if (outcome.kind === "paid") orders.markPaid(paid.orderId, "paid");
            else if (outcome.kind === "unknown" || spent(outcome)) {
                orders.markPaid(paid.orderId, "unknown");
            } else orders.forget(paid.orderId);
        }

        function spent(outcome: PayOutcome): boolean {
            return outcome.kind === "declined" && spentRefusals.has(outcome.reason);
        }

        function afterPay(outcome: PayOutcome): Promise<RemoteResult> | RemoteResult {
            if (outcome.kind === "paid") return redeem();
            if (outcome.kind === "unknown" || spent(outcome)) return reread();
            if (outcome.kind === "declined") {
                // A refusal that never clears leaves the link as the way to pay this order
                if (lastingRefusals.has(outcome.reason)) orders.holdLink(paid.orderId);
                return result;
            }
            return linkPath(paid, result, ctx, orders);
        }

        function redeem(): Promise<RemoteResult> {
            return redeemOrder(paid);
        }

        // Pay may have paid, so the order's own page says whether it did
        async function reread(): Promise<RemoteResult> {
            const state = await pay.status(paid.orderId, ctx.mcpReq.signal).catch(() => "?");
            if (state === "paid") return redeem();
            if (state === "unpaid") {
                // The order stays tried, so pay is never started for it again
                orders.forget(paid.orderId);
                return result;
            }
            if (state === "settling") return waitAndRedeem(paid, false);
            if (state === "review") {
                // A payment under manual review may still land, so the hold stays
                orders.markPaid(paid.orderId, "unknown");
                return toolError(unpaidText("closed", paid));
            }
            if (state === "?") return toolError(unpaidText("timeout", paid));
            orders.forget(paid.orderId);
            if (state === "expired") return toolError(unpaidText("expired", paid));
            if (state === null) return toolError(unpaidText("unknown_order", paid));
            return toolError(unpaidText("closed", paid));
        }
    };

    const passThrough = async (
        req: CallToolRequest,
        ctx: ServerContext,
    ): Promise<CallToolResult | InputRequiredResult> => {
        const params = forwardParams(req, ctx, clientCapabilities(ctx));
        const progress = progressFor(ctx);
        let result: RemoteResult;
        try {
            result =
                deps.pay && isPaidTool(req.params.name)
                    ? await payFlow(req, ctx, params, deps.pay, progress)
                    : await call(params, ctx, progress.relay);
        } catch (e) {
            if (ctx.mcpReq.signal.aborted) throw e;
            // A JSON-RPC error from the gateway reaches the local client as the same error
            if (e instanceof RemoteProtocolError)
                throw new ProtocolError(e.code, e.message, e.data);
            deps.log.warn("gateway call failed", { tool: req.params.name, err: errText(e) });
            return toolError("Bugnet's gateway did not answer, a retry may work.");
        }
        if (deps.pay) dropUsed(req, result, deps.pay.orders, ctx.mcpReq.signal);
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
