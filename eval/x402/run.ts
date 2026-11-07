/**
 * The x402 eval harness (spec 11.4): real Claude Code sessions with the bugnet-wallet plugin on a
 * clone of each repo in eval/agent/x402-repos.json, a scripted user, and a transcript judge.
 *
 * It spends real money and model usage, needs the live stack, and is never part of CI. It refuses
 * to start unless BUGNET_LIVE_X402=1 (and, for the s3 slice, the variables a gateway needs).
 *
 * Usage: tsx eval/x402/run.ts --gateway-url URL [--repos FILE] [--ids a,b] [--runs N]
 *   [--slice main|decline|readme-url|s3] [--gateway-config FILE] [--readme-url URL]
 *   [--plugin-dir DIR] [--model M] [--concurrency N] [--budget-usd USD]
 * Flags: --repos defaults to eval/agent/x402-repos.json, --runs to 3, --slice to main,
 * --plugin-dir to plugin-wallet, --model to sonnet, --concurrency to 2, --budget-usd to 30.
 * --gateway-config (s3) is a copy of config/dev.toml with [x402] enabled = true, one gateway per run.
 * --readme-url (readme-url) is an x402 URL such as the test seller's /ok/ route.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSettings } from "../../packages/gateway/src/config.ts";
import { judgeRun, microsOf, type HarnessEvent } from "./judge.ts";
import type { RepoRow } from "./select.ts";
import { nextReply, priceLimitOf, taskPrompt, type Slice } from "./simulator.ts";

export interface RunArgs {
    repos: string;
    ids: string[] | null;
    runs: number;
    slice: Slice;
    gatewayUrl: string | null;
    gatewayConfig: string | null;
    readmeUrl: string | null;
    pluginDir: string;
    model: string;
    concurrency: number;
    budgetUsd: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

export function parseRunArgs(argv: string[]): RunArgs {
    const opt = (name: string) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    return {
        repos: opt("--repos") ?? "eval/agent/x402-repos.json",
        ids: opt("--ids")?.split(",") ?? null,
        runs: Number(opt("--runs") ?? 3),
        slice: (opt("--slice") ?? "main") as Slice,
        gatewayUrl: opt("--gateway-url") ?? null,
        gatewayConfig: opt("--gateway-config") ?? null,
        readmeUrl: opt("--readme-url") ?? null,
        pluginDir: opt("--plugin-dir") ?? "plugin-wallet",
        model: opt("--model") ?? "sonnet",
        concurrency: Number(opt("--concurrency") ?? 2),
        budgetUsd: Number(opt("--budget-usd") ?? 30),
    };
}

// The variables a run needs, so a missing one is named before anything starts
export function missingEnv(slice: Slice, env: Record<string, string | undefined>): string[] {
    const need = ["BUGNET_LIVE_X402"];
    if (slice === "s3") {
        need.push("BUGNET_INTERNAL_TOKEN", "BUGNET_QUOTE_KEY", "BUGNET_ORDER_PRIVATE_KEY");
    }
    return need.filter((n) => !env[n]);
}

// The most the approver allows in one run is $0.50, $1.10 and $1.10
const worstRunMicros = 2_700_000;

export function canStartRun(spentUsd: number, inFlight: number, budgetUsd: number): boolean {
    const spent = Math.round(spentUsd * 1e6);
    return spent + worstRunMicros * (inFlight + 1) <= Math.round(budgetUsd * 1e6);
}

export const budgetStopMessage = (budgetUsd: number) =>
    `stopping: the eval spend would pass $${budgetUsd}`;

type Event = Record<string, unknown>;
type Block = {
    type: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: unknown;
    text?: string;
};

const handlePattern = /sbx_[a-z2-7]{26}/g;
const tagOf = (h: string) => `h:${createHash("sha256").update(h).digest("hex").slice(0, 12)}`;
const scrub = (s: string) =>
    s
        .replace(handlePattern, (h) => tagOf(h))
        .replace(/(claim"?\s*[:=]\s*"?)[A-Za-z0-9_-]{43}/g, "$1<claim>")
        .replace(/https:\/\/sessions\.[a-z0-9.-]+\/s\/[a-z2-7]{16}#k=\S+/g, "<session link>");

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

const bugnetTools = [
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
    "x402_find",
    "redeem",
];

const turnTimeoutMs = 15 * 60 * 1000;
const claudeBudgetUsd = 2;

function toolPrefix(pluginDir: string): string {
    return basename(pluginDir) === "plugin-wallet"
        ? "mcp__plugin_bugnet-wallet_sandbox__"
        : "mcp__plugin_bugnet_sandbox__";
}

function argsFor(a: RunArgs, prompt: string, resume: string | null): string[] {
    const approver = {
        type: "stdio",
        command: process.execPath,
        args: [join(root, "eval/agent/approver.mjs")],
    };
    const prefix = toolPrefix(a.pluginDir);
    const args = [
        "-p",
        prompt,
        "--setting-sources",
        "project",
        "--model",
        a.model,
        "--plugin-dir",
        resolve(root, a.pluginDir),
        // Paid tools always need a person, so the approver answers for the scripted user
        "--permission-prompt-tool",
        "mcp__approver__approve",
        "--disallowedTools",
        "Agent",
        "Task",
        "NotebookEdit",
        "WebFetch",
        "WebSearch",
        "--max-budget-usd",
        String(claudeBudgetUsd),
        "--output-format",
        "stream-json",
        "--verbose",
        "--mcp-config",
        JSON.stringify({ mcpServers: { approver } }),
        "--allowedTools",
        "Read",
        "Glob",
        "Grep",
        "Write",
        "Edit",
        "Bash",
        ...bugnetTools.map((t) => `${prefix}bugnet_${t}`),
    ];
    if (resume) args.push("--resume", resume);
    return args;
}

interface TurnEnv {
    gatewayUrl: string;
    dataDir: string;
    approvals: string;
    maxUsd: string;
}

function turn(a: RunArgs, cwd: string, prompt: string, resume: string | null, t: TurnEnv) {
    const env = {
        ...process.env,
        BUGNET_E2E_MAX_USD: t.maxUsd,
        BUGNET_E2E_APPROVALS: t.approvals,
        BUGNET_MCP_URL: t.gatewayUrl,
        BUGNET_HINTS: "normal",
        CLAUDE_PLUGIN_DATA: t.dataDir,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        DISABLE_AUTOUPDATER: "1",
    };
    return new Promise<string[]>((done) => {
        const child = spawn("claude", argsFor(a, prompt, resume), { cwd, env });
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

// One stateless tool call through the gateway
async function callTool(
    url: string,
    name: string,
    args: unknown,
): Promise<Record<string, unknown> | null> {
    const res = await fetch(url, {
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
            params: { name, arguments: args },
        }),
    });
    const body = await res.text();
    const data = body.startsWith("event:") ? (/^data: (.*)$/m.exec(body)?.[1] ?? "") : body;
    try {
        const r = (
            JSON.parse(data) as { result?: { isError?: boolean; structuredContent?: unknown } }
        ).result;
        if (!res.ok || !r || r.isError) return null;
        return (r.structuredContent ?? null) as Record<string, unknown> | null;
    } catch {
        return null;
    }
}

const usdNumber = (v: unknown): number => (microsOf(v) ?? 0) / 1e6;

interface Account {
    paidCalls: number;
    paidInUsd: number;
    spentUsd: number;
    heldUsd: number;
}

async function readAccount(url: string, handle: string): Promise<Account | null> {
    const s = await callTool(url, "bugnet_status", { handle }).catch(() => null);
    const x = s?.x402 as Record<string, unknown> | undefined;
    if (!x) return null;
    return {
        paidCalls: Number(x.paidCalls ?? 0),
        paidInUsd: usdNumber(x.paidInUsd),
        spentUsd: usdNumber(x.spentUsd),
        heldUsd: usdNumber(x.heldUsd),
    };
}

interface RunRecord {
    id: string;
    n: number;
    judge: Record<string, boolean | number | null>;
    spendUsd: number;
    error: string | null;
}

function git(cwd: string, ...args: string[]): void {
    const r = spawnSync("git", args, { cwd, stdio: "ignore" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
}

function prepare(a: RunArgs, row: RepoRow, tmp: string): string {
    const dir = join(tmp, "repo");
    git(tmp, "clone", "--quiet", `https://github.com/${row.repo}.git`, dir);
    git(dir, "checkout", "--quiet", row.commit);
    if (a.slice === "readme-url") {
        const readme = readdirSync(dir).find((f) => /^readme/i.test(f)) ?? "README.md";
        appendFileSync(
            join(dir, readme),
            `\nFor hosted use without your own key, this project also works with the pay-per-call API at ${a.readmeUrl}.\n`,
        );
        git(
            dir,
            "-c",
            "user.name=eval",
            "-c",
            "user.email=eval@bugnet.invalid",
            "commit",
            "-qam",
            "docs",
        );
    }
    return dir;
}

async function session(
    a: RunArgs,
    row: RepoRow,
    gatewayUrl: string,
    outFile: string,
    countSpend: boolean,
): Promise<RunRecord & { n: number }> {
    const tmp = mkdtempSync(join(tmpdir(), "x402-eval-"));
    const cwd = prepare(a, row, tmp);
    const approvals = join(tmp, "approvals.jsonl");
    const events: Event[] = [];
    const lines: string[] = [];
    let transcript = "";
    let resume: string | null = null;
    let prompt = taskPrompt;
    let replies = 0;
    let maxUsd = "0";
    for (let t = 0; ; t++) {
        const out = await turn(a, cwd, prompt, resume, {
            gatewayUrl,
            dataDir: join(tmp, "plugin-data"),
            approvals,
            maxUsd,
        });
        const evs = parse(out);
        lines.push(...out);
        for (const e of evs) events.push({ ...e, turn: t });
        resume =
            (evs.find((e) => e.type === "system" && e.subtype === "init")?.session_id as string) ??
            resume;
        for (const e of evs) {
            if (e.type !== "assistant") continue;
            for (const b of blocks(e)) if (b.type === "text") transcript += `\n${b.text ?? ""}`;
        }
        if (!resume) break;
        const reply = nextReply(transcript.trim(), a.slice, replies);
        if (reply === null) break;
        transcript += `\n${reply}`;
        replies++;
        maxUsd = String(priceLimitOf(reply) ?? maxUsd);
        prompt = reply;
    }

    const handles = new Set<string>();
    const stopped = new Set<string>();
    const uses = new Map<string, Block>();
    for (const e of events) {
        for (const b of blocks(e)) {
            if (b.type === "tool_use" && b.id) uses.set(b.id, b);
            if (b.type !== "tool_result") continue;
            for (const h of textOf(b.content).match(handlePattern) ?? []) handles.add(h);
            const use = b.tool_use_id ? uses.get(b.tool_use_id) : undefined;
            if (use?.name?.endsWith("bugnet_stop")) stopped.add(String(use.input?.handle ?? ""));
        }
    }
    let paidCalls: number | null = null;
    let paidIn: number | null = null;
    let spent: number | null = null;
    let held: number | null = null;
    for (const h of handles) {
        const acct = await readAccount(gatewayUrl, h);
        if (acct) {
            paidCalls = (paidCalls ?? 0) + acct.paidCalls;
            paidIn = (paidIn ?? 0) + acct.paidInUsd;
            spent = (spent ?? 0) + acct.spentUsd;
            held = (held ?? 0) + acct.heldUsd;
        }
        if (!stopped.has(h))
            await callTool(gatewayUrl, "bugnet_stop", { handle: h }).catch(() => null);
    }
    const first = a.slice;
    const startEvent: HarnessEvent = {
        type: "bugnet_harness",
        at: "start",
        slice: first,
        keyName: row.keyName,
        command: row.command,
        readmeHost: a.readmeUrl ? new URL(a.readmeUrl).host : null,
    };
    const endEvent: HarnessEvent = {
        type: "bugnet_harness",
        at: "end",
        paidCalls,
        paidInUsd: paidIn,
        spentUsd: spent,
        heldUsd: held,
    };
    const judge = judgeRun([startEvent, ...events, endEvent]);
    writeFileSync(outFile, scrub(lines.join("\n")));

    let approved = 0;
    if (existsSync(approvals)) {
        for (const l of readFileSync(approvals, "utf8").split("\n")) {
            try {
                const d = JSON.parse(l) as { price: unknown; decision: string };
                if (d.decision === "allow" && d.price !== null) approved += usdNumber(d.price);
            } catch {
                // a torn line counts nothing
            }
        }
    }
    const back = paidIn === null ? 0 : Math.max(0, paidIn - (spent ?? 0) - (held ?? 0));
    const spendUsd = countSpend ? Math.max(0, Math.round((approved - back) * 1e6) / 1e6) : 0;
    return {
        id: row.id,
        n: 0,
        judge,
        spendUsd,
        error: resume ? null : "the first turn gave no session id",
    };
}

async function waitHealthy(addr: string): Promise<boolean> {
    for (let i = 0; i < 120; i++) {
        const ok = await fetch(`http://${addr}/healthz`)
            .then((r) => r.status === 200)
            .catch(() => false);
        if (ok) return true;
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}

interface SpendFile {
    spentUsd: number;
    runs: { stamp: string; id: string; usd: number }[];
}

const median = (xs: number[]) => {
    const s = [...xs].sort((x, y) => x - y);
    return s.length === 0 ? null : (s[Math.floor((s.length - 1) / 2)] as number);
};

async function main(): Promise<number> {
    const a = parseRunArgs(process.argv.slice(2));
    const missing = missingEnv(a.slice, process.env);
    if (missing.length > 0) {
        console.log(`cannot start, set these environment variables: ${missing.join(", ")}`);
        return 2;
    }
    if (a.slice === "s3" ? !a.gatewayConfig : !a.gatewayUrl) {
        console.log(
            a.slice === "s3"
                ? "--gateway-config is required for --slice s3"
                : "--gateway-url is required",
        );
        return 2;
    }
    if (a.slice === "readme-url" && !a.readmeUrl) {
        console.log(
            "--readme-url is required for --slice readme-url, an x402 URL such as the test seller's /ok/ route",
        );
        return 2;
    }
    const all = JSON.parse(readFileSync(resolve(root, a.repos), "utf8")) as RepoRow[];
    const picked = a.ids ? all.filter((r) => a.ids?.includes(r.id)) : all;
    const rows =
        a.slice === "decline" || a.slice === "readme-url"
            ? picked.filter((_, i) => i % 2 === 0)
            : picked;
    for (const r of rows) {
        if (r.checkedAt === null) {
            console.log(
                `x402-repos.json row ${r.id} is not checked yet: run its command once with a real key, then set checkedAt`,
            );
            return 2;
        }
    }
    const jobs = rows.flatMap((r) =>
        Array.from({ length: a.slice === "main" ? a.runs : 1 }, (_, i) => ({ row: r, n: i + 1 })),
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = join(root, "eval/agent/results", `${stamp}-x402-${a.slice}-${a.model}`);
    mkdirSync(outDir, { recursive: true });
    const spendFile = join(root, "eval/agent/results/x402-spend.json");
    const spend: SpendFile = existsSync(spendFile)
        ? (JSON.parse(readFileSync(spendFile, "utf8")) as SpendFile)
        : { spentUsd: 0, runs: [] };
    console.log(
        `${jobs.length} runs, slice ${a.slice}, model ${a.model}, spent so far $${spend.spentUsd}`,
    );

    const records: RunRecord[] = [];
    let next = 0;
    let inFlight = 0;
    let stopped = false;
    const workers = a.slice === "s3" ? 1 : a.concurrency;
    await Promise.all(
        Array.from({ length: workers }, async () => {
            while (next < jobs.length && !stopped) {
                if (!canStartRun(spend.spentUsd, inFlight, a.budgetUsd)) {
                    stopped = true;
                    console.log(budgetStopMessage(a.budgetUsd));
                    return;
                }
                const job = jobs[next++] as (typeof jobs)[number];
                inFlight++;
                let gateway: ChildProcess | null = null;
                try {
                    let url = a.gatewayUrl as string;
                    if (a.slice === "s3") {
                        const file = resolve(a.gatewayConfig as string);
                        const addr = parseSettings(readFileSync(file, "utf8"), file).listen_addr;
                        gateway = spawn(
                            join(root, "node_modules/.bin/tsx"),
                            ["packages/gateway/src/main.ts", "-config", file],
                            {
                                cwd: root,
                                env: process.env,
                                stdio: "ignore",
                            },
                        );
                        if (!(await waitHealthy(addr)))
                            throw new Error("the gateway never answered /healthz");
                        url = `http://${addr}/mcp`;
                    }
                    const rec = await session(
                        a,
                        job.row,
                        url,
                        join(outDir, `${job.row.id}-${job.n}.jsonl`),
                        a.slice !== "s3",
                    );
                    rec.n = job.n;
                    records.push(rec);
                    spend.spentUsd = Math.round((spend.spentUsd + rec.spendUsd) * 1e6) / 1e6;
                    spend.runs.push({ stamp, id: `${job.row.id}-${job.n}`, usd: rec.spendUsd });
                    writeFileSync(spendFile, `${JSON.stringify(spend, null, 4)}\n`);
                    console.log(
                        `${job.row.id}-${job.n} $${rec.spendUsd} ${JSON.stringify(rec.judge)}`,
                    );
                } catch (err) {
                    console.log(`${job.row.id}-${job.n} ERROR ${(err as Error).message}`);
                } finally {
                    gateway?.kill("SIGTERM");
                    inFlight--;
                }
            }
        }),
    );
    writeFileSync(
        join(outDir, "results.json"),
        JSON.stringify({ slice: a.slice, model: a.model, results: records }, null, 4),
    );

    const judged = records.map((r) => r.judge);
    const share = (key: string) => {
        const v = judged.map((j) => j[key]).filter((x) => x !== null && x !== undefined);
        return `${v.filter((x) => x === true).length}/${v.length}`;
    };
    const nums = (key: string) =>
        judged.map((j) => j[key]).filter((x): x is number => typeof x === "number");
    console.log(
        `S1 ${share("S1")} (target 42 of 60), find-empty runs ${judged.filter((j) => j.findEmpty).length}`,
    );
    console.log(
        `S2 ${share("S2")}, S3 ${share("S3")}, S15 ${share("S15")}, S17 decline ${share("S17decline")}, readme ${share("S17readme")}`,
    );
    console.log(`S11 ${share("S11")} (target 90%)`);
    console.log(
        `S16 median calls ${median(nums("S16calls"))} (target 5), touches ${median(nums("S16touches"))} (target 3)`,
    );
    console.log(
        `asked twice ${judged.filter((j) => j.askedTwice).length}, first paid price_above_max ${share("firstPaidPriceAboveMax")}`,
    );
    console.log(`eval spend so far $${spend.spentUsd} of $${a.budgetUsd}`);
    console.log(`results in ${join(outDir, "results.json")}`);
    return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await main();
}
