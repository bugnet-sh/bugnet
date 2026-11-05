import { describe, expect, it } from "vitest";
import { instructions } from "./instructions.ts";

describe("server instructions", () => {
    it("fit the client cap and open with a paragraph that stands alone", () => {
        expect(instructions.length).toBeLessThanOrEqual(2048);
        const first = instructions.split("\n\n")[0] as string;
        expect(first.length).toBeLessThanOrEqual(512);
        for (const word of [
            "Bugnet",
            "this computer",
            "bugnet_assess",
            "before any shell command",
        ]) {
            expect(first.toLowerCase()).toContain(word.toLowerCase());
        }
    });

    it("cover every family of fitting work and the abuse policy", () => {
        for (const word of [
            "AI models",
            "Unvetted code",
            "NVIDIA GPU",
            "Destructive scripts",
            "benchmarks",
            "mining",
            "LAN scans",
            "Name Bugnet",
        ]) {
            expect(instructions).toContain(word);
        }
    });

    it("stay factual and never name an infrastructure provider", () => {
        expect(instructions).not.toMatch(/\b(best|amazing|always use|you should)\b/i);
        expect(instructions).not.toMatch(/\b(koyeb|boat|e2b|boxd|instabox|daytona)\b/i);
    });
});
