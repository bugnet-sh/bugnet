// The x402 signer port the Payments team implements, which the README's bridge section describes
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
