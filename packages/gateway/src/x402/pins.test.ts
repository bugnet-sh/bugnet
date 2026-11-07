import { describe, expect, it } from "vitest";
import type { Fetcher } from "../assess/fetch.ts";
import type {
    X402Account,
    X402AccountService,
    X402ServicePin,
    X402ServiceState,
} from "../payments/port.ts";
import {
    otherPayTo,
    sellerFetch,
    testChatId,
    testChatLine,
    testChatUrl,
    testConfig,
    testDeps,
    testFeePayer,
    testPayTo,
    testTerms,
    testTtsId,
    testTtsLine,
    testTtsUrl,
    testX402Index,
    type SellerPrice,
} from "../testing/harness.ts";
import { loadIndex, type X402Index } from "./index.ts";
import {
    lineCut,
    parseServiceLine,
    serviceId,
    solanaNetwork,
    usdcAsset,
    type ServiceLineParts,
} from "./lines.ts";
import {
    allowanceDescription,
    checkAddOf,
    newServiceCount,
    orderSetup,
    planLines,
    probeLines,
    servicesAfter,
    spendUnderPrice,
    type LineChange,
    type LinePlanInput,
    type PlannedService,
} from "./pins.ts";
import { probeWords } from "./probe.ts";
import { x402Text } from "./render.ts";
import { toServiceSpec } from "./router.ts";
import { lineLimits } from "./terms.ts";

const terms = testTerms();

// Each test gets its own settings object, so the probe cache never carries over
function fresh(o: { index?: X402Index; fetch?: Fetcher } = {}) {
    const prices: Record<string, SellerPrice> = {
        [testChatUrl]: { payTo: testPayTo, amountMicros: 10_000 },
        [testTtsUrl]: { payTo: otherPayTo, amountMicros: 20_000 },
    };
    const urls: string[] = [];
    const deps = testDeps({
        config: testConfig("[x402]\nenabled = true"),
        x402Fetch: o.fetch ?? sellerFetch(prices, urls),
        x402Index: o.index ?? testX402Index(),
    });
    const plan = (p: Partial<LinePlanInput>) =>
        planLines(deps, {
            what: "x402",
            lines: [],
            disable: [],
            allowUnlisted: false,
            account: null,
            terms,
            ...p,
        });
    return { deps, prices, urls, plan };
}

function messageOf(fn: () => unknown): string {
    try {
        fn();
    } catch (e) {
        return (e as Error).message;
    }
    throw new Error("expected a refusal");
}

async function rejection(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (e) {
        return (e as Error).message;
    }
    throw new Error("expected a refusal");
}

function partsOf(line: string): ServiceLineParts {
    const p = parseServiceLine(line, lineLimits(terms));
    if (!p.ok) throw new Error(`test line refused: ${line}`);
    return p.parts;
}

function held(
    line: string,
    state: X402ServiceState = "enabled",
    patch: Partial<X402AccountService> = {},
): X402AccountService {
    const p = partsOf(line);
    return {
        serviceId: p.serviceId,
        method: p.method,
        host: p.host,
        prefix: p.prefix,
        url: p.url,
        paidPath: null,
        maxPriceMicros: p.maxMicros,
        payTo: p.payTo,
        listed: "indexed",
        state,
        ...patch,
    };
}

function accountWith(services: X402AccountService[]): X402Account {
    return {
        state: "open",
        fundedMicros: 1_000_000,
        spentMicros: 0,
        heldMicros: 0,
        leftMicros: 1_000_000,
        allowanceRoomMicros: 4_000_000,
        paidCalls: 0,
        pendingCalls: 0,
        spendPerMinuteMicros: 500_000,
        services,
    };
}

function planned(line: string, change: LineChange = "new"): PlannedService {
    return { parts: partsOf(line), listed: "indexed", indexEntry: null, held: null, change };
}

const otherLine = (i: number) =>
    `POST https://s${i}.example.com/v1/run max=0.01 payTo=${otherPayTo}`;

