import { describe, expect, it } from "vitest";
import { z } from "zod";
import { otherPayTo, testPayTo } from "../testing/harness.ts";
import { x402Vector } from "../testing/vectors.ts";
import {
    base58Decode,
    base58Encode,
    defaultPrefix,
    disableId,
    envLinesFor,
    findDuplicate,
    formatServiceLine,
    hostRefused,
    isCanonicalPubkey,
    lineCut,
    lineMax,
    openAiBase,
    openAiEndings,
    parseServiceLine,
    pathRefused,
    payToShort,
    prefixRefused,
    serviceId,
    serviceIdPattern,
    serviceLine,
    serviceLinePattern,
    toMicros,
    underSuffix,
    urlParts,
    usdText,
} from "./lines.ts";

const limits = { maxPriceMicros: 500_000, bugnetAddresses: [otherPayTo] };
const chat = "https://agent402.tools/v1/auto/chat/completions";
const line = (url: string, rest = "", max = "0.01") =>
    `POST ${url} max=${max} payTo=${testPayTo}${rest}`;
const parts = (l: string) => {
    const r = parseServiceLine(l, limits);
    if (!r.ok) throw new Error(`refused ${l}`);
    return r.parts;
};
const { paths } = x402Vector("paths.json") as { paths: { path: string; ok: boolean }[] };
const refused = paths.filter((c) => !c.ok);
const passed = paths.filter((c) => c.ok);
const { cases: ids } = x402Vector("service-ids.json") as {
    cases: { method: "GET" | "POST"; host: string; prefix: string; id: string }[];
};
const { suffixes } = x402Vector("shared-hosting-suffixes.json") as { suffixes: string[] };

describe("amounts", () => {
    it("reads dollar amounts exactly in micros", () => {
        expect(toMicros("$0.10")).toBe(100_000);
        expect(toMicros("1")).toBe(1_000_000);
        expect(toMicros("0.003")).toBe(3_000);
        expect(toMicros("999.999999")).toBe(999_999_999);
        for (const bad of ["0.0000001", "1000", "1e3", "-1", " 1", "1,00"]) {
            expect(toMicros(bad)).toBeNull();
        }
    });
    it("accepts only usdText amounts, with the spec's message", () => {
        expect(usdText.safeParse("$0.10").success).toBe(true);
        for (const bad of ["0.0000001", "1000", " 1", "1,00", "$$1"]) {
            expect(usdText.safeParse(bad).error?.issues[0]?.message).toBe(
                "a dollar amount such as 0.01",
            );
        }
    });
    it("writes max= without the dollar sign", () => {
        expect([10_000, 3_000, 1_000_000, 500_000].map(lineMax)).toEqual([
            "0.01",
            "0.003",
            "1.00",
            "0.50",
        ]);
    });
});

