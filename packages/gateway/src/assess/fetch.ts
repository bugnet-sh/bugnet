/**
 * Fetches public files for bugnet_assess without letting a caller reach internal hosts.
 *
 * Only https on port 443. Hostnames resolve through a lookup that refuses loopback, private,
 * link-local, CGNAT, multicast and other reserved addresses, and the socket connects to the
 * address that lookup checked, so DNS rebinding cannot slip past it. Redirects are followed by
 * hand and each target is checked again. Bodies stop at a byte cap while they stream.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, isIPv4, isIPv6, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export const userAgent = "bugnet-assess/0.1";
export const maxRedirects = 3;

export class FetchRefused extends Error {
    readonly code = "EBUGNETREFUSED";
    // Kept out of the message, since a redirect lets the source pick it
    readonly host: string | undefined;

    constructor(message: string, host?: string) {
        super(message);
        this.host = host;
    }
}

export interface FetchOptions {
    signal: AbortSignal;
    maxBytes: number;
    headers?: Record<string, string>;
    // Sent only while the request stays on the first URL's origin, so tokens never follow a redirect
    originHeaders?: Record<string, string>;
}

export interface Fetched {
    status: number;
    url: string;
    headers: Record<string, string>;
    body: Uint8Array;
    truncated: boolean;
}

export type Fetcher = (url: string, opts: FetchOptions) => Promise<Fetched>;

export type RawFetch = (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal; redirect: "manual" },
) => Promise<Response>;

export type Resolve = (
    hostname: string,
    options: { all: true; family?: number | "IPv4" | "IPv6"; hints?: number },
    callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/* Address ranges */

const v4Reserved = [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.31.196.0/24",
    "192.52.193.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "192.175.48.0/24",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
].map((cidr) => {
    const [net, bits] = cidr.split("/") as [string, string];
    return { net: v4Number(parseV4(net) as number[]), bits: Number(bits) };
});

// Special-purpose, 6to4 and documentation blocks inside global unicast
const v6Reserved: { prefix: number[]; bits: number }[] = [
    { prefix: [0x20, 0x01, 0x00, 0x00], bits: 23 },
    { prefix: [0x20, 0x01, 0x0d, 0xb8], bits: 32 },
    { prefix: [0x20, 0x02], bits: 16 },
    { prefix: [0x3f, 0xff], bits: 20 },
];

function parseV4(s: string): number[] | null {
    if (!isIPv4(s)) return null;
    return s.split(".").map(Number);
}

function v4Number(b: number[]): number {
    return (
        (((b[0] as number) << 24) |
            ((b[1] as number) << 16) |
            ((b[2] as number) << 8) |
            (b[3] as number)) >>>
        0
    );
}

function parseV6(input: string): number[] | null {
    let s = input.replace(/^\[|\]$/g, "").split("%")[0] as string;
    if (!isIPv6(s)) return null;
    let v4: number[] | null = null;
    const last = s.lastIndexOf(":");
    if (s.slice(last + 1).includes(".")) {
        v4 = parseV4(s.slice(last + 1));
        if (!v4) return null;
        s = `${s.slice(0, last + 1)}0:0`;
    }
    const halves = s.split("::");
    const groups = (part: string | undefined) => (part ? part.split(":") : []);
    const head = groups(halves[0]);
    const tail = halves.length > 1 ? groups(halves[1]) : [];
    const fill = halves.length > 1 ? 8 - head.length - tail.length : 0;
    const all = [...head, ...Array<string>(fill).fill("0"), ...tail];
    if (all.length !== 8) return null;
    const bytes = all.flatMap((g) => {
        const n = Number.parseInt(g, 16);
        return [n >> 8, n & 0xff];
    });
    if (v4) bytes.splice(12, 4, ...v4);
    return bytes;
}

