/**
 * Stands in for the user at Claude Code's permission prompts during the end-to-end judge.
 *
 * A stdio MCP server with one tool, used through --permission-prompt-tool. It allows Bugnet's own
 * tools when the price the agent confirms is within BUGNET_E2E_MAX_USD, the limit the scripted
 * user reply agreed to, and denies everything else. Each decision is appended to
 * BUGNET_E2E_APPROVALS as one JSON line.
 */
import { appendFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";

const maxUsd = Number(process.env.BUGNET_E2E_MAX_USD ?? "0.5");
const log = process.env.BUGNET_E2E_APPROVALS;

function decide(toolName, input) {
    if (!/^mcp__bugnet__bugnet_[a-z_]+$/.test(toolName)) {
        return { behavior: "deny", message: "Only Bugnet tools are allowed in this run" };
    }
    const price = input?.confirmPriceUsd;
    if (price !== undefined) {
        const usd = Number.parseFloat(String(price).replace(/^\$/, ""));
        if (!Number.isFinite(usd) || usd > maxUsd) {
            return { behavior: "deny", message: `The user agreed to at most $${maxUsd}` };
        }
    }
    return { behavior: "allow", updatedInput: input ?? {} };
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
    let req;
    try {
        req = JSON.parse(line);
    } catch {
        return;
    }
    if (req.id === undefined) return;
    if (req.method === "initialize") {
        send({
            jsonrpc: "2.0",
            id: req.id,
            result: {
                protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "approver", version: "0.1.0" },
            },
        });
    } else if (req.method === "tools/list") {
        send({
            jsonrpc: "2.0",
            id: req.id,
            result: {
                tools: [
                    {
                        name: "approve",
                        description: "Answers permission prompts for the end-to-end judge",
                        inputSchema: {
                            type: "object",
                            properties: {
                                tool_name: { type: "string" },
                                input: { type: "object" },
                            },
                            required: ["tool_name"],
                        },
                    },
                ],
            },
        });
    } else if (req.method === "tools/call") {
        const { tool_name: toolName, input } = req.params?.arguments ?? {};
        const decision = decide(String(toolName ?? ""), input);
        if (log) {
            const price = input?.confirmPriceUsd ?? null;
            appendFileSync(
                log,
                `${JSON.stringify({ toolName, price, decision: decision.behavior })}\n`,
            );
        }
        send({
            jsonrpc: "2.0",
            id: req.id,
            result: { content: [{ type: "text", text: JSON.stringify(decision) }] },
        });
    } else if (req.method === "ping") {
        send({ jsonrpc: "2.0", id: req.id, result: {} });
    } else {
        send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } });
    }
});
