import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSettings } from "./config.ts";
import {
    AddressLimiter,
    addressKey,
    isLoopbackRange,
    maxTrackedAddresses,
    parseCidr,
    quoteLimiter,
    rangeFilter,
} from "./ratelimit.ts";

const limits = {
    normal: { perMinute: 6, burst: 2 },
    shared: { perMinute: 60, burst: 5 },
    sharedRanges: ["160.79.104.0/21", "2001:db8:aa::/48"],
    v6BlockMultiple: 3,
};

const tenAddress = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

function drain(l: AddressLimiter, address: string, now: number): number {
    let taken = 0;
    while (l.take(address, now) === null) taken += 1;
    return taken;
}

describe("AddressLimiter", () => {
    it("allows a burst, then gives the wait until the next token", () => {
        const l = new AddressLimiter(limits);
        expect(l.take("203.0.113.9", 0)).toBeNull();
        expect(l.take("203.0.113.9", 0)).toBeNull();
        expect(l.take("203.0.113.9", 0)).toBe(10_000);
        expect(l.take("203.0.113.9", 4_000)).toBe(6_000);
        expect(l.take("203.0.113.9", 10_000)).toBeNull();
        expect(l.take("203.0.113.9", 10_000)).toBe(10_000);
    });

    it("keeps one bucket per address", () => {
        const l = new AddressLimiter(limits);
        expect(drain(l, "203.0.113.9", 0)).toBe(2);
        expect(l.take("203.0.113.10", 0)).toBeNull();
    });

    it("refills no further than the burst", () => {
        const l = new AddressLimiter(limits);
        drain(l, "203.0.113.9", 0);
        expect(drain(l, "203.0.113.9", 3_600_000)).toBe(2);
    });

    it("gives the shared ranges their own higher limit", () => {
        const l = new AddressLimiter(limits);
        expect(drain(l, "160.79.104.1", 0)).toBe(5);
        expect(drain(l, "160.79.111.254", 0)).toBe(5);
        expect(l.take("160.79.104.1", 0)).toBe(1_000);
        expect(drain(l, "160.79.112.1", 0)).toBe(2);
        expect(drain(l, "2001:db8:aa:1::7", 0)).toBe(5);
    });

    it("counts one IPv6 /64 as one client", () => {
        const l = new AddressLimiter(limits);
        expect(l.take("2001:db8:1:2::1", 0)).toBeNull();
        expect(l.take("2001:db8:1:2:ffff:1:2:3", 0)).toBeNull();
        expect(l.take("2001:db8:1:2::9", 0)).not.toBeNull();
        expect(l.take("2001:db8:1:3::1", 0)).toBeNull();
    });

    it("leaves unknown and malformed addresses alone", () => {
        const l = new AddressLimiter({ ...limits, normal: { perMinute: 1, burst: 1 } });
        for (let i = 0; i < 5; i++) {
            expect(l.take(undefined, 0)).toBeNull();
            expect(l.take("not an address", 0)).toBeNull();
        }
        expect(l.tracked).toBe(0);
    });

    it("bounds a whole IPv6 /48 however many /64s it uses", () => {
        const l = new AddressLimiter(limits);
        let taken = 0;
        for (let i = 0; i < 1000; i++) taken += drain(l, `2001:db8:1234:${i.toString(16)}::1`, 0);
        expect(taken).toBe(limits.v6BlockMultiple * limits.normal.burst);
        expect(drain(l, "2001:db8:1235::1", 0)).toBe(limits.normal.burst);
    });

    it("refills a /48 at its multiple of the normal rate", () => {
        const l = new AddressLimiter(limits);
        for (let i = 0; i < 100; i++) drain(l, `2001:db8:1234:${i.toString(16)}::1`, 0);
        expect(drain(l, "2001:db8:1234:ffff::1", 3_000)).toBe(0);
        expect(drain(l, "2001:db8:1234:ffff::1", 4_000)).toBe(1);
    });

    it("keeps a drained bucket however many addresses pass through", () => {
        const l = new AddressLimiter(limits);
        drain(l, "198.51.100.1", 0);
        for (let i = 0; i < maxTrackedAddresses; i++) l.take(tenAddress(i), 1);
        expect(l.tracked).toBeLessThanOrEqual(maxTrackedAddresses + 1);
        expect(l.take("198.51.100.1", 2)).not.toBeNull();
    });

    it("sends new addresses to one overflow bucket while no bucket has refilled", () => {
        const l = new AddressLimiter(limits);
        for (let i = 0; i < maxTrackedAddresses; i++) l.take(tenAddress(i), 0);
        expect(drain(l, "198.51.100.1", 1)).toBe(limits.normal.burst);
        expect(l.take("198.51.100.2", 1)).not.toBeNull();
        expect(l.take("2001:db8:77::1", 1)).not.toBeNull();
    });

    it("forgets the least recently seen address once it has refilled", () => {
        const l = new AddressLimiter(limits);
        for (let i = 0; i < maxTrackedAddresses; i++) l.take(tenAddress(i), 0);
        expect(drain(l, "198.51.100.1", 20_000)).toBe(limits.normal.burst);
        expect(drain(l, "198.51.100.2", 20_000)).toBe(limits.normal.burst);
        expect(l.tracked).toBe(maxTrackedAddresses);
    });
});

