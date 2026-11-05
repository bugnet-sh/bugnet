import { describe, expect, it } from "vitest";
import {
    CanonicalError,
    canonicalHeaderNames,
    canonicalHost,
    canonicalHosts,
    canonicalSpec,
} from "./canonical.ts";

describe("canonicalHost", () => {
    it("lower-cases and drops one trailing dot", () => {
        expect(canonicalHost("HuggingFace.co")).toBe("huggingface.co");
        expect(canonicalHost("api.github.com.")).toBe("api.github.com");
    });

    it("turns an internationalised name into punycode", () => {
        expect(canonicalHost("Bücher.example")).toBe("xn--bcher-kva.example");
        expect(canonicalHost("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    });

    it.each([
        "https://huggingface.co",
        "huggingface.co:443",
        "huggingface.co/models",
        "user@huggingface.co",
        "*.github.com",
        "huggingface.co?x",
        "hugging face.co",
        "a.com..",
        "localhost",
        "-a.example",
        "",
        "a\u0000.example",
    ])("refuses %j", (host) => {
        expect(() => canonicalHost(host)).toThrow(CanonicalError);
    });

    it.each(["127.0.0.1", "0x7f.1", "[::1]", "10.0.0.1."])("refuses the IP literal %j", (host) => {
        expect(() => canonicalHost(host)).toThrow(CanonicalError);
    });

    it("refuses a name over 253 characters", () => {
        const long = `${"a".repeat(63)}.`.repeat(4) + "com";
        expect(() => canonicalHost(long)).toThrow(CanonicalError);
    });
});

describe("canonical lists", () => {
    it("sorts and removes duplicates as 10.2 compares sets", () => {
        expect(canonicalHosts(["b.example", "A.example", "a.example."])).toEqual([
            "a.example",
            "b.example",
        ]);
        expect(canonicalHeaderNames(["X-Api-Key", "x-api-key", "Accept"])).toEqual([
            "accept",
            "x-api-key",
        ]);
    });

    it("refuses header names that are not HTTP tokens", () => {
        expect(() => canonicalHeaderNames([":authority"])).toThrow(CanonicalError);
        expect(() => canonicalHeaderNames(["x api"])).toThrow(CanonicalError);
        expect(() => canonicalHeaderNames([""])).toThrow(CanonicalError);
    });
});

describe("canonicalSpec", () => {
    it("canonicalises hosts and headers and keeps the name", () => {
        expect(
            canonicalSpec({
                name: "ANTHROPIC_API_KEY",
                hosts: ["API.anthropic.com."],
                headerNames: ["X-API-Key"],
                fetchOnly: false,
            }),
        ).toEqual({
            name: "ANTHROPIC_API_KEY",
            hosts: ["api.anthropic.com"],
            headerNames: ["x-api-key"],
            fetchOnly: false,
        });
    });

    it("refuses a bad name and an empty host list", () => {
        const spec = { name: "HF_TOKEN", hosts: ["huggingface.co"], headerNames: [] };
        expect(() => canonicalSpec({ ...spec, name: "9X", fetchOnly: false })).toThrow(
            /not a valid secret name/,
        );
        expect(() => canonicalSpec({ ...spec, hosts: [], fetchOnly: false })).toThrow(
            /at least one host/,
        );
    });
});
