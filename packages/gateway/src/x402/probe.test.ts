import { describe, expect, it } from "vitest";
import { createSafeFetcher, type RawFetch, type Resolve } from "../assess/fetch.ts";
import type { X402ServicePin } from "../payments/port.ts";
import {
    paymentRequiredHeader,
    testConfig,
    testDeps,
    testNow,
    testTerms,
    x402Fixture,
} from "../testing/harness.ts";
import { base58Encode } from "./lines.ts";
import {
    chooseAccept,
    createProber,
    decodePaymentRequired,
    probeWords,
    reasonWords,
    x402Fetcher,
} from "./probe.ts";

const recorded = {
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    amount: "30000",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payTo: "DUPiupXtuox38dcGoXUKer5mAydCzmaHjrbQ66qeEm8s",
    maxTimeoutSeconds: 300,
    extra: { feePayer: "BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP" },
};
const evm = {
    amount: "150000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    extra: { name: "USD Coin", version: "2" },
    maxTimeoutSeconds: 300,
    network: "eip155:8453",
    payTo: "0xd5Ba9711a3D052846a3695C70e7fcb8b3168FE7d",
    scheme: "exact",
};
const terms = testTerms();
const bugnet = terms.bugnetAddresses[0] as string;
const short = base58Encode(new Uint8Array(31).fill(7));

function entry(patch: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    return { ...recorded, ...patch, extra: { ...recorded.extra, ...extra } };
}
function required(...accepts: unknown[]) {
    return { x402Version: 2, accepts };
}

