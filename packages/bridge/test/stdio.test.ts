import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PlacementState } from "@bugnet/gateway/gen";
import { packageOption, placement } from "@bugnet/gateway/testing";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    fakeGateway,
    fakeSecretsRoute,
    grantRouter,
    testHandle,
    type FakeGateway,
    type FakeSecretsRoute,
} from "../src/testing/harness.ts";

// BUGNET_BRIDGE_BIN and BUGNET_BRIDGE_NODE point the test at a built bundle and another Node
const node = process.env.BUGNET_BRIDGE_NODE ?? process.execPath;
const bin =
    process.env.BUGNET_BRIDGE_BIN ?? fileURLToPath(new URL("../src/main.ts", import.meta.url));
const value = "hf_FromTheShell_9f8e7d6c5b4a";

let dir = "";
let gateway: FakeGateway;
let route: FakeSecretsRoute;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bugnet-bridge-stdio-"));
    gateway = await fakeGateway({
        ...grantRouter,
        estimate: () => ({ options: [packageOption("small-10m", 50_000n)] }),
        createPlacement: () => ({ handle: testHandle, placement: placement(PlacementState.READY) }),
        getPlacement: () => ({ placement: placement(PlacementState.READY) }),
    });
    route = await fakeSecretsRoute();
    await writeFile(join(dir, "mcp.toml"), `secrets_url = "${route.url}"\n`);
});

afterAll(async () => {
    await gateway.close();
    await route.close();
    await rm(dir, { recursive: true, force: true });
});

describe("the bugnet-mcp command", () => {
    it("prints its version and usage, and refuses an unknown flag", { timeout: 60_000 }, () => {
        const version = spawnSync(node, [bin, "--version"], { encoding: "utf8" });
        expect(version.stdout).toBe("0.1.0\n");
        expect(version.status).toBe(0);
        const help = spawnSync(node, [bin, "--help"], { encoding: "utf8" });
        expect(help.stdout).toMatch(/^Usage: bugnet-mcp \[--gateway URL\] \[--config FILE\]/);
        const bad = spawnSync(node, [bin, "--gatewy", "x"], { encoding: "utf8" });
        expect(bad.status).toBe(2);
        expect(bad.stdout).toBe("");
        expect(bad.stderr).toMatch(/^bugnet-mcp: /);
    });

    for (const era of ["legacy", "modern"] as const) {
        // A release pins only the deploy's box keys, so the fake route's development key fails
        it(
            `serves the gateway over stdio to a ${era} client and refuses an unpinned key`,
            { timeout: 60_000 },
            async () => {
                const transport = new StdioClientTransport({
                    command: node,
                    args: [bin, "--gateway", gateway.url, "--config", join(dir, "mcp.toml")],
                    env: { ...getDefaultEnvironment(), HF_TOKEN: value },
                    cwd: dir,
                    stderr: "pipe",
                });
                let stderr = "";
                transport.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
                const client = new Client(
                    { name: "stdio-test", version: "0" },
                    era === "modern" ? { versionNegotiation: { mode: "auto" } } : {},
                );
                await client.connect(transport);
                route.requests.length = 0;
                try {
                    expect(client.getProtocolEra()).toBe(era);
                    expect(client.getInstructions()).toMatch(/^Bugnet runs code/);
                    const { tools } = await client.listTools();
                    expect(tools.map((t) => t.name)).toContain("bugnet_quote");
                    expect(tools.map((t) => t.name)).not.toContain("bugnet_secret_put_grant");
                    const q = await client.callTool({
                        name: "bugnet_quote",
                        arguments: { workload: "script" },
                    });
                    const quoteId = (q.structuredContent as { quoteId: string }).quoteId;
                    // A client that cannot ask the user adds secrets only to sandboxes it started
                    await client.callTool({
                        name: "bugnet_start",
                        arguments: { quoteId, packageId: "small-10m", confirmPriceUsd: "0.05" },
                    });
                    const r = await client.callTool({
                        name: "bugnet_secret_from_env",
                        arguments: {
                            handle: testHandle,
                            name: "HF_TOKEN",
                            source: { type: "env", variable: "HF_TOKEN" },
                            hosts: ["huggingface.co"],
                        },
                    });
                    expect(r.isError).toBe(true);
                    expect(r.content).toEqual([
                        {
                            type: "text",
                            text:
                                "secret: no listed sealing key is one this build pins (listed " +
                                "dev-only-1). A newer Bugnet bridge may be needed.",
                        },
                    ]);
                    expect(route.requests.map((q) => `${q.method} ${q.path}`)).toEqual([
                        "GET /v1/sealing-key",
                    ]);
                    expect(route.opened).toEqual([]);
                } finally {
                    await client.close();
                }
                expect(stderr).toMatch(/"msg":"secret refused"/);
                expect(stderr).not.toContain(value);
                expect(stderr).not.toContain(testHandle);
            },
        );
    }
});