describe("planLines", () => {
    it("refuses a line that passes the input check but not the URL, path or prefix rules", () => {
        const { plan } = fresh();
        const line = `POST https://agent402.tools/ max=0.01 payTo=${testPayTo}`;
        expect(messageOf(() => plan({ lines: [line, testChatLine, testChatLine] }))).toBe(
            `x402: "${lineCut(line)}" is not a service line. Copy it from bugnet_x402_find or bugnet_status, and to re-price change only max=`,
        );
        // B1 refuses a default prefix over 200 characters as malformed, so the same text names it
        const deep = `POST https://agent402.tools/${"d".repeat(201)}/x max=0.01 payTo=${testPayTo}`;
        expect(messageOf(() => plan({ lines: [deep], allowUnlisted: true }))).toBe(
            `x402: "${lineCut(deep)}" is not a service line. Copy it from bugnet_x402_find or bugnet_status, and to re-price change only max=`,
        );
    });

    it("refuses max= above the terms' cap and a Bugnet payTo", () => {
        const { plan } = fresh();
        const high = testChatLine.replace("max=0.01", "max=0.500001");
        expect(messageOf(() => plan({ lines: [high] }))).toBe(
            x402Text.maxAbove("x402", { terms, line: high }),
        );
        const bugnet = testChatLine.replace(testPayTo, terms.bugnetAddresses[0] as string);
        expect(messageOf(() => plan({ lines: [bugnet] }))).toBe(
            `x402: agent402.tools did not answer with a price Bugnet can pay (${probeWords.payee_refused}), so it cannot be enabled`,
        );
    });

    it("refuses two lines with one id, and an id also in disable", () => {
        const { plan } = fresh();
        const second = testChatLine.replace("max=0.01", "max=0.02");
        expect(messageOf(() => plan({ lines: [testChatLine, second] }))).toBe(
            x402Text.duplicate("x402", { line: second }),
        );
        expect(messageOf(() => plan({ lines: [testChatLine], disable: [testChatId] }))).toBe(
            x402Text.duplicate("x402", { line: testChatLine }),
        );
    });

    it("refuses an unlisted service without allowUnlisted unless the account holds it with that payTo", () => {
        const { plan } = fresh();
        expect(messageOf(() => plan({ lines: [testTtsLine] }))).toBe(
            "x402: tts.example.com is not reviewed by Bugnet. Enable it only if the user agreed to an unreviewed service, with allowUnlisted true",
        );
        expect(plan({ lines: [testTtsLine], allowUnlisted: true })).toHaveLength(1);
        const holding = accountWith([held(testTtsLine, "enabled", { listed: "unlisted" })]);
        expect(plan({ lines: [testTtsLine], account: holding })[0]?.change).toBe("same");
        const repinned = testTtsLine.replace(otherPayTo, testPayTo);
        expect(messageOf(() => plan({ lines: [repinned], account: holding }))).toBe(
            x402Text.unlisted("x402", { host: "tts.example.com" }),
        );
    });

    it("refuses an unindexed host under a shared-hosting suffix and passes an indexed one", () => {
        const line = `POST https://bot.workers.dev/v1/chat max=0.01 payTo=${otherPayTo}`;
        expect(messageOf(() => fresh().plan({ lines: [line], allowUnlisted: true }))).toBe(
            `x402: bot.workers.dev did not answer with a price Bugnet can pay (${probeWords.shared_hosting}), so it cannot be enabled`,
        );
        const index = loadIndex({
            v: 1,
            services: [
                {
                    host: "bot.workers.dev",
                    url: "https://bot.workers.dev/v1/other",
                    method: "GET",
                    prefix: "/v1/",
                    payTo: testPayTo,
                    category: "chat",
                    keyNames: [],
                    name: "Bot",
                    inputFields: [],
                    outputFields: [],
                    envLines: [],
                    reviewedAt: "2026-11-01",
                },
            ],
        });
        const ok = fresh({ index }).plan({ lines: [line], allowUnlisted: true });
        expect(ok[0]?.parts.host).toBe("bot.workers.dev");
    });

    it("checks in order: parse, duplicate, unlisted, shared hosting", () => {
        const { plan } = fresh();
        const bad = `POST https://agent402.tools/ max=0.01 payTo=${testPayTo}`;
        expect(messageOf(() => plan({ lines: [testChatLine, bad, testChatLine] }))).toBe(
            x402Text.malformed("x402", { line: bad }),
        );
        expect(messageOf(() => plan({ lines: [testTtsLine, testTtsLine] }))).toBe(
            x402Text.duplicate("x402", { line: testTtsLine }),
        );
        const shared = `POST https://bot.workers.dev/v1/chat max=0.01 payTo=${otherPayTo}`;
        expect(messageOf(() => plan({ lines: [shared, testTtsLine] }))).toBe(
            x402Text.unlisted("x402", { host: "bot.workers.dev" }),
        );
    });

    it("classifies each line against the account", () => {
        const { plan } = fresh();
        const change = (account: X402Account | null) =>
            plan({ lines: [testChatLine], account, allowUnlisted: true })[0]?.change;
        expect(change(null)).toBe("new");
        expect(change(accountWith([held(testChatLine, "enabled", { payTo: otherPayTo })]))).toBe(
            "repin",
        );
        expect(
            change(accountWith([held(testChatLine, "enabled", { maxPriceMicros: 20_000 })])),
        ).toBe("reprice");
        expect(change(accountWith([held(testChatLine, "disabled")]))).toBe("reenable");
        expect(change(accountWith([held(testChatLine)]))).toBe("same");
        const holding = accountWith([held(testChatLine)]);
        expect(plan({ lines: [testChatLine], account: holding })[0]?.held).toEqual(
            holding.services[0],
        );
    });

    it("marks a line indexed only when method, host, prefix and payTo all match", () => {
        const { plan } = fresh();
        const [indexed] = plan({ lines: [testChatLine] });
        expect(indexed?.listed).toBe("indexed");
        expect(indexed?.indexEntry?.serviceId).toBe(testChatId);
        const other = testChatLine.replace(testPayTo, otherPayTo);
        const [unlisted] = plan({ lines: [other], allowUnlisted: true });
        expect(unlisted?.listed).toBe("unlisted");
        expect(unlisted?.indexEntry?.serviceId).toBe(testChatId);
    });
});

