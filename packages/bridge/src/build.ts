/**
 * Bundles the bridge into the one file that npm ships as the bugnet-mcp command.
 *
 * The stdio test builds it the same way, so the suite runs the code that ships and not only the
 * TypeScript sources.
 */
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
        banner: { js: "#!/usr/bin/env node" },
        outfile,
        logLevel: "silent",
    });
}
