import type { X402Refusal, X402ServiceInfo } from "../gen/bugnet/router/v1/router_pb.ts";
import type {
    RefusedOrder,
    X402Account,
    X402AccountService,
    X402ConfigureRefused,
    X402Listed,
    X402RefundState,
    X402Terms,
} from "../payments/port.ts";
import { GatewayError, type GatewayErrorKind } from "../router.ts";
import { usd } from "../tools/common.ts";
import { refusalError, retryCall, type OrderTool, type RetryWith } from "../tools/orders.ts";
import { exactEntry, type X402Index } from "./index.ts";
import {
    envLinesFor,
    formatServiceLine,
    lineCut,
    lineMax,
    payToShort,
    toMicros,
    type X402Method,
} from "./lines.ts";
import { spendUnderPrice, type PlannedService } from "./pins.ts";
import { reasonWords } from "./probe.ts";
import { failureText, routerRows, routerState, type X402What } from "./router.ts";

export interface X402ViewService {
    serviceId: string;
    method: X402Method;
    host: string;
    prefix: string;
    paidPath: string | null;
    maxPriceUsd: string;
    payTo: string;
    listed: X402Listed;
    state: "applying" | "active" | "failed" | "disabled" | "unreliable";
    failureReason?: string;
    serviceLine: string;
    envLines: string[];
}

export interface X402ViewRefund {
    state: X402RefundState;
    amountUsd: string;
    keptUsd: string;
    txs?: string[];
}

export interface X402View {
    paidInUsd: string;
    spentUsd: string;
    heldUsd: string;
    leftUsd: string;
    maxPerSandboxUsd: string;
    feeDue: boolean;
    paidCalls: number;
    pendingCalls: number;
    refused: Record<string, number>;
    spendPerMinuteUsd: string;
    services: X402ViewService[];
    refund?: X402ViewRefund;
}

export interface ViewInput {
    account: X402Account;
    feeDue: boolean;
    // Null when the router gave no answer, so enabled rows read as applying
    router: readonly X402ServiceInfo[] | null;
    refusals: readonly X402Refusal[];
    terms: X402Terms;
    index: X402Index;
    // The service a refused repair names in its ErrorInfo service_id, with the router's reason
    notEnabled?: ReadonlyMap<string, string>;
}

type ViewState = X402ViewService["state"];

function stateOf(
    s: X402AccountService,
    input: ViewInput,
): { state: ViewState; failureReason?: string } {
    if (s.state === "disabled" || s.state === "unreliable") return { state: s.state };
    const refused = input.notEnabled?.get(s.serviceId);
    if (refused !== undefined) return { state: "failed", failureReason: refused };
    const info = input.router?.find((r) => r.serviceId === s.serviceId);
    if (info === undefined) return { state: "applying" };
    const state = routerState(info.state);
    return state === "failed" && info.failureReason !== ""
        ? { state, failureReason: info.failureReason }
        : { state };
}

export function buildView(input: ViewInput): X402View {
    const { account, terms, index } = input;
    const services = account.services.map((s): X402ViewService => {
        const { state, failureReason } = stateOf(s, input);
        const reviewed = exactEntry(index, s.method, s.host, s.prefix)?.envLines ?? null;
        return {
            serviceId: s.serviceId,
            method: s.method,
            host: s.host,
            prefix: s.prefix,
            paidPath: s.paidPath,
            maxPriceUsd: usd(s.maxPriceMicros),
            payTo: s.payTo,
            listed: s.listed,
            state,
            ...(failureReason !== undefined ? { failureReason } : {}),
            serviceLine: formatServiceLine({
                method: s.method,
                url: s.url,
                maxMicros: s.maxPriceMicros,
                payTo: s.payTo,
                prefix: s.prefix,
            }),
            envLines: envLinesFor(s.url, reviewed),
        };
    });
    const refund = account.refund;
    return {
        paidInUsd: usd(account.fundedMicros),
        spentUsd: usd(account.spentMicros),
        heldUsd: usd(account.heldMicros),
        leftUsd: usd(account.leftMicros),
        maxPerSandboxUsd: usd(terms.maxAllowancePerSandboxMicros),
        feeDue: input.feeDue,
        paidCalls: account.paidCalls,
        pendingCalls: account.pendingCalls,
        refused: Object.fromEntries(input.refusals.map((r) => [r.reason, r.count])),
        spendPerMinuteUsd: usd(account.spendPerMinuteMicros),
        services,
        ...(refund
            ? {
                  refund: {
                      state: refund.state,
                      amountUsd: usd(refund.amountMicros),
                      keptUsd: usd(refund.keptMicros),
                      ...(refund.txs.length > 0 ? { txs: [...refund.txs] } : {}),
                  },
              }
            : {}),
    };
}