describe("probeLines", () => {
    it("probes every changed service at once and leaves out the same ones", async () => {
        const one = fresh();
        const pins = await probeLines(
            one.deps,
            [planned(testChatLine), planned(testTtsLine, "same")],
            terms,
            "x402",
            AbortSignal.timeout(5_000),
        );
        expect(one.urls).toEqual([testChatUrl]);
        expect(pins.map((p) => p.serviceId)).toEqual([testChatId]);

        // Each answer waits until both requests arrived, so a probe made after another never ends
        const arrived: string[] = [];
        let release: () => void = () => {};
        const both = new Promise<void>((resolve) => (release = resolve));
        const inner = sellerFetch({
            [testChatUrl]: { payTo: testPayTo, amountMicros: 10_000 },
            [testTtsUrl]: { payTo: otherPayTo, amountMicros: 20_000 },
        });
        const gated: Fetcher = async (url, opts) => {
            arrived.push(url);
            if (arrived.length === 2) release();
            await both;
            return inner(url, opts);
        };
        const two = fresh({ fetch: gated });
        const tts = { ...planned(testTtsLine), listed: "unlisted" as const };
        const both2 = await probeLines(
            two.deps,
            [planned(testChatLine), tts],
            terms,
            "x402",
            AbortSignal.timeout(5_000),
        );
        expect(both2.map((p) => p.serviceId)).toEqual([testChatId, testTtsId]);
        expect(new Set(arrived)).toEqual(new Set([testChatUrl, testTtsUrl]));
    });

    it("pins the probe's chosen entry unmodified", async () => {
        const { deps } = fresh();
        const [pin] = await probeLines(
            deps,
            [planned(testChatLine)],
            terms,
            "x402",
            AbortSignal.timeout(5_000),
        );
        expect(pin).toEqual({
            serviceId: testChatId,
            method: "POST",
            host: "agent402.tools",
            prefix: "/v1/auto/",
            url: testChatUrl,
            maxPriceMicros: 10_000,
            payTo: testPayTo,
            listed: "indexed",
            pinnedFrom: "probe",
            probe: {
                at: expect.any(String),
                status: 402,
                accepted: {
                    scheme: "exact",
                    network: solanaNetwork,
                    asset: usdcAsset,
                    amount: "10000",
                    payTo: testPayTo,
                    maxTimeoutSeconds: 60,
                    extra: { feePayer: testFeePayer },
                },
            },
        } satisfies X402ServicePin);
    });

    it("refuses a changed payTo, a price above max= and a failed probe, naming the host", async () => {
        const run = (prices: Record<string, SellerPrice>, what: "x402" | "start" = "x402") => {
            const f = fresh({ fetch: sellerFetch(prices) });
            return rejection(
                probeLines(
                    f.deps,
                    [planned(testChatLine)],
                    terms,
                    what,
                    AbortSignal.timeout(5_000),
                ),
            );
        };
        expect(await run({ [testChatUrl]: { payTo: otherPayTo, amountMicros: 10_000 } })).toBe(
            x402Text.payToChanged("x402", {
                host: "agent402.tools",
                livePayTo: otherPayTo,
                linePayTo: testPayTo,
            }),
        );
        expect(await run({ [testChatUrl]: { payTo: testPayTo, amountMicros: 20_000 } })).toBe(
            x402Text.livePriceAbove("x402", {
                host: "agent402.tools",
                liveMicros: 20_000,
                maxMicros: 10_000,
            }),
        );
        const unindexed = fresh({
            fetch: sellerFetch({}),
            index: loadIndex({ v: 1, services: [] }),
        });
        expect(
            await rejection(
                probeLines(
                    unindexed.deps,
                    [planned(testChatLine)],
                    terms,
                    "x402",
                    AbortSignal.timeout(5_000),
                ),
            ),
        ).toBe(x402Text.probeFailed("x402", { host: "agent402.tools", words: probeWords.no_402 }));
        expect(
            await run({ [testChatUrl]: { payTo: otherPayTo, amountMicros: 10_000 } }, "start"),
        ).toMatch(/^start: agent402\.tools now pays a different address/);
    });

    it("pins from the index for a POST that does not answer 402 on an exact entry", async () => {
        const f = fresh({ fetch: sellerFetch({}) });
        const [p] = f.plan({ lines: [testChatLine] });
        const [pin] = await probeLines(
            f.deps,
            [p as PlannedService],
            terms,
            "x402",
            AbortSignal.timeout(5_000),
        );
        expect(pin?.pinnedFrom).toBe("index");
        expect(pin?.probe).toEqual({ at: expect.any(String), status: 404, accepted: null });
        expect(pin?.payTo).toBe(testPayTo);
        expect(pin?.maxPriceMicros).toBe(10_000);
    });
});

