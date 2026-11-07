import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLog } from "../log.ts";
import { devTerms } from "../payments/dev.ts";
import type { X402Terms } from "../payments/port.ts";
import { recordingLog, testNow, testPayments, testTerms } from "../testing/harness.ts";
import { lineLimits, pollTerms, readTerms, termsMaxAgeMs } from "./terms.ts";

function counted(answer: () => Promise<X402Terms>) {
    let reads = 0;
    const payments = testPayments(undefined, {
        x402: {
            terms: () => {
                reads++;
                return answer();
            },
        },
    });
    return { payments, reads: () => reads };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("terms cache", () => {
    it("serves the cached terms for under five minutes, then reads again", async () => {
        let clock = testNow;
        const c = counted(async () => testTerms());
        const deps = { payments: c.payments, now: () => clock, log: silentLog };
        expect(termsMaxAgeMs).toBe(300_000);
        expect(await readTerms(deps, AbortSignal.timeout(2_000))).toEqual(testTerms());
        clock += 299_999;
        await readTerms(deps, AbortSignal.timeout(2_000));
        expect(c.reads()).toBe(1);
        clock += 1;
        await readTerms(deps, AbortSignal.timeout(2_000));
        expect(c.reads()).toBe(2);
    });

    it("shares one read between callers in flight", async () => {
        let release!: (t: X402Terms) => void;
        const c = counted(
            () =>
                new Promise((r) => {
                    release = r;
                }),
        );
        const deps = { payments: c.payments, now: () => testNow, log: silentLog };
        const both = Promise.all([
            readTerms(deps, AbortSignal.timeout(2_000)),
            readTerms(deps, AbortSignal.timeout(2_000)),
        ]);
        release(testTerms());
        expect(await both).toEqual([testTerms(), testTerms()]);
        expect(c.reads()).toBe(1);
    });

    it("answers null on a failed read and keeps no stale copy", async () => {
        let clock = testNow;
        let fail = false;
        const c = counted(async () => {
            if (fail) throw new Error("down");
            return testTerms();
        });
        const { log, lines } = recordingLog();
        const deps = { payments: c.payments, now: () => clock, log };
        await readTerms(deps, AbortSignal.timeout(2_000));
        clock += 300_000;
        fail = true;
        expect(await readTerms(deps, AbortSignal.timeout(2_000))).toBeNull();
        expect(lines.some((l) => l.includes("x402 terms unavailable"))).toBe(true);
        fail = false;
        expect(await readTerms(deps, AbortSignal.timeout(2_000))).toEqual(testTerms());
        expect(c.reads()).toBe(3);
    });

    it("polls at once and every five minutes until stopped", async () => {
        vi.useFakeTimers({ now: testNow });
        const c = counted(async () => testTerms());
        const stop = pollTerms({ payments: c.payments, now: () => Date.now(), log: silentLog });
        await vi.advanceTimersByTimeAsync(0);
        expect(c.reads()).toBe(1);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(c.reads()).toBe(2);
        stop();
        await vi.advanceTimersByTimeAsync(600_000);
        expect(c.reads()).toBe(2);
    });

    it("takes the line limits from the terms", () => {
        expect(lineLimits(testTerms({ maxPricePerCallMicros: 400_000 }))).toEqual({
            maxPriceMicros: 400_000,
            bugnetAddresses: devTerms.bugnetAddresses,
        });
    });
});
