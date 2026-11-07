/**
 * Probes a seller's URL for its x402 price and picks the cheapest entry Bugnet can pay.
 *
 * The checks are the gateway's copy of Payments' seller rules, in the order of the probe table.
 * A 402 always pins "probe" with the accepted entry unmodified, and only a non-402 POST that
 * exactly matches Bugnet's index pins "index".
 */
import { TtlCache } from "../assess/cache.ts";
import {
    bodyJson,
    createSafeFetcher,
    FetchRefused,
    tooManyRedirects,
    type Fetcher,
    type FetchOptions,
} from "../assess/fetch.ts";
import { createGate, type Gate } from "../assess/gate.ts";
import type { X402Settings } from "../config.ts";
import type { X402Terms } from "../payments/port.ts";
import type { Deps } from "../tools/common.ts";
import { isCanonicalPubkey, type X402Method } from "./lines.ts";

export type ProbeFailure =
    | "no_402"
    | "version_unsupported"
    | "network_unsupported"
    | "flow_unsupported"
    | "fee_payer_refused"
    | "splits_unsupported"
    | "ata_creation_unsupported"
    | "payee_refused"
    | "price_above_max"
    | "price_above_ceiling"
    | "redirect"
    | "unreachable"
    | "shared_hosting";
export type PinReasonExtra = "payee_no_usdc_account" | "service_id_mismatch" | "index_mismatch";

export const probeWords: Readonly<Record<ProbeFailure | PinReasonExtra, string>> = {
    no_402: "no x402 price on a plain request",
    version_unsupported: "only the old x402 version",
    network_unsupported: "no USDC on Solana",
    fee_payer_refused: "a fee payer Bugnet cannot use",
    splits_unsupported: "a payment split between several payees",
    flow_unsupported: "a payment flow Bugnet does not use",
    ata_creation_unsupported: "a payment that creates an account",
    payee_refused: "a payee Bugnet cannot pay",
    price_above_max: "a price Bugnet cannot read, or above the approved max",
    price_above_ceiling: "more than $0.50 a call",
    redirect: "a redirect",
    unreachable: "no answer within 3 s",
    shared_hosting: "a shared hosting address Bugnet has not reviewed",
    payee_no_usdc_account: "its payee has no USDC account",
    service_id_mismatch: "the service line does not match its id",
    index_mismatch: "Bugnet's review of it changed",
};

export function reasonWords(code: string): string {
    return Object.hasOwn(probeWords, code)
        ? probeWords[code as keyof typeof probeWords]
        : `Bugnet's rule ${code}`;
}

export type ProbeTerms = Pick<
    X402Terms,
    "network" | "asset" | "maxPricePerCallMicros" | "bugnetAddresses" | "sellerMemoMaxBytes"
