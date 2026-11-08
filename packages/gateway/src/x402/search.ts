/**
 * Finds x402 services for an API from Bugnet's index, the Bazaar and PayAI's list, filters them
 * by the S 5.1 rules, ranks them (rank.ts), probes the best few and keeps the live prices.
 */
import { TtlCache } from "../assess/cache.ts";
import { bodyJson } from "../assess/fetch.ts";
import type { X402Settings } from "../config.ts";
import type { X402SellerStats, X402Terms } from "../payments/port.ts";
import type { Budget, Deps } from "../tools/common.ts";
import {
    apiWords,
    coveringEntry,
    exactEntry,
    hostIndexed,
    hostsSeen,
    indexOf,
    listedEntry,
    matchIndex,
    type IndexEntry,
    type X402Index,
} from "./index.ts";
import {
    defaultPrefix,
    formatServiceLine,
    hostRefused,
    lineMax,
    openAiBase,
    parseServiceLine,
    solanaNetwork,
    underSuffix,
    urlParts,
    usdcAsset,
    type LineLimits,
    type X402Method,
} from "./lines.ts";
import { createProber, probeWords, reasonWords, x402Fetcher, type Probe } from "./probe.ts";
import { score, type RankContext } from "./rank.ts";
import { lineLimits } from "./terms.ts";

export type FindSource = "index" | "bazaar" | "payai" | "user";

export interface Listing {
    source: "bazaar" | "payai";
    resource: string;
    type: string;
    x402Version: number;
    method: string | null;
    accepts: readonly unknown[];
    serviceName: string | null;
    description: string | null;
    payers30d: number | null;
    lastSettledAt: string | null;
    inputFields: string[];
    outputFields: string[];
}

export interface Dropped {
    price: number;
    network: number;
    terms: number;
    unreachable: number;
    shared: number;
}

export interface FindQuery {
    api: string;
    keyName: string | null;
    maxPriceMicros: number;
    url: string | null;
    method: X402Method;
}

export interface Candidate {
    method: X402Method;
    url: string;
    host: string;
    path: string;
    prefix: string;
    indexEntry: IndexEntry | null;
    listedPriceMicros: number | null;
    sources: FindSource[];
    sellerName: string | null;
    sellerText: string;
    payers30d: number | null;
    lastSettledAt: string | null;
    inputFields: string[];
    outputFields: string[];
}

export interface Found extends Candidate {
    probe: Extract<Probe, { ok: true }>;
    priceMicros: number;
    payTo: string;
    listed: "indexed" | "unlisted";
    score: number;
}

export interface FindOutcome {
    results: Found[];
    dropped: Dropped;
    partial: boolean;
    urlFailure: string | null;
}

const sourceMaxBytes = 4_194_304;
const payaiPageSize = 100;
const payaiMaxPages = 300;
const payaiMatchLimit = 20;
const sellersCapMs = 2_000;
const lineMaxChars = 400;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function fieldNames(v: unknown): string[] {
    if (!isObj(v)) return [];
    return Object.keys(v)
        .filter((k) => /^[A-Za-z0-9_.-]{1,40}$/.test(k))
        .slice(0, 10);
}

function rowsOf(json: unknown): unknown[] {
    if (!isObj(json)) return [];
    if (Array.isArray(json.resources)) return json.resources;
    return Array.isArray(json.items) ? json.items : [];
}

