// The pay link as a client URL prompt, for clients on the 2026-07-28 protocol that take one
import { createHmac, timingSafeEqual } from "node:crypto";
import {
    inputRequired,
    inputResponse,
    type InputRequiredResult,
    type ServerContext,
} from "@modelcontextprotocol/server";
import { usd } from "../money.ts";
import { claimPattern, orderIdPattern, type AwaitingPayment } from "../payments/port.ts";
import { GatewayError } from "../router.ts";

const capabilitiesKey = "io.modelcontextprotocol/clientCapabilities";
const clientInfoKey = "io.modelcontextprotocol/clientInfo";
// The bridge pays a payment step or shows its own prompt, so it must get the step itself
const bridgeName = "bugnet-bridge";
const promptKey = "pay";
const stateVersion = "p1";
// An unpaid order lapses after 15 minutes, so a prompt round never needs longer
const stateTtlMs = 30 * 60_000;

// Whether this request's client shows URL prompts, which only 2026-07-28 requests declare
export function takesUrlPrompt(ctx: ServerContext): boolean {
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const info = envelope?.[clientInfoKey];
    if (
        typeof info === "object" &&
        info !== null &&
        (info as { name?: unknown }).name === bridgeName
    ) {
        return false;
    }
    const caps = envelope?.[capabilitiesKey];
    if (typeof caps !== "object" || caps === null) return false;
    const elicitation = (caps as { elicitation?: unknown }).elicitation;
    if (typeof elicitation !== "object" || elicitation === null) return false;
    const url = (elicitation as { url?: unknown }).url;
    return typeof url === "object" && url !== null;
}

// The amount of the first x402 option, read without trusting the payload's shape
function stepPrice(r: AwaitingPayment): string | null {
    const first: unknown = r.paymentRequired.accepts[0];
    if (typeof first !== "object" || first === null) return null;
    const amount = (first as { amount?: unknown }).amount;
    return typeof amount === "string" && /^[0-9]{1,15}$/.test(amount) ? usd(BigInt(amount)) : null;
}

// The line that names the price and the link, for prompts and progress notes
export function payLine(r: AwaitingPayment): string {
    const price = stepPrice(r);
    return price ? `Pay ${price} USDC here: ${r.payUrl}` : `Pay here: ${r.payUrl}`;
}

function mac(key: Buffer, body: string): Buffer {
    return createHmac("sha256", key).update(`bugnet pay prompt\n${body}`).digest();
}

// The state round-trips through the client, so it carries a MAC and an expiry
export function signPromptState(key: Buffer, now: number, orderId: string, claim: string): string {
    const body = `${stateVersion}.${orderId}.${claim}.${Math.floor(now + stateTtlMs)}`;
    return `${body}.${mac(key, body).toString("base64url")}`;
}

export interface PromptOrder {
    orderId: string;
    claim: string;
}

export function verifyPromptState(key: Buffer, now: number, state: string): PromptOrder | null {
    const parts = state.split(".");
    if (parts.length !== 5 || parts[0] !== stateVersion) return null;
    const [, orderId, claim, expires, sig] = parts as [string, string, string, string, string];
    const body = parts.slice(0, 4).join(".");
    const want = mac(key, body);
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    if (!orderIdPattern.test(orderId) || !claimPattern.test(claim)) return null;
    const until = Number(expires);
    if (!Number.isSafeInteger(until) || until < now) return null;
    return { orderId, claim };
}

// Asks the client to show the pay link; the client calls the tool again once the user answers
export function payPrompt(
    key: Buffer,
    now: number,
    order: AwaitingPayment,
    claim: string,
): InputRequiredResult {
    const price = stepPrice(order);
    return inputRequired({
        inputRequests: {
            [promptKey]: inputRequired.elicitUrl({
                url: order.payUrl,
                message: `Pay ${price ? `${price} USDC` : "in USDC"} to start your Bugnet sandbox`,
            }),
        },
        requestState: signPromptState(key, now, order.orderId, claim),
    });
}

export interface PromptAnswer extends PromptOrder {
    // The user went on from the prompt rather than declining or closing it
    accepted: boolean;
}

// The answer to a pay prompt this call carries, or null on a call that answers none
export function promptAnswer(key: Buffer, now: number, ctx: ServerContext): PromptAnswer | null {
    const view = inputResponse(ctx.mcpReq.inputResponses, promptKey);
    if (view.kind === "missing") return null;
    const state = ctx.mcpReq.requestState();
    const order = typeof state === "string" ? verifyPromptState(key, now, state) : null;
    if (!order) {
        throw new GatewayError(
            "invalid",
            "start: the pay prompt's state is not valid or has expired. If the user paid, " +
                "call bugnet_redeem with the orderId and claim; otherwise call bugnet_start again",
        );
    }
    return { ...order, accepted: view.kind === "elicit" && view.action === "accept" };
}
