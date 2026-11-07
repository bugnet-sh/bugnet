import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const text = (p: string) => readFileSync(new URL(p, root), "utf8");
// eslint's no-explicit-any is on, so each read names the shape it needs
const json = <T>(p: string) => JSON.parse(text(p)) as T;
interface PluginJson {
    name: string;
    displayName?: string;
    version: string;
    keywords: string[];
}
interface Hooks {
    hooks: { PostToolUse: { matcher: string }[] };
}
interface Manifest {
    manifest_version: string;
    version: string;
    server: { entry_point: string; mcp_config: { args: string[] } };
}
const version = json<{ version: string }>("packages/bridge/package.json").version;
const wallet = "mcp__plugin_bugnet-wallet_sandbox__";
const base = "mcp__plugin_bugnet_sandbox__";

describe("the plugins", () => {
    it("lists both plugins in the marketplace", () => {
        const market = json<{ plugins: { name: string; source: string }[] }>(
            ".claude-plugin/marketplace.json",
        );
        expect(market.plugins.map((p) => [p.name, p.source])).toEqual([
            ["bugnet", "./plugin"],
            ["bugnet-wallet", "./plugin-wallet"],
        ]);
        const b = json<PluginJson>("plugin/.claude-plugin/plugin.json");
        const w = json<PluginJson>("plugin-wallet/.claude-plugin/plugin.json");
        expect(b.name).toBe("bugnet");
        expect([w.name, w.displayName, w.version]).toEqual([
            "bugnet-wallet",
            "Bugnet with a local wallet",
            "0.1.0",
        ]);
        expect(w.keywords).toEqual([...b.keywords, "wallet"]);
    });

    it("points bugnet at the public URL and bugnet-wallet at this bridge release", () => {
        const url = "${BUGNET_MCP_URL:-https://mcp.bugnet.sh/mcp}";
        expect(json("plugin/.mcp.json")).toEqual({
            mcpServers: { sandbox: { type: "http", url } },
        });
        expect(json("plugin-wallet/.mcp.json")).toEqual({
            mcpServers: {
                sandbox: {
                    type: "stdio",
                    command: "npx",
                    args: ["-y", `@bugnet/mcp@${version}`, "--gateway", url],
                },
            },
        });
    });

    it("gives the wallet plugin the same skill, hooks and hook bundle", () => {
        const skill = text("plugin/skills/run-in-sandbox/SKILL.md");
        expect(text("plugin-wallet/skills/run-in-sandbox/SKILL.md")).toBe(
            skill.replaceAll(base, wallet),
        );
        const hooks = json<Hooks>("plugin/hooks/hooks.json");
        hooks.hooks.PostToolUse[0]!.matcher = `Bash|${wallet}.*|mcp__bugnet__.*`;
        expect(json<Hooks>("plugin-wallet/hooks/hooks.json")).toEqual(hooks);
        for (const f of ["hooks/run.sh", "hooks/bugnet-hook.mjs"]) {
            expect(text(`plugin-wallet/${f}`), f).toBe(text(`plugin/${f}`));
        }
    });

    it("lets the skill redeem a paid order and never says a wallet pays by itself", () => {
        const skill = text("plugin/skills/run-in-sandbox/SKILL.md");
        expect(skill).toMatch(new RegExp(`^allowed-tools: .*${base}bugnet_redeem`, "m"));
        expect(skill).toContain("Once they say they paid, call");
        expect(skill).not.toMatch(/pays automatically|x402 wallet/);
    });

    it("builds the Claude Desktop extension from this bridge release", () => {
        const m = json<Manifest>("packages/bridge/mcpb/manifest.json");
        expect(m.manifest_version).toBe("0.3");
        expect(m.version).toBe(version);
        expect(m.server.entry_point).toBe("server/main.js");
        expect(m.server.mcp_config.args[0]).toBe("${__dirname}/server/main.js");
    });
});
