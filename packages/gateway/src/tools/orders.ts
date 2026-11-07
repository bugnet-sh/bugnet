// Payment steps, paid retries and Payments refusals shared by bugnet_start, bugnet_extend and bugnet_redeem
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
    claimPattern,
    type AwaitingPayment,
    type OrderResult,
    type RefusedOrder,
} from "../payments/port.ts";
import { GatewayError } from "../router.ts";

export type OrderTool = "bugnet_start" | "bugnet_extend" | "bugnet_redeem";

export const claimInput = z
    .string()
    .regex(claimPattern, "the 43-character claim from the payment step");

// D3, a call carrying a payment keeps the full path, so only orderId with claim skips the terms
export function isPaidRetry(
    args: { orderId?: string | undefined; claim?: string | undefined },
    payment: unknown,
): args is { orderId: string; claim: string } {
    return args.orderId !== undefined && args.claim !== undefined && payment === undefined;
}

// A claim sent beside a payment is held back, so a paid order that asks for it gets it next
export function claimAsked(
    order: OrderResult,
    args: { orderId?: string | undefined; claim?: string | undefined },
    payment: unknown,
): args is { orderId: string; claim: string } {
    return (
        order.status === "refused" &&
        order.reason === "paid_claim_required" &&
        payment !== undefined &&
        args.orderId !== undefined &&
        args.claim !== undefined
    );
}

export interface PaymentStepContext {
    tool: OrderTool;
    sentOrderId?: string;
    sentClaim?: string;
    quoteId?: string;
    withHandle?: boolean;
}

// Claude Code shows the model only the text of an error result, other clients read the fields
export function paymentRequiredResult(r: AwaitingPayment, c: PaymentStepContext): CallToolResult {
    const id = r.orderId;
    const claim = r.claim ?? c.sentClaim;
    const named = claim
        ? c.quoteId
            ? ` (orderId "${id}", claim "${claim}", quoteId "${c.quoteId}")`
            : c.tool === "bugnet_extend" || c.withHandle
              ? ` (orderId "${id}", claim "${claim}" and this sandbox's handle)`
              : ` (orderId "${id}", claim "${claim}")`
        : ` (orderId "${id}" and the claim from its first payment step)`;
    const guide = [
        c.sentOrderId === id
            ? `Order ${id} is not paid yet, and a payment can take a few seconds to confirm.`
            : `Payment required for order ${id}.`,
        `Next: pay at ${r.payUrl} with a Solana wallet holding USDC, then call bugnet_redeem ` +
            `with orderId and claim${named}.`,
        "Show the user the link, since they pay in their own browser.",
        c.tool === "bugnet_redeem"
            ? ""
            : `Calling ${c.tool} again without this orderId opens a new order the user would ` +
              "pay again.",
        // Live runs saw the model tell users they had 60 s to pay
        "The x402 maxTimeoutSeconds limits a wallet's signed payment, not the user's time to pay.",
    ]
        .filter(Boolean)
        .join(" ");
    return {
        isError: true,
        // The x402 MCP transport reads the requirement from the first text block
        content: [
            { type: "text", text: JSON.stringify(r.paymentRequired) },
            { type: "text", text: guide },
        ],
        structuredContent: {
            ...(r.paymentRequired as unknown as Record<string, unknown>),
            message: guide,
            orderId: id,
            payUrl: r.payUrl,
            ...(claim ? { claim } : {}),
            ...(c.quoteId ? { quoteId: c.quoteId } : {}),
        },
    };
}

// The order was abandoned to Payments, so a client that holds it treats it as spent
export function abandonedFields(orderId: string): Record<string, unknown> {
    return { orderId, refusal: "abandoned" };
}

export interface RetryWith {
    claim?: string;
    payment?: boolean;
    quoteId?: string;
    handle?: boolean;
}

// The call a model makes to finish the order, worded for the end of a sentence
export function retryCall(tool: OrderTool, orderId: string, w: RetryWith): string {
    if (w.claim && w.quoteId) {
        return `${tool} with orderId "${orderId}", claim "${w.claim}" and quoteId "${w.quoteId}"`;
    }
    if (w.claim && w.handle) {
        return `${tool} with the handle, orderId "${orderId}" and claim "${w.claim}"`;
    }
    if (w.claim) return `${tool} with orderId "${orderId}" and claim "${w.claim}"`;
    if (w.payment) return `${tool} with orderId "${orderId}" and the claim from its payment step`;
    return `${tool} with orderId "${orderId}"`;
}

