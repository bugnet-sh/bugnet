/**
 * The gateway's view of Payments.
 *
 * The gateway never moves money. For a paid tool it asks Payments for an order, passing along any
 * x402 payment the client attached. Payments answers with the x402 requirement to show the client,
 * or, once settled, with the signed order token the router accepts. docs/mcp-gateway/payments-port.md
 * is the contract the Payments service implements.
 */

import type { X402Method } from "../x402/lines.ts";

export type { X402Method };

export type OrderKind = "start" | "extend" | "allowance";
export type PackageKind = "start" | "extend";
export const allowancePackageId = "x402-allowance";

export type X402Listed = "indexed" | "unlisted";

export interface X402ServicePin {
    serviceId: string;
    method: X402Method;
    host: string;
    prefix: string;
    url: string;
    maxPriceMicros: number;
    payTo: string;
    listed: X402Listed;
    pinnedFrom: "probe" | "index";
    // The probe's chosen accepts entry, unmodified, null for an index pin
    probe: { at: string; status: number; accepted: Record<string, unknown> | null };
}

export interface X402Setup {
    services?: X402ServicePin[];
    disable?: string[];
    spendPerMinuteMicros?: number;
}

export interface X402Terms {
    enabled: boolean;
    startWithX402: boolean;
    network: string;
    asset: string;
    sessionFeeMicros: number;
    minAllowanceMicros: number;
    suggestedAllowanceMicros: number;
    maxAllowancePerSandboxMicros: number;
    maxPricePerCallMicros: number;
    defaultSpendPerMinuteMicros: number;
    minSpendPerMinuteMicros: number;
    maxSpendPerMinuteMicros: number;
    maxServices: number;
    maxNewServicesPerOrder: number;
    sellerMemoMaxBytes: number;
    refundMinMicros: number;
    bugnetAddresses: string[];
}

export type X402AccountState = "open" | "closing" | "closed";
export type X402ServiceState = "enabled" | "disabled" | "unreliable";

export interface X402AccountService {
    serviceId: string;
    method: X402Method;
    host: string;
    prefix: string;
    url: string;
    paidPath: string | null;
    maxPriceMicros: number;
    payTo: string;
    listed: X402Listed;
    state: X402ServiceState;
}

export type X402RefundState = "waiting" | "pending" | "sent" | "confirmed" | "kept" | "manual";

export interface X402Refund {
    state: X402RefundState;
    amountMicros: number;
    keptMicros: number;
    txs: string[];
}

// Spec 7.15 "the account view"
export interface X402Account {
    state: X402AccountState;
    fundedMicros: number;
    spentMicros: number;
    heldMicros: number;
    leftMicros: number;
    allowanceRoomMicros: number;
    paidCalls: number;
    pendingCalls: number;
    spendPerMinuteMicros: number;
    services: X402AccountService[];
    // Absent while open
    refund?: X402Refund;
}

// GET /v1/x402/accounts/{handleSha256}, spec 5.10 calls it X402AccountView
export interface X402AccountAnswer {
    x402: X402Account | null;
    feeDue: boolean;
}

export interface X402SellerStats {
    paidCalls30d: number;
    failedPaid30d: number;
}

export interface X402PaymentRequired {
    x402Version: number;
    accepts: unknown[];
    error?: string;
    resource?: { url: string; description?: string; mimeType?: string };
    extensions?: Record<string, unknown>;
}

export const claimPattern = /^[A-Za-z0-9_-]{43}$/;
export const orderIdPattern = /^ord_[a-z2-7]{26}$/;

// Spec 7.15 binds a payment to its order by the memo, read without trusting the payload's shape
export function paymentMemo(payment: unknown): string | null {
    const field = (v: unknown, key: string): unknown =>
        typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;
    const memo = field(field(field(payment, "accepted"), "extra"), "memo");
    return typeof memo === "string" && orderIdPattern.test(memo) ? memo : null;
}

