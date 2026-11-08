// Paid orders the bridge has not redeemed yet, kept in memory so a retry never pays twice
import type { CallToolResult } from "@modelcontextprotocol/server";
import { priceMicros, type PaymentStep } from "./pay.ts";

// Payments refunds a paid order nobody redeemed after 30 minutes
export const paidOrderTtlMs = 30 * 60_000;
// Bounds one status read
export const statusTimeoutMs = 10_000;

export type PublicOrderState = "unpaid" | "settling" | "paid" | "expired" | "refunded" | "review";
export type UnpaidOutcome = "timeout" | "expired" | "closed" | "unknown_order";

const states: readonly string[] = ["unpaid", "settling", "paid", "expired", "refunded", "review"];

export function orderKey(tool: string, args: Record<string, unknown>): string | null {
    const { handle, packageId } = args;
    if (tool === "bugnet_x402_budget") {
        // All paid allowance calls for a sandbox share one key, so a changed retry never pays twice
        const amount = priceMicros(args.amountUsd);
        return typeof handle === "string" && amount !== null && amount > 0
            ? `allowance\0${handle}`
            : null;
    }
    if (typeof packageId !== "string") return null;
    if (tool === "bugnet_start") return `start\0${packageId}`;
    if (tool === "bugnet_extend" && typeof handle === "string") {
        return `extend\0${handle}\0${packageId}`;
    }
    return null;
}

interface Entry {
    key: string | null;
    step: PaymentStep;
    state: "seen" | "paying" | "paid" | "unknown";
    tried: boolean;
    // The order's pay link was opened for the user, so it stays payable there
    link: boolean;
    at: number;
}

export class PaidOrders {
    private readonly entries = new Map<string, Entry>();
    private readonly flights = new Map<string, Promise<unknown>>();
    private readonly now: () => number;

    constructor(now: () => number) {
        this.now = now;
    }

    private sweep(): void {
        const t = this.now();
        for (const [id, e] of this.entries) {
            if (t >= e.at + paidOrderTtlMs) this.drop(id);
        }
    }

    see(key: string | null, step: PaymentStep): void {
        this.sweep();
        const e = this.entries.get(step.orderId);
        this.entries.set(step.orderId, {
            key,
            step,
            state: e?.state ?? "seen",
            tried: e?.tried ?? false,
            link: e?.link ?? false,
            at: this.now(),
        });
    }

    step(orderId: string): PaymentStep | undefined {
        this.sweep();
        return this.entries.get(orderId)?.step;
    }

    markPaid(orderId: string, state: "paid" | "unknown"): void {
        this.sweep();
        const e = this.entries.get(orderId);
        if (e) {
            e.state = state;
            e.at = this.now();
        }
    }

    // A pay in flight is held too, so a retry waits for it instead of opening a second order
    heldFor(key: string): (PaymentStep & { state: "paying" | "paid" | "unknown" }) | undefined {
        this.sweep();
        let best: Entry | undefined;
        for (const e of this.entries.values()) {
            if (e.key !== key || e.state === "seen") continue;
            if (!best || e.at >= best.at) best = e;
        }
        return best && { ...best.step, state: best.state as "paying" | "paid" | "unknown" };
    }

    // The hold on the order a call names, when it was made for the same package
    held(
        orderId: string,
        key: string,
    ): (PaymentStep & { state: "paying" | "paid" | "unknown" }) | undefined {
        this.sweep();
        const e = this.entries.get(orderId);
        if (!e || e.key !== key || e.state === "seen") return undefined;
        return { ...e.step, state: e.state };
    }

    // The hold on an order whose pay link the user was given, for a call that names no package
    heldLink(
        orderId: string,
    ): (PaymentStep & { state: "paying" | "paid" | "unknown" }) | undefined {
        this.sweep();
        const e = this.entries.get(orderId);
        if (!e || !e.link || e.state === "seen") return undefined;
        return { ...e.step, state: e.state };
    }

    // Marks the order as being paid, with the one pay promise every waiting call shares
    markPaying(orderId: string, flight: Promise<unknown>): void {
        this.sweep();
        const e = this.entries.get(orderId);
        if (!e) return;
        e.state = "paying";
        e.tried = true;
        e.at = this.now();
        this.flights.set(orderId, flight);
    }

    linkOpened(orderId: string): boolean {
        return this.entries.get(orderId)?.link ?? false;
    }