describe("addressKey", () => {
    it("folds IPv6 to its /64 and keeps IPv4 whole", () => {
        expect(addressKey("2001:db8:0:5:1:2:3:4")).toBe("2001:db8:0:5::/64");
        expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
        expect(addressKey("::1")).toBe("0:0:0:0::/64");
        expect(addressKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
        expect(addressKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
        expect(addressKey("203.0.113.9")).toBe("203.0.113.9");
    });
});

describe("rangeFilter", () => {
    it("matches a dual-stack listener's IPv4 peers and refuses everything outside", () => {
        const loopback = rangeFilter(["127.0.0.1/32", "::1/128"]);
        for (const a of ["127.0.0.1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1", "::1"]) {
            expect(loopback(a), a).toBe(true);
        }
        for (const a of ["127.0.0.2", "::ffff:10.0.0.1", "10.0.0.1", "::2", "nope", undefined]) {
            expect(loopback(a), String(a)).toBe(false);
        }
        expect(isLoopbackRange({ address: "127.0.0.0", prefix: 8, v6: false })).toBe(true);
        expect(isLoopbackRange({ address: "127.0.0.0", prefix: 7, v6: false })).toBe(false);
        expect(isLoopbackRange({ address: "::", prefix: 127, v6: true })).toBe(false);
    });
});

describe("parseCidr", () => {
    it("accepts IPv4 and IPv6 ranges and refuses anything else", () => {
        expect(parseCidr("160.79.104.0/21")).toEqual({
            address: "160.79.104.0",
            prefix: 21,
            v6: false,
        });
        expect(parseCidr("2001:db8::/32")?.v6).toBe(true);
        for (const bad of ["160.79.104.0", "160.79.104.0/33", "::/129", "host/8", "1.2.3/8"]) {
            expect(parseCidr(bad)).toBeNull();
        }
    });
});

describe("quote limit settings", () => {
    it("default to claude.ai's range and match config/example.toml", () => {
        const defaults = parseSettings("").limits;
        expect(defaults.shared_ranges).toEqual(["160.79.104.0/21"]);
        const example = readFileSync(new URL("../../../config/example.toml", import.meta.url));
        expect(parseSettings(example.toString(), "example.toml").limits).toEqual(defaults);
    });

    it("refuse a range that is not CIDR", () => {
        expect(() => parseSettings('[limits]\nshared_ranges = ["160.79.104.0"]')).toThrow(
            /limits\.shared_ranges\.0: a CIDR range/,
        );
    });

    it("share one limiter per settings object", () => {
        const s = parseSettings("[limits]\nquote_burst = 1").limits;
        expect(quoteLimiter(s)).toBe(quoteLimiter(s));
        expect(quoteLimiter(s).take("203.0.113.9", 0)).toBeNull();
        expect(quoteLimiter(s).take("203.0.113.9", 0)).not.toBeNull();
        expect(quoteLimiter(parseSettings("").limits)).not.toBe(quoteLimiter(s));
    });
});