export interface OrderTerms {
    kind: OrderKind;
    packageId: string;
    amountMicros: number;
    // Shown to the payer, for example "Bugnet sandbox 2 vCPU / 2 GiB / 10 min"
    description: string;
    // Lowercase hex sha256 of the handle, extend and allowance orders
    handleSha256?: string;
    // Start and allowance orders
    allowanceMicros?: number;
    // 0 or sessionFeeMicros
    feeMicros?: number;
    x402?: X402Setup;
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

// An orderId with a payment and no claim, every term optional (7.15 paid retry)
export interface PaymentRetryRequest extends Partial<OrderTerms> {
    orderId: string;
    payment: unknown;
    claim?: undefined;
    idempotencyKey?: string;
}

export type OrderRequest = NewOrderRequest | ClaimOrderRequest | PaymentRetryRequest;

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
    "x402_disabled",
    "x402_paused",
    "x402_unavailable",
    "x402_start_unavailable",
    "sandbox_unknown",
    "sandbox_ended",
    "sandbox_not_capable",
    "amount_too_small",
    "fee_mismatch",
    "too_many_services",
    "price_above_ceiling",
    "pin_refused",
    "spend_rate_out_of_range",
    "description_too_long",
    "allowance_ceiling",
    "allowance_pool_full",
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
    // The order's kind and allowance, so a local wallet can tell an allowance from sandbox time
    kind?: OrderKind;
    allowanceMicros?: number;
}

// Start and extend, a start with allowanceMicros above 0 adds allowanceMicros, firstUse and x402
export interface PaidOrder {
    status: "paid";
    orderId: string;
    orderToken: string;
    // The Solana address that paid
    payer: string;
    kind: PackageKind;
    packageId: string;
    amountMicros: number;
    // Extend orders only
    handleSha256?: string;
    allowanceMicros?: number;
    firstUse?: boolean;
    x402?: X402Account;
    // Goes back to the client as _meta["x402/payment-response"]
    paymentResponse?: unknown;
}

export interface PaidAllowanceOrder {
    status: "paid";
    orderId: string;
    kind: "allowance";
    handleSha256: string;
    // The Solana address that paid
    payer: string;
    amountMicros: number;
    allowanceMicros: number;
    firstUse: boolean;
    x402: X402Account;
    // Goes back to the client as _meta["x402/payment-response"]
    paymentResponse?: unknown;
}

export interface RefusedOrder {
    status: "refused";
    orderId?: string;
    reason: RefusalReason;
    retryAfterSeconds?: number;
    // Only allowance_ceiling, allowance_pool_full, sandbox_ended and order_expired after payment
    refundPending?: boolean;
    // Only x402_disabled, x402_paused and x402_unavailable at settle
    charged?: false;
    // Only pin_refused
    serviceId?: string;
    pinReason?: string;
}

export type OrderResult = AwaitingPayment | PaidOrder | PaidAllowanceOrder | RefusedOrder;

export const configureRefusalReasons = [
    "needs_payment",
    "no_account",
    "sandbox_ended",
    "price_above_ceiling",
    "too_many_services",
    "spend_rate_out_of_range",
    "router_unavailable",
    "idempotency_conflict",
    "bad_request",
    "unauthorized",
] as const;

export type ConfigureRefusalReason = (typeof configureRefusalReasons)[number];

export interface X402ConfigureRefused {
    status: "refused";
    reason: ConfigureRefusalReason;
}

export type X402ConfigureResult = { status: "ok"; x402: X402Account } | X402ConfigureRefused;

export interface Payments {
    readonly mode: "dev" | "http";
    order(req: OrderRequest, signal: AbortSignal): Promise<OrderResult>;
    // A paid order the router refused, which the router records nothing for, so Payments refunds it
    abandon(orderId: string, reason: string, signal: AbortSignal): Promise<void>;
    x402Terms(signal: AbortSignal): Promise<X402Terms>;
    x402Configure(
        handleSha256: string,
        setup: X402Setup,
        requestId: string,
        signal: AbortSignal,
    ): Promise<X402ConfigureResult>;
    // Never null, a sandbox with no account answers x402 null and feeDue true
    x402Account(handleSha256: string, signal: AbortSignal): Promise<X402AccountAnswer>;
    // At most 20 hosts, a host without paid calls is absent from the answer
    x402Sellers(hosts: string[], signal: AbortSignal): Promise<Record<string, X402SellerStats>>;
}
