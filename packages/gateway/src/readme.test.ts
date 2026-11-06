import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectTools, testDeps } from "./testing/harness.ts";

const root = new URL("../../../", import.meta.url);
const readme = readFileSync(new URL("README.md", root), "utf8");
const contributing = readFileSync(new URL("CONTRIBUTING.md", root), "utf8");

// Users pick tools from this table, so it names exactly what the gateway serves
function toolRows(): { name: string; paid: boolean }[] {
    const section = readme.split("\n## Tools\n")[1]?.split("\n## ")[0] ?? "";
    return [...section.matchAll(/^\| `(bugnet_[a-z_]+)` +\|.*\| ([^|]+) \|$/gm)].map((m) => ({
        name: m[1] as string,
        paid: /^Paid\b/.test((m[2] as string).trim()),
    }));
}

describe("README", () => {
    it("lists every gateway tool in its tools table, once each", async () => {
        const { tools } = await (await connectTools(testDeps())).listTools();
        expect(tools.length).toBeGreaterThan(20);
        const names = toolRows().map((r) => r.name);
        expect(names.sort()).toEqual(tools.map((t) => t.name).sort());
    });

    it("marks as paid exactly the tools whose title says paid", async () => {
        const { tools } = await (await connectTools(testDeps())).listTools();
        const paid = tools.filter((t) => /\bpaid\b/i.test(t.title ?? "")).map((t) => t.name);
        expect(paid.sort()).toEqual(["bugnet_extend", "bugnet_start"]);
        const marked = toolRows()
            .filter((r) => r.paid)
            .map((r) => r.name);
        expect(marked.sort()).toEqual(paid.sort());
    });

    it("says how to install the bridge and what it adds", () => {
        for (const text of [
            "npx -y @bugnet/mcp",
            "~/.config/bugnet/mcp.toml",
            "packages/bridge/config/example.toml",
            "`bugnet_secret_from_env`",
        ]) {
            expect(readme).toContain(text);
        }
    });
});

describe("CONTRIBUTING", () => {
    it("names the bridge and seal packages in its layout", () => {
        for (const text of ["| `packages/bridge`", "| `packages/seal`", "| `deploy`"]) {
            expect(contributing).toContain(text);
        }
    });
});
