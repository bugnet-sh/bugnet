import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedKeys } from "@bugnet/seal";
import { buildPage } from "./build.ts";

const outdir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const result = await buildPage({ outdir, pinned: pinnedKeys });
process.stdout.write(`built ${result.files.length} files into ${outdir}\n`);
if (pinnedKeys.length === 0) {
    process.stderr.write(
        "warning: @bugnet/seal pins no sealing key yet, so this page refuses every key the " +
            "route offers. Add the proxy's box key to packages/seal/src/pinned.ts before deploy\n",
    );
}