function parseListings(json: unknown, source: Listing["source"]): Listing[] {
    const out: Listing[] = [];
    for (const row of rowsOf(json)) {
        if (!isObj(row) || typeof row.resource !== "string") continue;
        const ext = isObj(row.extensions) ? row.extensions : {};
        const bazaar = isObj(ext.bazaar) ? ext.bazaar : {};
        const info = isObj(bazaar.info) ? bazaar.info : {};
        const input = isObj(info.input) ? info.input : {};
        const output = isObj(info.output) ? info.output : {};
        const quality = isObj(row.quality) ? row.quality : {};
        const inputMethod = str(input.method);
        out.push({
            source,
            resource: row.resource,
            type: str(row.type) ?? "",
            x402Version: typeof row.x402Version === "number" ? row.x402Version : 0,
            method: source === "payai" ? (inputMethod ?? str(row.method)) : inputMethod,
            accepts: Array.isArray(row.accepts) ? row.accepts : [],
            serviceName: str(row.serviceName),
            description: str(row.description),
            payers30d:
                source === "bazaar" &&
                typeof quality.l30DaysUniquePayers === "number" &&
                Number.isFinite(quality.l30DaysUniquePayers) &&
                quality.l30DaysUniquePayers >= 0
                    ? quality.l30DaysUniquePayers
                    : null,
            lastSettledAt: source === "bazaar" ? str(quality.lastCalledAt) : null,
            inputFields: fieldNames(isObj(input.body) ? input.body : input.queryParams),
            outputFields: fieldNames(output.example),
        });
    }
    return out;
}

export function parseBazaar(json: unknown): Listing[] {
    return parseListings(json, "bazaar");
}

export function parsePayai(json: unknown): Listing[] {
    return parseListings(json, "payai");
}

/* PayAI's list */

interface PayaiState {
    listings: readonly Listing[];
    ready: boolean;
    loading: boolean;
    abort: AbortController | null;
}

type PayaiDeps = Pick<Deps, "config" | "now" | "log" | "x402Fetch">;

const payaiStates = new WeakMap<X402Settings, PayaiState>();

function payaiState(x: X402Settings): PayaiState {
    let s = payaiStates.get(x);
    if (s === undefined) {
        s = { listings: [], ready: false, loading: false, abort: null };
        payaiStates.set(x, s);
    }
    return s;
}

function isSolanaUsdc(entry: unknown): boolean {
    return isObj(entry) && entry.network === solanaNetwork && entry.asset === usdcAsset;
}

async function loadPayai(deps: PayaiDeps, state: PayaiState): Promise<void> {
    const x = deps.config.x402;
    const fetch = x402Fetcher(deps);
    const abort = new AbortController();
    state.abort = abort;
    state.loading = true;
    let page = 0;
    try {
        const all: Listing[] = [];
        let offset = 0;
        for (; page < payaiMaxPages; page++) {
            const fetched = await fetch(`${x.payai_resources_url}?limit=100&offset=${offset}`, {
                signal: AbortSignal.any([abort.signal, AbortSignal.timeout(x.search_timeout)]),
                maxBytes: sourceMaxBytes,
                headers: { accept: "application/json" },
            });
            if (fetched.status !== 200) throw new Error("status");
            const json = bodyJson(fetched);
            const count = rowsOf(json).length;
            all.push(...parsePayai(json));
            offset += count;
            const total = isObj(json) && isObj(json.pagination) ? json.pagination.total : null;
            if (count < payaiPageSize) break;
            if (typeof total === "number" && offset >= total) break;
        }
        state.listings = all
            .filter((l) => l.type === "http" && l.accepts.some(isSolanaUsdc))
            .map((l) => ({ ...l, accepts: l.accepts.filter(isSolanaUsdc) }));
        state.ready = true;
    } catch {
        if (!abort.signal.aborted) deps.log.warn("payai refresh failed", { page });
    } finally {
        state.loading = false;
        state.abort = null;
    }
}

export function payaiListings(deps: Pick<Deps, "config">): {
    listings: readonly Listing[];
    ready: boolean;
} {
    const s = payaiStates.get(deps.config.x402);
    return s ? { listings: s.listings, ready: s.ready } : { listings: [], ready: false };
}

export function refreshPayai(deps: PayaiDeps): () => void {
    const x = deps.config.x402;
    const state = payaiState(x);
    const load = () => {
        if (!state.loading) void loadPayai(deps, state);
    };
    load();
    const timer = setInterval(load, x.payai_refresh);
    timer.unref();
    return () => {
        clearInterval(timer);
        state.abort?.abort();
    };
}

/* Candidates */

