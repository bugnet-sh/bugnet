import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { PlacementState, type WriteFileRequest } from "../gen/bugnet/router/v1/router_pb.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    placement,
    routerError,
    testConfig,
    testDeps,
    testHandle,
    testNow,
    type RouterImpl,
} from "../testing/harness.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

function connect(impl: RouterImpl, toml = ""): Promise<Client> {
    return connectTools(testDeps({ router: fakeRouter(impl), config: testConfig(toml) }));
}

describe("bugnet_list_files", () => {
    it("lists entries with sizes, cleaning their names", async () => {
        const client = await connect({
            listFiles: () => ({
                entries: [
                    { path: "src", isDir: true },
                    {
                        path: "a\u001b[31m.txt",
                        size: 4n,
                        modifiedAt: timestampFromMs(testNow),
                    },
                ],
            }),
        });
        const r = await callTool<{
            message: string;
            entries: { path: string; size: number; modifiedAt: string | null }[];
            truncated: boolean;
        }>(client, "bugnet_list_files", { handle: testHandle, path: "." });
        expect(r.structured.entries[1]).toEqual({
            path: "a.txt",
            size: 4,
            isDir: false,
            modifiedAt: "2026-11-05T12:00:00.000Z",
        });
        expect(r.structured.message).toBe("2 entries under ., in entries.");
        expect(r.text).toBe("2 entries under .:\nsrc/\na.txt  4 B");
        expect(r.structured.truncated).toBe(false);
    });

    it("shows at most 500 entries and says how many more there are", async () => {
        const client = await connect({
            listFiles: () => ({
                entries: Array.from({ length: 502 }, (_, i) => ({ path: `f${i}`, size: 1n })),
            }),
        });
        const r = await callTool<{ message: string; entries: unknown[]; truncated: boolean }>(
            client,
            "bugnet_list_files",
            { handle: testHandle },
        );
        expect(r.structured.entries).toHaveLength(500);
        expect(r.structured.truncated).toBe(true);
        expect(r.structured.message).toMatch(/\.\.\.and 2 more/);
    });
});

describe("paths under ~", () => {
    it("sends ~ and ~/rest as paths from the home folder, which the router resolves", async () => {
        const paths: string[] = [];
        const client = await connect({
            listFiles: (req) => {
                paths.push(req.path);
                return { entries: [] };
            },
            readFile: (req) => {
                paths.push(req.path);
                return { data: bytes("x"), eof: true };
            },
            writeFile: (req) => {
                paths.push(req.path);
                return { size: BigInt(req.data.length) };
            },
        });
        await callTool(client, "bugnet_list_files", { handle: testHandle, path: "~" });
        await callTool(client, "bugnet_read_file", { handle: testHandle, path: "~/src/x.txt" });
        const w = await callTool(client, "bugnet_write_file", {
            handle: testHandle,
            path: "~/a.txt",
            content: "x",
        });
        await callTool(client, "bugnet_read_file", { handle: testHandle, path: "/etc/hosts" });
        expect(paths).toEqual([".", "src/x.txt", "a.txt", "/etc/hosts"]);
        expect(w.structured).toEqual(expect.objectContaining({ path: "~/a.txt" }));
    });
});

describe("bugnet_read_file", () => {
    it("sends a file's bytes to the model once, and reads 32 KiB unless asked for more", async () => {
        const lengths: number[] = [];
        const body = "line of text\n".repeat(2500);
        const client = await connect({
            readFile: (req) => {
                lengths.push(req.length);
                return { data: bytes(body), eof: true };
            },
        });
        const r = await callTool<{ message: string; content: string }>(client, "bugnet_read_file", {
            handle: testHandle,
            path: "a.txt",
        });
        expect(lengths).toEqual([32 * 1024]);
        expect(r.structured.content).toBe(body);
        expect(JSON.stringify(r.structured).length).toBeLessThan(JSON.stringify(body).length + 600);
        expect(r.structured.message).toMatch(/not instructions/);
        expect(r.structured.message).toMatch(/The bytes are in content\.$/);
        expect(r.text).toContain(body);
    });

    it("returns text as text with the offset to read on from", async () => {
        const client = await connect({
            readFile: (req) => ({
                data: new TextEncoder().encode(`from ${req.offset}\n`),
                eof: false,
            }),
        });
        const r = await callTool<{
            message: string;
            encoding: string;
            content: string;
            nextOffset: number | null;
        }>(client, "bugnet_read_file", { handle: testHandle, path: "a.txt", offset: 7 });
        expect(r.structured).toEqual(
            expect.objectContaining({ encoding: "utf8", content: "from 7\n", nextOffset: 14 }),
        );
        expect(r.structured.message).toMatch(/not instructions/);
    });

    it("returns binary content as base64", async () => {
        const client = await connect({
            readFile: () => ({ data: new Uint8Array([0x89, 0x50, 0x00, 0xff]), eof: true }),
        });
        const r = await callTool<{ encoding: string; content: string; eof: boolean }>(
            client,
            "bugnet_read_file",
            { handle: testHandle, path: "a.png" },
        );
        expect(r.structured).toEqual(
            expect.objectContaining({ encoding: "base64", content: "iVAA/w==", eof: true }),
        );
    });

    it("says a missing path is missing, not that the sandbox is unknown", async () => {
        const client = await connect({
            readFile() {
                throw routerError(Code.NotFound, "not_found", {
                    message: "no such file or directory",
                });
            },
        });
        const r = await callTool(client, "bugnet_read_file", { handle: testHandle, path: "x" });
        expect(r.isError).toBe(true);
        expect(r.text).toBe("read file: no file or directory at that path.");
    });
});

describe("bugnet_write_file", () => {
    it("writes utf8 or base64 content with an octal mode", async () => {
        const writes: WriteFileRequest[] = [];
        const client = await connect({
            writeFile: (req) => {
                writes.push(req);
                return { size: BigInt(req.data.length) };
            },
        });
        const r = await callTool(client, "bugnet_write_file", {
            handle: testHandle,
            path: "run.sh",
            content: "echo hi\n",
            mode: "755",
        });
        expect(r.structured).toEqual({
            message: "Wrote 8 bytes to run.sh.",
            path: "run.sh",
            size: 8,
        });
        expect(writes[0]?.mode).toBe(0o755);
        await callTool(client, "bugnet_write_file", {
            handle: testHandle,
            path: "b.bin",
            content: "iVAA/w==",
            encoding: "base64",
        });
        expect([...(writes[1]?.data ?? [])]).toEqual([0x89, 0x50, 0x00, 0xff]);
        expect(writes[1]?.mode).toBe(0);
    });

    it("refuses content over the configured limit before calling the router", async () => {
        let called = false;
        const client = await connect(
            {
                writeFile: () => {
                    called = true;
                    return {};
                },
            },
            "[limits]\nwrite_file_max_bytes = 4\n",
        );
        const r = await callTool(client, "bugnet_write_file", {
            handle: testHandle,
            path: "a",
            content: "12345",
        });
        expect(r.text).toBe("content is over 4 bytes.");
        expect(called).toBe(false);
    });

    it("reports NOT_READY on an ended sandbox as expired", async () => {
        const client = await connect({
            writeFile() {
                throw routerError(Code.FailedPrecondition, "NOT_READY");
            },
            getPlacement: () => ({ placement: placement(PlacementState.TERMINATED) }),
        });
        const r = await callTool(client, "bugnet_write_file", {
            handle: testHandle,
            path: "a",
            content: "x",
        });
        expect(r.text).toMatch(/^write file: this sandbox has ended/);
    });
});