describe("service lines", () => {
    it("parses a line from find into its parts", () => {
        const l = line(chat, " prefix=/v1/auto/");
        expect(parseServiceLine(l, limits)).toEqual({
            ok: true,
            parts: {
                line: l,
                method: "POST",
                url: chat,
                host: "agent402.tools",
                path: "/v1/auto/chat/completions",
                prefix: "/v1/auto/",
                prefixGiven: true,
                maxMicros: 10_000,
                payTo: testPayTo,
                serviceId: "xs_w5a4htopmpzmmhos",
            },
        });
    });
    it("is a plain string in the tool schema, so an approval prompt shows one line", () => {
        expect(z.toJSONSchema(serviceLine)).toMatchObject({ type: "string", maxLength: 400 });
        expect(serviceLinePattern.source).toBe(
            String.raw`^(GET|POST) (https:\/\/[a-z0-9.-]{1,253}(?:\/[!-~]*)?) max=(\d{1,3}(?:\.\d{1,6})?) payTo=([1-9A-HJ-NP-Za-km-z]{32,44})(?: prefix=(\/[!-~]{0,198}\/))?$`,
        );
    });
    it("refuses a copied line with stray spaces, a line break, a non-breaking space or quotes", () => {
        const l = line(chat);
        for (const v of [`${l} `, `${l}\n`, l.replace(" max=", "\u00a0max="), `"${l}"`]) {
            expect(serviceLine.safeParse(v).error?.issues[0]?.message).toBe(
                "a service line from bugnet_x402_find or bugnet_status; to re-price, change only max=",
            );
            expect(parseServiceLine(v, limits)).toEqual({
                ok: false,
                refusal: "malformed",
                line: v,
                host: null,
            });
        }
    });
    it.each([
        "http://agent402.tools/v1/x",
        "https://user@agent402.tools/v1/x",
        "https://agent402.tools:443/v1/x",
        "https://Agent402.tools/v1/x",
        "https://agent402.tools/v1/x?a=1",
        "https://agent402.tools/v1/x#a",
        "https://1.2.3.4/v1/x",
        "https://0x7f.1/v1/x",
        "https://2130706433/v1/x",
        "https://agent402.tools",
    ])("refuses the URL %s", (url) => {
        expect(parseServiceLine(line(url), limits)).toMatchObject({
            ok: false,
            refusal: "malformed",
        });
    });
    it("checks the URL rule on the raw text", () => {
        expect(urlParts(chat)).toEqual({
            host: "agent402.tools",
            path: "/v1/auto/chat/completions",
        });
        for (const url of [
            "https://agent402.tools/v1/x?a=1",
            "https://agent402.tools/v1/x#a",
            "https://1.2.3.4/v1/x",
            "https://0x7f.1/v1/x",
            "https://agent402.tools",
        ]) {
            expect(urlParts(url)).toBeNull();
        }
    });
    it("refuses .. although new URL would resolve it", () => {
        expect(new URL("https://agent402.tools/v1/../x").pathname).toBe("/x");
        expect(urlParts("https://agent402.tools/v1/../x")).toBeNull();
        expect(parseServiceLine(line("https://agent402.tools/v1/../x"), limits)).toMatchObject({
            ok: false,
        });
    });
    it("reads the shared path vectors, which hold every case spec 11.1 names", () => {
        for (const bit of [
            "..;",
            "%252e%252e",
            "%u002e",
            "%3b",
            "%c0%ae",
            "%ef%bc%8f",
            "%0d%0a",
            "M%C3%BCnchen",
        ]) {
            expect(
                refused.some((c) => c.path.includes(bit)),
                bit,
            ).toBe(true);
        }
        expect(refused.some((c) => c.path.endsWith("/%"))).toBe(true);
        for (const bit of ["%20", "%40"]) {
            expect(
                passed.some((c) => c.path.includes(bit)),
                bit,
            ).toBe(true);
        }
    });
    it.each(refused)("refuses the shared path vector $path", ({ path }) => {
        expect(pathRefused(path)).toBe(true);
        if (path.startsWith("/")) {
            expect(parseServiceLine(line(`https://agent402.tools${path}`), limits)).toMatchObject({
                ok: false,
                refusal: "malformed",
            });
        }
    });
    it.each(passed)("passes the shared path vector $path", ({ path }) => {
        expect(pathRefused(path)).toBe(false);
        expect(parseServiceLine(line(`https://agent402.tools${path}`), limits).ok).toBe(true);
    });
    it("checks a few gateway-only paths beside the shared ones", () => {
        for (const p of ["", "/a/%zz", "/a/%3B/b", "/a\tb", "/a\u007fb"]) {
            expect(pathRefused(p), p).toBe(true);
        }
        expect(pathRefused("/a/b~c!d$e")).toBe(false);
    });
});