const emptyDropped = (): Dropped => ({
    price: 0,
    network: 0,
    terms: 0,
    unreachable: 0,
    shared: 0,
});

const caches = new WeakMap<X402Settings, TtlCache<FindOutcome>>();

function prefixFor(
    index: X402Index,
    method: X402Method,
    host: string,
    path: string,
): { prefix: string; indexEntry: IndexEntry | null } | null {
    const base = openAiBase(path);
    const prefix =
        coveringEntry(index, method, host, path)?.prefix ??
        (base !== null ? base + "/" : defaultPrefix(path));
    if (prefix === null) return null;
    return { prefix, indexEntry: exactEntry(index, method, host, prefix) };
}

function lineOk(
    c: { method: X402Method; url: string; prefix: string },
    maxMicros: number,
    payTo: string,
    limits: LineLimits,
): boolean {
    const line = formatServiceLine({ ...c, maxMicros, payTo });
    return line.length <= lineMaxChars && parseServiceLine(line, limits).ok;
}

interface Cheapest {
    amount: bigint;
    payTo: string;
}

function cheapestExact(
    accepts: readonly unknown[],
    terms: X402Terms,
): Cheapest | "network" | "terms" {
    const onNet = accepts.filter(
        (a): a is Obj => isObj(a) && a.network === terms.network && a.asset === terms.asset,
    );
    if (onNet.length === 0) return "network";
    let best: Cheapest | null = null;
    for (const a of onNet) {
        if (a.scheme !== "exact" || typeof a.amount !== "string" || !/^\d+$/.test(a.amount)) {
            continue;
        }
        const amount = BigInt(a.amount);
        if (amount <= 0n) continue;
        if (best === null || amount < best.amount) {
            best = { amount, payTo: typeof a.payTo === "string" ? a.payTo : "" };
        }
    }
    return best ?? "terms";
}

function mergeInto(c: Candidate, from: Partial<Candidate> & { source: FindSource }): void {
    if (!c.sources.includes(from.source)) c.sources.push(from.source);
    c.listedPriceMicros ??= from.listedPriceMicros ?? null;
    c.sellerName ??= from.sellerName ?? null;
    if (c.sellerText === "") c.sellerText = from.sellerText ?? "";
    c.payers30d ??= from.payers30d ?? null;
    c.lastSettledAt ??= from.lastSettledAt ?? null;
    if (c.inputFields.length === 0) c.inputFields = [...(from.inputFields ?? [])];
    if (c.outputFields.length === 0) c.outputFields = [...(from.outputFields ?? [])];
}

function indexCandidate(e: IndexEntry): Candidate {
    const parts = urlParts(e.url);
    return {
        method: e.method,
        url: e.url,
        host: e.host,
        path: parts?.path ?? "",
        prefix: e.prefix,
        indexEntry: e,
        listedPriceMicros: null,
        sources: ["index"],
        sellerName: null,
        sellerText: "",
        payers30d: null,
        lastSettledAt: null,
        inputFields: [...e.inputFields],
        outputFields: [...e.outputFields],
    };
}

function askedOnly(
    answer: Record<string, X402SellerStats>,
    hosts: readonly string[],
): Record<string, X402SellerStats> {
    const out: Record<string, X402SellerStats> = {};
    for (const h of hosts) if (Object.hasOwn(answer, h)) out[h] = answer[h] as X402SellerStats;
    return out;
}

// Plain copies that nothing can write to, so a cached outcome stays what the search made
function seal(outcome: FindOutcome): FindOutcome {
    const freeze = (v: unknown): void => {
        if (typeof v !== "object" || v === null || Object.isFrozen(v)) return;
        Object.freeze(v);
        for (const x of Object.values(v)) freeze(x);
    };
    const copy = structuredClone(outcome);
    freeze(copy);
    return copy;
}

function highestFirst<T extends { score: number }>(rows: T[]): T[] {
    return rows.sort((a, b) => b.score - a.score);
}

