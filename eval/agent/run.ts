/**
 * Live judge for intent detection: real Claude Code sessions on labelled prompts.
 *
 * Each prompt runs in a fresh empty directory under `claude -p`, cut off from the user's own
 * settings, memory, CLAUDE.md and connectors, once per arm: "baseline" without Bugnet, "mcp" with
 * only the Bugnet MCP server (instructions and tools), and "plugin" with the Claude Code plugin
 * (server, skill and hint hooks). Shell commands are denied, so nothing runs on this machine, but
 * attempts are recorded. Free Bugnet tools (assess, quote) are allowed, paid ones are not.
 *
 * A run "offers" Bugnet when, before its first shell command, it calls or searches for a Bugnet
 * tool or its text mentions Bugnet (baseline: any sandbox, VM or container suggestion). Offers
 * made only after a denied shell command are reported as late, since the denial itself can push
 * the agent toward alternatives. "before-run" also counts offers made after read-only looks such
 * as ls, but before any command that fetches, installs or runs code. "local_first" means a local
 * install or run was tried before any offer. The gate is "told-before-run": the text the user
 * sees names Bugnet before any fetch, install or run, since a silent tool call offers nothing.
 * On no-prompts "told" is a false offer and "any-touch" also counts silent Bugnet calls. Settings
 * come from eval/agent/config.json. --rescore FILE scores a saved run again from its transcripts.
 *
 * Usage: tsx eval/agent/run.ts [--split dev|test|NAME] [--arms mcp,plugin] [--limit N] [--model M]
 *   [--suggest N] [--no N] [--ids a,b] [--gateway-url URL] [--plugin-dir DIR] [--tag NAME]
 *   [--concurrency N] [--budget USD] [--rescore RESULTS.json]
 *
 * Every run's event stream is saved next to the results file, for reading why an agent did what
 * it did.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Arm = "baseline" | "mcp" | "plugin";

interface Config {
    gatewayUrl: string;
    pluginDir: string;
    model: string;
    concurrency: number;
    perRun: { maxBudgetUsd: number; timeoutSeconds: number };
    budgetUsd: number;
    sample: { suggest: number; no: number };
    arms: Arm[];
}

interface Item {
    id: string;
    kind: "prompt" | "command";
    text: string;
    label: "suggest" | "no";
    borderline: boolean;
    category: string;
}

interface RunResult {
    id: string;
    // The event stream, written to the transcripts folder and left out of the results file
    lines?: string[];
    arm: Arm;
    label: Item["label"];
    category: string;
    // Offered Bugnet before any shell command, the only offers that count
    offered: boolean;
    // Mentioned only after a denied shell command, reported but not counted
    offeredLate: boolean;
    // Offered before any command that fetches, installs or runs code, read-only looks allowed
    offeredBeforeRun: boolean;
    // The user-visible text named Bugnet before any fetch, install or run, the gate
    toldBeforeRun: boolean;
    // The user-visible text named Bugnet at any point
    told: boolean;
    called: string[];
    mentioned: boolean;
    localFirst: boolean;
    bashAttempts: string[];
    hookHints: number;
    costUsd: number;
    turns: number;
    error: string | null;
    finalText: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const cfg = JSON.parse(readFileSync(join(here, "config.json"), "utf8")) as Config;
const split = opt("--split") ?? "dev";
const arms = (opt("--arms")?.split(",") as Arm[] | undefined) ?? cfg.arms;
const limit = opt("--limit") ? Number(opt("--limit")) : Infinity;
const ids = opt("--ids")?.split(",");
const tag = opt("--tag") ?? "";
cfg.model = opt("--model") ?? cfg.model;
cfg.gatewayUrl = opt("--gateway-url") ?? cfg.gatewayUrl;
cfg.concurrency = Number(opt("--concurrency") ?? cfg.concurrency);
cfg.budgetUsd = Number(opt("--budget") ?? cfg.budgetUsd);
cfg.sample.suggest = Number(opt("--suggest") ?? cfg.sample.suggest);
cfg.sample.no = Number(opt("--no") ?? cfg.sample.no);
const pluginDir = opt("--plugin-dir")
    ? resolve(opt("--plugin-dir") as string)
    : resolve(here, cfg.pluginDir);

// A stable order by hash, so a sample is the same on every run and spread across lenses
const rank = (id: string) => createHash("sha256").update(id).digest("hex");

function sample(): Item[] {
    const dir = join(here, "../intent");
    const items = readdirSync(dir)
        .filter((f) => f.endsWith(`.${split}.jsonl`))
        .flatMap((f) =>
            readFileSync(join(dir, f), "utf8")
                .split("\n")
                .filter((l) => l.trim())
                .map((l) => JSON.parse(l) as Item),
        )
        .filter((i) => i.kind === "prompt" && !i.borderline)
        .sort((a, b) => rank(a.id).localeCompare(rank(b.id)));
    if (ids) return items.filter((i) => ids.includes(i.id));
    const pick = (label: Item["label"], n: number) =>
        items.filter((i) => i.label === label).slice(0, n);
    return [...pick("suggest", cfg.sample.suggest), ...pick("no", cfg.sample.no)].slice(0, limit);
}

const freeTools = ["bugnet_assess", "bugnet_quote"];

function argsFor(arm: Arm, prompt: string): string[] {
    const allowed = ["Read", "Glob", "Grep", "Skill"];
    const a = [
        "-p",
        prompt,
        "--setting-sources",
        "project",
        "--model",
        cfg.model,
        "--permission-mode",
        "dontAsk",
        "--disallowedTools",
        "WebFetch",
        "WebSearch",
        "--max-budget-usd",
        String(cfg.perRun.maxBudgetUsd),
        "--no-session-persistence",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-hook-events",
    ];
    if (arm === "baseline") a.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
    if (arm === "mcp") {
        const servers = { mcpServers: { bugnet: { type: "http", url: cfg.gatewayUrl } } };
        a.push("--strict-mcp-config", "--mcp-config", JSON.stringify(servers));
        allowed.push(...freeTools.map((t) => `mcp__bugnet__${t}`));
    }
    if (arm === "plugin") {
        a.push("--plugin-dir", pluginDir);
        allowed.push(...freeTools.map((t) => `mcp__plugin_bugnet_sandbox__${t}`));
    }
    a.push("--allowedTools", ...allowed);
    return a;
}

const installOrRun =
    /\b(pip3?|uv|conda|npm|pnpm|yarn|bun|cargo|go|brew|apt(-get)?|docker|git clone|curl|wget|python3?|node|ollama|huggingface-cli|hf)\b/;

function score(item: Item, arm: Arm, lines: string[]): Omit<RunResult, "error"> {
    const events = lines.flatMap((l) => {
        try {
            return [JSON.parse(l) as Record<string, unknown>];
        } catch {
            return [];
        }
    });
    const mentions = (text: string) =>
        arm === "baseline"
            ? /\b(sandbox|virtual machine|VM|container|docker|isolated)\b/i.test(text)
            : /\bbugnet\b/i.test(text);
    const called: string[] = [];
    const bashAttempts: string[] = [];
    let offeredBeforeBash = false;
    let offeredBeforeRun = false;
    let toldBeforeRun = false;
    let told = false;
    let runs = 0;
    let mentioned = false;
    let localFirst = false;
    let hookHints = 0;
    for (const e of events) {
        if (e.type === "system" && e.subtype === "hook_response") {
            if (String(e.output ?? "").includes("additionalContext")) hookHints++;
        }
        if (e.type !== "assistant" || e.parent_tool_use_id) continue;
        type Block = { type: string; name?: string; input?: unknown; text?: string };
        const content = (e.message as { content?: Block[] })?.content ?? [];
        for (const c of content) {
            if (c.type === "text" && mentions(c.text ?? "")) {
                mentioned = true;
                told = true;
                if (bashAttempts.length === 0) offeredBeforeBash = true;
                if (runs === 0) offeredBeforeRun = toldBeforeRun = true;
            }
            if (c.type !== "tool_use" || !c.name) continue;
            if (c.name === "Skill") {
                const skill = String((c.input as { skill?: string })?.skill ?? "");
                called.push(`Skill:${skill}`);
                if (/sandbox|bugnet/i.test(skill)) {
                    if (bashAttempts.length === 0) offeredBeforeBash = true;
                    if (runs === 0) offeredBeforeRun = true;
                }
                continue;
            }
            const searched =
                c.name === "ToolSearch" && /bugnet|sandbox/i.test(JSON.stringify(c.input ?? ""));
            if (/bugnet/i.test(c.name) || searched) {
                called.push(searched ? "ToolSearch" : c.name.replace(/^mcp__.*__/, ""));
                if (bashAttempts.length === 0) offeredBeforeBash = true;
                if (runs === 0) offeredBeforeRun = true;
            }
            if (c.name === "Bash") {
                const cmd = String((c.input as { command?: string })?.command ?? "");
                bashAttempts.push(cmd.slice(0, 200));
                if (!offeredBeforeBash && installOrRun.test(cmd)) localFirst = true;
                if (installOrRun.test(cmd)) runs++;
            }
        }
    }
    const result = events.find((e) => e.type === "result") as
        { result?: string; total_cost_usd?: number; num_turns?: number } | undefined;
    const finalText = result?.result ?? "";
    if (mentions(finalText)) {
        mentioned = true;
        told = true;
        if (bashAttempts.length === 0) offeredBeforeBash = true;
        if (runs === 0) offeredBeforeRun = toldBeforeRun = true;
    }
    return {
        id: item.id,
        arm,
        label: item.label,
        category: item.category,
        offered: offeredBeforeBash,
        offeredLate: mentioned && !offeredBeforeBash,
        offeredBeforeRun,
        toldBeforeRun,
        told,
        called,
        mentioned,
        localFirst,
        bashAttempts,
        hookHints,
        costUsd: result?.total_cost_usd ?? 0,
        turns: result?.num_turns ?? 0,
        finalText: finalText.slice(0, 1500),
    };
}

function runOne(item: Item, arm: Arm): Promise<RunResult> {
    const cwd = mkdtempSync(join(tmpdir(), "cc-eval-"));
    const env = {
        ...process.env,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        DISABLE_AUTOUPDATER: "1",
        BUGNET_MCP_URL: cfg.gatewayUrl,
        BUGNET_HINTS: "normal",
        CLAUDE_PLUGIN_DATA: join(cwd, ".plugin-data"),
    };
    return new Promise((done) => {
        const child = spawn("claude", argsFor(arm, item.text), { cwd, env });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        const timer = setTimeout(() => child.kill("SIGINT"), cfg.perRun.timeoutSeconds * 1000);
        child.on("close", (code) => {
            clearTimeout(timer);
            const s = score(item, arm, out.split("\n"));
            const error = code === 0 ? null : `exit ${code}: ${err.slice(0, 200)}`;
            done({ ...s, error, lines: out.split("\n") });
        });
    });
}

async function pool<T>(jobs: (() => Promise<T>)[], n: number, stop: () => boolean): Promise<T[]> {
    const out: T[] = [];
    let next = 0;
    const worker = async () => {
        while (next < jobs.length && !stop()) {
            const job = jobs[next++] as () => Promise<T>;
            out.push(await job());
        }
    };
    await Promise.all(Array.from({ length: n }, worker));
    return out;
}

const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((a / b) * 100).toFixed(0)}%`);

function summarize(results: RunResult[], arms: Arm[]): void {
    const cols = [
        "told-before-run(suggest)",
        "offered(suggest)",
        "before-run(suggest)",
        "told(no)",
        "any-touch(no)",
        "local-first(suggest)",
        "errors",
        "cost",
    ];
    console.log(`\n${"arm".padEnd(9)} ${cols.join("  ")}`);
    for (const arm of arms) {
        const rs = results.filter((r) => r.arm === arm);
        const pos = rs.filter((r) => r.label === "suggest");
        const neg = rs.filter((r) => r.label === "no");
        const share = (set: RunResult[], f: (r: RunResult) => boolean) =>
            pct(set.filter(f).length, set.length);
        const cells = [
            share(pos, (r) => r.toldBeforeRun),
            share(pos, (r) => r.offered),
            share(pos, (r) => r.offeredBeforeRun),
            share(neg, (r) => r.told),
            share(neg, (r) => r.mentioned || r.called.length > 0),
            share(pos, (r) => r.localFirst),
            String(rs.filter((r) => r.error).length),
            `$${rs.reduce((t, r) => t + r.costUsd, 0).toFixed(2)}`,
        ];
        console.log(
            `${arm.padEnd(9)} ${cells.map((c, i) => c.padStart((cols[i] as string).length)).join("  ")}`,
        );
    }
}

/* Rescore */

