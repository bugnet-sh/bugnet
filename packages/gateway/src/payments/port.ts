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

export interface OrderRequest {
    kind: OrderKind;
    packageId: string;
    amountMicros: number;
    // Shown to the payer, for example "Bugnet sandbox 2 vCPU / 2 GiB / 10 min"
    description: string;
    // Lowercase hex sha256 of the handle, extend orders only
    handleSha256?: string;
    // An order the client was given earlier and now retries
    orderId?: string;
    // The x402 PaymentPayload from _meta["x402/payment"], passed through untouched
    payment?: unknown;
    // Stable for one tool call across the client's retries
    idempotencyKey?: string;
}

export type OrderResult =
    | {
          status: "payment_required";
          orderId: string;
          paymentRequired: X402PaymentRequired;
          // A page or x402 resource where the order can be paid outside the MCP client
          payUrl?: string;
      }
    | {
          status: "paid";
          orderId: string;
          orderToken: string;
          // The Solana address that paid
          payer: string;
          // Goes back to the client as _meta["x402/payment-response"]
          paymentResponse?: unknown;
      }
    | { status: "refused"; orderId?: string; reason: string };

export interface Payments {
    readonly mode: "dev" | "http";
    order(req: OrderRequest, signal: AbortSignal): Promise<OrderResult>;
    // A paid order the router refused, which the router records nothing for, so Payments refunds it
    abandon(orderId: string, reason: string, signal: AbortSignal): Promise<void>;
}