function wordHits(want: ReadonlySet<string>, l: Listing): number {
    const have = apiWords(`${l.serviceName ?? ""} ${l.description ?? ""} ${l.resource}`);
    let n = 0;
    for (const w of have) if (want.has(w)) n++;
    return n;
}

async function bazaarListings(
    deps: Deps,
    q: FindQuery,
    terms: X402Terms,
    budget: Budget,
): Promise<Listing[] | null> {
    const s = deps.config.x402;
    const url =
        `${s.cdp_search_url}?query=${encodeURIComponent(q.api)}&network=${terms.network}` +
        `&maxUsdPrice=${lineMax(q.maxPriceMicros)}&limit=20`;
    try {
        const fetched = await x402Fetcher(deps)(url, {
            signal: budget.signal(s.search_timeout),
            maxBytes: sourceMaxBytes,
            headers: { accept: "application/json" },
        });
        if (fetched.status !== 200) throw new Error("status");
        return parseBazaar(bodyJson(fetched));
    } catch {
        deps.log.warn("x402 search source failed", { source: "bazaar" });
        return null;
    }
}

type Probed = Extract<Probe, { ok: true }>;

// Rule 8, the probe's answer as a result or the count that explains its absence
function finish(
    deps: Deps,
    c: Candidate,
    probe: Probe,
    q: FindQuery,
    limits: LineLimits,
    index: X402Index,
    ctx: RankContext,
    dropped: Dropped,
): { found: Found | null; failure: string | null } {
    if (!probe.ok) {
        if (probe.failure === "shared_hosting") dropped.shared++;
        else dropped.unreachable++;
        return { found: null, failure: reasonWords(probe.failure) };
    }
    let priceMicros: number;
    let payTo: string;
    if (probe.pinnedFrom === "probe") {
        priceMicros = probe.priceMicros;
        payTo = probe.payTo;
    } else {
        if (c.listedPriceMicros === null || c.indexEntry === null) {
            dropped.unreachable++;
            return { found: null, failure: reasonWords("no_402") };
        }
        priceMicros = c.listedPriceMicros;
        payTo = c.indexEntry.payTo;
    }
    if (priceMicros > q.maxPriceMicros) {
        dropped.price++;
        return { found: null, failure: null };
    }
    if (!lineOk(c, priceMicros, payTo, limits)) {
        dropped.terms++;
        return { found: null, failure: null };
    }
    const listed = listedEntry(index, c.method, c.host, c.prefix, payTo) !== null;
    const shown = { ...c, indexEntry: listed ? c.indexEntry : null };
    const total = score(shown, priceMicros, ctx);
    if (total === null) {
        dropped.unreachable++;
        return { found: null, failure: null };
    }
    const kept: Probed = probe;
    return {
        found: {
            ...shown,
            probe: kept,
            priceMicros,
            payTo,
            listed: listed ? "indexed" : "unlisted",
            score: total,
        },
        failure: null,
    };
}

