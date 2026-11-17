import { Code, ConnectError } from "@connectrpc/connect";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import {
    McpServer,
    legacyStatelessFallback,
    type CallToolResult,
    type McpHttpHandler,
    type ServerContext,
} from "@modelcontextprotocol/server";
import { allowedHosts } from "./config.ts";
import { instructions } from "./instructions.ts";
import { DevPayments } from "./payments/dev.ts";
import { peerAddress, urlPromptClient, withClientAddress, withToolCall } from "./request.ts";
import { setProviderNames } from "./router.ts";
import { recordToolCall } from "./sessionevents.ts";
import { registerAssessTool } from "./tools/assess.ts";
import type { Deps, Register } from "./tools/common.ts";
import { registerExtendTool } from "./tools/extend.ts";
import { registerFileTools } from "./tools/files.ts";
import { registerJobTools } from "./tools/jobs.ts";
import { registerQuoteTool } from "./tools/quote.ts";
import { registerRedeemTool } from "./tools/redeem.ts";
import { registerPreviewTool } from "./tools/preview.ts";
import { registerSandboxTools } from "./tools/sandbox.ts";
import { registerSourceTool } from "./tools/source.ts";
import { registerTransferTool } from "./tools/transfer.ts";
import { registerSshTools } from "./tools/ssh.ts";
import { registerSecretTools } from "./tools/secrets.ts";
import { registerX402Tools } from "./tools/x402.ts";

export const version = "0.1.0";

export const registrations: Register[] = [
    registerAssessTool,
    registerQuoteTool,
    registerSandboxTools,
    registerJobTools,
    registerFileTools,
    registerExtendTool,
    registerRedeemTool,
    registerSourceTool,
    registerPreviewTool,
    registerTransferTool,
    registerSshTools,
    registerSecretTools,
    registerX402Tools,
];

type AnyHandler = (...a: unknown[]) => unknown;

// Each tool call runs in its own scope, which the router client reads to cancel and trace its calls
function scopeToolCalls(server: McpServer, deps: Deps): void {
    const tracing = deps.tracing;
    const register = server.registerTool.bind(server) as (
        name: string,
        config: unknown,
        cb: AnyHandler,
    ) => unknown;
    const scoped = (name: string, config: unknown, cb: AnyHandler) =>
        register(name, config, (...a: unknown[]) => {
            const ctx = a[a.length - 1] as ServerContext;
            const args = a.length > 1 ? a[0] : undefined;
            const run = () => cb(...a);
            const traced = tracing ? () => tracing.tool(name, args, run) : run;
            const limit = new AbortController();
            const stop = () =>
                limit.abort(new ConnectError("tool time limit", Code.DeadlineExceeded));
            let timer = setTimeout(stop, deps.config.limits.tool_budget);
            const extend = (ms: number) => {
                clearTimeout(timer);
                timer = setTimeout(stop, ms);
            };
            const signal = AbortSignal.any([ctx.mcpReq.signal, limit.signal]);
            const started = deps.now();
            // The executor turns a handler's synchronous throw into a rejection it can record
            return new Promise((resolve) => resolve(withToolCall(signal, traced, extend)))
                .then(
                    (result) => {
                        recordToolCall(deps, name, args, started, result as CallToolResult);
                        return result;
                    },
                    (e: unknown) => {
                        recordToolCall(deps, name, args, started, undefined);
                        throw e;
                    },
                )
                .finally(() => clearTimeout(timer));
        });
    server.registerTool = scoped as typeof server.registerTool;
}

export function buildMcpServer(deps: Deps, extra: Register[] = []): McpServer {
    const server = new McpServer(
        { name: "bugnet", title: "Bugnet sandboxes", version },
        { instructions },
    );
    setProviderNames(deps.config.router.provider_names);
    scopeToolCalls(server, deps);
    for (const register of [...registrations, ...extra]) register(server, deps);
    return server;
}

// Previews are same-site with the gateway until the PSL entry ships, so same-site counts as foreign
export function foreignRequest(req: IncomingMessage, origins: ReadonlySet<string>): boolean {
    const site = req.headers["sec-fetch-site"];
    if (site === "same-site" || site === "cross-site") return true;
    const origin = req.headers.origin;
    return origin !== undefined && !origins.has(origin.replace(/\/$/, ""));
}

