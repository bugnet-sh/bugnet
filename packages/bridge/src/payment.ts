/**
 * The bridge's x402 payment port, for the Payments team to implement.
 *
 * A paid gateway tool (bugnet_start, bugnet_extend) that has no payment answers with an error
 * result whose structuredContent is the x402 PaymentRequired, as payments-port.md describes. When
 * the bridge has a signer, it hands that requirement to sign(). A payload back is sent as
 * _meta["x402/payment"] on one retry of the same call, with the same arguments and _meta, so the
 * gateway's idempotency key still names one order. null leaves the result to the agent unchanged,
 * which then shows the pay link. The signer owns the user's spend caps, the confirmation hook and
 * the wallet keys, and never sees anything but this requirement and the call it belongs to.
 * The bridge ships without a signer, so every paid call passes through untouched.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";

export interface X402PaymentRequired {
    x402Version: number;
    accepts: unknown[];
    error?: string;
    resource?: { url: string; description?: string; mimeType?: string };
    extensions?: Record<string, unknown>;
}

export interface PaidCall {
    tool: string;
    arguments: Record<string, unknown>;
}

export interface PaymentSigner {
    sign(
        required: X402PaymentRequired,
        call: PaidCall,
        signal: AbortSignal,
    ): Promise<unknown | null>;
}

export const paymentMetaKey = "x402/payment";

export function paymentRequired(result: CallToolResult): X402PaymentRequired | null {
    const s = result.structuredContent as Record<string, unknown> | undefined;
    if (result.isError !== true || !s || typeof s !== "object") return null;
    if (typeof s.x402Version !== "number" || !Array.isArray(s.accepts)) return null;
    return s as unknown as X402PaymentRequired;
}
