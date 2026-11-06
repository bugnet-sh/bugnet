import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectTools, testDeps } from "./testing/harness.ts";

const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");

describe("README", () => {
    it("lists every gateway tool in its tools table", async () => {
        const client = await connectTools(testDeps());
        const { tools } = await client.listTools();
        expect(tools.length).toBeGreaterThan(20);
        for (const t of tools) expect(readme, t.name).toContain(`| \`${t.name}\``);
    });

    it("names the bridge and seal packages and how to install the bridge", () => {
        for (const text of [
            "| `packages/bridge`",
            "| `packages/seal`",
            "| `deploy`",
            "npx -y @bugnet/mcp",
            "~/.config/bugnet/mcp.toml",
            "packages/bridge/config/example.toml",
            "| `bugnet_secret_from_env`",
        ]) {
            expect(readme).toContain(text);
        }
    });
});
