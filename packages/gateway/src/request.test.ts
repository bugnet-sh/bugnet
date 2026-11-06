import type { AddressInfo, Socket } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { clientAddress, peerAddress, setPeerAddress, withClientAddress } from "./request.ts";
import { startHttp } from "./server.ts";
import { callTool, connectTools, testConfig, testDeps } from "./testing/harness.ts";
import { ok, type Register } from "./tools/common.ts";

const whoami: Register = (server) => {
    server.registerTool(
        "test_whoami",
        { description: "Returns the client address", inputSchema: z.object({}) },
        async () => ok("whoami", { address: clientAddress() ?? null }),
    );
};

describe("request context", () => {
    const stops: (() => Promise<void>)[] = [];
    afterEach(async () => {
        for (const stop of stops.splice(0)) await stop();
    });

    it("is empty outside an HTTP request, as under the in-memory transport", async () => {
        expect(clientAddress()).toBeUndefined();
        const client = await connectTools(testDeps(), [whoami]);
        const r = await callTool(client, "test_whoami");
        expect(r.structured.address).toBeNull();
    });

    it("holds the address for the work run inside it", async () => {
        const seen = await withClientAddress("203.0.113.7", async () => {
            await new Promise((r) => setTimeout(r, 1));
            return clientAddress();
        });
        expect(seen).toBe("203.0.113.7");
        expect(clientAddress()).toBeUndefined();
    });

    it("prefers the address a PROXY front set and folds IPv4-mapped peers", () => {
        const socket = { remoteAddress: "::ffff:127.0.0.1" } as Socket;
        expect(peerAddress(socket)).toBe("127.0.0.1");
        setPeerAddress(socket, "2001:DB8::1");
        expect(peerAddress(socket)).toBe("2001:db8::1");
        expect(peerAddress({} as Socket)).toBeUndefined();
    });

    it("gives each tool call over HTTP the socket's peer address", async () => {
        const deps = testDeps({ config: testConfig('listen_addr = "127.0.0.1:0"') });
        const http = await startHttp(deps, [whoami]);
        stops.push(() => new Promise((r) => http.close(() => r())));
        const { port } = http.address() as AddressInfo;
        const client = new Client({ name: "test", version: "0" });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
        );
        stops.unshift(() => client.close());
        const r = await callTool(client, "test_whoami");
        expect(r.structured.address).toBe("127.0.0.1");
    });
});
