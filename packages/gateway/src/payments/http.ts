import { GatewayError } from "../router.ts";
import type { OrderRequest, OrderResult, Payments, RefusedOrder } from "./port.ts";

export const paymentsUnavailableText = "the payment service did not answer, try again in a minute";

// Payments takes 1 to 200 characters without control characters (port §5)
export function abandonReason(reason: string): string {
    const clean = reason
        .replace(/\p{Cc}/gu, "")
        .trim()
        .slice(0, 200);
    return clean || "abandoned";
}

interface Answer {
    status: number;
    body: unknown;
}

const unavailable = () => new GatewayError("unavailable", paymentsUnavailableText);

function isRefused(body: unknown): body is RefusedOrder {
    return (
        typeof body === "object" &&
        body !== null &&
        (body as { status?: unknown }).status === "refused"
    );
}

// Calls the Payments service over the contract in docs/mcp-gateway/payments-port.md
export class HttpPayments implements Payments {
    readonly mode = "http";

    constructor(
        private readonly baseUrl: string,
        private readonly token: string,
    ) {}

    private async post(path: string, body: unknown, signal: AbortSignal): Promise<Answer> {
        let res: Response;
        try {
            res = await fetch(new URL(path, this.baseUrl), {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${this.token}`,
                },
                body: JSON.stringify(body),
                signal,
            });
        } catch {
            throw signal.aborted ? signal.reason : unavailable();
        }
        const clientError = res.status >= 400 && res.status < 500;
        let text = "";
        try {
            text = await res.text();
        } catch {
            if (signal.aborted) throw signal.reason;
            if (!clientError) throw unavailable();
        }
        try {
            return { status: res.status, body: text ? JSON.parse(text) : undefined };
        } catch {
            return { status: res.status, body: undefined };
        }
    }

    async order(req: OrderRequest, signal: AbortSignal): Promise<OrderResult> {
        const { status, body } = await this.post("/v1/orders", req, signal);
        if (status >= 400 && status < 500) {
            if (isRefused(body)) return body;
            return { status: "refused", reason: status === 401 ? "unauthorized" : "bad_request" };
        }
        if (status < 200 || status >= 300) throw unavailable();
        if (!body || typeof body !== "object" || !("status" in body)) {
            throw new Error("payments answered without a status");
        }
        return body as OrderResult;
    }

    async abandon(orderId: string, reason: string, signal: AbortSignal): Promise<void> {
        const path = `/v1/orders/${encodeURIComponent(orderId)}/abandon`;
        const { status, body } = await this.post(path, { reason: abandonReason(reason) }, signal);
        if (status >= 200 && status < 300) return;
        // A 404 means Payments no longer holds the order, so there is nothing left to abandon
        if (status === 404) return;
        if (status >= 400 && status < 500) {
            const named = (body as { reason?: unknown } | undefined)?.reason;
            throw new Error(`abandon refused: ${typeof named === "string" ? named : status}`);
        }
        throw unavailable();
    }
}
