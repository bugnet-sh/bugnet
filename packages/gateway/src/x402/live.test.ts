import { describe, expect, it } from "vitest";
import { Budget } from "../tools/common.ts";
import { testConfig, testDeps, testTerms } from "../testing/harness.ts";
import { formatServiceLine, parseServiceLine, solanaNetwork, usdcAsset } from "./lines.ts";
import { findServices, payaiListings, refreshPayai } from "./search.ts";
import { lineLimits } from "./terms.ts";

describe.skipIf(process.env.BUGNET_LIVE_X402 !== "1")("live x402 search", () => {
    const deps = () => testDeps({ config: testConfig("[x402]\nenabled = true\n"), now: Date.now });

    it("finds chat completions through the Bazaar and live probes", async () => {
        const d = deps();
        const terms = testTerms();
        const out = await findServices(
            d,
            {
                api: "chat completions",
                keyName: "OPENAI_API_KEY",
                maxPriceMicros: 100_000,
                url: null,
                method: "POST",
            },
            terms,
            new Budget(d),
        );
        expect(out.results.length).toBeGreaterThanOrEqual(1);
        expect(out.results.length).toBeLessThanOrEqual(5);
        for (const r of out.results) {
            expect(r.url.startsWith("https:")).toBe(true);
            expect(r.priceMicros).toBeLessThanOrEqual(100_000);
            const line = formatServiceLine({
                method: r.method,
                url: r.url,
                maxMicros: r.priceMicros,
                payTo: r.payTo,
                prefix: r.prefix,
            });
            expect(parseServiceLine(line, lineLimits(terms)).ok).toBe(true);
        }
    });

    it("loads PayAI's list", { timeout: 150_000 }, async () => {
        const d = deps();
        const stop = refreshPayai(d);
        try {
            await expect
                .poll(() => payaiListings(d).ready, { timeout: 120_000, interval: 500 })
                .toBe(true);
            const { listings } = payaiListings(d);
            expect(listings.length).toBeGreaterThan(1_000);
            for (const l of listings) {
                expect(
                    l.accepts.some(
                        (a) =>
                            (a as { network?: string; asset?: string }).network === solanaNetwork &&
                            (a as { asset?: string }).asset === usdcAsset,
                    ),
                ).toBe(true);
            }
        } finally {
            stop();
        }
    });
});