const shownStates: ReadonlySet<ViewState> = new Set(["active", "applying", "failed"]);

function rowsOf(view: X402View): X402ViewService[] {
    return view.services.filter((s) => shownStates.has(s.state));
}

function isLive(s: X402ViewService): boolean {
    return s.state === "active" || s.state === "applying";
}

export function firstUseLine(view: X402View, terms: X402Terms): string {
    const rows = rowsOf(view);
    const perCall = usd(terms.maxPricePerCallMicros);
    const perMinute = usd(terms.maxSpendPerMinuteMicros);
    const parts = [
        `a ${view.paidInUsd} allowance (up to ${usd(terms.maxAllowancePerSandboxMicros)} in all)`,
        ...rows.map((s) => `${s.host} at most ${s.maxPriceUsd} a call (up to ${perCall})`),
        `and at most ${view.spendPerMinuteUsd} spent a minute (up to ${perMinute})`,
    ].join(", ");
    const first = rows[0];
    const examples =
        "'add $1', 'allow $0.02 a call'" +
        (first !== undefined
            ? `, 'let it spend $1 a minute' or 'stop paying ${first.host}'`
            : " or 'let it spend $1 a minute'");
    return (
        "First x402 allowance for this wallet. Show the user, in your next message: " +
        `"Your x402 limits for this sandbox: ${parts}. Tell me to change any of these, for ` +
        `example ${examples}. Bugnet fixes the ceilings and at most ${terms.maxServices} ` +
        "services. Changes last for this sandbox only. A new sandbox starts again at " +
        `${usd(terms.defaultSpendPerMinuteMicros)} a minute and the prices you approve."`
    );
}

function rowWords(s: X402ViewService): string {
    if (s.state === "active") return "active";
    if (s.state === "applying") return "applying, usable within a few seconds";
    return `failed, ${failureText(s.failureReason ?? "")}`;
}

function rowLine(s: X402ViewService): string {
    const paidOnly = s.paidPath ? `, paid only on ${s.paidPath}` : "";
    return (
        `- ${s.method} ${s.host}${s.prefix} at most ${s.maxPriceUsd} a call${paidOnly}, pays ` +
        `${payToShort(s.payTo)} (${s.serviceId}): ${rowWords(s)}. Service line: ${s.serviceLine}`
    );
}

export function x402Lines(
    view: X402View,
    opts: { firstUse: boolean; terms: X402Terms; notEnabled?: boolean },
): string[] {
    const { terms } = opts;
    const rows = rowsOf(view);
    const live = rows.filter(isLive);
    const hosts = [...new Set(live.map((s) => s.host))];
    const out: string[] = [];
    if (opts.firstUse) out.push(firstUseLine(view, terms));
    out.push(
        `x402 for this sandbox: ${view.paidInUsd} paid in, ${view.spentUsd} spent, ` +
            `${view.heldUsd} settling, ${view.leftUsd} left.`,
    );
    if (opts.notEnabled) {
        const amountMicros = toMicros(view.paidInUsd) ?? 0;
        out.push(`${x402Text.paidNotEnabled("x402", { amountMicros })}.`);
    } else if (rows.length > 0) {
        out.push("Enabled, paid only on these terms:", ...rows.map(rowLine));
    }
    out.push(`Spending is capped at ${view.spendPerMinuteUsd} a minute.`);
    if (!opts.notEnabled) {
        for (const s of live) {
            if (s.envLines.length === 0) continue;
            out.push(
                `Env for ${s.host}: ${s.envLines.join(" ")}. They go in bugnet_exec's env on ` +
                    "every command that runs this code.",
            );
        }
        if (hosts.length > 0) {
            out.push(
                `New commands get BUGNET_X402=1 and BUGNET_X402_HOSTS=${hosts.join(",")}. ` +
                    "Restart servers that should call these hosts.",
                "Code edits in the sandbox are fine, but they only work inside Bugnet: never " +
                    "commit, push or copy them into the user's own files without the user's yes.",
                "A paid call must finish within about 60 s. Bugnet reads the traffic to these " +
                    "hosts to pay for it.",
            );
        }
    }
    out.push(
        `Unspent money of ${usd(terms.refundMinMicros)} or more goes back to the paying wallet ` +
            "when the sandbox ends.",
    );
    return out;
}

