/**
 * The gateway's view of Payments.
 *
 * The gateway never moves money. For a paid tool it asks Payments for an order, passing along any
 * x402 payment the client attached. Payments answers with the x402 requirement to show the client,
 * or, once settled, with the signed order token the router accepts. docs/mcp-gateway/payments-port.md
 * is the contract the Payments service implements.
 */

export type OrderKind = "start" | "extend";

export interface X402PaymentRequired {
    x402Version: number;
    accepts: unknown[];
    error?: string;
    resource?: { url: string; description?: string; mimeType?: string };
    extensions?: Record<string, unknown>;
}

export const claimPattern = /^[A-Za-z0-9_-]{43}$/;

export interface OrderTerms {
    kind: OrderKind;
    packageId: string;
    amountMicros: number;
    // Shown to the payer, for example "Bugnet sandbox 2 vCPU / 2 GiB / 10 min"
    description: string;
    // Lowercase hex sha256 of the handle, extend orders only
    handleSha256?: string;
}

// A new order, or an orderId or payment retry that carries the terms
export interface NewOrderRequest extends OrderTerms {
    // An order the client was given earlier and now retries
    orderId?: string;
    // The x402 PaymentPayload from _meta["x402/payment"], passed through untouched
    payment?: unknown;
    // Stable for one tool call across the client's retries
    idempotencyKey?: string;
    claim?: undefined;
}

// An orderId with its claim, each term sent is compared with the stored order
export interface ClaimOrderRequest extends Partial<OrderTerms> {
    orderId: string;
    claim: string;
    payment?: undefined;
    idempotencyKey?: string;
}

export type OrderRequest = NewOrderRequest | ClaimOrderRequest;

export const refusalReasons = [
    "order_unknown",
    "order_expired",
    "order_closed",
    "payment_malformed",
    "payment_invalid",
    "payment_replayed",
    "payment_order_mismatch",
    "payer_blocked",
    "payer_busy",
    "payer_rate_limited",
    "payer_invalid",
    "router_unavailable",
    "rpc_unavailable",
    "settlement_unavailable",
    "too_many_attempts",
    "bad_request",
    "unauthorized",
    "claim_mismatch",
    "terms_mismatch",
    "idempotency_conflict",
    "settling",
    "payment_late",
    "token_expired",
    "paid_claim_required",
] as const;

export type RefusalReason = (typeof refusalReasons)[number];

export interface AwaitingPayment {
    status: "payment_required";
    orderId: string;
    // Only on a create or its idempotent replay
    claim?: string;
    // A page or x402 resource where the order can be paid outside the MCP client
    payUrl: string;
    paymentRequired: X402PaymentRequired;
}

export interface PaidOrder {
    status: "paid";
    orderId: string;
    orderToken: string;
    // The Solana address that paid
    payer: string;
    kind: OrderKind;
    packageId: string;
    amountMicros: number;
    // Extend orders only
    handleSha256?: string;
    // Goes back to the client as _meta["x402/payment-response"]
    paymentResponse?: unknown;
}

export interface RefusedOrder {
    status: "refused";
    orderId?: string;
    reason: RefusalReason;
    retryAfterSeconds?: number;
}

export type OrderResult = AwaitingPayment | PaidOrder | RefusedOrder;

export interface Payments {
    readonly mode: "dev" | "http";
    order(req: OrderRequest, signal: AbortSignal): Promise<OrderResult>;
    // A paid order the router refused, which the router records nothing for, so Payments refunds it
    abandon(orderId: string, reason: string, signal: AbortSignal): Promise<void>;
}