describe("chooseAccept", () => {
    const failing: [string, unknown[], string][] = [
        ["network", [evm], "network_unsupported"],
        [
            "asset",
            [entry({ asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" })],
            "network_unsupported",
        ],
        ["scheme", [entry({ scheme: "upto" })], "flow_unsupported"],
        [
            "assetTransferMethod",
            [entry({}, { assetTransferMethod: "permit2" })],
            "flow_unsupported",
        ],
        ["transactionVersions", [entry({}, { transactionVersions: [1] })], "flow_unsupported"],
        ["memo, 33 bytes", [entry({}, { memo: "a".repeat(33) })], "flow_unsupported"],
        ["memo, 34 UTF-8 bytes", [entry({}, { memo: "é".repeat(17) })], "flow_unsupported"],
        ["feePayer absent", [{ ...recorded, extra: {} }], "fee_payer_refused"],
        ["feePayer a Bugnet address", [entry({}, { feePayer: bugnet })], "fee_payer_refused"],
        ["feePayer of 31 bytes", [entry({}, { feePayer: short })], "fee_payer_refused"],
        [
            "feePayer not base58",
            [entry({}, { feePayer: "0OIl" + "1".repeat(40) })],
            "fee_payer_refused",
        ],
        [
            "splits",
            [entry({}, { splits: [{ payTo: evm.payTo, amount: "1000" }] })],
            "splits_unsupported",
        ],
        ["paymentFlow", [entry({}, { paymentFlow: "escrow" })], "flow_unsupported"],
        [
            "ataCreationRequired",
            [entry({}, { ataCreationRequired: true })],
            "ata_creation_unsupported",
        ],
        ["payTo a Bugnet address", [entry({ payTo: bugnet })], "payee_refused"],
        ["payTo of 31 bytes", [entry({ payTo: short })], "payee_refused"],
        ["payTo not base58", [entry({ payTo: evm.payTo })], "payee_refused"],
        ["amount not an integer", [entry({ amount: "0.03" })], "price_above_max"],
        ["amount 0", [entry({ amount: "0" })], "price_above_max"],
        ["amount a number", [entry({ amount: 30000 })], "price_above_max"],
        ["amount over the ceiling", [entry({ amount: "500001" })], "price_above_ceiling"],
    ];

    it.each(failing)("%s", (_name, accepts, failure) => {
        expect(chooseAccept(required(...accepts), terms)).toEqual({ ok: false, failure });
    });

    it("no accepts", () => {
        expect(chooseAccept({ x402Version: 2 }, terms)).toEqual({
            ok: false,
            failure: "network_unsupported",
        });
    });

    it.each([
        { assetTransferMethod: "default" },
        { transactionVersions: [0, 1] },
        { memo: "a".repeat(32) },
        { splits: [] },
        { paymentFlow: "authorization" },
        { paymentFlow: "upfront" },
        { ataCreationRequired: false },
    ])("each passing variant passes: %j", (extra) => {
        expect(chooseAccept(required(entry({}, extra)), terms).ok).toBe(true);
    });

    it("passes an amount at the ceiling", () => {
        expect(chooseAccept(required(entry({ amount: "500000" })), terms).ok).toBe(true);
    });

    it("the cheapest passing entry wins", () => {
        const fourth = entry({ amount: "25000" });
        const r = chooseAccept(
            required(
                evm,
                recorded,
                entry({ amount: "20000" }, { transactionVersions: [1] }),
                fourth,
            ),
            terms,
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.priceMicros).toBe(25_000);
        expect(r.payTo).toBe(recorded.payTo);
        expect(r.accepted).toBe(fourth);
    });

    it("a refusal names the first failing check of the cheapest Solana USDC entry", () => {
        const r = chooseAccept(
            required(evm, entry({ amount: "600000" }), entry({ amount: "10000", scheme: "upto" })),
            terms,
        );
        expect(r).toEqual({ ok: false, failure: "flow_unsupported" });
    });

    it("the memo limit is read from the terms", () => {
        const r = chooseAccept(
            required(entry({}, { memo: "a".repeat(33) })),
            testTerms({ sellerMemoMaxBytes: 64 }),
        );
        expect(r.ok).toBe(true);
    });
});

describe("decodePaymentRequired", () => {
    it("reads standard and url-safe base64", () => {
        const obj = { x402Version: 2, pad: "~~~???>>>" };
        const std = Buffer.from(JSON.stringify(obj)).toString("base64");
        expect(std).toMatch(/[+/]/);
        const urlSafe = std.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
        expect(decodePaymentRequired(std)).toEqual(obj);
        expect(decodePaymentRequired(urlSafe)).toEqual(obj);
    });

    it.each([
        "%%%",
        Buffer.from("[1]").toString("base64"),
        Buffer.from("null").toString("base64"),
        Buffer.from('{"a":').toString("base64"),
    ])("gives null for %s", (header) => {
        expect(decodePaymentRequired(header)).toBeNull();
    });
});

describe("probeWords", () => {
    it("holds the words of the spec", () => {
        expect(probeWords).toEqual({
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
        });
    });

    it("words a code, with a fallback", () => {
        expect(reasonWords("price_above_max")).toBe(
            "a price Bugnet cannot read, or above the approved max",
        );
        expect(reasonWords("SOMETHING_NEW")).toBe("Bugnet's rule SOMETHING_NEW");
    });
});

const at = "2026-11-05T12:00:00.000Z";
const target = {
    method: "GET",
    url: "https://loonie-toll.onrender.com/lobbying",
    indexMatch: false,
} as const;

function resolver(map: Record<string, string[]>): Resolve {
    return (hostname, _opts, cb) => {
        const ips = map[hostname];
        if (!ips) {
            cb(new Error(`getaddrinfo ENOTFOUND ${hostname}`), []);
            return;
        }
        cb(
            null,
            ips.map((address) => ({ address, family: 4 })),
        );
    };
}

function answer402(req: unknown = required(evm, recorded), body = "{}"): Response {
    return new Response(body, {
        status: 402,
        headers: {
            "payment-required": paymentRequiredHeader(req),
            "content-type": "application/json",
        },
    });
}

function setup(toml: string, raw: RawFetch) {
    const clock = { now: testNow };
    const deps = testDeps({
        config: testConfig("[x402]\n" + toml),
        x402Fetch: createSafeFetcher({ timeoutMs: 5000, rawFetch: raw }),
        now: () => clock.now,
    });
    return { clock, prober: createProber(deps) };
}

const sig = () => new AbortController().signal;

describe("createProber", () => {
    it("a 402 with a v2 header pins the probe with the chosen entry unmodified", async () => {
        const { prober } = setup("", async () => answer402());
        const p = await prober.probe(target, terms, sig());
        expect(p).toEqual({
            ok: true,
            pinnedFrom: "probe",
            at,
            status: 402,
            accepted: recorded,
            priceMicros: 30_000,
            payTo: "DUPiupXtuox38dcGoXUKer5mAydCzmaHjrbQ66qeEm8s",
        });
        if (!p.ok || p.pinnedFrom !== "probe") throw new Error("expected a probe pin");
        const pin: X402ServicePin["probe"] = { at: p.at, status: p.status, accepted: p.accepted };
        expect(pin.status).toBe(402);
    });

    it("GET sends Accept and no body, POST sends {} as JSON", async () => {
        const inits: Parameters<RawFetch>[1][] = [];
        const { prober } = setup("", async (_url, init) => {
            inits.push(init);
            return answer402();
        });
        await prober.probe(target, terms, sig());
        await prober.probe({ ...target, method: "POST" }, terms, sig());
        const [get, post] = inits;
        expect(get?.method).toBe("GET");
        expect(get?.headers.accept).toBe("application/json");
        expect(get?.body).toBeUndefined();
        expect(get?.headers["content-type"]).toBeUndefined();
        expect(post?.method).toBe("POST");
        expect(post?.body).toBe("{}");
        expect(post?.headers["content-type"]).toBe("application/json");
    });

    it("a redirect fails with redirect and is not followed", async () => {
        let n = 0;
        const { prober } = setup("", async () => {
            n += 1;
            return new Response(null, {
                status: 302,
                headers: { location: "https://other.example/x" },
            });
        });
        expect(await prober.probe(target, terms, sig())).toEqual({
            ok: false,
            at,
            failure: "redirect",
        });
        expect(n).toBe(1);
    });

    it("a private address is unreachable", async () => {
        const deps = testDeps({
            config: testConfig(),
            x402Fetch: createSafeFetcher({
                timeoutMs: 3000,
                resolve: resolver({ "evil.test": ["127.0.0.1"] }),
            }),
        });
        const p = await createProber(deps).probe(
            { method: "GET", url: "https://evil.test/x", indexMatch: false },
            terms,
            sig(),
        );
        expect(p).toMatchObject({ ok: false, failure: "unreachable" });
    });

    it("any other fetch error is unreachable", async () => {
        const { prober } = setup("", async () => {
            throw Object.assign(new Error("Headers Overflow Error"), {
                code: "UND_ERR_HEADERS_OVERFLOW",
            });
        });
        expect(await prober.probe(target, terms, sig())).toMatchObject({
            ok: false,
            failure: "unreachable",
        });
        const ok = setup("", async () => answer402());
        expect(await ok.prober.probe(target, terms, AbortSignal.abort())).toMatchObject({
            ok: false,
            failure: "unreachable",
        });
    });

    it("it waits at most probe_timeout", async () => {
        const { prober } = setup(
            'probe_timeout = "500ms"',
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(init.signal.reason));
                }),
        );
        const t0 = Date.now();
        expect(await prober.probe(target, terms, sig())).toMatchObject({
            ok: false,
            failure: "unreachable",
        });
        expect(Date.now() - t0).toBeLessThan(1500);
    });

    it("a valid header with a body that never ends is unreachable at probe_timeout", async () => {
        const { prober } = setup('probe_timeout = "500ms"', async (_url, init) =>
            answer402(
                undefined,
                // never ends, and fails when the signal aborts
                new ReadableStream<Uint8Array>({
                    pull: () =>
                        new Promise((_resolve, reject) => {
                            init.signal.addEventListener("abort", () => reject(init.signal.reason));
                        }),
                }) as unknown as string,
            ),
        );
        const t0 = Date.now();
        expect(await prober.probe(target, terms, sig())).toMatchObject({
            ok: false,
            failure: "unreachable",
        });
        expect(Date.now() - t0).toBeLessThan(1500);
    });

    it("it reads at most probe_max_bytes and decides from the header", async () => {
        let pulled = 0;
        let cancelled = false;
        const { prober } = setup("probe_max_bytes = 1024", async () =>
            answer402(
                undefined,
                new ReadableStream<Uint8Array>({
                    pull(controller) {
                        pulled += 1;
                        if (pulled > 1000) controller.close();
                        else controller.enqueue(new Uint8Array(1024).fill(65));
                    },
                    cancel() {
                        cancelled = true;
                    },
                }) as unknown as string,
            ),
        );
        expect(await prober.probe(target, terms, sig())).toMatchObject({
            ok: true,
            priceMicros: 30_000,
        });
        expect(cancelled).toBe(true);
        expect(pulled).toBeLessThan(10);
    });

    it("a v1 body alone is version_unsupported", async () => {
        const { prober } = setup(
            "",
            async () =>
                new Response(
                    JSON.stringify({
                        x402Version: 1,
                        error: "X-PAYMENT header is required",
                        accepts: [evm],
                    }),
                    { status: 402 },
                ),
        );
        expect(await prober.probe(target, terms, sig())).toEqual({
            ok: false,
            at,
            failure: "version_unsupported",
        });
    });

    it("no header and no v1 body is no_402", async () => {
        const empty = setup("", async () => new Response("", { status: 402 }));
        expect(await empty.prober.probe(target, terms, sig())).toMatchObject({
            ok: false,
            failure: "no_402",
        });
        const plain = setup("", async () => new Response('{"ok":true}', { status: 200 }));
        expect(await plain.prober.probe(target, terms, sig())).toMatchObject({
            ok: false,
            failure: "no_402",
        });
    });

    it("a non-402 POST pins the index only on an exact match", async () => {
        const { prober } = setup("", async () => new Response('{"ok":true}', { status: 200 }));
        const post = { ...target, method: "POST" } as const;
        expect(await prober.probe({ ...post, indexMatch: true }, terms, sig())).toEqual({
            ok: true,
            pinnedFrom: "index",
            at,
            status: 200,
            accepted: null,
        });
        expect(await prober.probe({ ...target, indexMatch: true }, terms, sig())).toMatchObject({
            ok: false,
            failure: "no_402",
        });
        expect(await prober.probe({ ...post, indexMatch: false }, terms, sig())).toMatchObject({
            ok: false,
            failure: "no_402",
        });
        const pricey = setup("", async () => answer402(required(entry({ amount: "600000" }))));
        expect(
            await pricey.prober.probe({ ...post, indexMatch: true }, terms, sig()),
        ).toMatchObject({ ok: false, failure: "price_above_ceiling" });
    });

    it("a 402 with no price on a POST with an index match is not an index pin", async () => {
        const { prober } = setup("", async () => new Response("", { status: 402 }));
        expect(
            await prober.probe({ ...target, method: "POST", indexMatch: true }, terms, sig()),
        ).toMatchObject({ ok: false, failure: "no_402" });
    });

    it("answers are cached per method and URL and checked against the terms each time", async () => {
        let n = 0;
        const { prober, clock } = setup("", async () => {
            n += 1;
            return answer402();
        });
        await prober.probe(target, terms, sig());
        const second = await prober.probe(target, terms, sig());
        expect(n).toBe(1);
        expect(second).toMatchObject({ ok: true, at });
        const capped = await prober.probe(
            target,
            testTerms({ maxPricePerCallMicros: 20_000 }),
            sig(),
        );
        expect(capped).toMatchObject({ ok: false, failure: "price_above_ceiling" });
        expect(n).toBe(1);
        await prober.probe({ ...target, method: "POST" }, terms, sig());
        expect(n).toBe(2);
        clock.now += 120_000;
        await prober.probe(target, terms, sig());
        expect(n).toBe(3);
    });

    it("an unreachable answer is not cached", async () => {
        let n = 0;
        const { prober } = setup("", async () => {
            n += 1;
            if (n === 1) throw new Error("boom");
            return answer402();
        });
        expect(await prober.probe(target, terms, sig())).toMatchObject({ failure: "unreachable" });
        expect(await prober.probe(target, terms, sig())).toMatchObject({ ok: true });
        expect(n).toBe(2);
    });

    it("a full queue is unreachable", async () => {
        const { prober } = setup(
            "probe_concurrency = 1",
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(init.signal.reason));
                }),
        );
        const ac = new AbortController();
        const pending = Array.from({ length: 33 }, (_, i) =>
            prober.probe(
                { method: "GET", url: `https://seller.example/p${i}`, indexMatch: false },
                terms,
                ac.signal,
            ),
        );
        const last = await prober.probe(
            { method: "GET", url: "https://seller.example/p33", indexMatch: false },
            terms,
            ac.signal,
        );
        expect(last).toMatchObject({ ok: false, failure: "unreachable" });
        ac.abort();
        await Promise.all(pending);
    });
});

