import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { allowedHosts } from "./config.ts";
import { instructions } from "./instructions.ts";
import type { Deps, Register } from "./tools/common.ts";
import { registerFileTools } from "./tools/files.ts";
import { registerJobTools } from "./tools/jobs.ts";
import { registerSandboxTools } from "./tools/sandbox.ts";

export const version = "0.1.0";

export const registrations: Register[] = [
    registerSandboxTools,
    registerJobTools,
    registerFileTools,
];

export function buildMcpServer(deps: Deps, extra: Register[] = []): McpServer {
    const server = new McpServer(
        { name: "bugnet", title: "Bugnet sandboxes", version },
        { instructions },
    );
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
        mcp(req, res).catch((e: Error) => {
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