describe("prefixes", () => {
    it("defaults the prefix to the path up to its last slash", () => {
        expect(defaultPrefix("/v1/auto/chat/completions")).toBe("/v1/auto/chat/");
        expect(defaultPrefix("/v1/auto/")).toBe("/v1/auto/");
        expect(defaultPrefix("/search")).toBe("/search/");
        expect(defaultPrefix("/")).toBeNull();
    });
    it("refuses a URL whose path is /", () => {
        const l = line("https://agent402.tools/");
        expect(parseServiceLine(l, limits)).toEqual({
            ok: false,
            refusal: "malformed",
            line: l,
            host: "agent402.tools",
        });
    });
    it("holds a default prefix to the same 200 characters as a given one", () => {
        expect(parts(line(`https://agent402.tools/${"a".repeat(198)}/x`)).prefix).toHaveLength(200);
        expect(
            parseServiceLine(line(`https://agent402.tools/${"a".repeat(199)}/x`), limits),
        ).toMatchObject({ ok: false, refusal: "malformed" });
    });
    it("refuses prefix=/v1//", () => {
        expect(
            parseServiceLine(line("https://agent402.tools/v1/x", " prefix=/v1//"), limits),
        ).toMatchObject({ ok: false, refusal: "malformed" });
    });
    it("takes a prefix that path plus / starts with", () => {
        expect(prefixRefused("/search/", "/search")).toBe(false);
        expect(prefixRefused("/v1/auto/", "/v1/auto/chat/completions")).toBe(false);
        expect(prefixRefused("/v2/", "/v1/x")).toBe(true);
        expect(prefixRefused("/v1/autox/", "/v1/auto")).toBe(true);
        expect(prefixRefused("//", "/x")).toBe(true);
        expect(prefixRefused(`/${"a".repeat(199)}/`, `/${"a".repeat(199)}/x`)).toBe(true);
        expect(prefixRefused("/a/;/", "/a/;/x")).toBe(true);
    });
});

describe("max and payTo", () => {
    it("refuses max=0 as malformed and a max above the terms' ceiling as max_above", () => {
        expect(parseServiceLine(line(chat, "", "0"), limits)).toMatchObject({
            ok: false,
            refusal: "malformed",
        });
        expect(parseServiceLine(line(chat, "", "0.000000"), limits)).toMatchObject({
            ok: false,
            refusal: "malformed",
        });
        const over = line(chat, "", "0.500001");
        expect(parseServiceLine(over, limits)).toEqual({
            ok: false,
            refusal: "max_above",
            line: over,
            host: "agent402.tools",
        });
        expect(parts(line(chat, "", "0.5")).maxMicros).toBe(500_000);
    });
    it("takes only canonical base58 of 32 bytes", () => {
        expect(isCanonicalPubkey(testPayTo)).toBe(true);
        expect(isCanonicalPubkey("11111111111111111111111111111111")).toBe(true);
        expect(isCanonicalPubkey("hBxVhPQ8E4i2LegsKLvezqUWNt1atk4gw3hJohmLKh")).toBe(false); // 31 bytes
        expect(isCanonicalPubkey("z".repeat(44))).toBe(false); // 33 bytes
        expect(base58Decode("0OIl")).toBeNull();
        expect(base58Encode(base58Decode(testPayTo) as Uint8Array)).toBe(testPayTo);
        for (const p of ["hBxVhPQ8E4i2LegsKLvezqUWNt1atk4gw3hJohmLKh", "z".repeat(44)]) {
            expect(parseServiceLine(`POST ${chat} max=0.01 payTo=${p}`, limits)).toMatchObject({
                ok: false,
                refusal: "malformed",
            });
        }
    });
    it("refuses a Bugnet address as payee", () => {
        const l = line(chat);
        expect(
            parseServiceLine(l, { maxPriceMicros: 500_000, bugnetAddresses: [testPayTo] }),
        ).toEqual({ ok: false, refusal: "payee", line: l, host: "agent402.tools" });
    });
    it("derives the test payees from fixed seeds", () => {
        expect(testPayTo).toBe("AoDGvVkqDmk7SbN3V1PnDpqcZMYYb6xC49uAmojhsqT8");
        expect(otherPayTo).toBe("CwfknpacFgWTjkABt47UQfds83dADbNo4x5mNXqodoie");
    });
});

