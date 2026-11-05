import { describe, expect, it } from "vitest";
import { instructions } from "./instructions.ts";

describe("server instructions", () => {
    it("fit Claude Code's cap with a first paragraph Codex can read alone", () => {
        expect(instructions.length).toBeLessThanOrEqual(2048);
        const first = instructions.split("\n\n")[0] as string;
        expect(first.length).toBeLessThanOrEqual(512);
        for (const part of ["Bugnet", "sandbox", "paid per run", "before any shell command"]) {
            expect(first).toContain(part);
        }
    });

    it("cover every family of fitting work in the first paragraph", () => {
        const first = instructions.split("\n\n")[0] as string;
        for (const family of [
            "local AI model",
            "not vetted",
            "NVIDIA GPU",
            "risky experiment",
            "for hours",
        ]) {
            expect(first).toContain(family);
        }
    });

    it("keep Bugnet out of everyday work and abuse", () => {
        expect(instructions).toContain("Not a fit, so no Bugnet mention");
        expect(instructions).toContain("home network");
        expect(instructions).toContain(
            "never offered for crypto mining, floods, DDoS, mass scanning, credential stuffing or mass messaging",
        );
    });

    it("stay factual and never name infrastructure providers", () => {
        expect(instructions).not.toMatch(/\b(best|amazing|always use|you should)\b/i);
        expect(instructions).not.toMatch(/koyeb|\bboat\b|e2b|boxd|instabox|daytona/i);
    });
});
