import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectTools, testConfig, testDeps } from "./testing/harness.ts";

const root = new URL("../../../", import.meta.url);
const copies = [
    { path: "plugin/skills/run-in-sandbox/SKILL.md", prefix: "mcp__plugin_bugnet_sandbox__" },
    {
        path: "plugin-wallet/skills/run-in-sandbox/SKILL.md",
        prefix: "mcp__plugin_bugnet-wallet_sandbox__",
    },
];
const keyHeading = "## When the code needs an API key the user may not have";
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
// From a level-two heading to the next one, the heading included
function section(skill: string, heading: string): string {
    const start = skill.indexOf(`\n${heading}\n`);
    if (start < 0) return "";
    const end = skill.indexOf("\n## ", start + heading.length + 1);
    return skill.slice(start + 1, end < 0 ? undefined : end).trimEnd();
}
const allowedTools = (skill: string) =>
    (/^allowed-tools: (.+)$/m.exec(skill)?.[1] ?? "").split(", ");
const flat = (s: string) => s.replace(/\s+/g, " ");

describe.each(copies)("the run-in-sandbox skill in $path", ({ path, prefix }) => {
    const skill = read(path);

    it("keeps the API key section under 2,400 characters", () => {
        const s = section(skill, keyHeading);
        expect(
            s.startsWith(
                `${keyHeading}\n\n1. When \`bugnet_assess\` lists API keys, make the sandbox offer first, unchanged.`,
            ),
        ).toBe(true);
        expect(
            s.endsWith("the user's choice from find results, or a URL the user gave, counts."),
        ).toBe(true);
        expect(s.length).toBeLessThan(2400);
    });

    it("puts the API key section after Once they agree and before Never", () => {
        const agree = skill.indexOf("\n## Once they agree\n");
        const key = skill.indexOf(`\n${keyHeading}\n`);
        const never = skill.indexOf("\n## Never\n");
        expect(agree).toBeGreaterThan(0);
        expect(key).toBeGreaterThan(agree);
        expect(never).toBeGreaterThan(key);
    });

    it("allows the free find tool and keeps the paid budget tool behind its prompt", () => {
        const tools = allowedTools(skill);
        expect(tools).toContain(`${prefix}bugnet_x402_find`);
        expect(tools.filter((t) => t.includes("bugnet_x402_budget"))).toEqual([]);
        expect(tools).not.toContain(`${prefix}bugnet_start`);
        expect(tools).not.toContain(`${prefix}bugnet_extend`);
    });

    it("forbids copying x402 edits out without the user's yes", () => {
        expect(flat(section(skill, "## Never"))).toContain(
            "- Commit, push or copy changes that call x402 services into the user's own files without the user's yes.",
        );
    });

    it("calls the x402 placeholder no secret and keeps the secret link rule", () => {
        const never = flat(section(skill, "## Never"));
        expect(never).toContain(
            "- Put real tokens, keys or passwords in commands, env or files. The placeholder OPENAI_API_KEY=x402 from bugnet_x402_find is not a secret. Secrets need the secret link flow.",
        );
        expect(never).not.toContain("- Put tokens, keys or passwords");
    });

    it("never tells the agent to approve for the user or pass allowUnlisted", () => {
        const s = flat(section(skill, keyHeading));
        expect(s).not.toContain("allowUnlisted");
        expect(s).not.toMatch(/approve/i);
        expect(s).not.toMatch(/E2B|Boat|InstaBox/i);
    });

    it("names only tools and arguments the gateway registers", async () => {
        const client = await connectTools(
            testDeps({ config: testConfig("[x402]\nenabled = true") }),
        );
        const { tools } = await client.listTools();
        const byName = new Map(tools.map((t) => [t.name, t]));
        const s = section(skill, keyHeading);
        const named = [...s.matchAll(/`(bugnet_[a-z0-9_]+)`/g)].map((m) => m[1] as string);
        expect(named).toContain("bugnet_x402_budget");
        for (const n of named) expect(byName.has(n), n).toBe(true);
        const props = (n: string) =>
            Object.keys((byName.get(n)?.inputSchema as { properties?: object }).properties ?? {});
        expect(props("bugnet_x402_budget")).toEqual(
            expect.arrayContaining(["amountUsd", "confirmPriceUsd"]),
        );
        expect(props("bugnet_start")).toContain("x402");
        expect(props("bugnet_start")).toContain("confirmPriceUsd");
        expect(props("bugnet_x402_find")).toContain("handle");
        for (const t of allowedTools(skill).filter((t) => t.includes("x402"))) {
            expect(byName.has(t.slice(prefix.length)), t).toBe(true);
        }
    });
});

it("gives both plugins the same API key section", () => {
    const [base, wallet] = copies.map((c) => section(read(c.path), keyHeading));
    expect(wallet).toBe(base);
});
