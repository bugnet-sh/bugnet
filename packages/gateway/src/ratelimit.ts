import { BlockList, isIPv4, isIPv6 } from "node:net";

export interface Rate {
    perMinute: number;
    burst: number;
}

export interface AddressLimits {
    normal: Rate;
    shared: Rate;
    // Ranges many users share, such as a hosted client's egress, which get the shared rate
    sharedRanges: readonly string[];
    // One IPv6 holder may own a /48 of /64s, so the /48 shares this multiple of the normal rate
    v6BlockMultiple: number;
}

interface Bucket {
    tokens: number;
    at: number;
    rate: Rate;
}

interface Level {
    key: string;
    rate: Rate;
}

// Past this many keys a new one may replace only a bucket that has refilled to its burst
export const maxTrackedAddresses = 10_000;

// New keys share this bucket while every tracked one is still refilling
const overflowKey = "overflow";

export function parseCidr(cidr: string): { address: string; prefix: number; v6: boolean } | null {
    const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr.trim());
    if (!m) return null;
    const address = m[1] as string;
    const prefix = Number(m[2]);
    if (isIPv4(address) && prefix <= 32) return { address, prefix, v6: false };
    if (isIPv6(address) && prefix <= 128) return { address, prefix, v6: true };
    return null;
}

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

export function isLoopbackRange(c: { address: string; prefix: number; v6: boolean }): boolean {
    const inside = loopback.check(c.address, c.v6 ? "ipv6" : "ipv4");
    return inside && c.prefix >= (c.v6 ? 128 : 8);
}

// Peers a set of CIDR ranges names, an IPv4 peer of a dual-stack listener included
export function rangeFilter(ranges: readonly string[]): (address: string | undefined) => boolean {
    const list = new BlockList();
    for (const range of ranges) {
        const c = parseCidr(range);
        if (c) list.addSubnet(c.address, c.prefix, c.v6 ? "ipv6" : "ipv4");
    }
    return (address) => {
        if (!address) return false;
        const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1] ?? address;
        if (isIPv4(v4)) return list.check(v4, "ipv4");
        return isIPv6(address) && list.check(address, "ipv6");
    };
}

function hextets(address: string): string[] | null {
    let a = address.split("%")[0] as string;
    const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
    if (v4) {
        const [b1, b2, b3, b4] = v4.slice(1).map(Number) as [number, number, number, number];
        const tail = `${((b1 << 8) | b2).toString(16)}:${((b3 << 8) | b4).toString(16)}`;
        a = a.slice(0, v4.index) + tail;
    }
    const halves = a.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
    const all = [...left, ...Array.from({ length: fill }, () => "0"), ...right];
    return all.length === 8 ? all : null;
}

function prefixKey(parts: string[], hextetCount: number): string {
    const head = parts.slice(0, hextetCount).map((h) => Number.parseInt(h, 16).toString(16));
    return `${head.join(":")}::/${hextetCount * 16}`;
}

// One IPv6 holder usually gets a whole /64, so its addresses share one bucket
export function addressKey(address: string): string {
    if (!isIPv6(address)) return address;
    const parts = hextets(address);
    return parts ? prefixKey(parts, 4) : address;
}

function refilled(b: Bucket, now: number): number {
    const perMs = b.rate.perMinute / 60_000;
    return Math.min(b.rate.burst, b.tokens + Math.max(0, now - b.at) * perMs);
}

export class AddressLimiter {
    // Kept in least recently used order, the first entry the stalest
    private readonly buckets = new Map<string, Bucket>();
    private readonly shared: (address: string) => boolean;
    private readonly block: Rate;

    constructor(private readonly limits: AddressLimits) {
        this.shared = rangeFilter(limits.sharedRanges);
        const m = limits.v6BlockMultiple;
        this.block = { perMinute: limits.normal.perMinute * m, burst: limits.normal.burst * m };
    }

    private levels(address: string): Level[] {
        if (this.shared(address)) return [{ key: `shared ${address}`, rate: this.limits.shared }];
        const parts = isIPv4(address) ? null : hextets(address);
        if (!parts) return [{ key: address, rate: this.limits.normal }];
        return [
            { key: prefixKey(parts, 4), rate: this.limits.normal },
            { key: prefixKey(parts, 3), rate: this.block },
        ];
    }

    // A full table never drops a bucket still refilling, as that would hand its owner a new burst
    private resolve(level: Level, now: number): Level {
        if (this.buckets.has(level.key) || this.buckets.size < maxTrackedAddresses) return level;
        const [staleKey, stale] = this.buckets.entries().next().value as [string, Bucket];
        if (refilled(stale, now) >= stale.rate.burst) {
            this.buckets.delete(staleKey);
            return level;
        }
        return { key: overflowKey, rate: this.limits.normal };
    }

    // Takes one token from every level, giving the milliseconds until all have one when any is empty
    take(address: string | undefined, now: number): number | null {
        if (!address || (!isIPv4(address) && !isIPv6(address))) return null;
        const resolved = new Map<string, Bucket>();
        for (const level of this.levels(address)) {
            const { key, rate } = this.resolve(level, now);
            const old = this.buckets.get(key);
            resolved.set(key, { tokens: old ? refilled(old, now) : rate.burst, at: now, rate });
        }
        const waits = [...resolved.values()].map((b) =>
            b.tokens < 1 ? Math.ceil(((1 - b.tokens) * 60_000) / b.rate.perMinute) : 0,
        );
        const wait = Math.max(...waits);
        for (const [key, b] of resolved) {
            if (wait === 0) b.tokens -= 1;
            else if (!this.buckets.has(key)) continue;
            this.buckets.delete(key);
            this.buckets.set(key, b);
        }
        return wait === 0 ? null : wait;
    }

    get tracked(): number {
        return this.buckets.size;
    }
}

export interface QuoteLimitSettings {
    quotes_per_minute: number;
    quote_burst: number;
    shared_ranges: string[];
    shared_quotes_per_minute: number;
    shared_quote_burst: number;
    quote_v6_block_multiple: number;
}

// Every MCP request builds its tools again, so the buckets live with the settings instead
const quoteLimiters = new WeakMap<QuoteLimitSettings, AddressLimiter>();

export function quoteLimiter(s: QuoteLimitSettings): AddressLimiter {
    let limiter = quoteLimiters.get(s);
    if (!limiter) {
        limiter = new AddressLimiter({
            normal: { perMinute: s.quotes_per_minute, burst: s.quote_burst },
            shared: { perMinute: s.shared_quotes_per_minute, burst: s.shared_quote_burst },
            sharedRanges: s.shared_ranges,
            v6BlockMultiple: s.quote_v6_block_multiple,
        });
        quoteLimiters.set(s, limiter);
    }
    return limiter;
}
