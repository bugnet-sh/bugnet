// Packs the bridge bundle and its manifest into the Claude Desktop extension
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBridge, distMain } from "./build.ts";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(pkg, "dist", "mcpb");

rmSync(stage, { recursive: true, force: true });
await buildBridge();
mkdirSync(join(stage, "server"), { recursive: true });
cpSync(distMain, join(stage, "server", "main.js"));
// The bundle is an ES module, and a bare folder would run it as CommonJS
writeFileSync(join(stage, "server", "package.json"), '{ "type": "module" }\n');
cpSync(join(pkg, "mcpb", "manifest.json"), join(stage, "manifest.json"));
execFileSync("mcpb", ["pack", "dist/mcpb", "dist/bugnet.mcpb"], { cwd: pkg, stdio: "inherit" });
process.stdout.write("built dist/bugnet.mcpb\n");
