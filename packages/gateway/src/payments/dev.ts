import { randomBytes, randomUUID } from "node:crypto";
import { orderKey, signOrderToken } from "./ordertoken.ts";
import type {
    AwaitingPayment,
    OrderRequest,
    OrderResult,
    OrderTerms,
    PaidOrder,
    Payments,
    RefusedOrder,
    RefusalReason,
} from "./port.ts";

export const devUnpaidTtlMs = 15 * 60_000;

export interface DevPaymentsOptions {
    requirePayment?: boolean;
    payBaseUrl?: string;
}

export interface DevPublicAnswer {
    status: number;
    body: Record<string, unknown>;
}

const paymentsIdPattern = /^ord_[a-z2-7]{26}$/;
const idAlphabet = "abcdefghijklmnopqrstuvwxyz234567";
const minIdempotencyKeyLength = 16;
const solanaMainnet = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface StoredOrder extends OrderTerms {
    orderId: string;
    claim: string | null;
    state: "unpaid" | "paid" | "redeemed";
    createdAt: number;
    idempotencyKey: string | null;
    // The JSON of the payment that paid it, null when paid at the pay link
    paidBy: string | null;
    token: PaidOrder | null;
    tokenExpiresAt: number | null;
}

function memoOf(payment: unknown): string | null {
    const accepted = (payment as { accepted?: { extra?: { memo?: unknown } } } | null)?.accepted;
    const memo = accepted?.extra?.memo;
    return typeof memo === "string" && paymentsIdPattern.test(memo) ? memo : null;
}

function newOrderId(): string {
    let id = "ord_";
    for (const byte of randomBytes(26)) id += idAlphabet[byte & 31];
    return id;
}

// Settles orders without charging, at once or at a loopback pay link, for a gateway that serves only this machine
export class DevPayments implements Payments {
    readonly mode = "dev";
    readonly requiresPayment: boolean;
    private readonly key;
    private readonly payBaseUrl: string;
    private readonly orders = new Map<string, StoredOrder>();
    private readonly byKey = new Map<string, string>();