>;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function decodePaymentRequired(header: string): Obj | null {
    try {
        const parsed: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
        return isObj(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export type Choice =
    | { ok: true; accepted: Obj; priceMicros: number; payTo: string }
    | { ok: false; failure: ProbeFailure };

function entryFailure(entry: Obj, terms: ProbeTerms): ProbeFailure | null {
    const extra = isObj(entry.extra) ? entry.extra : {};
    const pubkeyOk = (v: unknown) =>
        typeof v === "string" && isCanonicalPubkey(v) && !terms.bugnetAddresses.includes(v);
    if (entry.network !== terms.network || entry.asset !== terms.asset) {
        return "network_unsupported";
    }
    if (entry.scheme !== "exact") return "flow_unsupported";
    const method = extra.assetTransferMethod;
    if (method !== undefined && method !== "default") return "flow_unsupported";
    const versions = extra.transactionVersions;
    if (versions !== undefined && !(Array.isArray(versions) && versions.includes(0))) {
        return "flow_unsupported";
    }
    const memo = extra.memo;
    if (
        memo !== undefined &&
        !(typeof memo === "string" && Buffer.byteLength(memo, "utf8") <= terms.sellerMemoMaxBytes)
    ) {
        return "flow_unsupported";
    }
    if (!pubkeyOk(extra.feePayer)) return "fee_payer_refused";
    const splits = extra.splits;
    if (splits !== undefined && !(Array.isArray(splits) && splits.length === 0)) {
        return "splits_unsupported";
    }
    const flow = extra.paymentFlow;
    if (flow !== undefined && flow !== "authorization" && flow !== "upfront") {
        return "flow_unsupported";
    }
    if (extra.ataCreationRequired === true) return "ata_creation_unsupported";
    if (!pubkeyOk(entry.payTo)) return "payee_refused";
    if (!amountOk(entry.amount)) return "price_above_max";
    if (BigInt(entry.amount as string) > BigInt(terms.maxPricePerCallMicros)) {
        return "price_above_ceiling";
    }
    return null;
}

function amountOk(amount: unknown): boolean {
    return typeof amount === "string" && /^\d+$/.test(amount) && BigInt(amount) > 0n;
}

export function chooseAccept(required: Obj, terms: ProbeTerms): Choice {
    const accepts = Array.isArray(required.accepts) ? required.accepts.filter(isObj) : [];
    let best: { entry: Obj; amount: bigint } | null = null;
    // Entries that reach check 1 sort by amount, an unreadable amount last
    const ranked: { entry: Obj; amount: bigint; failure: ProbeFailure | null }[] = [];
    for (const entry of accepts) {
        const failure = entryFailure(entry, terms);
        if (failure === "network_unsupported") continue;
        const amount = amountOk(entry.amount) ? BigInt(entry.amount as string) : null;
        ranked.push({ entry, amount: amount ?? -1n, failure });
        if (failure === null && amount !== null && (best === null || amount < best.amount)) {
            best = { entry, amount };
        }
    }
    if (best) {
        const payTo = best.entry.payTo as string;
        return { ok: true, accepted: best.entry, priceMicros: Number(best.amount), payTo };
    }
    let first: (typeof ranked)[number] | undefined;
    for (const r of ranked) {
        if (!first || (r.amount >= 0n && (first.amount < 0n || r.amount < first.amount))) {
            first = r;
        }
    }
    return { ok: false, failure: first?.failure ?? "network_unsupported" };
}

export interface ProbeTarget {
    method: X402Method;
    url: string;
    indexMatch: boolean;
}

export type Probe =
    | {
          ok: true;
          pinnedFrom: "probe";
          at: string;
          status: 402;
          accepted: Obj;
          priceMicros: number;
          payTo: string;
      }
    | { ok: true; pinnedFrom: "index"; at: string; status: number; accepted: null }
    | { ok: false; at: string; failure: ProbeFailure };

export interface Prober {
    probe(target: ProbeTarget, terms: ProbeTerms, signal: AbortSignal): Promise<Probe>;
}

type Answer =
    | { at: string; failure: "redirect" }
    | { at: string; status: number; required: Obj | null; v1: boolean };

interface ProberState {
    cache: TtlCache<Answer>;
    gate: Gate;
}

// Every MCP request builds its tools again, so the cache and the gate live with the settings
const states = new WeakMap<X402Settings, ProberState>();
const fetchers = new WeakMap<X402Settings, Fetcher>();

export function x402Fetcher(deps: Pick<Deps, "config" | "x402Fetch">): Fetcher {
    if (deps.x402Fetch) return deps.x402Fetch;
    const x = deps.config.x402;
    let f = fetchers.get(x);
    if (!f) {
        f = createSafeFetcher({ timeoutMs: Math.max(x.search_timeout, x.probe_timeout) });
        fetchers.set(x, f);
    }
    return f;
}

function evaluate(answer: Answer, target: ProbeTarget, terms: ProbeTerms): Probe {
    const { at } = answer;
    if ("failure" in answer) return { ok: false, at, failure: answer.failure };
    if (answer.status === 402 && answer.required) {
        const c = chooseAccept(answer.required, terms);
        if (!c.ok) return { ok: false, at, failure: c.failure };
        return {
            ok: true,
            pinnedFrom: "probe",
            at,
            status: 402,
            accepted: c.accepted,
            priceMicros: c.priceMicros,
            payTo: c.payTo,
        };
    }
    if (answer.status === 402 && answer.v1) {
        return { ok: false, at, failure: "version_unsupported" };
    }
    if (answer.status !== 402 && target.method === "POST" && target.indexMatch) {
        return { ok: true, pinnedFrom: "index", at, status: answer.status, accepted: null };
    }
    return { ok: false, at, failure: "no_402" };
}

export function createProber(deps: Pick<Deps, "config" | "now" | "x402Fetch">): Prober {
    const x = deps.config.x402;
    let state = states.get(x);
    if (!state) {
        state = {
            cache: new TtlCache<Answer>(x.probe_cache_ttl, 500, deps.now),
            gate: createGate(x.probe_concurrency, 32),
        };
        states.set(x, state);
    }
    const { cache, gate } = state;
    return {
        async probe(target, terms, signal) {
            const key = `${target.method} ${target.url}`;
            const hit = cache.get(key);
            if (hit) return evaluate(hit, target, terms);
            const at = new Date(deps.now()).toISOString();
            const s = AbortSignal.any([signal, AbortSignal.timeout(x.probe_timeout)]);
            const opts: FetchOptions = {
                signal: s,
                maxBytes: x.probe_max_bytes,
                maxRedirects: 0,
                method: target.method,
                headers:
                    target.method === "GET"
                        ? { accept: "application/json" }
                        : { "content-type": "application/json" },
                ...(target.method === "POST" ? { body: "{}" } : {}),
            };
            if (s.aborted) return { ok: false, at, failure: "unreachable" };
            let answer: Answer;
            try {
                const fetched = await gate(() => x402Fetcher(deps)(target.url, opts), s);
                if (fetched === null) return { ok: false, at, failure: "unreachable" };
                const header = fetched.headers["payment-required"];
                let required: Obj | null = null;
                if (fetched.status === 402 && header !== undefined) {
                    const decoded = decodePaymentRequired(header);
                    if (decoded?.x402Version === 2) required = decoded;
                }
                let v1 = false;
                if (fetched.status === 402 && required === null && !fetched.truncated) {
                    try {
                        const body = bodyJson(fetched);
                        v1 = isObj(body) && body.x402Version === 1;
                    } catch {
                        v1 = false;
                    }
                }
                answer = { at, status: fetched.status, required, v1 };
            } catch (e) {
                if (e instanceof FetchRefused && e.message === tooManyRedirects) {
                    answer = { at, failure: "redirect" };
                } else {
                    return { ok: false, at, failure: "unreachable" };
                }
            }
            cache.set(key, answer);
            return evaluate(answer, target, terms);
        },
    };
}