const cookieAdvice =
    "This browser sent more bugnet.sh cookies than Bugnet reads. Clear the cookies for bugnet.sh " +
    "in your browser's site settings, then reload the page.\n";

// Node's own answer is gone once a clientError listener exists, so this keeps its status codes
function answerClientError(err: Error & { code?: string }, socket: Duplex): void {
    if (err.code === "ECONNRESET" || !socket.writable) {
        socket.destroy();
        return;
    }
    const tooLarge = err.code === "HPE_HEADER_OVERFLOW";
    const status = tooLarge
        ? "431 Request Header Fields Too Large"
        : err.code === "ERR_HTTP_REQUEST_TIMEOUT"
          ? "408 Request Timeout"
          : "400 Bad Request";
    const body = tooLarge ? cookieAdvice : "";
    socket.end(
        `HTTP/1.1 ${status}\r\ncontent-type: text/plain; charset=utf-8\r\n` +
            `content-security-policy: frame-ancestors 'none'\r\n` +
            `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
}

// A header Node may hand over as a list, read as its first value
function headerText(v: string | string[] | undefined): string | undefined {
    return Array.isArray(v) ? v[0] : v;
}

// Only the 2025 protocol, whose stateless calls can push a pay prompt and say when it is paid
export function mcpHandler(deps: Deps, extra: Register[] = []): McpHttpHandler {
    const legacy = legacyStatelessFallback(
        () => buildMcpServer(deps, extra),
        (e) => deps.log.warn("mcp request failed", { err: e.message }),
    );
    return { fetch: legacy, close: async () => {} } as unknown as McpHttpHandler;
}

export function startHttp(deps: Deps, extra: Register[] = []): Promise<Server> {
    const mcp = toNodeHandler(mcpHandler(deps, extra));
    const devPay =
        deps.payments instanceof DevPayments && deps.payments.requiresPayment
            ? deps.payments
            : null;
    const validHost = hostHeaderValidation(allowedHosts(deps.config));
    const home = deps.config.home_url;
    // Hosted clients such as claude.ai send their own Origin, and the gateway reads no cookie
    const origins = new Set([
        new URL(deps.config.public_url).origin,
        ...deps.config.allowed_origins.map((o) => o.replace(/\/$/, "")),
    ]);
    // A preview can fill the bugnet.sh cookie jar, which must never stop the gateway answering
    const http = createServer({ maxHeaderSize: 64 * 1024 }, (req, res: ServerResponse) => {
        res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
        delete req.headers.cookie;
        const path = (req.url ?? "/").split("?")[0];
        if (path === "/" && home && (req.method === "GET" || req.method === "HEAD")) {
            res.writeHead(302, { location: home }).end();
            return;
        }
        if (path === "/healthz") {
            res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
            return;
        }
        // Dev pay links stand in for the Payments checkout page on this machine
        const payLink = devPay && /^\/o\/([^/]+)(\/status)?$/.exec(path ?? "");
        if (devPay && payLink && (req.method === "GET" || req.method === "POST")) {
            const id = payLink[1] as string;
            const a = payLink[2] ? devPay.status(id) : devPay.pay(id);
            res.writeHead(a.status, { "content-type": "application/json" }).end(
                JSON.stringify(a.body),
            );
            return;
        }
        if (path !== "/mcp") {
            res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
            return;
        }
        if (!validHost(req, res)) return;
        if (foreignRequest(req, origins)) {
            res.writeHead(403, { "content-type": "text/plain" }).end("forbidden origin\n");
            return;
        }
        const prompts = urlPromptClient(
            req.headers["user-agent"],
            headerText(req.headers["mcp-protocol-version"]),
        );
        withClientAddress(peerAddress(req.socket), () => mcp(req, res), prompts).catch(
            (e: Error) => {
                deps.log.error("mcp handler crashed", { err: e.message });
                if (!res.headersSent) res.writeHead(500).end();
            },
        );
    });
    // A preview can set bugnet.sh cookies past any header limit, so the answer says how to clear them
    http.on("clientError", answerClientError);
    const addr = deps.config.listen_addr;
    const at = addr.lastIndexOf(":");
    const host = addr.slice(0, at).replace(/^\[|\]$/g, "") || "0.0.0.0";
    const port = Number(addr.slice(at + 1));
    return new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => resolve(http));
    });
}
