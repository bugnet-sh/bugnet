import { randomUUID } from "node:crypto";
import { orderKey, signOrderToken } from "./ordertoken.ts";
import type { OrderRequest, OrderResult, Payments } from "./port.ts";

// Settles every order at once without charging, for a gateway that serves only this machine
export class DevPayments implements Payments {
    readonly mode = "dev";
    private readonly key;

    constructor(
        seed: Buffer,
        private readonly ttlMs: number,
        private readonly now: () => number = Date.now,
    ) {
        this.key = orderKey(seed);
    }

    async order(req: OrderRequest): Promise<OrderResult> {
        const orderId = req.orderId ?? req.idempotencyKey ?? randomUUID();
        const orderToken = signOrderToken(this.key, {
            order_id: orderId,
            kind: req.kind,
            package_id: req.packageId,
            amount_micros: req.amountMicros,
            expires_at: new Date(this.now() + this.ttlMs).toISOString(),
            ...(req.handleSha256 ? { handle_sha256: req.handleSha256 } : {}),
        });
        return { status: "paid", orderId, orderToken, payer: "dev" };
    }

    async abandon(): Promise<void> {}
}
