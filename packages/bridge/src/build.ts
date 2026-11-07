// The stdio test bundles the bridge this same way, so the suite runs the file npm ships
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { pinnedKeys, type PinnedKey } from "@bugnet/seal";
import { isDevelopmentKey } from "@bugnet/seal/testing";

const here = dirname(fileURLToPath(import.meta.url));

export const distMain = join(here, "..", "dist", "main.js");

// The development key's private half is in this repository, so no release may seal to it
export function checkReleasePins(pinned: readonly PinnedKey[]): void {
    for (const key of pinned) {
        if (key.keyId.startsWith("dev-") || isDevelopmentKey(key)) {
            throw new Error(`pinned key ${key.keyId} is a development key, which no release pins`);
        }
    }
}

export async function buildBridge(outfile = distMain): Promise<void> {
    checkReleasePins(pinnedKeys);
    await esbuild.build({
        entryPoints: [join(here, "main.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        // package.json promises Node 20, so the bundle may use nothing newer
        target: "node20",
        legalComments: "none",
        // The stdio client's cross-spawn is CommonJS and requires Node's built-in modules
        banner: {
            js: '#!/usr/bin/env node\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
        },
        outfile,
        logLevel: "silent",
    });
}