function hasPrefix(bytes: number[], prefix: number[], bits: number): boolean {
    for (let i = 0; i < bits; i++) {
        const byte = i >> 3;
        const mask = 0x80 >> (i & 7);
        if (((bytes[byte] as number) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
    }
    return true;
}

// True only for addresses on the public internet, anything unparsable counts as not public
export function isPublicAddress(ip: string): boolean {
    const v4 = parseV4(ip);
    if (v4) {
        const n = v4Number(v4);
        return !v4Reserved.some((r) => (n ^ r.net) >>> (32 - r.bits) === 0);
    }
    const v6 = parseV6(ip);
    if (!v6) return false;
    const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
    if (mapped) return isPublicAddress(v6.slice(12).join("."));
    if (!hasPrefix(v6, [0x20], 3)) return false;
    return !v6Reserved.some((r) => hasPrefix(v6, r.prefix, r.bits));
}

/* Lookup and URL checks */

const systemResolve: Resolve = (hostname, options, callback) =>
    dnsLookup(hostname, options, callback);

function refused(message: string, host?: string): FetchRefused {
    return new FetchRefused(message, host);
}

// Refuses the whole name when any address is internal, so a mixed answer cannot be raced
export function guardedLookup(resolve: Resolve = systemResolve): LookupFunction {
    return (hostname, options, callback) => {
        const opts: Parameters<Resolve>[1] = { all: true };
        if (options.family) opts.family = options.family;
        if (options.hints) opts.hints = options.hints;
        resolve(hostname, opts, (err, addresses) => {
            if (err) {
                callback(err, "");
                return;
            }
            const first = addresses[0];
            if (!first || addresses.some((a) => !isPublicAddress(a.address))) {
                callback(refused("the host resolves to a non-public address", hostname), "");
                return;
            }
            if (options.all) callback(null, addresses);
            else callback(null, first.address, first.family);
        });
    };
}

export function checkUrl(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw refused("not a valid URL");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:") throw refused("only https URLs are fetched", host);
    if (url.username || url.password) throw refused("URLs with credentials are not fetched", host);
    if (url.port && url.port !== "443") {
        throw refused("only the default https port is fetched", host);
    }
    if (isIP(host) && !isPublicAddress(host)) {
        throw refused("the URL points at a non-public address", host);
    }
    url.hash = "";
    return url;
}

/* Fetching */

async function readCapped(
    body: ReadableStream<Uint8Array> | null,
    maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    if (!body) return { bytes: new Uint8Array(0), truncated: false };
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (size + value.length > maxBytes) {
                chunks.push(value.subarray(0, maxBytes - size));
                size = maxBytes;
                truncated = true;
                break;
            }
            chunks.push(value);
            size += value.length;
        }
    } finally {
        if (truncated) await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    return { bytes: new Uint8Array(Buffer.concat(chunks, size)), truncated };
}

function headerRecord(h: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    h.forEach((value, key) => {
        out[key.toLowerCase()] = value;
    });
    return out;
}

function undiciRawFetch(lookup: LookupFunction): RawFetch {
    const agent = new Agent({ connect: { lookup }, connections: 16 });
    return async (url, init) =>
        (await undiciFetch(url, { ...init, dispatcher: agent })) as unknown as Response;
}

export interface SafeFetchConfig {
    timeoutMs: number;
    resolve?: Resolve;
    rawFetch?: RawFetch;
}

export function createSafeFetcher(cfg: SafeFetchConfig): Fetcher {
    const raw = cfg.rawFetch ?? undiciRawFetch(guardedLookup(cfg.resolve));
    return async (url, opts) => {
        const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(cfg.timeoutMs)]);
        let current = checkUrl(url);
        const origin = current.origin;
        for (let hop = 0; ; hop++) {
            const headers: Record<string, string> = {
                "user-agent": userAgent,
                ...opts.headers,
                ...(current.origin === origin ? opts.originHeaders : {}),
            };
            let res: Response;
            try {
                res = await raw(current.href, { headers, signal, redirect: "manual" });
            } catch (e) {
                const cause = (e as { cause?: unknown }).cause;
                if (cause instanceof FetchRefused) throw cause;
                throw e;
            }
            const location = res.headers.get("location");
            if (res.status >= 300 && res.status < 400 && location) {
                await res.body?.cancel().catch(() => {});
                if (hop >= maxRedirects) throw refused("too many redirects");
                current = checkUrl(new URL(location, current).href);
                continue;
            }
            const { bytes, truncated } = await readCapped(res.body, opts.maxBytes);
            return {
                status: res.status,
                url: current.href,
                headers: headerRecord(res.headers),
                body: bytes,
                truncated,
            };
        }
    };
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

export function bodyText(f: Fetched): string {
    return utf8.decode(f.body);
}

export function bodyJson(f: Fetched): unknown {
    if (f.truncated) throw new Error("response over the size cap");
    return JSON.parse(bodyText(f));
}
