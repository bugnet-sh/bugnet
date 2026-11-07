import { afterEach, describe, expect, it, vi } from "vitest";
import type { X402SellerStats } from "../payments/port.ts";
import { silentLog, type Log } from "../log.ts";
import { Budget } from "../tools/common.ts";
import {
    fakeX402Fetch,
    otherPayTo,
    paymentRequiredHeader,
    recordingLog,
    testConfig,
    testDeps,
    testNow,
    testPayments,
    testTerms,
    x402Fixture,
    type FakeAnswer,
} from "../testing/harness.ts";
import { loadIndex, type X402Index } from "./index.ts";
import { solanaNetwork } from "./lines.ts";
import {
    findServices,
    parseBazaar,
    parsePayai,
    payaiListings,
    refreshPayai,
    type FindQuery,
} from "./search.ts";

type Row = Record<string, unknown> & { accepts: Record<string, unknown>[] };

const chat = x402Fixture("bazaar-search-chat.json") as { resources: Row[] };
const base = chat.resources[0] as Row;
const solanaEntry = base.accepts.find((a) => a.network === solanaNetwork) as Record<
    string,
    unknown
>;
const page = x402Fixture("payai-page.json") as { items: { resource: string }[] };
const sample = loadIndex(x402Fixture("index-sample.json"));
const empty: X402Index = { v: 1, services: [] };
const terms = testTerms();

const bazaarUrl = (api: string, max: string) =>
    `https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=${encodeURIComponent(api)}&network=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp&maxUsdPrice=${max}&limit=20`;
const payaiUrl = (offset: number) =>
    `https://facilitator.payai.network/discovery/resources?limit=100&offset=${offset}`;
const chatBazaar = bazaarUrl("chat completions", "0.10");

const answer402 = (accepts: unknown[]): FakeAnswer => ({
    status: 402,
    headers: { "payment-required": paymentRequiredHeader({ x402Version: 2, accepts }) },
});

function copy(patch: Record<string, unknown>, resource: string): Row {
    return { ...structuredClone(base), ...patch, resource };
}

function inputMethod(row: Row, method: string): Row {
    const r = structuredClone(row) as unknown as {
        extensions: { bazaar: { info: { input: { method: string } } } };
    };
    r.extensions.bazaar.info.input.method = method;
    return r as unknown as Row;
}

function probesOf(rows: Row[]): Record<string, FakeAnswer> {
    return Object.fromEntries(rows.map((r) => [r.resource as string, answer402(r.accepts)]));
}

const stops: (() => void)[] = [];
afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    vi.useRealTimers();
});

interface SetupOptions {
    toml?: string;
    index?: X402Index;
    sellers?: (hosts: string[]) => Promise<Record<string, X402SellerStats>>;
    log?: Log;
}

function setup(routes: Record<string, FakeAnswer>, o: SetupOptions = {}) {
    const fake = fakeX402Fetch(routes);
    const clock = { now: testNow };
    const deps = testDeps({
        config: testConfig("[x402]\nenabled = true\n" + (o.toml ?? "")),
        x402Fetch: fake.fetch,
        x402Index: o.index ?? empty,
        payments: testPayments(undefined, { x402: { sellers: o.sellers } }),
        log: o.log ?? silentLog,
        now: () => clock.now,
    });
    return { deps, fake, clock };
}

type Deps = ReturnType<typeof setup>["deps"];

function run(deps: Deps, q: Partial<FindQuery> = {}) {
    return findServices(
        deps,
        {
            api: "chat completions",
            keyName: null,
            maxPriceMicros: 100_000,
            url: null,
            method: "POST",
            ...q,
        },
        terms,
        new Budget(deps),
    );
}

async function ready(deps: Deps, routes: Record<string, FakeAnswer>): Promise<() => void> {
    routes[payaiUrl(0)] = { status: 200, body: page };
    const stop = refreshPayai(deps);
    stops.push(stop);
    await vi.waitFor(() => expect(payaiListings(deps).ready).toBe(true));
    return stop;
}