export const totalsUnavailable = "x402 totals are unavailable right now.";

export function x402Error(
    text: string,
    kind: GatewayErrorKind = "invalid",
    retryAfterMs: number | null = null,
    fields: Record<string, unknown> | null = null,
): GatewayError {
    return new GatewayError(kind, text, retryAfterMs, null, fields);
}

// Clients that read only structuredContent get the order a text names, as Plan A's refusals give it
function orderFields(text: string, orderId: string | undefined): { orderId: string } | null {
    return orderId !== undefined && text.includes(`order ${orderId}`) ? { orderId } : null;
}

export type X402TextKey =
    | "switchedOff"
    | "paused"
    | "startUnavailable"
    | "notCapable"
    | "amountTooSmall"
    | "noAllowance"
    | "needsPayment"
    | "overCeiling"
    | "ceilingReached"
    | "wrongConfirmFee"
    | "wrongConfirm"
    | "maxAbove"
    | "malformed"
    | "unlisted"
    | "livePriceAbove"
    | "payToChanged"
    | "probeFailed"
    | "pinRefused"
    | "duplicate"
    | "tooManyServices"
    | "spendRange"
    | "spendUnderMax"
    | "poolFull"
    | "paidRefused"
    | "ended"
    | "routerRefused"
    | "paidNotEnabled"
    | "unreachable"
    | "termsMismatch"
    | "idempotencyConflict"
    | "tooManyNew";

// Each row reads only its own values, and every row that shows an amount from the terms reads terms
export interface X402TextValues {
    terms?: X402Terms;
    host?: string;
    hosts?: readonly string[];
    // The full line, cut by lineCut inside the text
    line?: string;
    amountMicros?: number;
    totalMicros?: number;
    roomMicros?: number;
    liveMicros?: number;
    maxMicros?: number;
    limitMicros?: number;
    livePayTo?: string;
    linePayTo?: string;
    // Probe, pin or router reason words
    words?: string;
    orderId?: string;
    // paidRefused reads allowance_ceiling, allowance_pool_full, sandbox_ended or order_expired
    reason?: string;
    refundPending?: boolean;
}

function termsOf(v: X402TextValues): X402Terms {
    if (v.terms === undefined) throw new Error("this x402 text needs the terms");
    return v.terms;
}

const micros = (n: number | undefined) => usd(n ?? 0);

function paidRefusedText(what: X402What, v: X402TextValues): string {
    // A retry by claim sent no payment, so its text names none rather than guess one
    const payment =
        v.amountMicros === undefined ? "the payment" : `the payment of ${usd(v.amountMicros)}`;
    const refund = v.refundPending
        ? "is refunded in full to the paying wallet within 10 minutes"
        : "was refunded";
    const nothing = what === "start" ? "no sandbox was started" : "nothing was enabled";
    if (v.reason === "sandbox_ended") {
        return `${what}: the sandbox ended before ${payment} was applied, so it ${refund}`;
    }
    if (v.reason === "order_expired") {
        const order = v.orderId ? `order ${v.orderId}` : "its order";
        return (
            `${what}: ${payment} arrived after ${order} expired, so it ${refund} and ${nothing}. ` +
            "A new order needs the user's yes"
        );
    }
    return `${what}: ${payment} would pass Bugnet's x402 limits, so it ${refund} and ${nothing}`;
}

export const x402Text: Readonly<
    Record<X402TextKey, (what: X402What, v: X402TextValues) => string>