describe("x402Fetcher", () => {
    it("returns deps.x402Fetch when set", () => {
        const f = createSafeFetcher({ timeoutMs: 1000, rawFetch: async () => answer402() });
        expect(x402Fetcher(testDeps({ x402Fetch: f }))).toBe(f);
    });

    it("keeps one fetcher per config.x402 object", () => {
        const a = testDeps();
        expect(x402Fetcher(a)).toBe(x402Fetcher(a));
        expect(x402Fetcher(testDeps({ config: testConfig() }))).not.toBe(x402Fetcher(a));
    });
});

interface RecordedProbe {
    url: string;
    status: number;
    headers: Record<string, string>;
    body: string;
    expect: string;
    priceMicros?: number;
    recorded: boolean;
}
const probeRows = x402Fixture("probes.json") as RecordedProbe[];

describe("recorded probes", () => {
    it.each(probeRows.map((r) => [r.url, r] as const))("%s", async (_url, row) => {
        const { prober } = setup(
            "",
            async () => new Response(row.body, { status: row.status, headers: row.headers }),
        );
        const p = await prober.probe(
            { method: "GET", url: row.url, indexMatch: false },
            testTerms(),
            AbortSignal.timeout(5_000),
        );
        if (row.expect === "ok") {
            expect(p).toMatchObject({
                ok: true,
                pinnedFrom: "probe",
                priceMicros: row.priceMicros,
            });
        } else {
            expect(p).toEqual({ ok: false, at, failure: row.expect });
        }
    });

    it("holds every failure of the S 5.1 table", () => {
        const set = new Set(probeRows.map((r) => r.expect));
        for (const f of [
            "no_402",
            "version_unsupported",
            "network_unsupported",
            "flow_unsupported",
            "fee_payer_refused",
            "splits_unsupported",
            "ata_creation_unsupported",
            "payee_refused",
            "price_above_max",
            "price_above_ceiling",
        ]) {
            expect(set.has(f)).toBe(true);
        }
        expect(probeRows.filter((r) => r.recorded).length).toBeGreaterThanOrEqual(6);
    });
});
