import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { z } from "zod";
import type { X402Settings } from "../config.ts";
import type { Log } from "../log.ts";
import type { Deps } from "../tools/common.ts";
import hostsJson from "./hosts-seen.json" with { type: "json" };
import indexJson from "./index.json" with { type: "json" };
import { keyNamePattern } from "./keys.ts";
import { isCanonicalPubkey, prefixRefused, serviceId, urlParts, type X402Method } from "./lines.ts";

export interface IndexEntry {
    host: string;
    url: string;
    method: X402Method;
    prefix: string;
    payTo: string;
    category: string;
    keyNames: string[];
    name: string;
    inputFields: string[];
    outputFields: string[];
    envLines: string[];
    reviewedAt: string;
    serviceId: string;
}

export interface X402Index {
    v: 1;
    services: readonly IndexEntry[];
}

const fieldName = z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/);
const date = /^\d{4}-\d{2}-\d{2}$/;

const entrySchema = z
    .object({
        host: z.string().min(1).max(253),
        url: z.string().max(300),
        method: z.enum(["GET", "POST"]),
        prefix: z.string().max(200),
        payTo: z.string().max(44),
        category: z.string().regex(/^[a-z0-9 -]{1,40}$/),
        keyNames: z.array(z.string().regex(keyNamePattern)).max(10),
        name: z.string().min(1).max(60),
        inputFields: z.array(fieldName).max(10),
        outputFields: z.array(fieldName).max(10),
        envLines: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}=[!-~]{1,300}$/)).max(2),
        reviewedAt: z.string().regex(date),
    })
    .strict();

const indexSchema = z.object({ v: z.literal(1), services: z.array(entrySchema).max(500) }).strict();

export function loadIndex(json: unknown): X402Index {
    const parsed = indexSchema.safeParse(json);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = (issue?.path ?? []).map(String);
        const message = issue?.message ?? "is invalid";
        if (path[0] === "services" && path[1] !== undefined) {
            const rest = path.slice(2).join(".");
            throw new Error(`x402 index: services[${path[1]}] ${rest ? rest + " " : ""}${message}`);
        }
        throw new Error(`x402 index: ${path.join(".")} ${message}`);
    }
    const seen = new Map<string, number>();
    const services = parsed.data.services.map((e, i): IndexEntry => {
        const at = `x402 index: services[${i}]`;
        const parts = urlParts(e.url);
        if (parts === null) throw new Error(`${at} url is not a URL Bugnet pays`);
        if (parts.host !== e.host) throw new Error(`${at} host does not match its url`);
        if (prefixRefused(e.prefix, parts.path)) {
            throw new Error(`${at} prefix does not cover its url path`);
        }
        if (!isCanonicalPubkey(e.payTo)) throw new Error(`${at} payTo is not a canonical address`);
        const id = serviceId(e.method, e.host, e.prefix);
        const earlier = seen.get(id);
        if (earlier !== undefined) {
            throw new Error(`${at} repeats the service of services[${earlier}]`);
        }
        seen.set(id, i);
        return { ...e, serviceId: id };
    });
    return { v: 1, services };
}

export const builtinIndex: X402Index = loadIndex(indexJson);

export function indexOf(deps: Pick<Deps, "x402Index">): X402Index {
    return deps.x402Index ?? builtinIndex;
}

export function exactEntry(
    index: X402Index,
    method: X402Method,
    host: string,
    prefix: string,
): IndexEntry | null {
    return (
        index.services.find((e) => e.method === method && e.host === host && e.prefix === prefix) ??
        null
    );
}

export function listedEntry(
    index: X402Index,
    method: X402Method,
    host: string,
    prefix: string,
    payTo: string,
): IndexEntry | null {
    const e = exactEntry(index, method, host, prefix);
    return e !== null && e.payTo === payTo ? e : null;
}

// The entry with this method and host whose prefix covers path, the longest prefix first
export function coveringEntry(
    index: X402Index,
    method: X402Method,
    host: string,
    path: string,
): IndexEntry | null {
    let best: IndexEntry | null = null;
    for (const e of index.services) {
        if (e.method !== method || e.host !== host || prefixRefused(e.prefix, path)) continue;
        if (best === null || e.prefix.length > best.prefix.length) best = e;
    }
    return best;
}

export function hostIndexed(index: X402Index, host: string): boolean {
    return index.services.some((e) => e.host === host);
}

// Without these, "api" in a query matches every seller that calls itself an API
const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "api",
    "apis",
    "http",
    "https",
    "www",
    "com",
]);

export function apiWords(text: string): Set<string> {
    const out = new Set<string>();
    for (const m of text.toLowerCase().matchAll(/[a-z0-9]{3,}/g)) {
        if (!stopWords.has(m[0])) out.add(m[0]);
    }
    return out;
}

export function matchIndex(index: X402Index, api: string, keyName: string | null): IndexEntry[] {
    const want = apiWords(api);
    return index.services.filter((e) => {
        if (keyName !== null && e.keyNames.includes(keyName)) return true;
        const have = apiWords([e.name, e.category, ...e.inputFields, ...e.outputFields].join(" "));
        for (const w of have) if (want.has(w)) return true;
        return false;
    });
}

export function indexKeyNames(index: X402Index): ReadonlySet<string> {
    return new Set(index.services.flatMap((e) => e.keyNames));
}

export interface HostsSeen {
    firstSeen(host: string): string | null;
}

const hostsSchema = z
    .object({
        v: z.literal(1),
        hosts: z.record(z.string().min(1).max(253), z.string().regex(date)),
    })
    .strict();

export function parseHostsSeen(json: unknown): Map<string, string> {
    return new Map(Object.entries(hostsSchema.parse(json).hosts));
}

let builtinHosts: Map<string, string> | null = null;
function builtinDates(): Map<string, string> {
    return (builtinHosts ??= parseHostsSeen(hostsJson));
}

interface HostsState {
    map: Map<string, string>;
}
const states = new WeakMap<X402Settings, HostsState>();

function readFile(settings: X402Settings, log: Log): Map<string, string> | null {
    try {
        return parseHostsSeen(JSON.parse(readFileSync(settings.hosts_seen_file, "utf8")));
    } catch {
        log.warn("hosts-seen unreadable", { file: settings.hosts_seen_file });
        return null;
    }
}

function stateOf(settings: X402Settings, log: Log): HostsState {
    let s = states.get(settings);
    if (s === undefined) {
        const map = settings.hosts_seen_file === "" ? null : readFile(settings, log);
        s = { map: map ?? builtinDates() };
        states.set(settings, s);
    }
    return s;
}

export function hostsSeen(settings: X402Settings, log: Log): HostsSeen {
    const state = stateOf(settings, log);
    return { firstSeen: (host) => state.map.get(host) ?? null };
}

export function watchHostsSeen(settings: X402Settings, log: Log, intervalMs = 60_000): () => void {
    const file = settings.hosts_seen_file;
    if (file === "") return () => {};
    const state = stateOf(settings, log);
    const listener = (curr: { mtimeMs: number }, prev: { mtimeMs: number }) => {
        if (curr.mtimeMs === prev.mtimeMs) return;
        const next = readFile(settings, log);
        if (next !== null) state.map = next;
    };
    watchFile(file, { interval: intervalMs, persistent: false }, listener);
    return () => unwatchFile(file, listener);
}
