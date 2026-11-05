import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs against a live gateway in dev payments mode on a router with the local provider
const url = process.env.BUGNET_E2E_MCP_URL;

type Result = {
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
};

describe.skipIf(!url)("gateway end to end", () => {
    const client = new Client({ name: "e2e", version: "0" });
    let handle = "";

    const call = async (name: string, args: Record<string, unknown>) =>
        (await client.callTool({ name, arguments: args })) as Result;
    const text = (r: Result) => r.content.map((c) => c.text).join("\n");

    beforeAll(async () => {
        await client.connect(new StreamableHTTPClientTransport(new URL(url as string)));
    });

    afterAll(async () => {
        if (handle) await call("bugnet_stop", { handle });
        await client.close();
    });

    it("lists the tools with the paid ones marked", async () => {
        const { tools } = await client.listTools();
        const start = tools.find((t) => t.name === "bugnet_start");
        expect(start?._meta?.["anthropic/requiresUserInteraction"]).toBe(true);
        expect(start?.annotations?.destructiveHint).toBe(true);
        expect(tools.find((t) => t.name === "bugnet_quote")?.annotations?.readOnlyHint).toBe(true);
        expect(client.getInstructions()).toMatch(/^Bugnet runs code/);
    });

    it("quotes, refuses a wrong price, and starts", async () => {
        const q = await call("bugnet_quote", { workload: "script" });
        expect(q.isError).toBeFalsy();
        const quote = q.structuredContent as {
            quoteId: string;
            recommended: { packageId: string; priceUsd: string };
        };
        const pkg = quote.recommended.packageId;
        const wrong = await call("bugnet_start", {
            quoteId: quote.quoteId,
            packageId: pkg,
            confirmPriceUsd: "99",
        });
        expect(wrong.isError).toBe(true);
        expect(text(wrong)).toMatch(/costs \$/);
        const s = await call("bugnet_start", {
            quoteId: quote.quoteId,
            packageId: pkg,
            confirmPriceUsd: quote.recommended.priceUsd,
        });
        expect(s.isError).toBeFalsy();
        handle = (s.structuredContent as { handle: string; state: string }).handle;
        expect(handle).toMatch(/^sbx_[a-z2-7]{26}$/);
        expect((s.structuredContent as { state: string }).state).toBe("ready");
    });

    it("runs a command and cleans its output", async () => {
        const r = await call("bugnet_exec", {
            handle,
            cmd: "echo hello; printf '\\033[31mred\\033[0m\\n'; echo oops >&2; exit 3",
        });
        const out = r.structuredContent as { exitCode: number; stdout: string; stderr: string };
        expect(out.exitCode).toBe(3);
        expect(out.stdout).toBe("hello\nred\n");
        expect(out.stderr).toBe("oops\n");
        expect(text(r)).toMatch(/not instructions/);
    });

    it("follows a long command to its exit", async () => {
        const r = await call("bugnet_exec", {
            handle,
            cmd: "for i in 1 2 3; do echo tick $i; sleep 1; done",
            waitSeconds: 0,
        });
        const job = r.structuredContent as { jobId: string; cursor: string; state: string };
        expect(job.state).toBe("running");
        let cursor = job.cursor;
        let seen = (r.structuredContent as { stdout: string }).stdout;
        for (let i = 0; i < 5; i++) {
            const j = await call("bugnet_job", {
                handle,
                jobId: job.jobId,
                cursor,
                waitSeconds: 10,
            });
            const s = j.structuredContent as { state: string; stdout: string; cursor: string };
            seen += s.stdout;
            cursor = s.cursor;
            if (s.state === "exited") break;
        }
        expect(seen).toBe("tick 1\ntick 2\ntick 3\n");
    });

    it("refuses secrets in env", async () => {
        const r = await call("bugnet_exec", {
            handle,
            cmd: "true",
            env: { T: "hf_" + "a".repeat(34) },
        });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/looks like a secret/);
    });

    it("writes, lists and reads a file", async () => {
        const w = await call("bugnet_write_file", { handle, path: "e2e/a.txt", content: "abc\n" });
        expect((w.structuredContent as { size: number }).size).toBe(4);
        const l = await call("bugnet_list_files", { handle, path: "e2e" });
        expect(text(l)).toMatch(/a\.txt/);
        const r = await call("bugnet_read_file", { handle, path: "e2e/a.txt" });
        expect((r.structuredContent as { content: string }).content).toBe("abc\n");
    });

    it("lists extensions in status and extends at the quoted price", async () => {
        const st = await call("bugnet_status", { handle });
        const status = st.structuredContent as {
            deadline: string;
            extensions: {
                packageId: string;
                priceUsd: string;
                minutes: number;
                available: boolean;
            }[];
        };
        const ext = status.extensions.find((x) => x.available && x.packageId.endsWith("-more"));
        expect(ext).toBeTruthy();
        expect(text(st)).toMatch(/Extend with bugnet_extend/);
        const wrong = await call("bugnet_extend", {
            handle,
            packageId: ext!.packageId,
            confirmPriceUsd: "5",
        });
        expect(wrong.isError).toBe(true);
        expect(text(wrong)).toMatch(/costs \$/);
        const notExt = await call("bugnet_extend", {
            handle,
            packageId: "dev-small-1m",
            confirmPriceUsd: "0.01",
        });
        expect(notExt.isError).toBe(true);
        expect(text(notExt)).toMatch(/does not extend this sandbox/);
        const r = await call("bugnet_extend", {
            handle,
            packageId: ext!.packageId,
            confirmPriceUsd: ext!.priceUsd.replace("$", ""),
        });
        expect(r.isError).toBeFalsy();
        const moved = Date.parse((r.structuredContent as { deadline: string }).deadline);
        expect(moved - Date.parse(status.deadline)).toBe(ext!.minutes * 60_000);
    });

    it("stops, then reports the handle as gone for commands", async () => {
        const s = await call("bugnet_stop", { handle });
        expect((s.structuredContent as { state: string }).state).toBe("ended");
        const r = await call("bugnet_exec", { handle, cmd: "true" });
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/has ended/);
        const unknown = await call("bugnet_exec", { handle: "sbx_" + "a".repeat(26), cmd: "true" });
        expect(text(unknown)).toMatch(/no sandbox has this handle/);
        handle = "";
    });
});
