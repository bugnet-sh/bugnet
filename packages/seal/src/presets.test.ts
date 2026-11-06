import { describe, expect, it } from "vitest";
import { canonicalHeaderNames, canonicalHosts, namePattern } from "./canonical.ts";
import { presetFor, presets, withinPreset } from "./presets.ts";

describe("presets", () => {
    it("are already canonical, since the router refuses any other form", () => {
        for (const p of presets) {
            expect(canonicalHosts(p.hosts), p.service).toEqual(p.hosts);
            expect(canonicalHeaderNames(p.headerNames), p.service).toEqual(p.headerNames);
            for (const name of p.names) expect(namePattern.test(name), name).toBe(true);
        }
    });

    it("keep GitHub's tarball host out, so public tarballs never cross Bugnet", () => {
        expect(presetFor("GH_TOKEN")?.hosts).toEqual([
            "api.github.com",
            "github.com",
            "uploads.github.com",
        ]);
    });

    it("tell a preset's own hosts from the rest", () => {
        expect(withinPreset("HF_TOKEN", ["huggingface.co"], [])).toBe(true);
        expect(withinPreset("HF_TOKEN", ["evil.example"], [])).toBe(false);
        expect(withinPreset("MY_TOKEN", ["huggingface.co"], [])).toBe(false);
    });
});