> = {
    switchedOff: (what) => routerRows.switchedOff(what),
    paused: (what) =>
        `${what}: Bugnet paused x402 payments right now. Nothing was charged. Try again later, ` +
        "or add the user's key with bugnet_secret_link",
    startUnavailable: () =>
        "start: an allowance cannot be bought together with a sandbox yet. Start the sandbox " +
        "without x402, then call bugnet_x402_budget with the handle and the same service line. " +
        "Nothing was charged",
    notCapable: (what) => routerRows.notCapable(what),
    amountTooSmall: (what, v) =>
        `${what}: amountUsd is at least ${usd(termsOf(v).minAllowanceMicros)}, or "0" to ` +
        "re-price, disable or change the minute limit only",
    noAllowance: (what, v) =>
        `${what}: this sandbox has no allowance yet. Pass amountUsd, such as ` +
        `${lineMax(termsOf(v).suggestedAllowanceMicros)}, with the services`,
    needsPayment: (what, v) =>
        `${what}: adding ${v.host}, or changing who it pays, needs an allowance payment of at ` +
        `least ${usd(termsOf(v).minAllowanceMicros)}, so the user approves it in their wallet. ` +
        "Pass amountUsd, such as 0.50, with the service line, and the total as confirmPriceUsd",
    overCeiling: (what, v) => {
        const t = termsOf(v);
        const room = v.roomMicros ?? 0;
        const amount = v.amountMicros ?? 0;
        const total = t.maxAllowancePerSandboxMicros - room + amount;
        return (
            `${what}: ${usd(amount)} would bring this sandbox's allowance to ${usd(total)}, past ` +
            `the ${usd(t.maxAllowancePerSandboxMicros)} limit for one sandbox. At most ` +
            `${usd(room)} more can be added`
        );
    },
    ceilingReached: (what, v) => {
        const t = termsOf(v);
        return (
            `${what}: this sandbox has reached its ${usd(t.maxAllowancePerSandboxMicros)} ` +
            `allowance limit (${micros(v.roomMicros)} is left, under the ` +
            `${usd(t.minAllowanceMicros)} minimum order). Add the user's key with ` +
            "bugnet_secret_link, or start a new sandbox"
        );
    },
    wrongConfirmFee: (what, v) =>
        `${what}: this charges ${micros(v.totalMicros)}: ${micros(v.amountMicros)} of allowance ` +
        `plus a one-time ${usd(termsOf(v).sessionFeeMicros)} fee that covers the refund. Tell ` +
        "the user that total and pass it as confirmPriceUsd",
    wrongConfirm: (what, v) =>
        `${what}: this charges ${micros(v.amountMicros)}. Tell the user that total and pass it ` +
        "as confirmPriceUsd",
    maxAbove: (what, v) => {
        const cap = termsOf(v).maxPricePerCallMicros;
        return (
            `${what}: max= in "${lineCut(v.line ?? "")}" is above ${usd(cap)}, the most Bugnet ` +
            `pays a call. Lower max= to ${lineMax(cap)} or less, with the user's yes`
        );
    },
    malformed: (what, v) =>
        `${what}: "${lineCut(v.line ?? "")}" is not a service line. Copy it from ` +
        "bugnet_x402_find or bugnet_status, and to re-price change only max=",
    unlisted: (what, v) =>
        `${what}: ${v.host} is not reviewed by Bugnet. Enable it only if the user agreed to an ` +
        "unreviewed service, with allowUnlisted true",
    livePriceAbove: (what, v) =>
        `${what}: ${v.host} now asks ${micros(v.liveMicros)} a call, above the approved ` +
        `${micros(v.maxMicros)}. Tell the user the new price, and enable it only if they agree`,
    payToChanged: (what, v) =>
        `${what}: ${v.host} now pays a different address (${payToShort(v.livePayTo ?? "")}) ` +
        `than the one the user approved (${payToShort(v.linePayTo ?? "")}). Run ` +
        "bugnet_x402_find again and ask the user before enabling it",
    probeFailed: (what, v) =>
        `${what}: ${v.host} did not answer with a price Bugnet can pay (${v.words}), so it ` +
        "cannot be enabled",
    pinRefused: (what, v) =>
        `${what}: Bugnet cannot pay ${v.host} (${v.words}). Nothing was charged. Pick another ` +
        "service from bugnet_x402_find",
    duplicate: (what, v) =>
        `${what}: "${lineCut(v.line ?? "")}" names the same service as another line here. ` +
        "Send each service once",
    tooManyServices: (what, v) => routerRows.tooManyServices(what, termsOf(v).maxServices),
    spendRange: (what, v) => {
        const t = termsOf(v);
        return (
            `${what}: spendPerMinuteUsd is between ${usd(t.minSpendPerMinuteMicros)} and ` +
            usd(t.maxSpendPerMinuteMicros)
        );
    },
    spendUnderMax: (what, v) =>
        `${what}: spendPerMinuteUsd ${micros(v.limitMicros)} is under ${v.host}'s ` +
        `${micros(v.maxMicros)} a call, so no call to it could ever be paid. Raise the limit to ` +
        `at least ${micros(v.maxMicros)}, or lower that service's max=, with the user's yes`,
    poolFull: (what) =>
        `${what}: Bugnet cannot take more x402 allowances right now. Nothing was charged. Try ` +
        "again later, or add the user's key with bugnet_secret_link",
    paidRefused: paidRefusedText,
    ended: (what) => routerRows.ended(what),
    routerRefused: (what, v) => routerRows.routerRefused(what, v.hosts ?? [], v.words ?? ""),
    paidNotEnabled: (what, v) =>
        `${what}: the allowance is paid (${micros(v.amountMicros)}), but the services were not ` +
        "enabled yet. Call bugnet_status with the handle; it finishes enabling them at no charge",
    unreachable: (what) =>
        `${what}: Bugnet could not reach its payment service, so nothing was charged. Try ` +
        "again in a minute",
    termsMismatch: (what, v) =>
        `${what}: order ${v.orderId} was made with other terms. If the user already paid it, ` +
        "call again with only orderId and the claim or payment, and Bugnet answers from that " +
        "order. Make a new order (no orderId) only if the user has not paid, and only with " +
        "their yes to the new total",
    idempotencyConflict: (what) =>
        `${what}: Bugnet already applied this call with other settings. bugnet_status shows ` +
        "the current services and limits",
    tooManyNew: (what, v) =>
        `${what}: the wallet cannot show this many new services in one payment, so nothing ` +
        `was charged. Enable at most ${termsOf(v).maxNewServicesPerOrder} new services in this ` +
        "call, then add the rest with another bugnet_x402_budget call",
};

