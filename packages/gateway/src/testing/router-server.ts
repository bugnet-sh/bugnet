/**
 * A real Connect router for tests that need the gateway's own client and transport.
 *
 * It serves h2c on 127.0.0.1 at a free port, records the headers of every call, and answers with
 * the methods given. Methods left out answer Unimplemented.
 */
import { createServer, type Http2Server, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { SandboxRouterService } from "../gen/bugnet/router/v1/router_pb.ts";
import type { RouterImpl } from "./harness.ts";

export interface SeenCall {
    method: string;
    header: Headers;
}

export interface TestRouterServer {
    url: string;
    calls: SeenCall[];
    close(): Promise<void>;
}

export async function startRouterServer(impl: RouterImpl): Promise<TestRouterServer> {
    const calls: SeenCall[] = [];
    const handler = connectNodeAdapter({
        routes: (router) => router.service(SandboxRouterService, impl),
        interceptors: [
            (next) => (req) => {
                calls.push({ method: req.method.name, header: new Headers(req.header) });
                return next(req);
            },
        ],
    });
    const server: Http2Server = createServer(handler);
    const sessions = new Set<ServerHttp2Session>();
    server.on("session", (s: ServerHttp2Session) => {
        sessions.add(s);
        s.once("close", () => sessions.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                // Sessions a client keeps open would hold close back
                for (const s of sessions) s.destroy();
            }),
    };
}

// A handler that answers only when the call is cancelled, recording that it was
export function stall(cancelled: string[], name: string): () => Promise<never> {
    return (...a: unknown[]) =>
        new Promise<never>((_, reject) => {
            const ctx = a[1] as { signal: AbortSignal };
            ctx.signal.addEventListener("abort", () => {
                cancelled.push(name);
                reject(ctx.signal.reason as Error);
            });
        });
}
