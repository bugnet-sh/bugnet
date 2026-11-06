import { buildBridge, distMain } from "./build.ts";

await buildBridge();
process.stdout.write(`built ${distMain}\n`);
