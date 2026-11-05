import type { OrderRequest, OrderResult, Payments } from "./port.ts";

// Calls the Payments service over the contract in docs/mcp-gateway/payments-port.md
export class HttpPayments implements Payments {
    readonly mode = "http";

    constructor(
        private readonly baseUrl: string,
        private readonly token: string,
    ) {}

    private async post(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
        const res = await fetch(new URL(path, this.baseUrl), {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${this.token}`,
            },
            body: JSON.stringify(body),
            signal,
        });
        if (!res.ok) throw new Error(`payments answered ${res.status}`);
        return res.status === 204 ? null : res.json();
    }

    async order(req: OrderRequest, signal: AbortSignal): Promise<OrderResult> {
        const out = (await this.post("/v1/orders", req, signal)) as OrderResult;
        if (!out || typeof out !== "object" || !("status" in out)) {
            throw new Error("payments answered without a status");
        }
        return out;
    }

    async abandon(orderId: string, reason: string, signal: AbortSignal): Promise<void> {
        await this.post(`/v1/orders/${encodeURIComponent(orderId)}/abandon`, { reason }, signal);
    }
}
