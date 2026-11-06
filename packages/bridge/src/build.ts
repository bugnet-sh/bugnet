/**
 * Bundles the bridge into the one file that npm ships as the bugnet-mcp command.
 *
 * The stdio test builds it the same way, so the suite runs the code that ships and not only the
 * TypeScript sources.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

export const distMain = join(here, "..", "dist", "main.js");

export async function buildBridge(outfile = distMain): Promise<void> {
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