const tenRows = (): Row[] =>
    Array.from({ length: 10 }, (_, i) =>
        copy(
            { quality: { l30DaysUniquePayers: 100 - i, lastCalledAt: null } },
            `https://s${i}.example/v1/chat/completions`,
        ),
    );

describe("parsing", () => {
    it("parseBazaar reads a search answer", () => {
        expect(parseBazaar(chat)[0]).toEqual({
            source: "bazaar",
            resource: "https://api.chit402.com/v1/chat/completions",
            type: "http",
            x402Version: 2,
            method: "POST",
            accepts: base.accepts,
            serviceName: "Chit402",
            description: base.description,
            payers30d: 25,
            lastSettledAt: "2026-11-05T01:05:35.626Z",
            inputFields: ["max_tokens", "messages", "model"],
            outputFields: ["choices", "created", "id", "model", "object", "usage", "xfuel"],
        });
        expect(
            parseBazaar({ resources: [1, {}, { resource: 5 }, chat.resources[0]] }),
        ).toHaveLength(1);
        expect(parseBazaar("x")).toEqual([]);
        expect(parseBazaar({ items: [chat.resources[0]] })).toHaveLength(1);
    });

    it("parsePayai takes the item's method when the input has none", () => {
        expect(parsePayai(page)[1]).toMatchObject({
            source: "payai",
            resource: "https://clawhunter.fun/api/v1/chat/completions",
            method: "POST",
            payers30d: null,
            lastSettledAt: null,
        });
    });
});

describe("the Bazaar request and the filters", () => {
    it("is the S 5.2 URL", async () => {
        const { deps, fake } = setup({ [chatBazaar]: { status: 200, body: { resources: [] } } });
        await run(deps);
        const call = fake.calls.find((c) => c.url === chatBazaar);
        expect(call?.headers.accept).toBe("application/json");
        expect(fake.calls.filter((c) => c.url.includes("coinbase"))).toHaveLength(1);
    });

    it("counts each filter in its Dropped field", async () => {
        const a = (n: number, patch: Record<string, unknown>) =>
            copy(patch, `https://a${n}.example/v1/chat/completions`);
        const withEntry = (patch: Record<string, unknown>) => [{ ...solanaEntry, ...patch }];
        const rows: Row[] = [
            base,
            a(1, { type: "mcp" }),
            a(2, { x402Version: 1 }),
            inputMethod(a(3, {}), "DELETE"),
            a(4, { accepts: withEntry({ network: "eip155:8453" }) }),
            a(5, { accepts: withEntry({ scheme: "upto" }) }),
            a(6, { accepts: withEntry({ amount: "200000" }) }),
            copy({}, "http://a7.example/v1/chat/completions"),
            copy({}, "https://203.0.113.9/v1/chat/completions"),
            copy({}, "https://x.bugnet.sh/v1/chat/completions"),
            copy({}, "https://seller.workers.dev/v1/chat/completions"),
            copy({}, `https://a8.example/${"a".repeat(330)}/chat/completions`),
            copy({}, "https://a9.example/v1/%2e%2e/chat/completions"),
        ];
        const { deps } = setup({
            [chatBazaar]: { status: 200, body: { resources: rows } },
            [base.resource as string]: answer402(base.accepts),
        });
        const out = await run(deps);
        expect(out.dropped).toEqual({ price: 1, network: 1, terms: 9, unreachable: 0, shared: 1 });
        expect(out.results.map((r) => r.url)).toEqual([base.resource]);
    });

    it("lets a shared-hosting host pass when the index lists it", async () => {
        const url = "https://perp-gap-api.perpgap.workers.dev/catalog/items";
        const row = inputMethod(copy({}, url), "GET");
        const { deps } = setup(
            {
                [chatBazaar]: { status: 200, body: { resources: [row] } },
                [url]: answer402([
                    { ...solanaEntry, payTo: "5MoL8HNnvZUogGrqiF4T1StmAUpdU7ERA2GUJ7gLrEja" },
                ]),
            },
            { index: sample },
        );
        const out = await run(deps);
        expect(out.results).toHaveLength(1);
        expect(out.results[0]).toMatchObject({ prefix: "/catalog/", listed: "indexed" });
    });

    it("takes the prefix from the index entry, else the OpenAI base, else the default", async () => {
        const rows = [
            copy({}, "https://agent402.tools/v1/auto/embeddings"),
            copy({}, "https://seller.example/v2/chat/completions"),
            copy({}, "https://seller.example/api/run"),
        ];
        const { deps } = setup(
            {
                [chatBazaar]: { status: 200, body: { resources: rows } },
                ...probesOf(rows),
            },
            { index: sample },
        );
        const out = await run(deps, { api: "chat completions" });
        const by = (url: string) => out.results.find((r) => r.url === url);
        expect(by(rows[0]?.resource as string)).toMatchObject({
            prefix: "/v1/auto/",
            indexEntry: sample.services[0],
        });
        expect(by(rows[1]?.resource as string)?.prefix).toBe("/v2/");
        expect(by(rows[2]?.resource as string)?.prefix).toBe("/api/");
    });
});

