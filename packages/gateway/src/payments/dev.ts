import { randomUUID } from "node:crypto";
import { orderKey, signOrderToken } from "./ordertoken.ts";
import type { OrderRequest, OrderResult, OrderTerms, PaidOrder, Payments } from "./port.ts";

export interface DevPaymentsOptions {
    requirePayment?: boolean;
}

const paymentsIdPattern = /^ord_[a-z2-7]{26}$/;

interface StoredOrder extends OrderTerms {
    orderId: string;
}

// Settles every order at once without charging, for a gateway that serves only this machine
export class DevPayments implements Payments {
    readonly mode = "dev";
    readonly requiresPayment: boolean;
    private readonly key;
    private readonly orders = new Map<string, StoredOrder>();

    constructor(
        seed: Buffer,
        private readonly ttlMs: number,
        private readonly now: () => number = Date.now,
        opts: DevPaymentsOptions = {},
    ) {
        this.key = orderKey(seed);
        this.requiresPayment = opts.requirePayment ?? false;
    }

    private paid(o: StoredOrder): PaidOrder {
        const orderToken = signOrderToken(this.key, {
            order_id: o.orderId,
            kind: o.kind,
            package_id: o.packageId,
            amount_micros: o.amountMicros,
            expires_at: new Date(this.now() + this.ttlMs).toISOString(),
            ...(o.handleSha256 ? { handle_sha256: o.handleSha256 } : {}),
        });
        return {
            status: "paid",
            orderId: o.orderId,
            orderToken,
            payer: "dev",
            kind: o.kind,
            packageId: o.packageId,
            amountMicros: o.amountMicros,
            ...(o.handleSha256 ? { handleSha256: o.handleSha256 } : {}),
        };
    }

    async order(req: OrderRequest): Promise<OrderResult> {
        if (req.claim !== undefined) {
            const stored = this.orders.get(req.orderId);
            if (!stored) {
                // Port §2, orderId only when the order is known
                return {
                    status: "refused",
                    ...(paymentsIdPattern.test(req.orderId) ? { orderId: req.orderId } : {}),
                    reason: "order_unknown",
                };
            }
            return this.paid(stored);
        }
        const orderId = req.orderId ?? req.idempotencyKey ?? randomUUID();
        const stored: StoredOrder = {
            orderId,
            kind: req.kind,
            packageId: req.packageId,
            amountMicros: req.amountMicros,
            description: req.description,
            ...(req.handleSha256 ? { handleSha256: req.handleSha256 } : {}),
        };
        this.orders.set(orderId, stored);
        return this.paid(stored);
    }

    async abandon(): Promise<void> {}
}
