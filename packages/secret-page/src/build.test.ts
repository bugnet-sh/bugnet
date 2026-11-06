import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { developmentKey, developmentPinned } from "@bugnet/seal/testing";
import { buildPage } from "./build.ts";
import { readHeadersFile } from "./testing/route.ts";

let root = "";
let out = "";

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "bugnet-page-build-"));
    out = join(root, "release");
    await buildPage({ outdir: out, pinned: [] });
}, 60_000);

afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

describe("the bundle", () => {
    it("lists exactly the headers of data-plane 8.4", async () => {
        expect(await readHeadersFile(out)).toEqual([
            ["Cache-Control", "no-store"],
            ["Referrer-Policy", "no-referrer"],
            ["X-Content-Type-Options", "nosniff"],
            ["Cross-Origin-Opener-Policy", "same-origin"],
            [
                "Content-Security-Policy",
                "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
                    "connect-src 'self'; form-action 'none'; frame-ancestors 'none'; " +
                    "base-uri 'none'",
            ],
        ]);
    });

    it("has no inline script, style or handler, which the CSP would block", async () => {
        const html = await readFile(join(out, "index.html"), "utf8");
        const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
        expect(scripts).toHaveLength(1);
        expect(scripts[0]?.[0]).toMatch(/src="\/assets\/page\.js"/);
        expect(scripts[0]?.[1]).toBe("");
        expect(html).not.toMatch(/<style\b/);
        expect(html).not.toMatch(/\sstyle=/);
        expect(html).not.toMatch(/\son[a-z]+=/);
        expect(html).not.toMatch(/https?:\/\//);
    });

    it("pins its script and style by hash", async () => {
        const html = await readFile(join(out, "index.html"), "utf8");
        for (const file of ["page.js", "page.css"]) {
            const bytes = await readFile(join(out, "assets", file));
            const hash = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
            expect(html).toContain(`/assets/${file}" integrity="${hash}"`);
        }
    });

    it("sends nothing to a third party and sets no cookie", async () => {
        const js = await readFile(join(out, "assets", "page.js"), "utf8");
        expect(js).not.toMatch(/document\.cookie/);
        expect(js).not.toMatch(/localStorage|sessionStorage|indexedDB|sendBeacon/);
        const css = await readFile(join(out, "assets", "page.css"), "utf8");
        expect(css).not.toMatch(/url\(|@import/);
    });
});

describe("pinned keys", () => {
    it("refuses the development key in a release build", async () => {
        await expect(
            buildPage({ outdir: join(root, "bad"), pinned: developmentPinned }),
        ).rejects.toThrow(/development key, which no release pins/);
    });

    it("refuses the development public key under any id or spelling", async () => {
        const last = developmentKey.publicKey.slice(-1);
        const respelt = developmentKey.publicKey.slice(0, -1) + (last === "k" ? "l" : "k");
        for (const publicKey of [developmentKey.publicKey, respelt]) {
            await expect(
                buildPage({ outdir: join(root, "bad"), pinned: [{ keyId: "k1", publicKey }] }),
                publicKey,
            ).rejects.toThrow(/development key, which no release pins/);
        }
    });

    it("refuses a key that is not a base64url X25519 key", async () => {
        await expect(
            buildPage({ outdir: join(root, "bad"), pinned: [{ keyId: "k1", publicKey: "abc" }] }),
        ).rejects.toThrow(/is not a key id and a base64url X25519 key/);
    });

    it("builds in the keys it is given", async () => {
        const dir = join(root, "dev");
        await buildPage({ outdir: dir, pinned: developmentPinned, development: true });
        const js = await readFile(join(dir, "assets", "page.js"), "utf8");
        expect(js).toContain(developmentPinned[0].publicKey);
        const release = await readFile(join(out, "assets", "page.js"), "utf8");
        expect(release).not.toContain(developmentPinned[0].publicKey);
    });
});