describe("the index as a source", () => {
    const exa = "https://api.exa.ai/search";
    const exaEntry = sample.services[4];

    it.each([
        ["web search", null],
        ["zzz", "EXA_API_KEY"],
    ])("finds the entry by word or key name (%s, %s)", async (api, keyName) => {
        const routes = (payTo: string) => ({
            [bazaarUrl(api, "0.10")]: { status: 200, body: { resources: [] } },
            [exa]: answer402([{ ...solanaEntry, payTo }]),
        });
        const good = setup(routes(exaEntry?.payTo ?? ""), { index: sample });
        const a = await run(good.deps, { api, keyName });
        expect(a.results).toHaveLength(1);
        expect(a.results[0]).toMatchObject({ url: exa, sources: ["index"], listed: "indexed" });
        const bad = setup(routes(otherPayTo), { index: sample });
        const b = await run(bad.deps, { api, keyName });
        expect(b.results[0]?.listed).toBe("unlisted");
        expect(b.results[0]?.score).toBeCloseTo((a.results[0]?.score ?? 0) - 100);
    });

    it("pins a POST entry with no 402 from the entry at the listed price", async () => {
        const row = copy({ accepts: [{ ...solanaEntry, amount: "7000" }] }, exa);
        const routes = {
            [bazaarUrl("web search", "0.10")]: { status: 200, body: { resources: [row] } },
            [exa]: { status: 200, body: {} },
        };
        const { deps } = setup(routes, { index: sample });
        const out = await run(deps, { api: "web search" });
        expect(out.results[0]).toMatchObject({
            priceMicros: 7_000,
            payTo: exaEntry?.payTo,
            sources: ["index", "bazaar"],
        });
        expect(out.results[0]?.probe.pinnedFrom).toBe("index");
        const none = setup(
            {
                [bazaarUrl("web search", "0.10")]: { status: 200, body: { resources: [] } },
                [exa]: { status: 200, body: {} },
            },
            { index: sample },
        );
        const gone = await run(none.deps, { api: "web search" });
        expect(gone.results).toEqual([]);
        expect(gone.dropped.unreachable).toBe(1);
    });
});

