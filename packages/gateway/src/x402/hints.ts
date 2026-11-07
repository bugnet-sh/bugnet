import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { X402Refusal } from "../gen/bugnet/router/v1/router_pb.ts";
import type { X402Account, X402Terms } from "../payments/port.ts";
import { handleHash, usd, type Budget, type Deps } from "../tools/common.ts";
import { exactEntry, indexKeyNames, indexOf } from "./index.ts";
import { isApiKeyName, keyNamePattern } from "./keys.ts";
import { envLinesFor } from "./lines.ts";
import { hostnamePattern, listServices } from "./router.ts";
import { untilAborted } from "./status.ts";
import { readTerms } from "./terms.ts";

// Names only, never values, from the error texts SDKs print for a missing key
export const missingKeyPatterns: readonly RegExp[] = [
    /\b([A-Z][A-Z0-9_]{1,63})\b(?: environment variable)? (?:is )?(?:not set|missing|required|must be set|not found|undefined|empty)/,
    /(?:set|provide|missing|requires?|export)(?: the)?(?: env(?:ironment)?(?: var(?:iable)?)?)? `?\b([A-Z][A-Z0-9_]{1,63})\b/,
    /KeyError: '([A-Z][A-Z0-9_]{1,63})'/,
    /by setting the ([A-Z][A-Z0-9_]{1,63}) environment variable/,
];

// The code from the message egress writes, in any SDK's printed form
export const refusalPattern =
    /Bugnet did not (?:pay this call|send this request) \(x402 ([a-z0-9_]{1,40})\)/;

// Every code of the spec 6.13 table
export const egressCodes: ReadonlySet<string> = new Set([
    "path_refused",
    "path_not_enabled",
    "unpaid_cap",
    "upgrade_refused",
    "host_rate",
    "buffer_busy",
    "payments_unavailable",
    "upstream_unreachable",
    "x402_disabled",
    "account_closed",
    "service_not_enabled",
    "ref_conflict",
    "method_not_enabled",
    "path_not_paid",
    "body_too_large",
    "body_slow",
    "first_answer_slow",
    "not_x402",
    "version_unsupported",
    "network_unsupported",
    "splits_unsupported",
    "flow_unsupported",
    "ata_creation_unsupported",
    "fee_payer_refused",
    "payee_refused",
    "payee_changed",
    "payee_unreliable",
    "payto_blocked",
    "price_above_max",
    "allowance_spent",
    "rate_cap",
    "too_many_open_payments",
    "payto_daily_cap",
    "outflow_cap",
    "outflow_paused",
    "payment_rejected",
    "paid_no_answer",
]);

// Not refusals, since Bugnet sent a payment for each (spec 6.13)
const notRefusals: ReadonlySet<string> = new Set(["paid_no_answer", "payment_rejected"]);

export const codeWords: Readonly<Record<string, string>> = {
    allowance_spent: "the allowance is spent",
    price_above_max: "the seller asked more than the approved price",
    payee_changed: "the seller asked to be paid at another address",
    rate_cap: "the spending limit a minute was reached",
    method_not_enabled: "this method is not enabled",
    path_not_paid: "this path is not the approved one",
    body_too_large: "the request body is too large for Bugnet to pay for",
    body_slow: "the request body was too slow to arrive",
    path_refused: "the path has characters Bugnet does not forward",
    unpaid_cap: "this host's unpaid requests or bytes for the sandbox are used up",
    host_rate: "the host gets too many requests through Bugnet",
};

export function codeText(code: string): string {
    return Object.hasOwn(codeWords, code) ? (codeWords[code] as string) : `Bugnet's rule ${code}`;
}

const maxNames = 2;

// At most 2 names, each matching keyNamePattern and an API key by isApiKey, first seen first
export function missingKeyNames(text: string, isApiKey: (name: string) => boolean): string[] {
    const found: { name: string; at: number }[] = [];
    for (const p of missingKeyPatterns) {
        for (const m of text.matchAll(new RegExp(p.source, "gd"))) {
            const name = m[1];
            const at = m.indices?.[1]?.[0];
            if (name !== undefined && at !== undefined) found.push({ name, at });
        }
    }
    found.sort((a, b) => a.at - b.at);
    const names: string[] = [];
    for (const { name } of found) {
        if (names.includes(name) || !keyNamePattern.test(name) || !isApiKey(name)) continue;
        names.push(name);
        if (names.length === maxNames) break;
    }
    return names;
}

// Codes in egressCodes in order of first appearance, never paid_no_answer or payment_rejected
export function refusalCodesIn(text: string): string[] {
    const codes: string[] = [];
    for (const m of text.matchAll(new RegExp(refusalPattern.source, "g"))) {
        const code = m[1];
        if (code === undefined || codes.includes(code)) continue;
        if (egressCodes.has(code) && !notRefusals.has(code)) codes.push(code);
    }
    return codes;
}

export interface HintInput {
    tool: "exec" | "job";
    handle: string;
    // The cleaned stdout and stderr tails
    text: string;
    // Exec's real-clock start, null for job
    startedAt: number | null;
    budget: Budget;
}

export const recheckMs = 2_500;
export const execWindowMs = 5_000;

const lookupCapMs = 3_000;
const minLeftMs = 1_000;
const recheckLeftMs = 3_500;