async function findByUrl(
    deps: Deps,
    q: FindQuery,
    url: string,
    terms: X402Terms,
    budget: Budget,
): Promise<FindOutcome> {
    const s = deps.config.x402;
    const index = indexOf(deps);
    const limits = lineLimits(terms);
    const dropped = emptyDropped();
    let partial = false;
    const out = (urlFailure: string | null, results: Found[] = []): FindOutcome =>
        seal({ results, dropped, partial, urlFailure });
    const parts = urlParts(url);
    if (
        parts === null ||
        hostRefused(
            parts.host,
            deps.config.router.links_domain,
            deps.config.x402.sandbox_host_domains,
        )
    ) {
        dropped.terms++;
        return out(null);
    }
    if (underSuffix(parts.host, s.shared_hosting_suffixes) && !hostIndexed(index, parts.host)) {
        dropped.shared++;
        return out(probeWords.shared_hosting);
    }
    const p = prefixFor(index, q.method, parts.host, parts.path);
    if (p === null) {
        dropped.terms++;
        return out(null);
    }
    const c: Candidate = {
        method: q.method,
        url,
        host: parts.host,
        path: parts.path,
        prefix: p.prefix,
        indexEntry: p.indexEntry,
        listedPriceMicros: null,
        sources: ["user"],
        sellerName: null,
        sellerText: "",
        payers30d: null,
        lastSettledAt: null,
        inputFields: [...(p.indexEntry?.inputFields ?? [])],
        outputFields: [...(p.indexEntry?.outputFields ?? [])],
    };
    let sellers: Record<string, X402SellerStats> = {};
    try {
        sellers = askedOnly(
            await deps.payments.x402Sellers([c.host], budget.signal(sellersCapMs)),
            [c.host],
        );
    } catch {
        partial = true;
        deps.log.warn("x402 sellers unavailable");
    }
    const probe = await createProber(deps).probe(
        { method: c.method, url, indexMatch: c.indexEntry !== null },
        terms,
        budget.signal(s.probe_timeout),
    );
    const ctx: RankContext = {
        maxPriceMicros: q.maxPriceMicros,
        now: deps.now(),
        sellers,
        hostsSeen: hostsSeen(s, deps.log),
    };
    const { found, failure } = finish(deps, c, probe, q, limits, index, ctx, dropped);
    return out(failure, found ? [found] : []);
}