describe("probing and ranking", () => {
    it("probes the top 8 at once and drops failures", async () => {
        const rows = tenRows();
        const routes: Record<string, FakeAnswer> = {
            [chatBazaar]: { status: 200, body: { resources: rows } },
        };
        rows.forEach((r, i) => {
            routes[r.resource as string] =
                i === 3 || i === 5
                    ? { status: 404, delayMs: 20 }
                    : ({ ...(answer402(r.accepts) as object), delayMs: 20 } as FakeAnswer);
        });
        const { deps, fake } = setup(routes);
        const out = await run(deps);
        expect(fake.maxInFlight()).toBe(8);
        expect(fake.calls.some((c) => c.url.includes("s8.") || c.url.includes("s9."))).toBe(false);
        expect(out.dropped.unreachable).toBe(2);
        expect(out.results.map((r) => r.host)).toEqual([
            "s0.example",
            "s1.example",
            "s2.example",
            "s4.example",
            "s6.example",
        ]);
    });

    it("replaces the listed price with the live one and reorders", async () => {
        const listed = (n: number) => [{ ...solanaEntry, amount: String(n) }];
        const rowA = copy({ accepts: listed(50_000) }, "https://a.example/v1/chat/completions");
        const rowB = copy({ accepts: listed(20_000) }, "https://b.example/v1/chat/completions");
        const probes = (a: number, b: number) => ({
            [chatBazaar]: { status: 200, body: { resources: [rowA, rowB] } },
            [rowA.resource as string]: answer402(listed(a)),
            [rowB.resource as string]: answer402(listed(b)),
        });
        const one = await run(setup(probes(10_000, 60_000)).deps);
        expect(one.results.map((r) => [r.host, r.priceMicros])).toEqual([
            ["a.example", 10_000],
            ["b.example", 60_000],
        ]);
        expect(one.results[0]?.listedPriceMicros).toBe(50_000);
        const two = await run(setup(probes(10_000, 150_000)).deps);
        expect(two.results.map((r) => r.host)).toEqual(["a.example"]);
        expect(two.dropped.price).toBe(1);
    });

    it("caps the results at max_results", async () => {
        const rows = tenRows();
        const { deps } = setup(
            { [chatBazaar]: { status: 200, body: { resources: rows } }, ...probesOf(rows) },
            { toml: "max_results = 3\n" },
        );
        expect((await run(deps)).results).toHaveLength(3);
    });

    it("sends the sellers call the first 20 hosts and drops bad sellers", async () => {
        const rows = Array.from({ length: 25 }, (_, i) =>
            copy(
                { quality: { l30DaysUniquePayers: 200 - i, lastCalledAt: null } },
                `https://s${i}.example/v1/chat/completions`,
            ),
        );
        const calls: string[][] = [];
        const sellers = async (hosts: string[]) => {
            calls.push(hosts);
            return {
                "s1.example": { paidCalls30d: 10, failedPaid30d: 6 },
                "s2.example": { paidCalls30d: 10, failedPaid30d: 3 },
            };
        };
        const routes = {
            [chatBazaar]: { status: 200, body: { resources: rows } },
            ...probesOf(rows),
        };
        const { deps, fake } = setup(routes, { sellers });
        const out = await run(deps);
        expect(calls).toEqual([Array.from({ length: 20 }, (_, i) => `s${i}.example`)]);
        expect(fake.calls.some((c) => /s[12]\.example/.test(c.url))).toBe(false);
        expect(out.dropped.unreachable).toBe(1);

        const failing = setup(routes, { sellers: () => Promise.reject(new Error("down")) });
        await ready(failing.deps, routes);
        const second = await run(failing.deps);
        expect(second.partial).toBe(true);
        expect(second.results.length).toBeGreaterThan(0);
    });
});