describe("service ids", () => {
    it.each(ids)(
        "gives the shared vector's $id for $method $host $prefix",
        ({ method, host, prefix, id }) => {
            expect(serviceId(method, host, prefix)).toBe(id);
        },
    );
    it("checks disable ids", () => {
        expect(serviceIdPattern.source).toBe("^xs_[a-z2-7]{16}$");
        expect(disableId.safeParse("xs_w5a4htopmpzmmhos").success).toBe(true);
        expect(disableId.safeParse("xs_W5A4HTOPMPZMMHOS").error?.issues[0]?.message).toBe(
            "a service id from bugnet_status",
        );
    });
    it("finds a line that repeats a service, or one also in disable", () => {
        const a = parts(line(chat, " prefix=/v1/auto/"));
        const b = parts(line("https://agent402.tools/v1/auto/embeddings", " prefix=/v1/auto/"));
        const c = parts(`GET ${chat} max=0.01 payTo=${testPayTo} prefix=/v1/auto/`);
        expect(findDuplicate([a, b], [])).toBe(b);
        expect(findDuplicate([a], [a.serviceId])).toBe(a);
        expect(findDuplicate([a, c], ["xs_aaaaaaaaaaaaaaaa"])).toBeNull();
    });
    it("formats a line that parses back to the same service", () => {
        const s = {
            method: "POST" as const,
            url: chat,
            maxMicros: 10_000,
            payTo: testPayTo,
            prefix: "/v1/auto/",
        };
        expect(formatServiceLine(s)).toBe(
            `POST ${chat} max=0.01 payTo=${testPayTo} prefix=/v1/auto/`,
        );
        expect(formatServiceLine({ ...s, prefix: "/v1/auto/chat/" })).toBe(
            `POST ${chat} max=0.01 payTo=${testPayTo}`,
        );
        expect(parts(formatServiceLine(s))).toMatchObject(s);
    });
});

describe("hosts and env lines", () => {
    it("checks shared-hosting suffixes by label", () => {
        expect(suffixes).toHaveLength(16);
        expect(underSuffix("x.workers.dev", suffixes)).toBe(true);
        expect(underSuffix("workers.dev", suffixes)).toBe(true);
        expect(underSuffix("notworkers.dev", suffixes)).toBe(false);
    });
    it("refuses the hosts the router refuses", () => {
        for (const h of [
            "localhost",
            "example.com.",
            "a..b",
            "1.2.3.4",
            "Example.com",
            "bugnet.sh",
            "x.bugnet.sh",
            "x.acmebox.dev",
            "cloudvm.app",
        ]) {
            expect(hostRefused(h, "bugnet.sh", ["acmebox.dev", "cloudvm.app"]), h).toBe(true);
        }
        for (const h of ["agent402.tools", "xn--mnchen-3ya.de", "api.example.com"]) {
            expect(hostRefused(h, "bugnet.sh", ["acmebox.dev", "cloudvm.app"]), h).toBe(false);
        }
        expect(hostRefused("x.acmebox.dev", "bugnet.sh", [])).toBe(false);
    });
    it("gives OpenAI env lines for the OpenAI shape only", () => {
        expect(openAiEndings).toEqual([
            "/chat/completions",
            "/embeddings",
            "/audio/speech",
            "/audio/transcriptions",
            "/images/generations",
            "/models",
        ]);
        expect(envLinesFor(chat, null)).toEqual([
            "OPENAI_BASE_URL=https://agent402.tools/v1/auto",
            "OPENAI_API_KEY=x402",
        ]);
        expect(openAiBase("/v1/embeddings")).toBe("/v1");
        expect(envLinesFor("https://api.example.com/v1/search", null)).toEqual([]);
        expect(envLinesFor("https://api.example.com/models", null)).toEqual([]);
        expect(envLinesFor(chat, ["A=1", "B=2", "C=3"])).toEqual(["A=1", "B=2"]);
    });
    it("cuts lines to 80 and shows payTo as its first and last 4", () => {
        expect(lineCut("x".repeat(100))).toBe("x".repeat(80));
        expect(payToShort(testPayTo)).toBe("AoDG...sqT8");
    });
});