describe("plan helpers", () => {
    it("builds CheckX402's add from the changed lines", () => {
        const chat = planned(testChatLine);
        const tts = { ...planned(testTtsLine), listed: "unlisted" as const };
        const same = planned(otherLine(1), "same");
        expect(checkAddOf([chat, tts, same])).toEqual([
            toServiceSpec(chat.parts, true),
            toServiceSpec(tts.parts, false),
        ]);
    });

    it("counts new and repinned services", () => {
        const changes: LineChange[] = ["new", "repin", "reprice", "reenable", "same"];
        expect(newServiceCount(changes.map((c, i) => planned(otherLine(i), c)))).toBe(2);
    });

    it("counts the services left not disabled", () => {
        const five = [1, 2, 3, 4, 5].map((i) => held(otherLine(i)));
        const account = accountWith([...five, held(otherLine(6), "disabled")]);
        expect(servicesAfter(account, [planned(testChatLine)], [])).toBe(6);
        expect(
            servicesAfter(account, [planned(testChatLine)], [five[0]?.serviceId as string]),
        ).toBe(5);
        const repriced = planned(otherLine(1).replace("max=0.01", "max=0.02"), "reprice");
        expect(servicesAfter(account, [repriced], [])).toBe(5);
        expect(servicesAfter(null, [], [])).toBe(0);
    });

    it("finds the highest max a minute limit is under", () => {
        const high = planned(testChatLine.replace("max=0.01", "max=0.20"));
        expect(spendUnderPrice(100_000, null, [high], [])).toEqual({
            host: "agent402.tools",
            maxMicros: 200_000,
        });
        expect(spendUnderPrice(100_000, null, [high], [testChatId])).toBeNull();
        const disabled = accountWith([
            held(testTtsLine.replace("max=0.02", "max=0.30"), "disabled"),
        ]);
        expect(spendUnderPrice(100_000, disabled, [], [])).toBeNull();
        const holding = accountWith([held(testChatLine.replace("max=0.01", "max=0.30"))]);
        expect(spendUnderPrice(100_000, holding, [], [])).toEqual({
            host: "agent402.tools",
            maxMicros: 300_000,
        });
        expect(
            spendUnderPrice(100_000, holding, [planned(testChatLine, "reprice")], []),
        ).toBeNull();
        expect(spendUnderPrice(200_000, null, [high], [])).toBeNull();
        const tie = planned(testTtsLine.replace("max=0.02", "max=0.20"));
        expect(spendUnderPrice(100_000, null, [high, tie], [])?.host).toBe("agent402.tools");
    });

    it("sends only what the call changes", () => {
        expect(orderSetup([], [], undefined)).toEqual({});
        const pin = { serviceId: testChatId } as X402ServicePin;
        expect(orderSetup([pin], [testTtsId], 2_000_000)).toEqual({
            services: [pin],
            disable: [testTtsId],
            spendPerMinuteMicros: 2_000_000,
        });
    });

    it("describes an allowance and its services", () => {
        const chatPin = {
            host: "agent402.tools",
            prefix: "/v1/auto/",
            maxPriceMicros: 10_000,
        } as X402ServicePin;
        const ttsPin = {
            host: "tts.example.com",
            prefix: "/v1/",
            maxPriceMicros: 20_000,
        } as X402ServicePin;
        expect(allowanceDescription(1_000_000, 3_000, [chatPin])).toBe(
            "x402 $1.00 + $0.003 fee: agent402.tools/v1/auto/ up to $0.01",
        );
        expect(allowanceDescription(500_000, 0, [])).toBe("x402 $0.50");
        expect(allowanceDescription(500_000, 0, [chatPin, ttsPin])).toBe(
            "x402 $0.50: agent402.tools/v1/auto/ up to $0.01, tts.example.com/v1/ up to $0.02",
        );
    });
});

it("keeps service ids distinct across the helper lines", () => {
    const ids = [1, 2, 3, 4, 5, 6].map((i) => partsOf(otherLine(i)).serviceId);
    expect(new Set(ids).size).toBe(6);
    expect(ids[0]).toBe(serviceId("POST", "s1.example.com", "/v1/"));
});