const unavailableRefusals: ReadonlySet<string> = new Set([
    "router_unavailable",
    "rpc_unavailable",
    "settlement_unavailable",
]);

// The skill forbids a call without the orderId, so a spent order's refusal names the next step
function spentStep(reason: string, id: string | undefined, tool: OrderTool): string | null {
    const order = id ? `Order ${id}` : "This order";
    const paid = tool === "bugnet_redeem" ? "bugnet_start or bugnet_extend" : tool;
    const fresh =
        `Start a new order with ${paid} and no orderId, ` + "once the user agrees to its price";
    switch (reason) {
        case "order_expired":
            return `${order} can no longer be paid. ${fresh}`;
        case "order_unknown":
            return (
                "Check that the orderId was copied exactly from the payment step. If it was, " +
                `${id ? `order ${id}` : "this order"} can no longer be paid. ${fresh}`
            );
        case "payment_late":
            return (
                `${order} expired before its payment landed, so that payment is refunded ` +
                `automatically. Do not pay it again. ${fresh}`
            );
        case "token_expired":
            return (
                `${order} was already used and can no longer be redeemed. If it was paid and ` +
                "never started a sandbox or added time, it is refunded automatically, so do not " +
                "pay it again"
            );
        case "order_closed":
            return (
                `${order} is closed: its payment was refunded or is being checked by hand. Do ` +
                "not pay it again, and tell the user before starting a new order"
            );
        default:
            return null;
    }
}

export function refusalError(
    r: RefusedOrder,
    what: "start" | "extend" | "redeem",
    tool: OrderTool,
    opts: {
        sentOrderId?: string;
        sentClaim?: string;
        handleSent?: boolean;
        paymentSent?: boolean;
    } = {},
): GatewayError {
    const id = r.orderId ?? opts.sentOrderId;
    const fields = { ...(id ? { orderId: id } : {}), refusal: r.reason };
    const error = (
        kind: ConstructorParameters<typeof GatewayError>[0],
        text: string,
        ms: number | null = null,
    ) => new GatewayError(kind, text, ms, null, fields);
    if (id) {
        switch (r.reason) {
            case "paid_claim_required":
                return error(
                    "precondition",
                    `${what}: order ${id} is already paid. Call ${tool} again with orderId ` +
                        `"${id}" and the claim from its payment step, and do not pay it again. ` +
                        "If the claim is lost, the payment is refunded automatically",
                );
            case "claim_mismatch":
                return error(
                    "invalid",
                    `${what}: that claim does not belong to order ${id}, copy the claim from its ` +
                        "payment step exactly",
                );
            case "settling":
                return error(
                    "unavailable",
                    `${what}: the payment for order ${id} is still confirming. Call again with ` +
                        `the same orderId and ${opts.paymentSent ? "its " : ""}claim, and do not ` +
                        "pay again",
                    1000 * (r.retryAfterSeconds ?? 3),
                );
            case "terms_mismatch":
                if (opts.handleSent) {
                    return error(
                        "invalid",
                        `redeem: order ${id} is not for that sandbox. Check the handle, and ` +
                            "leave it out when the order starts a new sandbox",
                    );
                }
                // A paid extend retry sends the handle's hash, which a start order never has
                if (tool === "bugnet_extend" && opts.sentClaim) {
                    const redeem = retryCall("bugnet_redeem", id, { claim: opts.sentClaim });
                    return error(
                        "invalid",
                        `${what}: order ${id} is not for this sandbox. If it starts a new ` +
                            `sandbox, call ${redeem}, plus the quoteId bugnet_start was called ` +
                            "with. Otherwise check the handle",
                    );
                }
                return error("invalid", `${what}: order ${id} is for another package or sandbox`);
            default:
        }
    }
    const text = `payment refused: ${r.reason}`;
    if (unavailableRefusals.has(r.reason)) {
        return error("unavailable", `${text}, retry in a few seconds`);
    }
    const step = spentStep(r.reason, id, tool);
    if (step !== null) return error("denied", `${text}. ${step}`);
    return r.retryAfterSeconds !== undefined
        ? new GatewayError("rate_limited", text, 1000 * r.retryAfterSeconds, null, fields)
        : error("denied", text);
}
