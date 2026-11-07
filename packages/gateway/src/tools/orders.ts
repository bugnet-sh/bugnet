// Payment steps, paid retries and Payments refusals shared by bugnet_start, bugnet_extend and bugnet_redeem
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { claimPattern, type AwaitingPayment, type RefusedOrder } from "../payments/port.ts";
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
    if (w.payment) return `${tool} with orderId "${orderId}" and the same payment`;
    return `${tool} with orderId "${orderId}"`;
}

export function refusalError(
    r: RefusedOrder,
    what: "start" | "extend" | "redeem",
    tool: OrderTool,
    opts: { sentOrderId?: string; handleSent?: boolean; paymentSent?: boolean } = {},
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
                        `the same orderId and ${opts.paymentSent ? "payment" : "claim"}, and do ` +
                        "not pay again",
                    1000 * (r.retryAfterSeconds ?? 3),
                );
            case "terms_mismatch":
                return error(
                    "invalid",
                    opts.handleSent
                        ? `redeem: order ${id} is not for that sandbox. Check the handle, and ` +
                              "leave it out when the order starts a new sandbox"
                        : `${what}: order ${id} is for another package or sandbox`,
                );
            default:
        }
    }
    const text = `payment refused: ${r.reason}`;
    return r.retryAfterSeconds !== undefined
        ? new GatewayError("rate_limited", text, 1000 * r.retryAfterSeconds, null, fields)
        : error("denied", text);
}