export const x402Kinds: Readonly<Record<X402TextKey, GatewayErrorKind>> = {
    switchedOff: "unsupported",
    paused: "unavailable",
    startUnavailable: "unsupported",
    notCapable: "unsupported",
    amountTooSmall: "invalid",
    noAllowance: "precondition",
    needsPayment: "invalid",
    overCeiling: "limit",
    ceilingReached: "limit",
    wrongConfirmFee: "invalid",
    wrongConfirm: "invalid",
    maxAbove: "invalid",
    malformed: "invalid",
    unlisted: "invalid",
    livePriceAbove: "invalid",
    payToChanged: "invalid",
    probeFailed: "invalid",
    pinRefused: "denied",
    duplicate: "invalid",
    tooManyServices: "limit",
    spendRange: "invalid",
    spendUnderMax: "invalid",
    poolFull: "unavailable",
    paidRefused: "denied",
    ended: "expired",
    routerRefused: "invalid",
    paidNotEnabled: "unavailable",
    unreachable: "unavailable",
    termsMismatch: "invalid",
    idempotencyConflict: "invalid",
    tooManyNew: "invalid",
};

export function x402Fail(key: X402TextKey, what: X402What, v: X402TextValues = {}): GatewayError {
    const text = x402Text[key](what, v);
    return x402Error(text, x402Kinds[key], null, orderFields(text, v.orderId));
}

export interface RefusalContext {
    what: X402What;
    tool: OrderTool;
    terms: X402Terms;
    // The order carried the session fee
    feeDue: boolean;
    // The allowance asked for
    amountMicros: number;
    // confirmPriceUsd in micros, the payment's total, null on a paid retry whose amount is unknown
    chargedMicros: number | null;
    orderId: string | null;
    planned: readonly PlannedService[];
    account: X402Account | null;
    // Payment true when the call carried a payment, so settling says payment
    retry: RetryWith;
    // The minute limit the call leaves in force
    spendPerMinuteMicros: number;
    disable: readonly string[];
}

// Payments answers these with refundPending once a payment reached its paid check
const paidCheckReasons: ReadonlySet<string> = new Set([
    "allowance_ceiling",
    "allowance_pool_full",
    "sandbox_ended",
    "order_expired",
]);

function plannedHost(c: RefusalContext): string {
    const fresh = c.planned.find((p) => p.change === "new" || p.change === "repin");
    return (fresh ?? c.planned[0])?.parts.host ?? "the service";
}