export async function findServices(
    deps: Deps,
    q: FindQuery,
    terms: X402Terms,
    budget: Budget,
): Promise<FindOutcome> {
    if (q.url !== null) return findByUrl(deps, q, q.url, terms, budget);
    const s = deps.config.x402;
    let cache = caches.get(s);
    if (cache === undefined) {
        cache = new TtlCache<FindOutcome>(s.search_cache_ttl, 200, deps.now);
        caches.set(s, cache);
    }
    const cacheKey = JSON.stringify([q.api, q.keyName, q.maxPriceMicros]);
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;

    const index = indexOf(deps);
    const limits = lineLimits(terms);
    const dropped = emptyDropped();
    let partial = false;

    // The three sources run at once, the index and PayAI lists are already in memory
    const bazaar = await bazaarListings(deps, q, terms, budget);
    if (bazaar === null) partial = true;
    const payai = payaiListings(deps);
    if (!payai.ready) partial = true;
    const want = apiWords(q.api);
    const payaiMatches = payai.listings
        .map((l) => ({ l, hits: wordHits(want, l) }))
        .filter((m) => m.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, payaiMatchLimit)
        .map((m) => m.l);

    const kept = new Map<string, Candidate | null>();
    const order: Candidate[] = [];
    const keep = (c: Candidate) => {
        kept.set(`${c.method} ${c.url}`, c);
        order.push(c);
    };

    for (const e of matchIndex(index, q.api, q.keyName)) {
        const key = `${e.method} ${e.url}`;
        if (kept.has(key)) continue;
        if (
            hostRefused(
                e.host,
                deps.config.router.links_domain,
                deps.config.x402.sandbox_host_domains,
            )
        ) {
            kept.set(key, null);
            dropped.terms++;
            continue;
        }
        const c = indexCandidate(e);
        if (!lineOk(c, q.maxPriceMicros, e.payTo, limits)) {
            kept.set(key, null);
            dropped.terms++;
            continue;
        }
        keep(c);
    }

    type Checked = { drop: keyof Dropped } | { ok: Candidate; micros: number | null };

    const check = (l: Listing): Checked => {
        const cheapest = cheapestExact(l.accepts, terms);
        const method = l.method;
        if (l.type !== "http" || l.x402Version !== 2) return { drop: "terms" };
        if (method !== "GET" && method !== "POST") return { drop: "terms" };
        if (cheapest === "network") return { drop: "network" };
        if (cheapest === "terms") return { drop: "terms" };
        if (cheapest.amount > BigInt(q.maxPriceMicros)) return { drop: "price" };
        const parts = urlParts(l.resource);
        if (
            parts === null ||
            hostRefused(
                parts.host,
                deps.config.router.links_domain,
                deps.config.x402.sandbox_host_domains,
            )
        ) {
            return { drop: "terms" };
        }
        if (underSuffix(parts.host, s.shared_hosting_suffixes) && !hostIndexed(index, parts.host)) {
            return { drop: "shared" };
        }
        const p = prefixFor(index, method, parts.host, parts.path);
        const micros = Number(cheapest.amount);
        if (
            p === null ||
            !lineOk({ method, url: l.resource, prefix: p.prefix }, micros, cheapest.payTo, limits)
        ) {
            return { drop: "terms" };
        }
        return {
            ok: {
                method,
                url: l.resource,
                host: parts.host,
                path: parts.path,
                prefix: p.prefix,
                indexEntry: p.indexEntry,
                listedPriceMicros: null,
                sources: [],
                sellerName: null,
                sellerText: "",
                payers30d: null,
                lastSettledAt: null,
                inputFields: [],
                outputFields: [],
            },
            micros: cheapest.amount <= BigInt(Number.MAX_SAFE_INTEGER) ? micros : null,
        };
    };

    // A listing that fails the filters adds nothing, and one already seen is not counted again
    for (const l of [...(bazaar ?? []), ...payaiMatches]) {
        const key = `${l.method} ${l.resource}`;
        const seen = kept.has(key);
        const checked = check(l);
        if ("drop" in checked) {
            if (!seen) {
                kept.set(key, null);
                dropped[checked.drop]++;
            }
            continue;
        }
        const fill = {
            source: l.source,
            listedPriceMicros: checked.micros,
            sellerName: l.serviceName,
            sellerText: `${l.serviceName ?? ""} ${l.description ?? ""}`,
            payers30d: l.payers30d,
            lastSettledAt: l.lastSettledAt,
            inputFields: l.inputFields,
            outputFields: l.outputFields,
        } as const;
        const earlier = kept.get(key);
        if (earlier) {
            mergeInto(earlier, fill);
        } else {
            keep(checked.ok);
            mergeInto(checked.ok, fill);
        }
    }

    const ctx: RankContext = {
        maxPriceMicros: q.maxPriceMicros,
        now: deps.now(),
        sellers: {},
        hostsSeen: hostsSeen(s, deps.log),
    };
    const pre = highestFirst(
        order.map((c) => ({
            c,
            score: score(c, c.listedPriceMicros ?? q.maxPriceMicros, ctx) ?? 0,
        })),
    ).map((r) => r.c);

    let sellers: Record<string, X402SellerStats> = {};
    const hosts = [...new Set(pre.map((c) => c.host))].slice(0, 20);
    if (hosts.length > 0) {
        try {
            sellers = askedOnly(
                await deps.payments.x402Sellers(hosts, budget.signal(sellersCapMs)),
                hosts,
            );
        } catch {
            partial = true;
            deps.log.warn("x402 sellers unavailable");
        }
    }
    const rctx: RankContext = { ...ctx, sellers };
    const ranked: { c: Candidate; score: number }[] = [];
    for (const c of pre) {
        const sc = score(c, c.listedPriceMicros ?? q.maxPriceMicros, rctx);
        if (sc === null) dropped.unreachable++;
        else ranked.push({ c, score: sc });
    }
    const top = highestFirst(ranked)
        .slice(0, s.probe_concurrency)
        .map((r) => r.c);

    const prober = createProber(deps);
    const probeSignal = budget.signal(s.probe_timeout);
    const probes = await Promise.all(
        top.map((c) =>
            prober.probe(
                { method: c.method, url: c.url, indexMatch: c.indexEntry !== null },
                terms,
                probeSignal,
            ),
        ),
    );
    const found: Found[] = [];
    top.forEach((c, i) => {
        const probe = probes[i];
        if (!probe) return;
        const r = finish(deps, c, probe, q, limits, index, rctx, dropped);
        if (r.found) found.push(r.found);
    });
    const outcome = seal({
        results: highestFirst(found).slice(0, s.max_results),
        dropped,
        partial,
        urlFailure: null,
    });
    if (!partial) cache.set(cacheKey, outcome);
    return outcome;
}