    constructor(
        seed: Buffer,
        private readonly ttlMs: number,
        private readonly now: () => number = Date.now,
        opts: DevPaymentsOptions = {},
    ) {
        this.key = orderKey(seed);
        this.requiresPayment = opts.requirePayment ?? false;
        this.payBaseUrl = opts.payBaseUrl ?? "http://127.0.0.1:8787";
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

    private store(
        orderId: string,
        terms: OrderTerms,
        extra: Partial<StoredOrder> = {},
    ): StoredOrder {
        const stored: StoredOrder = {
            orderId,
            kind: terms.kind,
            packageId: terms.packageId,
            amountMicros: terms.amountMicros,
            description: terms.description,
            ...(terms.handleSha256 ? { handleSha256: terms.handleSha256 } : {}),
            claim: null,
            state: "paid",
            createdAt: this.now(),
            idempotencyKey: null,
            paidBy: null,
            token: null,
            tokenExpiresAt: null,
            ...extra,
        };
        this.orders.set(orderId, stored);
        return stored;
    }

    async order(req: OrderRequest): Promise<OrderResult> {
        return this.requiresPayment ? this.requireOrder(req) : this.settleAtOnce(req);
    }

    private settleAtOnce(req: OrderRequest): OrderResult {
        if (req.claim !== undefined) {
            const stored = this.orders.get(req.orderId);
            return stored ? this.paid(stored) : this.unknown(req.orderId);
        }
        const orderId = req.orderId ?? req.idempotencyKey ?? randomUUID();
        return this.paid(this.store(orderId, req));
    }

    // Port §2, orderId only when the order is known or the id is well formed
    private unknown(orderId: string): RefusedOrder {
        return {
            status: "refused",
            ...(paymentsIdPattern.test(orderId) ? { orderId } : {}),
            reason: "order_unknown",
        };
    }

    private expired(o: StoredOrder): boolean {
        return o.state === "unpaid" && this.now() >= o.createdAt + devUnpaidTtlMs;
    }

    private awaiting(o: StoredOrder, withClaim: boolean): AwaitingPayment {
        const payUrl = `${this.payBaseUrl}/o/${o.orderId}`;
        return {
            status: "payment_required",
            orderId: o.orderId,
            ...(withClaim && o.claim ? { claim: o.claim } : {}),
            payUrl,
            paymentRequired: {
                x402Version: 2,
                resource: { url: payUrl, description: o.description, mimeType: "application/json" },
                accepts: [
                    {
                        scheme: "exact",
                        network: solanaMainnet,
                        asset: usdcMint,
                        amount: String(o.amountMicros),
                        payTo: "BugnetDevPayee",
                        maxTimeoutSeconds: 300,
                        extra: { memo: o.orderId },
                    },
                ],
            },
        };
    }

    private refuse(o: StoredOrder, reason: RefusalReason): RefusedOrder {
        return { status: "refused", orderId: o.orderId, reason };
    }

    // Follows Payments' handleOrderRequest, with the pay link standing in for the chain
    private requireOrder(req: OrderRequest): OrderResult {
        const memo = memoOf(req.payment);
        const keyed =
            req.idempotencyKey !== undefined && req.idempotencyKey.length >= minIdempotencyKeyLength
                ? req.idempotencyKey
                : null;
        let stored: StoredOrder | undefined;
        let replay = false;
        if (req.orderId !== undefined || memo !== null) {
            const id = req.orderId ?? (memo as string);
            stored = this.orders.get(id);
            if (!stored) return this.unknown(id);
        } else if (keyed !== null && this.byKey.has(keyed)) {
            stored = this.orders.get(this.byKey.get(keyed) as string);
            replay = true;
        }
        if (!stored) {
            const orderId = newOrderId();
            const created = this.store(orderId, req as OrderTerms, {
                state: "unpaid",
                claim: randomBytes(32).toString("base64url"),
                idempotencyKey: keyed,
            });
            if (keyed !== null) this.byKey.set(keyed, orderId);
            return this.awaiting(created, true);
        }
        const differs =
            (req.kind !== undefined && req.kind !== stored.kind) ||
            (req.packageId !== undefined && req.packageId !== stored.packageId) ||
            (req.amountMicros !== undefined && req.amountMicros !== stored.amountMicros) ||
            (req.handleSha256 !== undefined && req.handleSha256 !== stored.handleSha256);
        if (differs) return this.refuse(stored, replay ? "idempotency_conflict" : "terms_mismatch");

        // The payment settles first and the claim is checked after it (port §2)
        let authorized = false;
        if (req.payment !== undefined) {
            if (memo === null && replay) return this.refuse(stored, "payment_order_mismatch");
            if (memo !== null) {
                if (memo !== stored.orderId) return this.refuse(stored, "payment_order_mismatch");
                const json = JSON.stringify(req.payment);
                if (stored.state === "unpaid") {
                    if (!this.expired(stored)) {
                        stored.state = "paid";
                        stored.paidBy = json;
                    }
                    authorized = true;
                } else {
                    // Port §6, the token goes only to the claim or the payment that paid it
                    authorized = stored.paidBy === json;
                }
            }
        }
        if (req.claim !== undefined) {
            if (req.claim !== stored.claim) return this.refuse(stored, "claim_mismatch");
            authorized = true;
        }
        if (this.expired(stored)) return this.refuse(stored, "order_expired");
        if (!authorized) {
            if (stored.state === "unpaid") return this.awaiting(stored, replay);
            return this.refuse(stored, "paid_claim_required");
        }
        if (stored.state === "unpaid") return this.awaiting(stored, false);
        if (stored.state === "paid") {
            stored.state = "redeemed";
            stored.tokenExpiresAt = this.now() + this.ttlMs;
            stored.token = this.paid(stored);
            return stored.token;
        }
        if (this.now() < (stored.tokenExpiresAt as number)) return stored.token as PaidOrder;
        return this.refuse(stored, "token_expired");
    }

    // Marks an unpaid order paid, in place of Payments' 402 for a request with no payment header
    pay(orderId: string): DevPublicAnswer {
        const stored = this.orders.get(orderId);
        if (!stored) return { status: 404, body: { error: "order_unknown" } };
        if (this.expired(stored)) {
            return { status: 410, body: { error: "order_expired", orderId } };
        }
        if (stored.state === "unpaid") stored.state = "paid";
        return { status: 200, body: { paid: true, orderId } };
    }

    status(orderId: string): DevPublicAnswer {
        const stored = this.orders.get(orderId);
        if (!stored) return { status: 404, body: { error: "order_unknown" } };
        const state = this.expired(stored)
            ? "expired"
            : stored.state === "unpaid"
              ? "unpaid"
              : "paid";
        return {
            status: 200,
            body: {
                orderId,
                state,
                expiresAt: new Date(stored.createdAt + devUnpaidTtlMs).toISOString(),
            },
        };
    }

    async abandon(): Promise<void> {}
}