describe("PayAI", () => {
    it("loads once an hour and serves the Solana USDC rows", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const routes: Record<string, FakeAnswer> = {};
        const { deps, fake } = setup(routes);
        const stop = await ready(deps, routes);
        const count = () => fake.calls.filter((c) => c.url === payaiUrl(0)).length;
        expect(count()).toBe(1);
        expect(payaiListings(deps).listings.map((l) => l.resource)).toEqual([
            "https://clawhunter.fun/api/v1/chat/completions",
            "https://api.xfuel.app/v1/chat/completions",
            "https://blockrun-sol-staging-vbsbhh7lea-uc.a.run.app/api/v1/chat/completions",
            "https://blockrun-sol-vbsbhh7lea-an.a.run.app/api/v1/chat/completions",
        ]);
        vi.advanceTimersByTime(3_600_000);
        await vi.waitFor(() => expect(count()).toBe(2));
        stop();
        vi.advanceTimersByTime(7_200_000);
        expect(count()).toBe(2);
    });

    it.each([
        ["a short last page", 100, 103, [100, 3], 2],
        ["an empty page", 100, null, [100, 0], 2],
        ["the total", 100, 100, [100], 1],
    ])("pages until %s", async (_name, _size, total, sizes, calls) => {
        const item = (page.items[1] ?? {}) as object;
        const pageOf = (n: number, t: number | null) => ({
            items: Array.from({ length: n }, () => item),
            ...(t === null ? {} : { pagination: { total: t } }),
        });
        const routes: Record<string, FakeAnswer> = {
            [payaiUrl(0)]: { status: 200, body: pageOf(sizes[0] ?? 0, total) },
            [payaiUrl(100)]: { status: 200, body: pageOf(sizes[1] ?? 0, total) },
        };
        const { deps, fake } = setup(routes);
        stops.push(refreshPayai(deps));
        await vi.waitFor(() => expect(payaiListings(deps).ready).toBe(true));
        expect(fake.calls.filter((c) => c.url.includes("payai"))).toHaveLength(calls);
    });

    it("keeps the last list after a failed load", async () => {
        const rec = recordingLog();
        const routes: Record<string, FakeAnswer> = {};
        const { deps } = setup(routes, { log: rec.log });
        await ready(deps, routes);
        const before = payaiListings(deps).listings.length;
        routes[payaiUrl(0)] = { status: 500 };
        stops.push(refreshPayai(deps));
        await vi.waitFor(() =>
            expect(rec.lines.some((l) => l.includes("payai refresh failed"))).toBe(true),
        );
        expect(payaiListings(deps)).toMatchObject({ ready: true });
        expect(payaiListings(deps).listings).toHaveLength(before);
    });

    it("matches rows by word", async () => {
        const routes: Record<string, FakeAnswer> = {
            [chatBazaar]: { status: 200, body: { resources: [] } },
            [bazaarUrl("weather forecast", "0.10")]: { status: 200, body: { resources: [] } },
        };
        for (const l of page.items) {
            routes[l.resource] = answer402([{ ...solanaEntry, payTo: solanaEntry.payTo }]);
        }
        const { deps } = setup(routes);
        await ready(deps, routes);
        const hit = await run(deps, { api: "chat completions" });
        expect(hit.results.some((r) => r.sources.includes("payai"))).toBe(true);
        const miss = await run(deps, { api: "weather forecast" });
        expect(miss.results).toEqual([]);
    });
});

