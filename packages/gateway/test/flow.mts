import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
const url = new URL(process.argv[2] ?? "http://127.0.0.1:8787/mcp");
const c = new Client({ name: "flow", version: "0" });
await c.connect(new StreamableHTTPClientTransport(url));
const call = async (name: string, args: Record<string, unknown>) => {
    const r = await c.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[]).map((x) => x.text).join("\n");
    console.log(
        `== ${name}${r.isError ? " ERROR" : ""}\n${text.replace(/q1\.[A-Za-z0-9_.-]+/g, "q1.…").replace(/sbx_[a-z2-7]{26}/g, "sbx_…")}`,
    );
    return r;
};
const tools = await c.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const q = await call("bugnet_quote", { workload: "script" });
const quote = q.structuredContent as {
    quoteId: string;
    packages: { id: string; priceUsd: string; priceMicros: number }[];
    recommended: { packageId: string };
};
const pkg = quote.packages.find((p) => p.id === quote.recommended.packageId)!;
await call("bugnet_start", { quoteId: quote.quoteId, packageId: pkg.id, confirmPriceUsd: "9.99" });
const s = await call("bugnet_start", {
    quoteId: quote.quoteId,
    packageId: pkg.id,
    confirmPriceUsd: String(pkg.priceMicros / 1e6),
});
const handle = (s.structuredContent as { handle: string }).handle;
await call("bugnet_status", { handle });
await call("bugnet_exec", {
    handle,
    cmd: "echo hello; printf '\\033[31mred\\033[0m\\n'; echo err >&2; exit 3",
});
const e = await call("bugnet_exec", {
    handle,
    cmd: "for i in 1 2 3; do echo tick $i; sleep 1; done",
    waitSeconds: 0,
});
const job = e.structuredContent as { jobId: string; cursor: string };
await call("bugnet_job", { handle, jobId: job.jobId, cursor: job.cursor, waitSeconds: 10 });
await call("bugnet_exec", { handle, cmd: "env", env: { TOKEN: "hf_" + "x".repeat(34) } });
await call("bugnet_write_file", { handle, path: "notes/hello.txt", content: "hi there\n" });
await call("bugnet_list_files", { handle, path: ".", depth: 2 });
await call("bugnet_read_file", { handle, path: "notes/hello.txt" });
await call("bugnet_stop", { handle });
await call("bugnet_status", { handle });
await call("bugnet_exec", { handle: "sbx_aaaaaaaaaaaaaaaaaaaaaaaaaa", cmd: "true" });
await c.close();
