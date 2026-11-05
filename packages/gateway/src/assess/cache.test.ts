import { describe, expect, it } from "vitest";
import { TtlCache } from "./cache.ts";
import { urlFindings } from "./script.ts";

describe("TtlCache", () => {
    it("expires entries after the TTL", () => {
        let t = 0;
        const c = new TtlCache<string>(1000, 10, () => t);
        c.set("a", "1");
        t = 999;
        expect(c.get("a")).toBe("1");
        t = 1000;
        expect(c.get("a")).toBeUndefined();
        expect(c.size).toBe(0);
    });

    it("evicts the least recently used entry past the limit", () => {
        const c = new TtlCache<number>(60_000, 500, () => 0);
        for (let i = 0; i < 500; i++) c.set(`k${i}`, i);
        expect(c.get("k0")).toBe(0);
        c.set("k500", 500);
        expect(c.size).toBe(500);
        expect(c.get("k1")).toBeUndefined();
        expect(c.get("k0")).toBe(0);
        expect(c.get("k500")).toBe(500);
    });
});

describe("script link checks", () => {
    it("flags bare IPs, paste sites and binary downloads, not ordinary script links", () => {
        expect(urlFindings("https://45.9.12.3/x.sh").map((f) => f.id)).toEqual(["suspicious_url"]);
        expect(urlFindings("https://pastebin.com/raw/abc").map((f) => f.id)).toEqual([
            "suspicious_url",
        ]);
        expect(urlFindings("https://example.dev/releases/tool-setup.exe")).toMatchObject([
            { id: "binary_download", severity: "medium", evidence: "tool-setup.exe" },
        ]);
        expect(urlFindings("https://raw.githubusercontent.com/acme/tool/main/install.sh")).toEqual(
            [],
        );
    });
});
