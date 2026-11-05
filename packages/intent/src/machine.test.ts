import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gatherFacts } from "./machine.ts";

function home(dirs: string[]): string {
    const h = mkdtempSync(join(tmpdir(), "bugnet-home-"));
    for (const d of dirs) {
        if (d.startsWith(".npmrc")) writeFileSync(join(h, d), "");
        else mkdirSync(join(h, d), { recursive: true });
    }
    return h;
}

describe("gatherFacts", () => {
    it("reads memory, cores and disk, and knows a Mac has no NVIDIA GPU", () => {
        const h = home([]);
        const f = gatherFacts("darwin", "arm64", h, h);
        expect(f.os).toBe("macos");
        expect(f.arch).toBe("arm64");
        expect(f.nvidia).toBe(false);
        expect(f.ramGiB).toBeGreaterThan(0);
        expect(f.cores).toBeGreaterThan(0);
        expect(f.freeDiskGiB).not.toBeNull();
        expect(f.usedDiskGiB).not.toBeNull();
    });

    it("lists only the credential folders that exist, without reading them", () => {
        const h = home([".ssh", ".config/gcloud", ".npmrc"]);
        expect(gatherFacts("linux", "x64", h, h).secrets).toEqual([
            ".ssh",
            ".config/gcloud",
            ".npmrc",
        ]);
        expect(gatherFacts("linux", "x64", h, "").secrets).toEqual([]);
    });

    it("leaves the NVIDIA driver unknown on Windows", () => {
        const h = home([]);
        const f = gatherFacts("win32", "x64", h, h);
        expect(f.os).toBe("windows");
        expect(f.nvidia).toBeNull();
    });

    it("falls back to the home folder when the working folder is gone", () => {
        const h = home([]);
        const f = gatherFacts("darwin", "arm64", join(h, "missing"), h);
        expect(f.freeDiskGiB).not.toBeNull();
    });
});
