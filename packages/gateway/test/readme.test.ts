import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { connectTools, testDeps } from "../src/testing/harness.ts";

// Users pick tools from this table, so it names exactly what the gateway serves
async function readmeRows(): Promise<{ name: string; paid: boolean }[]> {
    const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
    const section = readme.split("\n## Tools\n")[1]?.split("\n## ")[0] ?? "";
    return [...section.matchAll(/^\| `(bugnet_[a-z_]+)` +\|.*\| ([^|]+) \|$/gm)].map((m) => ({
        name: m[1] as string,
        paid: /^Paid\b/.test((m[2] as string).trim()),
    }));
}

describe("the README's tools table", () => {
    it("lists every tool the gateway serves, once each", async () => {
        const rows = await readmeRows();
        const { tools } = await (await connectTools(testDeps())).listTools();
        expect(rows.map((r) => r.name).sort()).toEqual(tools.map((t) => t.name).sort());
    });

    it("marks as paid exactly the tools whose title says paid", async () => {
        const rows = await readmeRows();
        const { tools } = await (await connectTools(testDeps())).listTools();
        const paid = tools.filter((t) => /\bpaid\b/i.test(t.title ?? "")).map((t) => t.name);
        expect(paid.sort()).toEqual(["bugnet_extend", "bugnet_start"]);
        expect(
            rows
                .filter((r) => r.paid)
                .map((r) => r.name)
                .sort(),
        ).toEqual(paid.sort());
    });
});
