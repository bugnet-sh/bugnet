import { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { silentLog } from "../log.ts";
import { recordingLog, testConfig, testDeps, x402Fixture } from "../testing/harness.ts";
import hostsJson from "./hosts-seen.json" with { type: "json" };
import {
    builtinIndex,
    coveringEntry,
    exactEntry,
    hostIndexed,
    hostsSeen,
    indexKeyNames,
    indexOf,
    listedEntry,
    loadIndex,
    matchIndex,
    parseHostsSeen,
    watchHostsSeen,
    apiWords,
} from "./index.ts";
import { base58Encode } from "./lines.ts";

const sample = loadIndex(x402Fixture("index-sample.json"));
const raw = x402Fixture("index-sample.json") as { v: number; services: Record<string, unknown>[] };
const svc = (i: number) => sample.services[i];

describe("the built-in index", () => {
    it("loads empty", () => {
        expect(builtinIndex).toEqual({ v: 1, services: [] });
        expect(indexOf(testDeps())).toBe(builtinIndex);
        expect(indexOf(testDeps({ x402Index: sample }))).toBe(sample);
    });

    it("gives every entry of a fixture index its computed service id", () => {
        for (const s of sample.services) expect(s.serviceId).toMatch(/^xs_[a-z2-7]{16}$/);
    });
});

describe("loadIndex", () => {
    it("computes service ids", () => {
        expect(sample.services).toHaveLength(6);
        expect(svc(0)?.serviceId).toBe("xs_w5a4htopmpzmmhos");
    });

    const second = raw.services[1] as Record<string, unknown>;
    const first = raw.services[0] as Record<string, unknown>;
    const wrap = (patch: Record<string, unknown>) => ({
        v: 1,
        services: [first, { ...second, ...patch }],
    });
    it.each<[string, Record<string, unknown>, RegExp]>([
        ["url", { url: "http://netintel.dev/embeddings" }, /^x402 index: services\[1\] url/],
        ["host", { host: "other.example" }, /^x402 index: services\[1\] host/],
        ["prefix", { prefix: "/v2/" }, /^x402 index: services\[1\] prefix/],
        [
            "payTo",
            { payTo: base58Encode(new Uint8Array(31).fill(7)) },
            /^x402 index: services\[1\] payTo/,
        ],
        ["method", { method: "PUT" }, /^x402 index: services\[1\] method/],
        ["keyNames", { keyNames: ["openai_api_key"] }, /^x402 index: services\[1\] keyNames/],
        [
            "inputFields",
            { inputFields: Array.from({ length: 11 }, (_, i) => `f${i}`) },
            /^x402 index: services\[1\] inputFields/,
        ],
        ["outputFields", { outputFields: ["bad name"] }, /^x402 index: services\[1\] outputFields/],
        ["envLines", { envLines: ["A=1", "B=2", "C=3"] }, /^x402 index: services\[1\] envLines/],
        ["reviewedAt", { reviewedAt: "2026-11-7" }, /^x402 index: services\[1\] reviewedAt/],
        [
            "serviceId",
            { serviceId: "xs_w5a4htopmpzmmhos" },
            /^x402 index: services\[1\].*serviceId/,
        ],
    ])("an entry failing %s throws with its index", (_n, patch, pattern) => {
        expect(() => loadIndex(wrap(patch))).toThrow(pattern);
    });

    it("refuses a repeated service", () => {
        expect(() => loadIndex({ v: 1, services: [first, first] })).toThrow(
            /^x402 index: services\[1\] repeats the service of services\[0\]/,
        );
    });

    it("refuses another version", () => {
        expect(() => loadIndex({ v: 2, services: [] })).toThrow(/^x402 index: v /);
    });

    it("holds only the spec's 12 fields in the file, so Payments and the router read it too", () => {
        const keys = [
            "category",
            "envLines",
            "host",
            "inputFields",
            "keyNames",
            "method",
            "name",
            "outputFields",
            "payTo",
            "prefix",
            "reviewedAt",
            "url",
        ];
        for (const s of raw.services) expect(Object.keys(s).sort()).toEqual(keys);
    });
});

describe("matching", () => {
    const payTo = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";
    const first = raw.services[0] as Record<string, unknown>;
    it("exact and listed matches need method, host and prefix, listed also payTo", () => {
        expect(exactEntry(sample, "POST", "agent402.tools", "/v1/auto/")).toBe(svc(0));
        expect(listedEntry(sample, "POST", "agent402.tools", "/v1/auto/", payTo)).toBe(svc(0));
        const other = base58Encode(new Uint8Array(32).fill(9));
        expect(listedEntry(sample, "POST", "agent402.tools", "/v1/auto/", other)).toBeNull();
        expect(exactEntry(sample, "GET", "agent402.tools", "/v1/auto/")).toBeNull();
        expect(exactEntry(sample, "POST", "agent402.tools", "/v1/metered/")).toBeNull();
        expect(hostIndexed(sample, "agent402.tools")).toBe(true);
        expect(hostIndexed(sample, "never.example")).toBe(false);
    });

    it("coveringEntry finds the prefix that covers a path", () => {
        expect(coveringEntry(sample, "POST", "agent402.tools", "/v1/auto/embeddings")).toBe(svc(0));
        expect(coveringEntry(sample, "POST", "netintel.dev", "/embeddings")).toBe(svc(1));
        expect(
            coveringEntry(sample, "POST", "agent402.tools", "/v1/metered/chat/completions"),
        ).toBeNull();
    });

    it("coveringEntry takes the longest prefix first", () => {
        const long = loadIndex({
            v: 1,
            services: [
                { ...first, prefix: "/v1/", url: "https://agent402.tools/v1/x" },
                { ...first },
            ],
        });
        expect(coveringEntry(long, "POST", "agent402.tools", "/v1/auto/chat")?.prefix).toBe(
            "/v1/auto/",
        );
    });

    it("apiWords keeps lower-case runs of three or more and drops the stop words", () => {
        expect(apiWords("Chat Completions API for the web")).toEqual(
            new Set(["chat", "completions", "web"]),
        );
        expect(apiWords("a b c").size).toBe(0);
    });

    it("matchIndex matches by key name or by a shared word", () => {
        expect(matchIndex(sample, "web search", null)).toEqual([svc(4)]);
        expect(matchIndex(sample, "speech synthesis", null)).toEqual([svc(2)]);
        expect(matchIndex(sample, "something else", "OPENAI_API_KEY")).toEqual([svc(0), svc(1)]);
        expect(matchIndex(sample, "zzz", null)).toEqual([]);
    });

    it("indexKeyNames lists every key name", () => {
        expect(indexKeyNames(sample)).toEqual(
            new Set(["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "REPLICATE_API_TOKEN", "EXA_API_KEY"]),
        );
    });
});

describe("hosts-seen", () => {
    it("parseHostsSeen reads the sample and the built-in file, and refuses bad files", () => {
        expect(parseHostsSeen(x402Fixture("hosts-seen-sample.json")).get("agent402.tools")).toBe(
            "2026-07-01",
        );
        expect(parseHostsSeen(hostsJson).size).toBe(4447);
        expect(() => parseHostsSeen({ v: 2, hosts: {} })).toThrow();
        expect(() => parseHostsSeen({ v: 1, hosts: { "a.example": "2026-1-1" } })).toThrow();
    });

    it("an empty setting reads the built-in dates and watches nothing", () => {
        const seen = hostsSeen(testConfig().x402, silentLog);
        expect(seen.firstSeen("agent402.tools")).toBe("2026-07-01");
        expect(seen.firstSeen("never.example")).toBeNull();
        expect(typeof watchHostsSeen(testConfig().x402, silentLog, 20)).toBe("function");
    });

    it("reads the file, rereads it when it changes and keeps the last good copy", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bugnet-hosts-"));
        const path = join(dir, "hosts.json");
        writeFileSync(path, '{"v":1,"hosts":{"a.example":"2026-10-01"}}');
        const settings = testConfig(`[x402]\nhosts_seen_file = "${path}"`).x402;
        const { log, lines } = recordingLog();
        const seen = hostsSeen(settings, log);
        expect(seen.firstSeen("a.example")).toBe("2026-10-01");
        const stop = watchHostsSeen(settings, log, 20);
        try {
            writeFileSync(path, '{"v":1,"hosts":{"a.example":"2026-09-01"}}');
            utimesSync(path, new Date(), new Date(Date.now() + 5_000));
            await vi.waitFor(() => expect(seen.firstSeen("a.example")).toBe("2026-09-01"));
            writeFileSync(path, "{");
            utimesSync(path, new Date(), new Date(Date.now() + 10_000));
            await vi.waitFor(() =>
                expect(lines.some((l) => l.includes("hosts-seen unreadable"))).toBe(true),
            );
            expect(seen.firstSeen("a.example")).toBe("2026-09-01");
        } finally {
            stop();
        }
    });

    it("a file that cannot be read at first falls back to the built-in dates", () => {
        const dir = mkdtempSync(join(tmpdir(), "bugnet-hosts-"));
        const settings = testConfig(
            `[x402]\nhosts_seen_file = "${join(dir, "missing.json")}"`,
        ).x402;
        const { log, lines } = recordingLog();
        expect(hostsSeen(settings, log).firstSeen("agent402.tools")).toBe("2026-07-01");
        expect(lines.filter((l) => l.includes("hosts-seen unreadable"))).toHaveLength(1);
    });
});

describe("fixtures", () => {
    it("stay under 300 KiB", () => {
        const dir = new URL("../../test/fixtures/x402/", import.meta.url);
        let total = 0;
        for (const f of readdirSync(dir, { recursive: true })) {
            total += statSync(new URL(String(f), dir)).size;
        }
        expect(total).toBeLessThanOrEqual(307_200);
    });
});
