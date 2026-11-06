import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { developmentKey } from "@bugnet/seal/testing";
import { buildBridge, checkReleasePins } from "./build.ts";

let dir = "";

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bugnet-bridge-build-"));
});

afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
});

describe("the bridge bundle", () => {
    it("refuses the development key pinned under any id", () => {
        for (const keyId of ["k1", developmentKey.keyId]) {
            const pinned = [{ keyId, publicKey: developmentKey.publicKey }];
            expect(() => checkReleasePins(pinned), keyId).toThrow(
                /development key, which no release pins/,
            );
        }
        expect(() => checkReleasePins([])).not.toThrow();
    });

    it("builds with the release pins and leaves the development key out", async () => {
        const out = join(dir, "main.js");
        await buildBridge(out);
        const js = await readFile(out, "utf8");
        expect(js.startsWith("#!/usr/bin/env node\n")).toBe(true);
        expect(js).not.toContain(developmentKey.publicKey);
        expect(js).not.toContain(developmentKey.privateKey);
    }, 60_000);
});