export function paymentsRefusal(
    r: RefusedOrder | X402ConfigureRefused,
    c: RefusalContext,
): GatewayError {
    const order = r as RefusedOrder;
    const reason: string = r.reason;
    const fail = (key: X402TextKey, v: X402TextValues = {}) =>
        x402Fail(key, c.what, { terms: c.terms, ...v });
    if (order.refundPending !== undefined && paidCheckReasons.has(reason)) {
        return fail("paidRefused", {
            reason,
            refundPending: order.refundPending,
            amountMicros: c.retry.claim === undefined ? (c.chargedMicros ?? undefined) : undefined,
            orderId: order.orderId ?? c.orderId ?? undefined,
        });
    }
    switch (reason) {
        case "x402_disabled":
        case "x402_unavailable":
            return fail("switchedOff");
        case "x402_paused":
            return fail("paused");
        case "x402_start_unavailable":
            return fail("startUnavailable");
        case "sandbox_not_capable":
            return fail("notCapable");
        case "amount_too_small":
            return fail("amountTooSmall");
        case "no_account":
            return fail("noAllowance");
        case "too_many_services":
            return fail("tooManyServices");
        case "description_too_long":
            return fail("tooManyNew");
        case "allowance_pool_full":
            return fail("poolFull");
        case "sandbox_ended":
        case "sandbox_unknown":
            return fail("ended");
        case "router_unavailable":
            return fail("unreachable");
        case "idempotency_conflict":
            return fail("idempotencyConflict");
        case "terms_mismatch":
            return fail("termsMismatch", { orderId: order.orderId ?? c.orderId ?? undefined });
        case "needs_payment":
            return fail("needsPayment", { host: plannedHost(c) });
        case "allowance_ceiling": {
            const room = c.account?.allowanceRoomMicros ?? c.terms.maxAllowancePerSandboxMicros;
            return room < c.terms.minAllowanceMicros
                ? fail("ceilingReached", { roomMicros: room })
                : fail("overCeiling", { amountMicros: c.amountMicros, roomMicros: room });
        }
        case "fee_mismatch":
            // A fee sent where none is due, or none sent where one is
            return c.feeDue
                ? fail("wrongConfirm", { amountMicros: c.amountMicros })
                : fail("wrongConfirmFee", {
                      amountMicros: c.amountMicros,
                      totalMicros: c.amountMicros + c.terms.sessionFeeMicros,
                  });
        case "price_above_ceiling": {
            const high = c.planned.find((p) => p.parts.maxMicros > c.terms.maxPricePerCallMicros);
            return fail("maxAbove", { line: (high ?? c.planned[0])?.parts.line ?? "" });
        }
        case "pin_refused": {
            const id = order.serviceId;
            const host =
                c.planned.find((p) => p.parts.serviceId === id)?.parts.host ??
                c.account?.services.find((s) => s.serviceId === id)?.host ??
                id ??
                "";
            return fail("pinRefused", { host, words: reasonWords(order.pinReason ?? "") });
        }
        case "spend_rate_out_of_range": {
            const limit = c.spendPerMinuteMicros;
            const t = c.terms;
            if (limit < t.minSpendPerMinuteMicros || limit > t.maxSpendPerMinuteMicros) {
                return fail("spendRange");
            }
            const under = spendUnderPrice(limit, c.account, c.planned, c.disable);
            return under === null
                ? fail("spendRange")
                : fail("spendUnderMax", { limitMicros: limit, ...under });
        }
        default:
            return refusalError(order, c.what, c.tool, {
                ...(c.orderId !== null ? { sentOrderId: c.orderId } : {}),
                handleSent: c.tool === "bugnet_x402_budget",
                paymentSent: c.retry.payment === true,
            });
    }
}

export function paidRetryUnreachable(
    what: "x402" | "redeem",
    tool: OrderTool,
    orderId: string,
    w: RetryWith,
): GatewayError {
    return x402Error(
        `${what}: order ${orderId} is paid, but Bugnet could not reach its payment service to ` +
            `apply it. Call ${retryCall(tool, orderId, w)} in a minute`,
        "unavailable",
        null,
        { orderId },
    );
}

export function notAllowanceOrder(orderId: string): GatewayError {
    return x402Error(
        `x402: order ${orderId} starts a sandbox or adds time to one, not x402 allowance. Call ` +
            "bugnet_redeem with its orderId and claim",
        "invalid",
        null,
        { orderId },
    );
}

// A paid allowance answer for another handle, which this call never enables
export function otherSandboxOrder(orderId: string): GatewayError {
    return x402Error(
        `x402: order ${orderId} is not for that sandbox, check the handle`,
        "invalid",
        null,
        { orderId },
    );
}
