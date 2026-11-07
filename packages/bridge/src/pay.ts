// Pays an order with the pay CLI, started with flags that refuse any other origin, network or amount
import type { CallToolResult } from "@modelcontextprotocol/server";
import { paymentRequired, type X402PaymentRequired } from "./payment.ts";

export const payTimeoutMs = 300_000;
export const progressEveryMs = 5_000;
// Bounds pay's connect and its tool listing
export const payStartTimeoutMs = 15_000;

export type PaidTool = "bugnet_start" | "bugnet_extend";

export interface PaymentStep {
    tool: PaidTool;
    orderId: string;
    claim: string;
    payUrl: string;
    amountMicros: number;
}

const orderIdPattern = /^[A-Za-z0-9_-]{1,200}$/;
const claimPattern = /^[A-Za-z0-9_-]{43}$/;
const amountPattern = /^\d{1,15}$/;

export function paymentStep(tool: string, result: CallToolResult): PaymentStep | null {
    if (tool !== "bugnet_start" && tool !== "bugnet_extend") return null;
    const required = paymentRequired(result);
    if (!required) return null;
    const s = result.structuredContent as Record<string, unknown>;
    const { orderId, claim, payUrl } = s;
    if (typeof orderId !== "string" || !orderIdPattern.test(orderId)) return null;
    if (typeof claim !== "string" || !claimPattern.test(claim)) return null;
    if (typeof payUrl !== "string" || !URL.canParse(payUrl)) return null;
    const first = required.accepts[0] as { amount?: unknown } | undefined;
    if (typeof first?.amount !== "string" || !amountPattern.test(first.amount)) return null;
    return { tool, orderId, claim, payUrl, amountMicros: Number(first.amount) };
}

// Integer arithmetic only, so a price is never off by a float's rounding
export function priceMicros(confirmPriceUsd: unknown): number | null {
    if (typeof confirmPriceUsd !== "string") return null;
    const m = /^\$?(\d{1,9})(?:\.(\d{1,6}))?$/.exec(confirmPriceUsd);
    if (!m) return null;
    return Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
}

export function usdText(micros: number): string {
    const whole = Math.floor(micros / 1_000_000);
    const frac = String(micros % 1_000_000)
        .padStart(6, "0")
        .replace(/0+$/, "")
        .padEnd(2, "0");
    return `$${whole}.${frac}`;
}

export function maxPaymentMicros(pricesMicros: readonly number[]): number {
    if (pricesMicros.length === 0) throw new RangeError("no prices");
    return Math.max(...pricesMicros);
}

export function payArgs(origin: string, maxMicros: number): string[] {
    return [
        "mcp",
        "--allow-origin",
        origin,
        "--allow-network",
        "mainnet",
        "--max-payment",
        usdText(maxMicros),
    ];
}

// Any PAY_ variable could loosen pay's limits, and NO_DNA turns on its auto-pay
export function payEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
        if (typeof v === "string" && !/^PAY_/i.test(k) && k !== "NO_DNA") out[k] = v;
    }
    return out;
}

// Returns the first check that fails, in the order origin, path, memo, price
export function payRefusal(
    step: PaymentStep,
    origin: string,
    confirmedMicros: number | null,
    required: X402PaymentRequired,
): string | null {
    const url = new URL(step.payUrl);
    if (url.origin !== origin || url.username !== "" || url.password !== "") return "origin";
    if (url.pathname !== `/o/${step.orderId}` || url.search !== "" || url.hash !== "") {
        return "path";
    }
    const memo = (required.accepts[0] as { extra?: { memo?: unknown } } | undefined)?.extra?.memo;
    if (memo !== undefined && memo !== step.orderId) return "memo";
    if (confirmedMicros === null || step.amountMicros > confirmedMicros) return "price";
    return null;
}

function asObject(v: unknown): Record<string, unknown> | null {
    return typeof v === "object" && v !== null && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

// Pay's curl text is the body, the status line and headers then the body, or a status and body pair
export function parsePayBody(text: string): Record<string, unknown> | null {
    let found = asObject(parseJson(text));
    if (!found) {
        const line = text
            .split("\n")
            .reverse()
            .find((l) => l.startsWith("{"));
        found = line === undefined ? null : asObject(parseJson(line));
    }
    if (!found) return null;
    const body = typeof found.body === "string" ? parseJson(found.body) : found.body;
    return asObject(body) ?? found;
}

export type PayOutcome =
    | { kind: "paid" }
    | { kind: "declined"; reason: string }
    | { kind: "unavailable"; reason: string }
    | { kind: "unknown" };

export interface OrderPayer {
    pay(step: PaymentStep, maxMicros: number, onProgress: () => void): Promise<PayOutcome>;
}
