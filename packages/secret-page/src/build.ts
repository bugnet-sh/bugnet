/**
 * Builds the secret entry page into a static bundle for the secrets route's page_dir.
 *
 * The bundle is index.html, assets/page.js, assets/page.css and assets/icon.svg, plus
 * headers.txt, the response headers the route sends with every one of them (data-plane 8.4).
 * The pinned sealing keys are built in, so neither the router nor the route can hand the page a
 * key of its own (data-plane 10.2).
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import type { PinnedKey } from "@bugnet/seal";
// Build time only, the bundle never imports it
import { isDevelopmentKey } from "@bugnet/seal/testing";

const here = dirname(fileURLToPath(import.meta.url));
const pageDir = join(here, "page");
const require = createRequire(import.meta.url);

export const headersFile = "headers.txt";

export interface BuildOptions {
    outdir: string;
    pinned: readonly PinnedKey[];
    // Pins the development key and says so on the page, for tests only
    development?: boolean;
}

export interface BuildResult {
    files: string[];
    scriptBytes: number;
}

function integrity(bytes: Uint8Array): string {
    return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}

// Release builds must never carry the development key, whose private half is in this repository
function checkPinned(opts: BuildOptions): void {
    for (const key of opts.pinned) {
        if (
            !/^[A-Za-z0-9._-]{1,100}$/.test(key.keyId) ||
            !/^[A-Za-z0-9_-]{43}$/.test(key.publicKey)
        ) {
            throw new Error(
                `pinned key ${JSON.stringify(key.keyId)} is not a key id and a base64url ` +
                    "X25519 key",
            );
        }
        if (!opts.development && (key.keyId.startsWith("dev-") || isDevelopmentKey(key))) {
            throw new Error(`pinned key ${key.keyId} is a development key, which no release pins`);
        }
    }
}

const pinnedPlugin = (opts: BuildOptions): esbuild.Plugin => ({
    name: "bugnet-pinned",
    setup(build) {
        build.onResolve({ filter: /^\.\/keys\.ts$/ }, () => ({
            path: "keys",
            namespace: "pinned",
        }));
        build.onLoad({ filter: /.*/, namespace: "pinned" }, () => ({
            loader: "js",
            contents:
                `export const pinnedKeys = ${JSON.stringify(opts.pinned)};\n` +
                `export const developmentBuild = ${opts.development === true};\n`,
        }));
    },
});

// The spec's CSP has no wasm-unsafe-eval, so the page needs the CommonJS build and its asm.js
const sodiumPlugin: esbuild.Plugin = {
    name: "bugnet-sodium",
    setup(build) {
        build.onResolve({ filter: /^libsodium-wrappers$/ }, () => ({
            path: require.resolve("libsodium-wrappers"),
        }));
        build.onResolve({ filter: /^(node:)?(crypto|fs|path)$/ }, (args) => ({
            path: args.path,
            namespace: "node-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
            loader: "js",
            contents: "module.exports = {};",
        }));
    },
};

export async function buildPage(opts: BuildOptions): Promise<BuildResult> {
    checkPinned(opts);
    const assets = join(opts.outdir, "assets");
    await rm(opts.outdir, { recursive: true, force: true });
    await mkdir(assets, { recursive: true });

    const script = await esbuild.build({
        entryPoints: [join(here, "main.ts")],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: ["es2022"],
        minify: true,
        legalComments: "eof",
        write: false,
        logLevel: "silent",
        plugins: [pinnedPlugin(opts), sodiumPlugin],
    });
    const style = await esbuild.build({
        entryPoints: [join(pageDir, "page.css")],
        bundle: true,
        minify: true,
        write: false,
        logLevel: "silent",
    });
    const js = script.outputFiles[0]?.contents;
    const css = style.outputFiles[0]?.contents;
    if (!js || !css) throw new Error("esbuild wrote no output");

    await writeFile(join(assets, "page.js"), js);
    await writeFile(join(assets, "page.css"), css);
    await copyFile(join(pageDir, "icon.svg"), join(assets, "icon.svg"));
    await copyFile(join(pageDir, headersFile), join(opts.outdir, headersFile));

    // A half-deployed bundle then fails loudly instead of pairing a page with the wrong script
    const html = (await readFile(join(pageDir, "index.html"), "utf8"))
        .replace("__PAGE_JS_INTEGRITY__", integrity(js))
        .replace("__PAGE_CSS_INTEGRITY__", integrity(css));
    if (html.includes("__PAGE_")) throw new Error("index.html has an unfilled placeholder");
    await writeFile(join(opts.outdir, "index.html"), html);

    return {
        files: ["index.html", "assets/page.js", "assets/page.css", "assets/icon.svg", headersFile],
        scriptBytes: js.length,
    };
}
