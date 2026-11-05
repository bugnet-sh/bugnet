import { describe, expect, it } from "vitest";
import { instructions } from "./instructions.ts";

describe("server instructions", () => {
    it("fit Claude Code's cap with a first paragraph Codex can read alone", () => {
        expect(instructions.length).toBeLessThanOrEqual(2048);
        const first = instructions.split("\n\n")[0] as string;
        expect(first.length).toBeLessThanOrEqual(512);
        for (const word of ["Bugnet", "sandbox", "before", "AI model", "unvetted code"]) {
            expect(first).toContain(word);
        }
    });

    it("name a concrete local cost for every situation family", () => {
        for (const cost of [
            "tens of GB of weights",
            "Macs have no CUDA",
            "SSH keys",
            "slow emulation",
            "a mistake hits their data",
            "hours of a busy computer",
        ]) {
            expect(instructions).toContain(cost);
        }
    });

    it("stay factual and never name infrastructure providers", () => {
        expect(instructions).not.toMatch(/\b(best|amazing|always use|you should)\b/i);
        expect(instructions).not.toMatch(/koyeb|boat|e2b|boxd|instabox|daytona/i);
        expect(instructions).toContain("Never for mining, floods, DDoS, mass scanning");
    });
});
