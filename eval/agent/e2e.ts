/**
 * End-to-end judge: real Claude Code sessions that do real tasks in real Bugnet sandboxes.
 *
 * Each task runs as two turns in a fresh empty folder, cut off from the user's own settings: the
 * task, then a scripted user reply that accepts Bugnet within a price. The session sees only the
 * Bugnet MCP server, the shell, subagent, edit and web tools are removed, so all work happens in
 * the sandbox, and approver.mjs answers the approval prompts of paid tools within the reply's price. After each session the harness stops every sandbox the session started
 * and left running. The report lists, per task, the package, the tools called, every refusal,
 * whether the agent stopped its sandbox, and its final answer. Handles appear only as tags.
 *
 * Usage: tsx eval/agent/e2e.ts --gateway-url URL [--ids T1-kokoro,T2-git-extras] [--model M]
 *   [--concurrency N] [--max-usd PER_SESSION] [--reply TEXT] [--tasks FILE]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Task {
    id: string;
    task: string;
}

interface Call {
    tool: string;
    error: string | null;
}

interface TaskResult {
    id: string;
    packageId: string | null;
    started: boolean;
    extended: boolean;
    stoppedByAgent: boolean;
    cleanedUp: string[];
    calls: Call[];
    deniedShell: number;
    costUsd: number;
    minutes: number;
    error: string | null;
    finalText: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const gatewayUrl = opt("--gateway-url");
if (!gatewayUrl) throw new Error("--gateway-url is required");
const ids = opt("--ids")?.split(",");
const model = opt("--model") ?? "sonnet";
const concurrency = Number(opt("--concurrency") ?? 2);
const maxUsd = Number(opt("--max-usd") ?? 1.5);
const reply = opt("--reply") ?? "Yes, run it in Bugnet, up to $0.50 is fine.";
const turnTimeoutMs = 15 * 60 * 1000;

// Paid tools stay off this list, so their approval prompts reach the approver and its price limit
const tools = [
    "assess",
    "quote",
    "status",
    "exec",
    "job",
    "cancel_job",
    "list_files",
    "read_file",
    "write_file",
    "stop",
    "preview",
    "transfer",
    "ssh",
    "ssh_remove",
    "secret_link",
    "secrets",
    "secret_delete",
    "fetch_source",
].map((t) => `mcp__bugnet__bugnet_${t}`);

const handlePattern = /sbx_[a-z2-7]{26}/g;
const tagOf = (h: string) => `h:${createHash("sha256").update(h).digest("hex").slice(0, 12)}`;
const scrub = (s: string) => s.replace(handlePattern, (h) => tagOf(h));

const priceLimit = (reply.match(/\$(\d+(?:\.\d+)?)/) ?? [])[1] ?? "0.5";

function argsFor(prompt: string, resume: string | null): string[] {
    const approver = {
        type: "stdio",
        command: process.execPath,
        args: [join(here, "approver.mjs")],
    };
    const servers = { mcpServers: { bugnet: { type: "http", url: gatewayUrl }, approver } };
    const a = [
        "-p",
        prompt,
        "--setting-sources",
        "project",
        "--model",
        model,
        // Paid tools always need a person, so the approver answers for the scripted user
        "--permission-prompt-tool",
        "mcp__approver__approve",
        "--disallowedTools",
        "Bash",
        "Agent",
        "Task",
        "Edit",
        "NotebookEdit",
        "WebFetch",
        "WebSearch",
        "--max-budget-usd",
        String(maxUsd),
        "--output-format",
        "stream-json",
        "--verbose",
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify(servers),
        "--allowedTools",
        "Read",
        "Glob",
        "Grep",
        "Write",
        ...tools,
    ];
    if (resume) a.push("--resume", resume);
    return a;
}

function turn(cwd: string, prompt: string, resume: string | null, approvals: string) {
    const env = {
        ...process.env,
        BUGNET_E2E_MAX_USD: priceLimit,
        BUGNET_E2E_APPROVALS: approvals,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        DISABLE_AUTOUPDATER: "1",
    };
    return new Promise<string[]>((done) => {
        const child = spawn("claude", argsFor(prompt, resume), { cwd, env });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", () => {});
        const timer = setTimeout(() => child.kill("SIGINT"), turnTimeoutMs);
        child.on("close", () => {
            clearTimeout(timer);
            done(out.split("\n"));
        });
    });
}

type Event = Record<string, unknown>;
type Block = {
    type: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    is_error?: boolean;
    content?: unknown;
};

const parse = (lines: string[]): Event[] =>
    lines.flatMap((l) => {
        try {
            return [JSON.parse(l) as Event];
        } catch {
            return [];
        }
    });

const blocks = (e: Event): Block[] => {
    const content = (e.message as { content?: unknown })?.content;
    return Array.isArray(content) ? (content as Block[]) : [];
};

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((c) => (c as { text?: string }).text ?? "").join("\n")
          : "";

// Stops a sandbox through the gateway, which needs no session for one stateless call
async function stop(handle: string): Promise<boolean> {
    const res = await fetch(gatewayUrl as string, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "bugnet_stop", arguments: { handle } },
        }),
    });
    const body = await res.text();
    return res.ok && !body.includes('"isError":true');
}

async function runTask(t: Task, outDir: string): Promise<TaskResult> {
    const cwd = mkdtempSync(join(tmpdir(), "cc-e2e-"));
    const began = Date.now();
    const approvals = join(outDir, `${t.id}.approvals.jsonl`);
    const first = await turn(cwd, t.task, null, approvals);
    const session = parse(first).find((e) => e.type === "system" && e.subtype === "init")
        ?.session_id as string | undefined;
    const second = session ? await turn(cwd, reply, session, approvals) : [];
    const lines = [...first, ...second];
    writeFileSync(join(outDir, `${t.id}.jsonl`), lines.join("\n"));

    const events = parse(lines);
    const uses = new Map<string, Block>();
    const calls: Call[] = [];
    const handles = new Set<string>();
    const stopped = new Set<string>();
    let packageId: string | null = null;
    let started = false;
    let extended = false;
    let deniedShell = 0;
    for (const e of events) {
        for (const b of blocks(e)) {
            if (b.type === "tool_use" && b.id) uses.set(b.id, b);
            if (b.type !== "tool_result" || !b.tool_use_id) continue;
            const use = uses.get(b.tool_use_id);
            if (!use?.name) continue;
            const text = textOf(b.content);
            for (const h of text.match(handlePattern) ?? []) handles.add(h);
            if (use.name === "Bash") {
                deniedShell++;
                continue;
            }
            const tool = use.name.replace(/^mcp__bugnet__/, "");
            calls.push({ tool, error: b.is_error ? scrub(text).slice(0, 200) : null });
            if (b.is_error) continue;
            if (tool === "bugnet_start") {
                started = true;
                packageId = String(use.input?.packageId ?? "") || null;
            }
            if (tool === "bugnet_extend") extended = true;
            if (tool === "bugnet_stop") stopped.add(String(use.input?.handle ?? ""));
        }
    }
    const cleanedUp: string[] = [];
    for (const h of handles) {
        if (stopped.has(h)) continue;
        const ok = await stop(h).catch(() => false);
        cleanedUp.push(`${tagOf(h)} ${ok ? "stopped" : "stop failed"}`);
    }
    const results = events.filter((e) => e.type === "result") as {
        result?: string;
        total_cost_usd?: number;
    }[];
    return {
        id: t.id,
        packageId,
        started,
        extended,
        stoppedByAgent: stopped.size > 0,
        cleanedUp,
        calls,
        deniedShell,
        costUsd: results.reduce((s, r) => s + (r.total_cost_usd ?? 0), 0),
        minutes: Math.round((Date.now() - began) / 6000) / 10,
        error: session ? null : "the first turn gave no session id",
        finalText: scrub(results.at(-1)?.result ?? "").slice(0, 1500),
    };
}

const taskFile = opt("--tasks") ?? join(here, "e2e-tasks.json");
const all = JSON.parse(readFileSync(taskFile, "utf8")) as Task[];
const tasks = ids ? all.filter((t) => ids.includes(t.id)) : all;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(here, "results", `${stamp}-e2e-${model}`);
mkdirSync(outDir, { recursive: true });
console.log(`${tasks.length} tasks on ${gatewayUrl}, model ${model}, ${concurrency} at a time`);

const results: TaskResult[] = [];
let next = 0;
await Promise.all(
    Array.from({ length: concurrency }, async () => {
        while (next < tasks.length) {
            const t = tasks[next++] as Task;
            const r = await runTask(t, outDir);
            results.push(r);
            const errs = r.calls.filter((c) => c.error).length;
            console.log(
                `${r.started ? "ran " : "NONE"} ${r.id.padEnd(18)} package=${r.packageId ?? "-"} ` +
                    `calls=${r.calls.length} refusals=${errs} extended=${r.extended} ` +
                    `stopped=${r.stoppedByAgent} cleanup=${r.cleanedUp.join(",") || "-"} ` +
                    `$${r.costUsd.toFixed(2)} ${r.minutes} min${r.error ? ` ERROR ${r.error}` : ""}`,
            );
        }
    }),
);
writeFileSync(
    join(outDir, "results.json"),
    JSON.stringify({ gatewayUrl, model, results }, null, 4),
);
console.log(`results in ${join(outDir, "results.json")}`);