const rescore = opt("--rescore");
if (rescore) {
    const saved = JSON.parse(readFileSync(rescore, "utf8")) as {
        arms: Arm[];
        results: RunResult[];
    };
    const dir = rescore.replace(/\.json$/, "");
    const results = saved.results.map((r) => {
        const lines = readFileSync(join(dir, `${r.id}.${r.arm}.jsonl`), "utf8").split("\n");
        const item = { id: r.id, label: r.label, category: r.category } as Item;
        return { ...score(item, r.arm, lines), error: r.error };
    });
    summarize(results, saved.arms);
    process.exit(0);
}

/* Run */

const items = sample();
let spent = 0;
const jobs = items.flatMap((item) =>
    arms.map((arm) => async () => {
        const r = await runOne(item, arm);
        spent += r.costUsd;
        const mark = r.toldBeforeRun === (r.label === "suggest") ? "ok  " : "MISS";
        console.log(
            `${mark} ${arm.padEnd(8)} ${r.id.padEnd(24)} ${r.label.padEnd(7)} told=${r.toldBeforeRun} ` +
                `offered=${r.offered} called=${r.called.join("+") || "-"} ` +
                `localFirst=${r.localFirst} hints=${r.hookHints} ` +
                `$${r.costUsd.toFixed(3)}${r.error ? ` ERROR ${r.error}` : ""}`,
        );
        return r;
    }),
);
console.log(`${items.length} prompts x ${arms.length} arms on ${split}, model ${cfg.model}`);
const results = await pool(jobs, cfg.concurrency, () => spent >= cfg.budgetUsd);
summarize(results, arms);
if (spent >= cfg.budgetUsd) console.log(`stopped at the $${cfg.budgetUsd} budget`);

const outDir = join(here, "results");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const name = `${stamp}-${split}-${cfg.model}${tag ? `-${tag}` : ""}`;
const transcripts = join(outDir, name);
mkdirSync(transcripts, { recursive: true });
for (const r of results) {
    writeFileSync(join(transcripts, `${r.id}.${r.arm}.jsonl`), (r.lines ?? []).join("\n"));
    delete r.lines;
}
const file = join(outDir, `${name}.json`);
const meta = { split, model: cfg.model, arms, gatewayUrl: cfg.gatewayUrl, pluginDir, tag };
writeFileSync(file, JSON.stringify({ ...meta, results }, null, 4));
console.log(`results in ${file}, transcripts in ${transcripts}`);