describe("caching and budgets", () => {
    it("serves a second call within 10 minutes from the cache", async () => {
        const rows = tenRows().slice(0, 2);
        const routes: Record<string, FakeAnswer> = {
            [chatBazaar]: { status: 200, body: { resources: rows } },
            [bazaarUrl("chat completions", "0.05")]: { status: 200, body: { resources: rows } },
            ...probesOf(rows),
        };
        const { deps, fake, clock } = setup(routes);
        await ready(deps, routes);
        await run(deps);
        const after = fake.calls.length;
        await run(deps);
        expect(fake.calls.length).toBe(after);
        await run(deps, { maxPriceMicros: 50_000 });
        expect(fake.calls.length).toBeGreaterThan(after);
        const again = fake.calls.length;
        await run(deps, { keyName: "OPENAI_API_KEY" });
        expect(fake.calls.length).toBeGreaterThan(again);
        const last = fake.calls.length;
        clock.now += 600_000;
        await run(deps);
        expect(fake.calls.length).toBeGreaterThan(last);
    });

    it("does not cache a partial answer", async () => {
        const { deps, fake } = setup({ [chatBazaar]: { status: 200, body: { resources: [] } } });
        await run(deps);
        await run(deps);
        expect(fake.calls.filter((c) => c.url === chatBazaar)).toHaveLength(2);
    });

    it("sets partial on a Bazaar timeout and keeps index and PayAI results", async () => {
        const rec = recordingLog();
        const key = bazaarUrl("chat completions", "0.10");
        const routes: Record<string, FakeAnswer> = { [key]: "hang" };
        for (const e of sample.services.slice(0, 2)) {
            routes[e.url] = answer402([{ ...solanaEntry, payTo: e.payTo }]);
        }
        for (const l of page.items) routes[l.resource] = answer402([solanaEntry]);
        const { deps } = setup(routes, {
            toml: 'search_timeout = "500ms"\n',
            index: sample,
            log: rec.log,
        });
        await ready(deps, routes);
        const out = await run(deps, { keyName: "OPENAI_API_KEY" });
        const sources = out.results.flatMap((r) => r.sources);
        expect(out.partial).toBe(true);
        expect(sources).toContain("index");
        expect(sources).toContain("payai");
        expect(sources).not.toContain("bazaar");
        const everything = rec.lines.join("\n");
        for (const e of sample.services) expect(everything).not.toContain(e.payTo);
        expect(everything).not.toContain(solanaEntry.payTo as string);
    });

    it("never reads partialResults as partial", async () => {
        const routes: Record<string, FakeAnswer> = {
            [chatBazaar]: { status: 200, body: chat },
            ...probesOf([base]),
        };
        const { deps } = setup(routes);
        await ready(deps, routes);
        expect((await run(deps)).partial).toBe(false);
    });

    it("stops every source and probe at its timeout", async () => {
        const routes: Record<string, FakeAnswer> = {
            [bazaarUrl("chat completions", "0.10")]: "hang",
        };
        for (const e of sample.services.slice(0, 2)) routes[e.url] = "hang";
        const { deps } = setup(routes, {
            toml: 'search_timeout = "500ms"\nprobe_timeout = "500ms"\n',
            index: sample,
        });
        const t0 = Date.now();
        const out = await run(deps, { keyName: "OPENAI_API_KEY" });
        const took = Date.now() - t0;
        expect(took).toBeGreaterThanOrEqual(900);
        expect(took).toBeLessThan(2_500);
        expect(out).toMatchObject({ partial: true, results: [] });
        expect(out.dropped.unreachable).toBe(2);
    });
});

describe("url mode", () => {
    const url = "https://api.chit402.com/v1/chat/completions";

    it("probes only that URL", async () => {
        const calls: string[][] = [];
        const { deps, fake } = setup(
            { [url]: answer402(base.accepts) },
            {
                sellers: async (h) => {
                    calls.push(h);
                    return {};
                },
            },
        );
        const out = await run(deps, { url });
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0]?.method).toBe("POST");
        expect(out.results[0]).toMatchObject({ sources: ["user"], payers30d: null });
        expect(out.results[0]?.url).toBe(url);
        expect(calls).toEqual([]);
    });

    it("explains its failures", async () => {
        const plain = setup({ [url]: { status: 200, body: {} } });
        const a = await run(plain.deps, { url });
        expect(a).toMatchObject({
            urlFailure: "no x402 price on a plain request",
            results: [],
        });
        expect(a.dropped.unreachable).toBe(1);

        const shared = setup({});
        const b = await run(shared.deps, { url: "https://seller.workers.dev/v1/x" });
        expect(b.urlFailure).toBe("a shared hosting address Bugnet has not reviewed");
        expect(b.dropped.shared).toBe(1);
        expect(shared.fake.calls).toHaveLength(0);

        const http = setup({});
        const c = await run(http.deps, { url: "http://a.example/x" });
        expect(c.urlFailure).toBeNull();
        expect(c.dropped.terms).toBe(1);
        expect(http.fake.calls).toHaveLength(0);

        const dear = setup({ [url]: answer402([{ ...solanaEntry, amount: "200000" }]) });
        const d = await run(dear.deps, { url });
        expect(d.urlFailure).toBeNull();
        expect(d.dropped.price).toBe(1);
    });
});