    markLink(orderId: string): void {
        const e = this.entries.get(orderId);
        if (e) e.link = true;
    }

    // The user may pay at a link without the client ever calling back, so it is held once issued
    holdLink(orderId: string): void {
        this.sweep();
        const e = this.entries.get(orderId);
        if (!e) return;
        e.link = true;
        if (e.state === "paying") return;
        e.state = "unknown";
        e.at = this.now();
    }

    flight(orderId: string): Promise<unknown> | undefined {
        return this.flights.get(orderId);
    }

    // Stops holding an order but remembers pay was tried for it, so it is never paid twice
    forget(orderId: string): void {
        const e = this.entries.get(orderId);
        if (e) e.state = "seen";
    }

    drop(orderId: string): void {
        this.entries.delete(orderId);
        this.flights.delete(orderId);
    }

    tried(orderId: string): boolean {
        this.sweep();
        return this.entries.get(orderId)?.tried ?? false;
    }

    markTried(orderId: string): void {
        this.sweep();
        const e = this.entries.get(orderId);
        if (e) e.tried = true;
    }
}

export async function orderStatus(
    origin: string,
    orderId: string,
    signal: AbortSignal,
    fetchFn: typeof fetch = fetch,
): Promise<PublicOrderState | null> {
    const res = await fetchFn(`${origin}/o/${encodeURIComponent(orderId)}/status`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(statusTimeoutMs)]),
    });
    if (res.status === 404) return null;
    if (res.status === 200) {
        const body = (await res.json().catch(() => null)) as { state?: unknown } | null;
        if (typeof body?.state === "string" && states.includes(body.state)) {
            return body.state as PublicOrderState;
        }
    }
    throw new Error(`order status answered ${res.status}`);
}

export function afterPaymentText(step: Pick<PaymentStep, "tool" | "orderId" | "claim">): string {
    return (
        ` Order ${step.orderId} is paid: call ${step.tool} again with orderId "${step.orderId}" ` +
        `and claim "${step.claim}" to use it, and never pay it again.`
    );
}

// Payments called these orders spent, so a paid one is refunded and must not be paid again
export function spentOrderText(step: Pick<PaymentStep, "orderId" | "claim">): string {
    return (
        ` Order ${step.orderId} (claim "${step.claim}") can no longer be used. If it was paid, ` +
        "it is refunded automatically, so do not pay it again."
    );
}

export const spentRefusals: ReadonlySet<string> = new Set([
    // The gateway's own word for an order the router refused outright, which Payments refunds
    "abandoned",
    "order_unknown",
    "order_expired",
    "order_closed",
    "claim_mismatch",
    "terms_mismatch",
    "payment_late",
    "token_expired",
    // Payments refunds an allowance its paid check refused, and an ended sandbox can use none
    "sandbox_ended",
    "sandbox_unknown",
    "allowance_ceiling",
    "allowance_pool_full",
]);

export function unpaidText(
    outcome: UnpaidOutcome,
    step: Pick<PaymentStep, "tool" | "orderId" | "claim" | "payUrl">,
): string {
    const id = step.orderId;
    switch (outcome) {
        case "timeout":
            return (
                `Order ${id} is not paid yet. Once the user pays at ${step.payUrl}, call ` +
                `${step.tool} again with orderId "${id}" and claim "${step.claim}".`
            );
        case "expired":
            return (
                `Order ${id} expired before it was paid, so nothing was charged. ` +
                `Call ${step.tool} again for a new order.`
            );
        case "closed":
            return (
                `Order ${id} is closed: its payment was refunded or is being checked by hand. ` +
                "Tell the user before paying again."
            );
        case "unknown_order":
            return (
                `Order ${id} is unknown to the payment page. ` +
                `Call ${step.tool} again for a new order.`
            );
    }
}

export function withAfterPayment(
    result: CallToolResult,
    step: PaymentStep,
    spent = false,
): CallToolResult {
    const line = spent ? spentOrderText(step) : afterPaymentText(step);
    const content = [...result.content];
    const at = content.map((c) => c.type).lastIndexOf("text");
    const last = content[at];
    if (last?.type === "text") content[at] = { ...last, text: last.text + line };
    else content.push({ type: "text", text: line.trimStart() });
    const out: CallToolResult = { ...result, content };
    const sc = result.structuredContent as { message?: unknown } | undefined;
    if (typeof sc?.message === "string")
        out.structuredContent = { ...sc, message: sc.message + line };
    return out;
}
