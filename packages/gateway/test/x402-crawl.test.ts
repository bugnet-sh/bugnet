import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fetched, Fetcher } from "../src/assess/fetch.ts";
import { parseHostsSeen } from "../src/x402/index.ts";
import builtin from "../src/x402/hosts-seen.json" with { type: "json" };
import { recordingLog, x402Fixture } from "../src/testing/harness.ts";
import {
    crawlHosts,
    crawlMaxPages,
    crawlUsage,
    mergeHostsSeen,
    parseArgs,
    runCrawl,
    writeHostsSeen,
} from "../scripts/x402-crawl.ts";

const urls = {
    bazaar: "https://bazaar.test/platform/v2/x402/discovery/resources",
    payai: "https://payai.test/discovery/resources",
};
const bazaarFixture = x402Fixture("crawl-bazaar-page.json") as { items: unknown[] };
const payaiFixture = x402Fixture("payai-page.json") as { items: unknown[] };

function page(
    fixture: { items: unknown[] },
    prefix: string,
    offset: number,
    n: number,
    total: number | null,
): unknown {
    const first = fixture.items[0] as Record<string, unknown>;
    const items = Array.from({ length: n }, (_, i) => ({
        ...first,
        resource: `https://${prefix}${offset + i}.example/v1/x`,
    }));
    return { ...fixture, items, pagination: { limit: 100, offset, total } };
}

type Answer = { status: number; json: unknown };

function fakeFetcher(answers: Map<string, Answer>): { fetcher: Fetcher; asked: string[] } {
    const asked: string[] = [];
    const fetcher: Fetcher = (url) => {
        asked.push(url);
        const a = answers.get(url);
        if (a === undefined) return Promise.reject(new Error(`unexpected ${url}`));
        const body = new TextEncoder().encode(JSON.stringify(a.json));
        const f: Fetched = { status: a.status, url, headers: {}, body, truncated: false };
        return Promise.resolve(f);
    };
    return { fetcher, asked };
}

