import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { Assessor } from "../assess/assessor.ts";
import { parseSettings } from "../config.ts";
import { silentLog } from "../log.ts";
import type { Payments } from "../payments/port.ts";
import type { RouterClient } from "../router.ts";
import type { Deps } from "./common.ts";
import { registerExtendTool } from "./extend.ts";
import { registerSandboxTools } from "./sandbox.ts";

async function metaOf(toml: string) {
    const deps: Deps = {
        config: {
            ...parseSettings(toml),
            secrets: {
                internalToken: "",
                quoteKey: Buffer.alloc(32, 1),
                orderPrivateKey: null,
                paymentsToken: "",
                githubToken: "",
                huggingfaceToken: "",
            },
        },
        router: {} as RouterClient,
        payments: {} as Payments,
        assessor: {} as Assessor,
        log: silentLog,
        now: () => 0,
    };
    const server = new McpServer({ name: "t", version: "0" });
    registerSandboxTools(server, deps);
    registerExtendTool(server, deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const { tools } = await client.listTools();
    const flag = (name: string) =>
        tools.find((t) => t.name === name)?._meta?.["anthropic/requiresUserInteraction"];
    return {
        start: flag("bugnet_start"),
        extend: flag("bugnet_extend"),
        quote: flag("bugnet_quote"),
    };
}

describe("paid tool approval", () => {
    it("asks for a person's approval on paid tools by default", async () => {
        expect(await metaOf("")).toEqual({ start: true, extend: true, quote: undefined });
    });

    it("drops the approval mark only when the settings turn it off", async () => {
        const meta = await metaOf("[tools]\nrequire_user_approval = false\n");
        expect(meta).toEqual({ start: undefined, extend: undefined, quote: undefined });
    });
});
