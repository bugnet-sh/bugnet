// A stand-in for the pay CLI's MCP server, run as a child process by the PayCli tests
import { appendFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const record = process.env.BUGNET_FAKE_PAY_RECORD;
if (record) appendFileSync(`${record}.starts`, "start\n");
if (process.env.BUGNET_FAKE_PAY_OLD === "1" && process.argv.includes("--max-payment")) {
    process.exit(2);
}

const toolName = process.env.BUGNET_FAKE_PAY_TOOL ?? "curl";
const argName = process.env.BUGNET_FAKE_PAY_ARG ?? "url";

serveStdio(() => {
    const server = new Server({ name: "pay", version: "0" }, { capabilities: { tools: {} } });
    server.oninitialized = () => {
        if (!record) return;
        const seen = {
            argv: process.argv.slice(2),
            payEnvKeys: Object.keys(process.env).filter((k) => /^PAY_/i.test(k) || k === "NO_DNA"),
            capabilities: server.getClientCapabilities() ?? null,
        };
        writeFileSync(record, JSON.stringify(seen));
    };
    server.setRequestHandler("tools/list", async () => ({
        tools: [
            {
                name: toolName,
                inputSchema: { type: "object", properties: { [argName]: { type: "string" } } },
            },
        ],
    }));
    server.setRequestHandler("tools/call", async (req) => {
        const url = String(
            (req.params.arguments as Record<string, unknown> | undefined)?.url ?? "",
        );
        const delay = Number(process.env.BUGNET_FAKE_PAY_DELAY_MS ?? 0);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        // pay 0.29.0 cannot read the CAIP-2 Solana network once any limit flag is set
        const networkBug =
            process.env.BUGNET_FAKE_PAY_NETWORK_BUG === "1" && process.argv.length > 3;
        const text = networkBug
            ? "Pay curl failed: Payment rejected: MCP permission denied: invalid Solana network " +
              "`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`"
            : (process.env.BUGNET_FAKE_PAY_ANSWER ??
              JSON.stringify({ paid: true, orderId: url.split("/").at(-1) }));
        return { content: [{ type: "text", text }] };
    });
    return server;
});
