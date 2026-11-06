import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { McpServer, createMcpHandler, type ServerContext } from "@modelcontextprotocol/server";
import { allowedHosts } from "./config.ts";
import { instructions } from "./instructions.ts";
import { peerAddress, withClientAddress, withToolCall } from "./request.ts";
import { registerAssessTool } from "./tools/assess.ts";
import type { Deps, Register } from "./tools/common.ts";
import { registerExtendTool } from "./tools/extend.ts";
import { registerFileTools } from "./tools/files.ts";
import { registerJobTools } from "./tools/jobs.ts";
import { registerQuoteTool } from "./tools/quote.ts";
import { registerPreviewTool } from "./tools/preview.ts";
import { registerSandboxTools } from "./tools/sandbox.ts";
import { registerSourceTool } from "./tools/source.ts";
import { registerTransferTool } from "./tools/transfer.ts";
import { registerSshTools } from "./tools/ssh.ts";
import { registerSecretTools } from "./tools/secrets.ts";

export const version = "0.1.0";

export const registrations: Register[] = [
    registerAssessTool,
    registerQuoteTool,
    registerSandboxTools,
    registerJobTools,
    registerFileTools,
    registerExtendTool,
    registerSourceTool,
    registerPreviewTool,
    registerTransferTool,
    registerSshTools,
    registerSecretTools,
];

type AnyHandler = (...a: unknown[]) => unknown;

// Each tool call runs in its own scope, which the router client reads to cancel its calls
function scopeToolCalls(server: McpServer): void {
    const register = server.registerTool.bind(server) as (
        name: string,
        config: unknown,
        cb: AnyHandler,
    ) => unknown;
    const scoped = (name: string, config: unknown, cb: AnyHandler) =>
        register(name, config, (...a: unknown[]) => {
            const ctx = a[a.length - 1] as ServerContext;
            return withToolCall(ctx.mcpReq.signal, () => cb(...a));
        });
    server.registerTool = scoped as typeof server.registerTool;
}

export function buildMcpServer(deps: Deps, extra: Register[] = []): McpServer {
    const server = new McpServer(
        { name: "bugnet", title: "Bugnet sandboxes", version },
        { instructions },
    );
    scopeToolCalls(server);
    for (const register of [...registrations, ...extra]) register(server, deps);
    return server;
}

export function startHttp(deps: Deps, extra: Register[] = []): Promise<Server> {
    const handler = createMcpHandler(() => buildMcpServer(deps, extra), {
        legacy: "stateless",
        onerror: (e) => deps.log.warn("mcp request failed", { err: e.message }),
    });
    const mcp = toNodeHandler(handler);
    const validHost = hostHeaderValidation(allowedHosts(deps.config));
    const http = createServer((req: IncomingMessage, res: ServerResponse) => {
        const path = (req.url ?? "/").split("?")[0];
        if (path === "/healthz") {
            res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
            return;
        }
        if (path !== "/mcp") {
            res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
            return;
        }
        if (!validHost(req, res)) return;
        withClientAddress(peerAddress(req.socket), () => mcp(req, res)).catch((e: Error) => {
            deps.log.error("mcp handler crashed", { err: e.message });
            if (!res.headersSent) res.writeHead(500).end();
        });
    });
    const addr = deps.config.listen_addr;
    const at = addr.lastIndexOf(":");
    const host = addr.slice(0, at).replace(/^\[|\]$/g, "") || "0.0.0.0";
    const port = Number(addr.slice(at + 1));
    return new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => resolve(http));
    });
}
