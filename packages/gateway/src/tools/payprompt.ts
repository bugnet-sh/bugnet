// The pay link as a URL prompt the client shows mid-call, held open until the payment lands
import { setTimeout as sleep } from "node:timers/promises";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { usd } from "../money.ts";
import type { AwaitingPayment, OrderResult } from "../payments/port.ts";
import { extendToolCall, toolCallSignal } from "../request.ts";
import { withProgress, type Deps } from "./common.ts";

// The pause between two looks at an order the user is paying
export const payLookMs = 3_000;

// The amount of the first x402 option, read without trusting the payload's shape
function stepPrice(r: AwaitingPayment): string | null {
    const first: unknown = r.paymentRequired.accepts[0];
    if (typeof first !== "object" || first === null) return null;
    const amount = (first as { amount?: unknown }).amount;
    return typeof amount === "string" && /^[0-9]{1,15}$/.test(amount) ? usd(BigInt(amount)) : null;
}

// The line that names the price and the link, for prompts and progress notes
export function payLine(r: AwaitingPayment): string {
    const price = stepPrice(r);
    return price ? `Pay ${price} USDC here: ${r.payUrl}` : `Pay here: ${r.payUrl}`;
}

export function promptId(orderId: string): string {
    return `bugnet-pay-${orderId}`;
}

function awaitingPayment(order: OrderResult): boolean {
    return (
        order.status === "payment_required" ||
        (order.status === "refused" && order.reason === "settling")
    );
}

// A stateless call's server never saw initialize, where the client declared URL prompts
function trustUrlPrompts(server: McpServer): void {
    const s = server.server as unknown as { _clientCapabilities?: Record<string, unknown> };
    s._clientCapabilities = { ...s._clientCapabilities, elicitation: { url: {} } };
}

function showPrompt(ctx: ServerContext, order: AwaitingPayment): void {
    const price = stepPrice(order);
    // The answer goes to another stateless call, so only the payment itself is waited on
    ctx.mcpReq
        .send({
            method: "elicitation/create",
            params: {
                mode: "url",
                elicitationId: promptId(order.orderId),
                url: order.payUrl,
                message: `Pay ${price ? `${price} USDC` : "in USDC"} to start your Bugnet sandbox`,
            },
        })
        .catch(() => {});
}

// Closes the client's prompt, which otherwise waits for this word after the user opened the link
async function closePrompt(server: McpServer, ctx: ServerContext, orderId: string): Promise<void> {
    trustUrlPrompts(server);
    await ctx.mcpReq
        .notify({
            method: "notifications/elicitation/complete",
            params: { elicitationId: promptId(orderId) },
        })
        .catch(() => {});
}

// Shows the pay link as a prompt and looks at the order until it is paid, refused or out of time
export async function waitWithPrompt(
    deps: Deps,
    server: McpServer,
    ctx: ServerContext,
    order: AwaitingPayment,
    look: () => Promise<OrderResult>,
): Promise<OrderResult> {
    const wait = deps.config.limits.pay_wait;
    extendToolCall(wait + deps.config.limits.tool_budget);
    showPrompt(ctx, order);
    const until = deps.now() + wait;
    const pause =
        deps.sleep ??
        ((ms: number, signal: AbortSignal | undefined) =>
            sleep(ms, undefined, signal ? { signal } : {}));
    let current: OrderResult = order;
    await withProgress(
        ctx,
        payLine(order),
        async () => {
            while (awaitingPayment(current) && deps.now() < until) {
                const signal = toolCallSignal();
                if (signal?.aborted) break;
                try {
                    await pause(payLookMs, signal);
                } catch {
                    break;
                }
                try {
                    current = await look();
                } catch {
                    // Payments answering slowly is no answer, so the next look tries again
                }
            }
        },
        { now: true },
    );
    await closePrompt(server, ctx, order.orderId);
    // What follows the payment gets a whole tool budget of its own
    extendToolCall(deps.config.limits.tool_budget);
    return current;
}