const offLine = (names: readonly string[]) =>
    `Bugnet: the command reports a missing API key, ${names.join(", ")}. bugnet_secret_link lets ` +
    "the user add it without it passing through the chat.";

const onLine = (names: readonly string[]) =>
    `Bugnet: the command reports a missing API key, ${names.join(", ")}. bugnet_x402_find ` +
    "(free) lists pay-per-call APIs that need no key, and bugnet_secret_link adds a key the " +
    "user has. The user picks one.";

function activeLine(deps: Deps, account: X402Account, names: readonly string[]): string | null {
    const index = indexOf(deps);
    for (const s of account.services) {
        if (s.state !== "enabled" || !hostnamePattern.test(s.host)) continue;
        const reviewed = exactEntry(index, s.method, s.host, s.prefix)?.envLines ?? null;
        const envLines = envLinesFor(s.url, reviewed);
        if (envLines.some((l) => names.some((n) => l.startsWith(`${n}=`)))) {
            return (
                `Bugnet: x402 is active for ${s.host} in this sandbox. This command ran without ` +
                `its environment lines: ${envLines.join(" ")}. They go in env.`
            );
        }
    }
    return null;
}

function missingKeyLine(
    deps: Deps,
    names: readonly string[],
    terms: X402Terms | null,
    account: X402Account | null,
): string {
    if (terms === null || !terms.enabled) return offLine(names);
    return (account !== null ? activeLine(deps, account, names) : null) ?? onLine(names);
}

function matchedRows(
    rows: readonly X402Refusal[],
    codes: readonly string[],
    input: HintInput,
): X402Refusal[] {
    return rows.filter((r) => {
        if (!codes.includes(r.reason)) return false;
        if (input.startedAt === null) return true;
        return (
            r.lastAt !== undefined &&
            timestampDate(r.lastAt).getTime() >= input.startedAt - execWindowMs
        );
    });
}

function refusalLine(
    matched: readonly X402Refusal[],
    codes: readonly string[],
    terms: X402Terms | null,
    account: X402Account | null,
): string {
    const seen = new Set(matched.map((r) => r.reason));
    const shown = codes.filter((c) => seen.has(c));
    const count = matched.reduce(
        (sum, r) => sum + (Number.isSafeInteger(r.count) && r.count > 0 ? r.count : 0),
        0,
    );
    // The records still hold the refusals while a pause or the kill switch turns payments off
    const paused = terms !== null && !terms.enabled;
    let line =
        `Bugnet's records show ${count} x402 calls in this sandbox that Bugnet did not pay or ` +
        `send: ${shown.map(codeText).join("; ")}, the last during this command. bugnet_status ` +
        "has the totals.";
    if (!paused) {
        line += " More allowance or a new limit needs the user's yes and bugnet_x402_budget.";
    }
    if (seen.has("allowance_spent") && !paused && account !== null && terms !== null) {
        line +=
            ` A question for the user: "The ${usd(account.fundedMicros)} x402 allowance is ` +
            `spent after ${account.paidCalls} paid calls. Add $0.50 more? Unspent money of ` +
            `${usd(terms.refundMinMicros)} or more comes back when the sandbox ends."`;
    }
    if (seen.has("payee_unreliable")) line += " Propose another service from bugnet_x402_find.";
    return line;
}

async function hintLines(deps: Deps, input: HintInput): Promise<string[]> {
    const { budget } = input;
    const on = deps.config.x402.enabled;
    const indexKeys = indexKeyNames(indexOf(deps));
    const names = missingKeyNames(input.text, (n) => isApiKeyName(n, indexKeys));
    if (!on) return names.length > 0 ? [offLine(names)] : [];
    const codes = refusalCodesIn(input.text);
    if (names.length === 0 && codes.length === 0) return [];
    if (budget.left() < minLeftMs) return [];
    const signal = budget.signal(lookupCapMs);
    const needAccount = names.length > 0 || codes.includes("allowance_spent");
    const [termsR, accountR, listR] = await Promise.allSettled([
        untilAborted(readTerms(deps, signal), signal),
        needAccount
            ? untilAborted(deps.payments.x402Account(handleHash(input.handle), signal), signal)
            : Promise.resolve(null),
        codes.length > 0
            ? untilAborted(listServices(deps, input.handle, signal), signal)
            : Promise.resolve(null),
    ]);
    const terms = termsR.status === "fulfilled" ? termsR.value : null;
    const account = accountR.status === "fulfilled" ? (accountR.value?.x402 ?? null) : null;
    const lines: string[] = [];
    if (names.length > 0) lines.push(missingKeyLine(deps, names, terms, account));
    if (listR.status !== "fulfilled" || listR.value === null) return lines;
    let matched = matchedRows(listR.value.refusals, codes, input);
    if (matched.length === 0 && budget.left() >= recheckLeftMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, recheckMs));
        try {
            const again = budget.signal(lookupCapMs);
            const second = await untilAborted(listServices(deps, input.handle, again), again);
            matched = matchedRows(second.refusals, codes, input);
        } catch {
            matched = [];
        }
    }
    if (matched.length > 0) lines.push(refusalLine(matched, codes, terms, account));
    return lines;
}

// Never rejects, so a slow or failed lookup never costs the command's output
export async function x402HintLines(deps: Deps, input: HintInput): Promise<string[]> {
    try {
        return await hintLines(deps, input);
    } catch {
        return [];
    }
}
