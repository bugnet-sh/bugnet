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
}

interface Bucket {
    tokens: number;
    at: number;
}

// Past this many addresses the least recently seen bucket goes, as it has refilled the longest
export const maxTrackedAddresses = 10_000;

export function parseCidr(cidr: string): { address: string; prefix: number; v6: boolean } | null {
    const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr.trim());
    if (!m) return null;
    const address = m[1] as string;
    const prefix = Number(m[2]);
    if (isIPv4(address) && prefix <= 32) return { address, prefix, v6: false };
    if (isIPv6(address) && prefix <= 128) return { address, prefix, v6: true };
    return null;
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

// One IPv6 holder usually gets a whole /64, so its addresses share one bucket
export function addressKey(address: string): string {
    if (!isIPv6(address)) return address;
    const parts = hextets(address);
    if (!parts) return address;
    return `${parts
        .slice(0, 4)
        .map((h) => Number.parseInt(h, 16).toString(16))
        .join(":")}::/64`;
}

export class AddressLimiter {
    private readonly buckets = new Map<string, Bucket>();
    private readonly shared = new BlockList();

    constructor(private readonly limits: AddressLimits) {
        for (const range of limits.sharedRanges) {
            const c = parseCidr(range);
            if (c) this.shared.addSubnet(c.address, c.prefix, c.v6 ? "ipv6" : "ipv4");
        }
    }

    private rateFor(address: string): { rate: Rate; key: string } {
        const family = isIPv4(address) ? "ipv4" : "ipv6";
        if (this.shared.check(address, family)) {
            return { rate: this.limits.shared, key: `shared ${address}` };
        }
        return { rate: this.limits.normal, key: addressKey(address) };
    }

    // Takes one token, giving the milliseconds until one is free when the bucket is empty
    take(address: string | undefined, now: number): number | null {
        if (!address || (!isIPv4(address) && !isIPv6(address))) return null;
        const { rate, key } = this.rateFor(address);
        const perMs = rate.perMinute / 60_000;
        const old = this.buckets.get(key);
        const tokens = old
            ? Math.min(rate.burst, old.tokens + Math.max(0, now - old.at) * perMs)
            : rate.burst;
        this.buckets.delete(key);
        if (tokens < 1) {
            this.buckets.set(key, { tokens, at: now });
            return Math.ceil((1 - tokens) / perMs);
        }
        this.buckets.set(key, { tokens: tokens - 1, at: now });
        if (this.buckets.size > maxTrackedAddresses) {
            const oldest = this.buckets.keys().next().value as string;
            this.buckets.delete(oldest);
        }
        return null;
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
        });
        quoteLimiters.set(s, limiter);
    }
    return limiter;
}
