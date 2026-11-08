// Lets the user pay at the order's link in their browser, then waits for the payment page to say paid
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as sleepFor } from "node:timers/promises";
import {
    inputRequired,
    type CallToolResult,
    type ClientCapabilities,
    type InputRequiredResult,
} from "@modelcontextprotocol/server";
import type { BridgePay } from "./bridge.ts";
import type { PublicOrderState } from "./orders.ts";
import { progressEveryMs, usdText, type PaymentStep } from "./pay.ts";

export const pollEveryMs = 2_500;
export const pollForMs = 600_000;
export const linkTtlMs = 600_000;

// An empty elicitation object means form only, as the SDK reads it
export function canElicitUrl(caps: ClientCapabilities | undefined): boolean {
    const e: unknown = caps?.elicitation;
    return typeof e === "object" && e !== null && "url" in e;
}

const linkKey = randomBytes(32);
const statePattern = /^p1\.(\d{1,15})\.([A-Za-z0-9_-]{1,200})\.([0-9a-f]{64})$/;

function mac(issuedAt: number | string, orderId: string, tool: string): string {
    return createHmac("sha256", linkKey).update(`${issuedAt}\0${orderId}\0${tool}`).digest("hex");
}

export function linkState(step: PaymentStep, issuedAt: number): string {
    return `p1.${issuedAt}.${step.orderId}.${mac(issuedAt, step.orderId, step.tool)}`;
}

export function readLinkState(
    state: unknown,
    tool: string,
    now: number,
): { orderId: string } | null {
    if (typeof state !== "string") return null;
    const m = statePattern.exec(state);
    if (!m) return null;
    const issuedAt = Number(m[1]);
    if (now - issuedAt > linkTtlMs || issuedAt - now > 60_000) return null;
    const want = Buffer.from(`p1.${m[1]}.${m[2]}.${mac(m[1]!, m[2]!, tool)}`);
    const got = Buffer.from(state);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    return { orderId: m[2]! };
}

// The orderId field of a p1 state, its MAC not checked
export function linkStateOrderId(state: unknown): string | null {
    if (typeof state !== "string") return null;
    return statePattern.exec(state)?.[2] ?? null;
}

export function payLinkRequest(step: PaymentStep, now: number): InputRequiredResult {
    return inputRequired({
        inputRequests: {
            pay: inputRequired.elicitUrl({
                message:
                    `Pay ${usdText(step.amountMicros)} USDC for Bugnet order ${step.orderId} ` +
                    "with a Solana wallet in your browser. The agent goes on once it is paid.",
                url: step.payUrl,
            }),
        },
        requestState: linkState(step, now),
    });
}

export type LinkOutcome = "paid" | "expired" | "closed" | "unknown_order" | "timeout";

export async function waitPaid(
    orderId: string,
    deps: { status: BridgePay["status"]; sleep?: BridgePay["sleep"]; now: () => number },
    signal: AbortSignal,
    onProgress: () => void,
): Promise<LinkOutcome> {
    const sleep =
        deps.sleep ?? ((ms: number, s: AbortSignal) => sleepFor(ms, undefined, { signal: s }));
    const start = deps.now();
    let noted: number | undefined;
    // The read count caps the poll too, so a stopped clock cannot keep it going
    for (let read = 0; read < Math.ceil(pollForMs / pollEveryMs); read++) {
        if (deps.now() - start >= pollForMs) return "timeout";
        if (noted === undefined || deps.now() - noted >= progressEveryMs) {
            noted = deps.now();
            onProgress();
        }
        let state: PublicOrderState | null | undefined;
        try {
            state = await deps.status(orderId, signal);
        } catch (e) {
            // A failed read, a 429 included, only means the next poll tries again
            if (signal.aborted) throw e;
        }
        if (signal.aborted) throw signal.reason;
        if (state === null) return "unknown_order";
        if (state === "paid") return "paid";
        if (state === "expired") return "expired";
        if (state === "refunded" || state === "review") return "closed";
        await sleep(pollEveryMs, signal);
    }
    return "timeout";
}

// The gateway's payment step for the order, worded as its own tool words it
export function paymentStepResult(step: PaymentStep, quoteId?: string): CallToolResult {
    const id = step.orderId;
    const named = quoteId
        ? ` (orderId "${id}", claim "${step.claim}", quoteId "${quoteId}")`
        : step.tool !== "bugnet_start"
          ? ` (orderId "${id}", claim "${step.claim}" and this sandbox's handle)`
          : ` (orderId "${id}", claim "${step.claim}")`;
    const guide = [
        `Payment required for order ${id}.`,
        "Next: show the user this link to pay in their browser with a Solana wallet holding " +
            `USDC: ${step.payUrl}. Then, in the same turn and without waiting for the user, call ` +
            `bugnet_redeem with orderId and claim${named}.`,
        "It waits for the payment and goes on once it lands; if it answers that the order is " +
            "not paid yet, call it again, for up to 10 minutes.",
        `Calling ${step.tool} again without this orderId opens a new order the user would pay again.`,
        "The x402 maxTimeoutSeconds limits a wallet's signed payment, not the user's time to pay.",
    ].join(" ");
    return {
        isError: true,
        content: [{ type: "text", text: guide }],
        structuredContent: {
            message: guide,
            orderId: id,
            payUrl: step.payUrl,
            claim: step.claim,
            ...(quoteId ? { quoteId } : {}),
        },
    };
}

export function lostLinkText(tool: string): string {
    return (
        `This pay link is no longer valid. Call ${tool} again with the orderId and claim ` +
        "from its payment step, since a call without them opens a new order the user would " +
        "pay again."
    );
}