const ok = (json: unknown): Answer => ({ status: 200, json });
const at = (base: string, offset: number) => `${base}?limit=100&offset=${offset}`;
const signal = () => new AbortController().signal;
const sorted = (m: ReadonlyMap<string, string>) =>
    [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

describe("crawlHosts", () => {
    it("pages each source until a short page", async () => {
        const { fetcher, asked } = fakeFetcher(
            new Map([
                [at(urls.bazaar, 0), ok(page(bazaarFixture, "b", 0, 100, null))],
                [at(urls.bazaar, 100), ok(page(bazaarFixture, "b", 100, 37, null))],
                [at(urls.payai, 0), ok(page(payaiFixture, "p", 0, 100, null))],
                [at(urls.payai, 100), ok(page(payaiFixture, "p", 100, 0, null))],
            ]),
        );
        const hosts = await crawlHosts(fetcher, urls, signal());
        expect(asked).toEqual([
            at(urls.bazaar, 0),
            at(urls.bazaar, 100),
            at(urls.payai, 0),
            at(urls.payai, 100),
        ]);
        const want = new Set<string>();
        for (let i = 0; i < 137; i++) want.add(`b${i}.example`);
        for (let i = 0; i < 100; i++) want.add(`p${i}.example`);
        expect(hosts).toEqual(want);
        expect(hosts.size).toBe(237);
    });

    it("stops at pagination.total", async () => {
        const { fetcher, asked } = fakeFetcher(
            new Map([
                [at(urls.bazaar, 0), ok(page(bazaarFixture, "b", 0, 100, 200))],
                [at(urls.bazaar, 100), ok(page(bazaarFixture, "b", 100, 100, 200))],
                [at(urls.payai, 0), ok(page(payaiFixture, "p", 0, 1, null))],
            ]),
        );
        await crawlHosts(fetcher, urls, signal());
        expect(asked).not.toContain(at(urls.bazaar, 200));
    });

    it("keeps https hosts only, as the URL parser writes them", async () => {
        const first = bazaarFixture.items[0] as Record<string, unknown>;
        const items = ["https://Mixed.Example/a", "http://plain.example/a", "not a url"].map(
            (resource) => ({ ...first, resource }),
        );
        const { fetcher } = fakeFetcher(
            new Map([
                [at(urls.bazaar, 0), ok({ items })],
                [at(urls.payai, 0), ok({ items: [] })],
            ]),
        );
        expect(await crawlHosts(fetcher, urls, signal())).toEqual(new Set(["mixed.example"]));
    });

    it("drops hostnames that fail the shared pattern", async () => {
        const first = bazaarFixture.items[0] as Record<string, unknown>;
        const items = [
            "https://ok.example/a",
            "https://under_score.example/a",
            "https://[::1]/a",
        ].map((resource) => ({ ...first, resource }));
        const { fetcher } = fakeFetcher(
            new Map([
                [at(urls.bazaar, 0), ok({ items })],
                [at(urls.payai, 0), ok({ items: [] })],
            ]),
        );
        expect(await crawlHosts(fetcher, urls, signal())).toEqual(new Set(["ok.example"]));
    });

    it("fails when a source answers an error", async () => {
        const { fetcher } = fakeFetcher(
            new Map([
                [at(urls.bazaar, 0), ok({ items: [] })],
                [at(urls.payai, 0), { status: 500, json: {} }],
            ]),
        );
        await expect(crawlHosts(fetcher, urls, signal())).rejects.toThrow(/payai/);
    });

    it("fails a source that never ends", async () => {
        const answers = new Map<string, Answer>();
        for (let n = 0; n < crawlMaxPages; n++) {
            answers.set(at(urls.bazaar, n * 100), ok(page(bazaarFixture, "b", n * 100, 100, null)));
        }
        const { fetcher, asked } = fakeFetcher(answers);
        await expect(crawlHosts(fetcher, urls, signal())).rejects.toThrow(/bazaar/);
        expect(asked.length).toBe(crawlMaxPages);
    });
});

describe("mergeHostsSeen", () => {
    it("keeps the earliest date and every old host", () => {
        const merged = mergeHostsSeen(
            new Map([
                ["a.example", "2026-09-01"],
                ["b.example", "2026-11-08"],
                ["old.example", "2026-01-02"],
            ]),
            new Set(["a.example", "b.example", "c.example"]),
            "2026-11-07",
        );
        expect(sorted(merged)).toEqual([
            ["a.example", "2026-09-01"],
            ["b.example", "2026-11-07"],
            ["c.example", "2026-11-07"],
            ["old.example", "2026-01-02"],
        ]);
    });
});

describe("writeHostsSeen", () => {
    it("writes the file whole, sorted and readable by all", () => {
        const dir = mkdtempSync(join(tmpdir(), "crawl-"));
        const p = join(dir, "hosts-seen.json");
        const map = new Map([
            ["z.example", "2026-01-01"],
            ["a.example", "2026-02-02"],
        ]);
        writeHostsSeen(p, map);
        const text = readFileSync(p, "utf8");
        expect(parseHostsSeen(JSON.parse(text))).toEqual(map);
        expect(text).toBe(
            JSON.stringify({ v: 1, hosts: Object.fromEntries(sorted(map)) }, null, 4) + "\n",
        );
        expect(statSync(p).mode & 0o777).toBe(0o644);
        expect(readdirSync(dir)).toEqual(["hosts-seen.json"]);
    });
});

describe("parseArgs", () => {
    it("reads -config and --out", () => {
        expect(parseArgs(["-config", "c.toml", "--out", "o.json"])).toEqual({
            config: "c.toml",
            out: "o.json",
        });
        expect(parseArgs(["--config", "c.toml"])).toEqual({ config: "c.toml", out: null });
        expect(() => parseArgs([])).toThrow(crawlUsage);
    });
});

function tomlIn(dir: string, hostsFile: string | null): string {
    const p = join(dir, "gateway.toml");
    const lines = [
        "[x402]",
        'cdp_search_url = "https://bazaar.test/platform/v2/x402/discovery/search"',
        'payai_resources_url = "https://payai.test/discovery/resources"',
    ];
    if (hostsFile !== null) lines.push(`hosts_seen_file = ${JSON.stringify(hostsFile)}`);
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
}

describe("runCrawl", () => {
    it("leaves the old file untouched when a source fails", async () => {
        const dir = mkdtempSync(join(tmpdir(), "crawl-"));
        const file = join(dir, "hosts-seen.json");
        writeFileSync(file, JSON.stringify({ v: 1, hosts: { "keep.example": "2026-01-01" } }));
        const before = readFileSync(file);
        const config = tomlIn(dir, file);
        const { fetcher } = fakeFetcher(
            new Map([
                [at(urls.bazaar, 0), ok({ items: [] })],
                [at(urls.payai, 0), { status: 500, json: {} }],
            ]),
        );
        const { log, lines } = recordingLog();
        const code = await runCrawl(
            { config, out: null },
            { fetcher, today: "2026-11-07", log, signal: signal() },
        );
        expect(code).toBe(1);
        expect(readFileSync(file).equals(before)).toBe(true);
        expect(readdirSync(dir).sort()).toEqual(["gateway.toml", "hosts-seen.json"]);
        expect(lines.some((l) => l.includes("crawl failed"))).toBe(true);
    });

    it("needs somewhere to write", async () => {
        const dir = mkdtempSync(join(tmpdir(), "crawl-"));
        const config = tomlIn(dir, null);
        const { fetcher, asked } = fakeFetcher(new Map());
        const { log, lines } = recordingLog();
        const code = await runCrawl(
            { config, out: null },
            { fetcher, today: "2026-11-07", log, signal: signal() },
        );
        expect(code).toBe(2);
        expect(lines.some((l) => l.includes("x402.hosts_seen_file is empty, pass --out"))).toBe(
            true,
        );
        expect(asked).toEqual([]);
    });

    it("returns 2 on a bad config", async () => {
        const { fetcher } = fakeFetcher(new Map());
        const { log } = recordingLog();
        const code = await runCrawl(
            { config: join(tmpdir(), "no-such-crawl.toml"), out: null },
            { fetcher, today: "2026-11-07", log, signal: signal() },
        );
        expect(code).toBe(2);
    });

    it("returns 1 and writes nothing when the old file is unreadable", async () => {
        const dir = mkdtempSync(join(tmpdir(), "crawl-"));
        const file = join(dir, "hosts-seen.json");
        writeFileSync(file, "{ not json");
        const config = tomlIn(dir, file);
        const { fetcher, asked } = fakeFetcher(new Map());
        const { log, lines } = recordingLog();
        const code = await runCrawl(
            { config, out: null },
            { fetcher, today: "2026-11-07", log, signal: signal() },
        );
        expect(code).toBe(1);
        expect(readFileSync(file, "utf8")).toBe("{ not json");
        expect(asked).toEqual([]);
        expect(lines.some((l) => l.includes("hosts-seen file unreadable"))).toBe(true);
    });

    it("seeds a new file from the built-in dates", async () => {
        const dir = mkdtempSync(join(tmpdir(), "crawl-"));
        const config = tomlIn(dir, null);
        const out = join(dir, "out.json");
        const known = Object.keys(builtin.hosts)[0] as string;
        const first = bazaarFixture.items[0] as Record<string, unknown>;
        const items = [`https://${known}/a`, "https://new.example/a"].map((resource) => ({
            ...first,
            resource,
        }));
        const { fetcher } = fakeFetcher(
            new Map([
                [at(urls.bazaar, 0), ok({ items })],
                [at(urls.payai, 0), ok({ items })],
            ]),
        );
        const { log, lines } = recordingLog();
        const code = await runCrawl(
            { config, out },
            { fetcher, today: "2026-11-07", log, signal: signal() },
        );
        expect(code).toBe(0);
        expect(existsSync(out)).toBe(true);
        const written = parseHostsSeen(JSON.parse(readFileSync(out, "utf8")));
        const builtinMap = parseHostsSeen(builtin);
        expect(written.get(known)).toBe(builtinMap.get(known));
        expect(written.get("new.example")).toBe("2026-11-07");
        for (const h of builtinMap.keys()) expect(written.has(h)).toBe(true);
        expect(lines.some((l) => l.includes("crawl written"))).toBe(true);
    });
});
