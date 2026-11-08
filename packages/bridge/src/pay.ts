// Pays an order with the pay CLI, started with flags that refuse any other origin, network or amount
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { CallToolResult } from "@modelcontextprotocol/server";
import pkg from "../package.json" with { type: "json" };
import type { Log } from "./log.ts";
import { paymentRequired, type X402PaymentRequired } from "./payment.ts";

export const payTimeoutMs = 300_000;
export const progressEveryMs = 5_000;
// Bounds pay's connect and its tool listing
export const payStartTimeoutMs = 15_000;

export type PaidTool = "bugnet_start" | "bugnet_extend" | "bugnet_x402_budget";
export const paidTools: readonly PaidTool[] = [
    "bugnet_start",
    "bugnet_extend",
    "bugnet_x402_budget",
];

export interface PaymentStep {
    tool: PaidTool;
    orderId: string;
    claim: string;
    payUrl: string;
    amountMicros: number;
}

// The only network and asset the bridge pays, checked here since pay may run without its limits
export const solanaMainnet = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// pay 0.29.0 refuses every payment with this once a limit flag is set, before anything is signed
const networkBug = /MCP permission denied: invalid Solana network/;

const orderIdPattern = /^[A-Za-z0-9_-]{1,200}$/;
const claimPattern = /^[A-Za-z0-9_-]{43}$/;
const amountPattern = /^\d{1,15}$/;

export function isPaidTool(tool: string): tool is PaidTool {
    return (paidTools as readonly string[]).includes(tool);
}

export function paymentStep(tool: string, result: CallToolResult): PaymentStep | null {
    if (!isPaidTool(tool)) return null;
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
    const first = required.accepts[0] as { network?: unknown; asset?: unknown } | undefined;
    if (first?.network !== solanaMainnet || first.asset !== usdcMint) return "network";
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

export interface PayCliOptions {
    command: string;
    origin: string;
    env: NodeJS.ProcessEnv;
    log: Log;
    timeoutMs?: number;
    progressMs?: number;
}

// One pay process per payment, so --max-payment is that order's confirmed price
export class PayCli implements OrderPayer {
    private readonly opts: PayCliOptions;

    constructor(opts: PayCliOptions) {
        this.opts = opts;
    }

    async pay(step: PaymentStep, maxMicros: number, onProgress: () => void): Promise<PayOutcome> {
        const { log } = this.opts;
        log.info("pay started", { orderId: step.orderId });
        let answer = await this.attempt(step, payArgs(this.opts.origin, maxMicros), onProgress);
        if (answer.text !== null && networkBug.test(answer.text)) {
            log.info("pay retried without its limits", { orderId: step.orderId });
            answer = await this.attempt(step, ["mcp"], onProgress);
        }
        const outcome = answer.outcome;
        log.info("pay finished", {
            orderId: step.orderId,
            outcome: outcome.kind,
            ...(outcome.kind === "unavailable" ? { reason: outcome.reason } : {}),
        });
        return outcome;
    }

    // One pay process, its outcome, and its curl text when it answered
    private async attempt(
        step: PaymentStep,
        args: string[],
        onProgress: () => void,
    ): Promise<{ outcome: PayOutcome; text: string | null }> {
        const transport = new StdioClientTransport({
            command: this.opts.command,
            args,
            env: payEnv(this.opts.env),
            stderr: "pipe",
        });
        // Pay's own words are never logged, they can name the payment
        (transport.stderr as NodeJS.ReadableStream | null)?.resume();
        // No capabilities and no handlers, so pay sees no elicitation and fails closed
        const client = new Client(
            { name: "bugnet-bridge", version: pkg.version },
            { capabilities: {} },
        );
        let ticker: NodeJS.Timeout | undefined;
        try {
            const tool = await this.start(client, transport);
            if (typeof tool !== "string") return { outcome: tool, text: null };
            ticker = setInterval(onProgress, this.opts.progressMs ?? progressEveryMs);
            try {
                const res = await client.callTool(
                    { name: tool, arguments: { url: step.payUrl } },
                    { timeout: this.opts.timeoutMs ?? payTimeoutMs },
                );
                const text = (res.content as { type: string; text?: string }[])
                    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
                    .join("\n");
                return { outcome: readAnswer(step, parsePayBody(text)), text };
            } catch {
                return { outcome: { kind: "unknown" }, text: null };
            }
        } finally {
            clearInterval(ticker);
            await client.close().catch(() => {});
        }
    }

    // The name of pay's curl tool, or why pay cannot be used
    private async start(
        client: Client,
        transport: StdioClientTransport,
    ): Promise<string | PayOutcome> {
        try {
            await client.connect(transport, { timeout: payStartTimeoutMs });
            const { tools } = await client.listTools(undefined, { timeout: payStartTimeoutMs });
            const tool =
                tools.find((t) => t.name === "curl") ?? tools.find((t) => t.name === "pay.curl");
            if (!tool) return { kind: "unavailable", reason: "no_curl" };
            const props = tool.inputSchema.properties as Record<string, unknown> | undefined;
            if (!props || !("url" in props)) return { kind: "unavailable", reason: "no_curl" };
            return tool.name;
        } catch {
            return { kind: "unavailable", reason: "start" };
        }
    }
}

// Port 8, a 200 says the order is paid and every non-2xx names a refusal
function readAnswer(step: PaymentStep, body: Record<string, unknown> | null): PayOutcome {
    if (body?.paid === true && body.orderId === step.orderId) return { kind: "paid" };
    if (typeof body?.refused === "string") {
        return { kind: "declined", reason: body.refused.slice(0, 64) };
    }
    return { kind: "unknown" };
}
