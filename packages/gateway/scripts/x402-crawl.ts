/**
 * Writes hosts-seen.json, the first date each host appeared in the public x402 directories.
 * A systemd timer runs it once a day and the gateway rereads the file when it changes.
 * Only hostnames and dates are kept, never seller text.
 */
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { bodyJson, createSafeFetcher, type Fetcher } from "../src/assess/fetch.ts";
import { ConfigError, parseSettings } from "../src/config.ts";
import { jsonLog, type Log } from "../src/log.ts";
import { parseHostsSeen } from "../src/x402/index.ts";
import builtinHostsSeen from "../src/x402/hosts-seen.json" with { type: "json" };
import { parseBazaar, parsePayai } from "../src/x402/search.ts";
import { hostnamePattern } from "../src/x402/router.ts";

export const crawlPageSize = 100;
export const crawlMaxPages = 1_000; // per source, a full page that never ends fails the source
export const crawlPageMaxBytes = 8 * 1024 * 1024;
export const crawlPageTimeoutMs = 30_000;
export const crawlTimeoutMs = 25 * 60_000;
export const crawlUsage = "usage: x402-crawl -config FILE [--out FILE]";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The page's listing array (items, or resources), null when there is none
export function pageItems(json: unknown): unknown[] | null {
    if (!isObj(json)) return null;
    if (Array.isArray(json.items)) return json.items;
    return Array.isArray(json.resources) ? json.resources : null;
}

// pagination.total when it is a non-negative integer, else null
export function pageTotal(json: unknown): number | null {
    if (!isObj(json) || !isObj(json.pagination)) return null;
    const t = json.pagination.total;
    return typeof t === "number" && Number.isInteger(t) && t >= 0 ? t : null;
}

async function crawlSource(
    source: "bazaar" | "payai",
    base: string,
    fetcher: Fetcher,
    signal: AbortSignal,
    hosts: Set<string>,
): Promise<void> {
    const parse = source === "bazaar" ? parseBazaar : parsePayai;
    for (let n = 0; ; n++) {
        if (n === crawlMaxPages) throw new Error(`${source}: more than ${crawlMaxPages} pages`);
        const offset = n * crawlPageSize;
        const url = new URL(base);
        url.searchParams.set("limit", String(crawlPageSize));
        url.searchParams.set("offset", String(offset));
        const fetched = await fetcher(url.href, {
            signal,
            maxBytes: crawlPageMaxBytes,
            headers: { accept: "application/json" },
        });
        if (fetched.status !== 200) {
            throw new Error(`${source}: status ${fetched.status} at offset ${offset}`);
        }
        const json = bodyJson(fetched);
        const items = pageItems(json);
        if (items === null) throw new Error(`${source}: no listings at offset ${offset}`);
        for (const listing of parse(json)) {
            let u: URL;
            try {
                u = new URL(listing.resource);
            } catch {
                continue;
            }
            if (u.protocol === "https:" && hostnamePattern.test(u.hostname)) hosts.add(u.hostname);
        }
        const total = pageTotal(json);
        if (items.length < crawlPageSize) return;
        if (total !== null && offset + items.length >= total) return;
    }
}

// The Bazaar list is new URL("resources", cdp_search_url), PayAI's is payai_resources_url
export async function crawlHosts(
    fetcher: Fetcher,
    urls: { bazaar: string; payai: string },
    signal: AbortSignal,
): Promise<Set<string>> {
    const hosts = new Set<string>();
    await crawlSource("bazaar", urls.bazaar, fetcher, signal, hosts);
    await crawlSource("payai", urls.payai, fetcher, signal, hosts);
    return hosts;
}

// Keeps every earlier date, adds today's for new hosts
export function mergeHostsSeen(
    old: ReadonlyMap<string, string>,
    seen: ReadonlySet<string>,
    today: string,
): Map<string, string> {
    const out = new Map(old);
    for (const host of seen) {
        const have = out.get(host);
        if (have === undefined || today < have) out.set(host, today);
    }
    return out;
}

// Temp file in the same directory then rename, mode 0644
export function writeHostsSeen(path: string, hosts: ReadonlyMap<string, string>): void {
    const sorted = [...hosts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const text = JSON.stringify({ v: 1, hosts: Object.fromEntries(sorted) }, null, 4) + "\n";
    const tmp = `${path}.tmp-${process.pid}`;
    try {
        writeFileSync(tmp, text);
        chmodSync(tmp, 0o644);
        renameSync(tmp, path);
    } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
    }
}

export function parseArgs(argv: string[]): { config: string; out: string | null } {
    let config: string | null = null;
    let out: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "-config" || a === "--config") config = argv[++i] ?? null;
        else if (a === "--out") out = argv[++i] ?? null;
    }
    if (config === null) throw new ConfigError(crawlUsage);
    return { config, out };
}

const firstLine = (err: unknown): string =>
    (err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 200) ?? "";

// 0 written, 1 a source failed or the old file is unreadable (nothing written), 2 usage or settings
export async function runCrawl(
    args: { config: string; out: string | null },
    deps: { fetcher: Fetcher; today: string; log: Log; signal: AbortSignal },
): Promise<number> {
    const { log } = deps;
    let settings;
    try {
        settings = parseSettings(readFileSync(args.config, "utf8"), args.config);
    } catch (err) {
        log.error(firstLine(err));
        return 2;
    }
    const out = args.out ?? (settings.x402.hosts_seen_file || null);
    if (out === null) {
        log.error("x402.hosts_seen_file is empty, pass --out");
        return 2;
    }
    let old: Map<string, string>;
    try {
        old = existsSync(out)
            ? parseHostsSeen(JSON.parse(readFileSync(out, "utf8")))
            : parseHostsSeen(builtinHostsSeen);
    } catch {
        log.error("hosts-seen file unreadable, fix or remove it");
        return 1;
    }
    let seen: Set<string>;
    try {
        seen = await crawlHosts(
            deps.fetcher,
            {
                bazaar: new URL("resources", settings.x402.cdp_search_url).href,
                payai: settings.x402.payai_resources_url,
            },
            deps.signal,
        );
    } catch (err) {
        log.error("crawl failed", { err: firstLine(err) });
        return 1;
    }
    const merged = mergeHostsSeen(old, seen, deps.today);
    try {
        writeHostsSeen(out, merged);
    } catch (err) {
        log.error("crawl failed", { err: firstLine(err) });
        return 1;
    }
    log.info("crawl written", { hosts: merged.size, added: merged.size - old.size });
    return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const log = jsonLog("x402-crawl");
    try {
        const args = parseArgs(process.argv.slice(2));
        process.exitCode = await runCrawl(args, {
            fetcher: createSafeFetcher({ timeoutMs: crawlPageTimeoutMs }),
            today: new Date().toISOString().slice(0, 10),
            log,
            signal: AbortSignal.timeout(crawlTimeoutMs),
        });
    } catch (err) {
        log.error(firstLine(err));
        process.exitCode = 2;
    }
}
