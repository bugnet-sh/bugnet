import { z } from "zod";
import { GatewayError } from "../router.ts";
import {
    configureRefusalReasons,
    type OrderRequest,
    type OrderResult,
    type Payments,
    type RefusedOrder,
    type X402AccountAnswer,
    type X402ConfigureRefused,
    type X402ConfigureResult,
    type X402SellerStats,
    type X402Setup,
    type X402Terms,
} from "./port.ts";

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

const micros = z.int().min(0);
const method = z.enum(["GET", "POST"]);

export const termsSchema = z.object({
    enabled: z.boolean(),
    startWithX402: z.boolean(),
    network: z.string(),
    asset: z.string(),
    sessionFeeMicros: micros,
    minAllowanceMicros: micros,
    suggestedAllowanceMicros: micros,
    maxAllowancePerSandboxMicros: micros,
    maxPricePerCallMicros: micros,
    defaultSpendPerMinuteMicros: micros,
    minSpendPerMinuteMicros: micros,
    maxSpendPerMinuteMicros: micros,
    maxServices: micros,
    maxNewServicesPerOrder: micros,
    sellerMemoMaxBytes: micros,
    refundMinMicros: micros,
    bugnetAddresses: z.array(z.string()).min(1).max(16),
}) satisfies z.ZodType<X402Terms>;

const accountSchema = z.object({
    state: z.enum(["open", "closing", "closed"]),
    fundedMicros: micros,
    spentMicros: micros,
    heldMicros: micros,
    leftMicros: micros,
    allowanceRoomMicros: micros,
    paidCalls: micros,
    pendingCalls: micros,
    spendPerMinuteMicros: micros,
    services: z.array(
        z.object({
            serviceId: z.string(),
            method,
            host: z.string(),
            prefix: z.string(),
            url: z.string(),
            paidPath: z.string().nullable(),
            maxPriceMicros: micros,
            payTo: z.string(),
            listed: z.enum(["indexed", "unlisted"]),
            state: z.enum(["enabled", "disabled", "unreliable"]),
        }),
    ),
    refund: z
        .object({
            state: z.enum(["waiting", "pending", "sent", "confirmed", "kept", "manual"]),
            amountMicros: micros,
            keptMicros: micros,
            txs: z.array(z.string()),
        })
        .optional(),
});

export const accountAnswerSchema = z.object({
    x402: accountSchema.nullable(),
    feeDue: z.boolean(),
}) satisfies z.ZodType<X402AccountAnswer>;

export const sellersSchema = z.record(
    z.string(),
    z.object({ paidCalls30d: micros, failedPaid30d: micros }),
) satisfies z.ZodType<Record<string, X402SellerStats>>;

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

    private async get(path: string, signal: AbortSignal): Promise<unknown> {
        let res: Response;
        try {
            res = await fetch(new URL(path, this.baseUrl), {
                method: "GET",
                headers: { authorization: `Bearer ${this.token}`, accept: "application/json" },
                signal,
            });
        } catch {
            throw signal.aborted ? signal.reason : unavailable();
        }
        let text: string;
        try {
            text = await res.text();
        } catch {
            throw signal.aborted ? signal.reason : unavailable();
        }
        if (res.status !== 200) throw unavailable();
        try {
            return JSON.parse(text);
        } catch {
            throw unavailable();
        }
    }

    private async getParsed<T>(
        path: string,
        schema: z.ZodType<T>,
        signal: AbortSignal,
    ): Promise<T> {
        const parsed = schema.safeParse(await this.get(path, signal));
        if (!parsed.success) throw unavailable();
        return parsed.data;
    }

    x402Terms(signal: AbortSignal): Promise<X402Terms> {
        return this.getParsed("/v1/x402/terms", termsSchema, signal);
    }

    x402Account(handleSha256: string, signal: AbortSignal): Promise<X402AccountAnswer> {
        const path = `/v1/x402/accounts/${encodeURIComponent(handleSha256)}`;
        return this.getParsed(path, accountAnswerSchema, signal);
    }

    async x402Sellers(
        hosts: string[],
        signal: AbortSignal,
    ): Promise<Record<string, X402SellerStats>> {
        if (hosts.length === 0) return {};
        const query = new URLSearchParams({ hosts: hosts.slice(0, 20).join(",") });
        return this.getParsed(`/v1/x402/sellers?${query}`, sellersSchema, signal);
    }

    async x402Configure(
        handleSha256: string,
        setup: X402Setup,
        requestId: string,
        signal: AbortSignal,
    ): Promise<X402ConfigureResult> {
        const { status, body } = await this.post(
            "/v1/x402/configure",
            {
                handleSha256,
                services: setup.services ?? [],
                disable: setup.disable ?? [],
                ...(setup.spendPerMinuteMicros !== undefined
                    ? { spendPerMinuteMicros: setup.spendPerMinuteMicros }
                    : {}),
                requestId,
            },
            signal,
        );
        const mapped = this.mapAnswer(status, body);
        if (mapped.refused) {
            const reason = (mapped.refused as { reason?: unknown }).reason;
            const known = (configureRefusalReasons as readonly unknown[]).includes(reason);
            return known
                ? (mapped.refused as X402ConfigureRefused)
                : { status: "refused", reason: "bad_request" };
        }
        const b = mapped.body as { status?: unknown } | undefined;
        if (b?.status === "ok") {
            const x402 = accountSchema.safeParse((mapped.body as { x402?: unknown }).x402);
            if (x402.success) return { status: "ok", x402: x402.data };
        }
        throw unavailable();
    }

    // Every 4xx and every 2xx refused body is a refusal, other statuses are unavailable
    private mapAnswer(
        status: number,
        body: unknown,
    ): { refused: { status: "refused"; reason: string } | null; body: unknown } {
        if (status >= 400 && status < 500) {
            return {
                refused: isRefused(body)
                    ? body
                    : {
                          status: "refused",
                          reason: status === 401 ? "unauthorized" : "bad_request",
                      },
                body,
            };
        }
        if (status < 200 || status >= 300) throw unavailable();
        return { refused: isRefused(body) ? body : null, body };
    }

    async order(req: OrderRequest, signal: AbortSignal): Promise<OrderResult> {
        const { status, body } = await this.post("/v1/orders", req, signal);
        const mapped = this.mapAnswer(status, body);
        if (mapped.refused && status >= 400) return mapped.refused as RefusedOrder;
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
