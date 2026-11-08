import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    armRates,
    baselineFile,
    offerRateCheck,
    shortArms,
    type RunRow,
} from "../../../eval/x402/heldout.ts";
import { judgeRun } from "../../../eval/x402/judge.ts";
import {
    budgetStopMessage,
    canStartRun,
    missingEnv,
    parseRunArgs,
} from "../../../eval/x402/run.ts";
import {
    collectCandidates,
    envReadPattern,
    keepRepo,
    type RepoFacts,
    type RepoRow,
} from "../../../eval/x402/select.ts";
import { nextReply, priceLimitOf, replyTexts } from "../../../eval/x402/simulator.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const baseline = JSON.parse(readFileSync(join(root, baselineFile), "utf8")) as {
    results: RunRow[];
};

describe("held-out interval check", () => {
    it("passes a drop within the interval and fails one past it", () => {
        const base = [{ arm: "mcp" as const, offered: 91, runs: 108, toldNo: 0 }];
        const at = (offered: number) => [{ arm: "mcp" as const, offered, runs: 108, toldNo: 0 }];
        expect(offerRateCheck(base, at(86)).pass).toBe(true);
        expect(offerRateCheck(base, at(76)).pass).toBe(false);
        const rate = (arm: "mcp" | "plugin", offered: number) => [
            { arm, offered, runs: 44, toldNo: 0 },
        ];
        expect(offerRateCheck(rate("mcp", 37), rate("mcp", 30)).pass).toBe(true);
        expect(offerRateCheck(rate("mcp", 37), rate("mcp", 29)).pass).toBe(false);
        expect(offerRateCheck(rate("plugin", 35), rate("plugin", 27)).pass).toBe(true);
        expect(offerRateCheck(rate("plugin", 35), rate("plugin", 26)).pass).toBe(false);
        expect(offerRateCheck(rate("mcp", 30), rate("mcp", 40)).pass).toBe(true);
        expect(offerRateCheck(rate("mcp", 37), rate("mcp", 30)).lines[0]).toBe(
            "mcp offered 30/44 (68.2%) against 37/44 (84.1%): drop 15.9 points, allowed 17.5, told(no) 0, pass",
        );
    });

    it("fails any told(no)", () => {
        const base = [{ arm: "mcp" as const, offered: 37, runs: 44, toldNo: 0 }];
        const out = offerRateCheck(base, [{ ...base[0]!, toldNo: 1 }]);
        expect(out.pass).toBe(false);
        expect(out.lines[0]!.endsWith("told(no) 1, FAIL")).toBe(true);
    });

    it("fails an arm the rerun lacks", () => {
        const base = [
            { arm: "mcp" as const, offered: 37, runs: 44, toldNo: 0 },
            { arm: "plugin" as const, offered: 35, runs: 44, toldNo: 0 },
        ];
        const out = offerRateCheck(base, [base[0]!]);
        expect(out.pass).toBe(false);
        expect(out.lines).toContain("plugin missing from the rerun, FAIL");
    });

    it("counts the baseline as run.ts scores it", () => {
        expect(armRates(baseline.results)).toEqual([
            { arm: "mcp", offered: 37, runs: 44, toldNo: 0 },
            { arm: "plugin", offered: 35, runs: 44, toldNo: 0 },
        ]);
        expect(baseline.results).toHaveLength(324);
    });

    it("fails a rerun cut short", () => {
        const rows = baseline.results;
        expect(shortArms(rows, rows)).toEqual([]);
        let kept = 0;
        const cut = rows.filter((r) => {
            if (r.arm !== "mcp" || r.label !== "no") return true;
            return ++kept <= 40;
        });
        expect(shortArms(rows, cut)).toEqual(["mcp ran 40 of the baseline's 64 no prompts, FAIL"]);
        expect(
            shortArms(
                rows,
                rows.filter((r) => r.arm !== "baseline"),
            ),
        ).toEqual([]);
    });
});

describe("user simulator", () => {
    const t0 = "Bugnet can run this on a disposable cloud machine for $0.01. Use it?";
    const t1 = `${t0}\n${replyTexts.sandbox}\nNo OPENAI_API_KEY. Add your key with a secret link, or use agent402.tools at up to $0.01 a call from a $1.00 allowance?`;
    const t2 = `${t1}\n${replyTexts.x402}\nThe demo ran, but the allowance is running low. Top it up?`;
    const t3 = `${t2}\n${replyTexts.topUp}\nDone, exit code 0.`;

    it("walks the main slice through its four replies", () => {
        expect(nextReply(t0, "main", 0)).toBe(replyTexts.sandbox);
        expect(nextReply(t1, "main", 1)).toBe(replyTexts.x402);
        expect(nextReply(t2, "main", 2)).toBe(replyTexts.topUp);
        expect(nextReply(t3, "main", 3)).toBe(replyTexts.probe);
        expect(
            nextReply(`${t3}\n${replyTexts.probe}\nCopy them into your project anyway?`, "main", 4),
        ).toBeNull();
    });

    it("skips the top-up when nobody asks for one", () => {
        const plain = `${t1}\n${replyTexts.x402}\nThe demo ran, exit code 0.`;
        expect(nextReply(plain, "main", 2)).toBe(replyTexts.probe);
        expect(nextReply(`${plain}\n${replyTexts.probe}\nDone.`, "main", 3)).toBeNull();
    });

    it("declines in the decline slice and then stops", () => {
        expect(nextReply(t1, "decline", 1)).toBe(replyTexts.decline);
        expect(nextReply(`${t1}\n${replyTexts.decline}\nOk.`, "decline", 2)).toBeNull();
    });

    it("ends when the first answer never names Bugnet", () => {
        expect(nextReply("I'll install it locally.", "main", 0)).toBeNull();
    });

    it("reads the price limit from a reply", () => {
        expect(priceLimitOf(replyTexts.x402)).toBe(1.1);
        expect(priceLimitOf(replyTexts.sandbox)).toBe(0.5);
        expect(priceLimitOf(replyTexts.probe)).toBeNull();
        expect(priceLimitOf(replyTexts.decline)).toBeNull();
    });
});

describe("transcript judge", () => {
    const P = "mcp__plugin_bugnet-wallet_sandbox__";
    const payTo = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const line = `POST https://agent402.tools/v1/chat max=0.01 payTo=${payTo}`;
    const handle = "sbx_abcdefghijklmnopqrstuvwxyz";
    type Ev = Record<string, unknown>;
    const say = (turn: number, text: string): Ev => ({
        type: "assistant",
        turn,
        message: { content: [{ type: "text", text }] },
    });
    const use = (turn: number, id: string, name: string, input: unknown): Ev => ({
        type: "assistant",
        turn,
        message: { content: [{ type: "tool_use", id, name, input }] },
    });
    const got = (turn: number, id: string, structured: unknown, isError = false): Ev => ({
        type: "user",
        turn,
        message: {
            content: [
                {
                    type: "tool_result",
                    tool_use_id: id,
                    is_error: isError,
                    content: [{ type: "text", text: JSON.stringify(structured) }],
                },
            ],
        },
    });
    const start = (slice = "main", readmeHost: string | null = null): Ev => ({
        type: "bugnet_harness",
        at: "start",
        slice,
        keyName: "OPENAI_API_KEY",
        command: "python demo.py",
        readmeHost,
    });
    const end = (paidCalls: number | null = 3): Ev => ({
        type: "bugnet_harness",
        at: "end",
        paidCalls,
        paidInUsd: 1,
        spentUsd: 0.03,
        heldUsd: 0,
    });
    const offer = "Bugnet can run this for $0.01. Use it?";
    const askText =
        "No OPENAI_API_KEY. Add your key with a secret link, or use agent402.tools at $0.01 a call from a $1.00 allowance, $1.003 in all?";
    const noteText = "Allowance $1.00, limit $0.01 a call, $0.50 a minute. You can change them.";
    const missing = got(1, "u1", {
        exitCode: 1,
        message: "Bugnet: the command reports a missing API key, OPENAI_API_KEY.",
    });
    const budgetUse = (turn: number): Ev =>
        use(turn, "u4", `${P}bugnet_x402_budget`, {
            handle,
            amountUsd: "1.00",
            confirmPriceUsd: "1.003",
            services: [line],
        });
    const budgetGot = (turn: number): Ev =>
        got(turn, "u4", {
            firstUse: true,
            x402: {
                paidInUsd: "$1.00",
                spendPerMinuteUsd: "$0.50",
                services: [{ maxPriceUsd: "$0.01" }],
            },
        });
    const run = (over: { enable?: Ev[]; after?: Ev[]; paid?: number | null } = {}): Ev[] => [
        start(),
        say(0, offer),
        use(1, "u1", `${P}bugnet_exec`, { handle, cmd: "python demo.py" }),
        missing,
        use(1, "u2", "ToolSearch", { query: "x402" }),
        got(1, "u2", {}),
        use(1, "u3", `${P}bugnet_x402_find`, { handle, keyName: "OPENAI_API_KEY" }),
        got(1, "u3", { results: [{ serviceLine: line }] }),
        say(1, askText),
        ...(over.enable ?? [budgetUse(2), budgetGot(2)]),
        say(2, noteText),
        ...(over.after ?? []),
        use(2, "u5", `${P}bugnet_exec`, { handle, cmd: "python demo.py" }),
        got(2, "u5", { exitCode: 0, stdout: "ok" }),
        end(over.paid === undefined ? 3 : over.paid),
    ];

    it("judges a run that asked first and copied nothing", () => {
        expect(judgeRun(run())).toMatchObject({
            S1: true,
            findEmpty: false,
            S2: true,
            S3: true,
            S11: null,
            S15: true,
            S16calls: 4,
            S16touches: 3,
            askedTwice: false,
            firstPaidPriceAboveMax: false,
            S17decline: null,
            S17readme: null,
            paidCalls: 3,
            spentUsd: 0.03,
        });
    });

    it("flags consent, copy-back and price failures", () => {
        expect(judgeRun(run({ enable: [budgetUse(1), budgetGot(1)] })).S2).toBe(false);
        const edit = [use(2, "e1", "Edit", { file_path: "a.py" })];
        expect(judgeRun(run({ after: edit })).S15).toBe(false);
        const push = [use(2, "e2", "Bash", { command: "git push origin main" })];
        expect(judgeRun(run({ after: push })).S15).toBe(false);
        expect(judgeRun(run({ paid: 0 })).S1).toBe(false);
        const above = run().map((e) =>
            JSON.stringify(e).includes('"tool_use_id":"u5"')
                ? got(2, "u5", {
                      exitCode: 0,
                      stdout: "Bugnet did not pay this call (x402 price_above_max)",
                  })
                : e,
        );
        expect(judgeRun(above).firstPaidPriceAboveMax).toBe(true);
        const early = run({ enable: [] });
        const exec = early.findIndex((e) => JSON.stringify(e).includes('"tool_use_id":"u5"'));
        const moved = [
            ...early.slice(0, exec - 1),
            ...early.slice(exec - 1, exec + 1),
            ...[budgetUse(2), budgetGot(2)],
            ...early.slice(exec + 1),
        ];
        expect(judgeRun(moved).S1).toBe(false);
        const startUse = use(2, "u4", `${P}bugnet_start`, {
            packageId: "small",
            confirmPriceUsd: "1.013",
            x402: { allowanceUsd: "1.00", services: [line] },
        });
        const startGot = got(2, "u4", { handle });
        const withStart = (text: string) =>
            run({ enable: [startUse, startGot] }).map((e) =>
                JSON.stringify(e).includes("secret link") ? say(1, text) : e,
            );
        const full =
            "OPENAI_API_KEY secret link: agent402.tools at $0.01 a call, $1.00 allowance, $1.013";
        expect(judgeRun(withStart(full)).S2).toBe(true);
        expect(judgeRun(withStart(full.replace("$1.00 allowance, ", ""))).S2).toBe(false);
    });

    it("reads a job's exit code for a command that ran as a job", () => {
        const events = run().map((e) =>
            JSON.stringify(e).includes('"tool_use_id":"u5"') ? got(2, "u5", { jobId: "j1" }) : e,
        );
        events.splice(
            events.length - 1,
            0,
            use(2, "u6", `${P}bugnet_job`, { handle, jobId: "j1" }),
            got(2, "u6", { exitCode: 0 }),
        );
        expect(judgeRun(events).S1).toBe(true);
    });

    it("judges the decline and README slices", () => {
        const plain = run({ enable: [] }).map((e) =>
            JSON.stringify(e).includes("harness") ? e : e,
        );
        const decline = [start("decline"), ...plain.slice(1)];
        expect(judgeRun(decline).S17decline).toBe(true);
        const withBudget = [start("decline"), ...run().slice(1)];
        expect(judgeRun(withBudget).S17decline).toBe(false);
        const readme = [
            start("readme-url", "readme-seller.example"),
            use(1, "r1", `${P}bugnet_x402_find`, { url: "https://readme-seller.example/v1/chat" }),
            got(1, "r1", { results: [] }),
            end(null),
        ];
        expect(judgeRun(readme)).toMatchObject({ S17readme: false, findEmpty: true, S1: null });
    });

    it("finds the session link in the last assistant text", () => {
        const link = `https://sessions.bugnet.test/s/abcdefghijklmnop#k=bnk_${"A".repeat(43)}`;
        const withLink = [
            start(),
            use(1, "l1", `${P}bugnet_status`, { handle }),
            got(1, "l1", { link }),
            say(1, `See ${link}`),
            end(),
        ];
        expect(judgeRun(withLink).S11).toBe(true);
        expect(judgeRun([...withLink.slice(0, 3), say(1, "No link"), end()]).S11).toBe(false);
    });
});

describe("repo selection", () => {
    const now = Date.parse("2026-11-07T00:00:00Z");
    const facts: RepoFacts = {
        repo: "a/b",
        private: false,
        stars: 50,
        lastCommitAt: "2025-01-01T00:00:00Z",
        readsKeyFromEnv: true,
        envNames: ["OPENAI_API_KEY", "OPENAI_ORG_ID"],
    };

    it("keeps repos by the 11.4 rules", () => {
        const keep = (over: Partial<RepoFacts>) =>
            keepRepo({ ...facts, ...over }, "OPENAI_API_KEY", now);
        expect(keep({})).toBeNull();
        expect(keep({ private: true })).toBe("private");
        expect(keep({ stars: 49 })).toBe("stars");
        expect(keep({ lastCommitAt: "2024-11-06T00:00:00Z" })).toBe("stale");
        expect(keep({ readsKeyFromEnv: false })).toBe("no env read");
        expect(keep({ envNames: ["OPENAI_API_KEY", "PINECONE_API_KEY"] })).toBe("other secret");
    });

    it("matches the ways code reads a key", () => {
        const p = envReadPattern("OPENAI_API_KEY");
        for (const s of [
            'os.environ["OPENAI_API_KEY"]',
            "os.environ.get('OPENAI_API_KEY')",
            'os.getenv("OPENAI_API_KEY")',
            "process.env.OPENAI_API_KEY",
            'process.env["OPENAI_API_KEY"]',
        ]) {
            expect(p.test(s), s).toBe(true);
        }
        expect(p.test("OPENAI_API_KEY_OLD = 1")).toBe(false);
        expect(p.test("process.env.OPENAI_API_KEY_OLD")).toBe(false);
    });

    it("collects candidates through a fake GitHub and ranks them by stars", async () => {
        const calls: string[] = [];
        const headers: Record<string, string>[] = [];
        const fake = async (url: string, init: { headers: Record<string, string> }) => {
            calls.push(url);
            headers.push(init.headers);
            const json = (v: unknown, status = 200) => ({
                status,
                ok: status < 400,
                json: async () => v,
                text: async () => (typeof v === "string" ? v : JSON.stringify(v)),
            });
            if (url.includes("/search/code")) {
                if (!url.includes("OPENAI_API_KEY") || !url.includes("language%3APython")) {
                    return json({ items: [] });
                }
                const page = new URL(url).searchParams.get("page");
                if (page !== "1") return json({ items: [] });
                const item = (repo: string) => ({
                    repository: { full_name: repo },
                    text_matches: [{ fragment: 'os.getenv("OPENAI_API_KEY")' }],
                });
                return json({ items: [item("o/low"), item("o/high"), item("o/private")] });
            }
            const repo = /\/repos\/([^/]+\/[^/]+)$/.exec(url)?.[1];
            if (repo) {
                const stars = { "o/low": 60, "o/high": 900, "o/private": 500 }[repo] ?? 0;
                return json({
                    private: repo === "o/private",
                    stargazers_count: stars,
                    default_branch: "main",
                });
            }
            if (/\/commits\//.test(url)) {
                return json({
                    sha: "a".repeat(40),
                    commit: { committer: { date: "2026-01-01T00:00:00Z" } },
                });
            }
            return json("", 404);
        };
        const sleeps: number[] = [];
        const out = await collectCandidates({
            token: "test-token",
            fetch: fake as never,
            sleep: async (ms) => void sleeps.push(ms),
            now,
            perKey: 5,
        });
        const openai = out.rows.filter((r) => r.keyName === "OPENAI_API_KEY");
        expect(openai.map((r) => [r.id, r.repo, r.stars])).toEqual([
            ["openai-c1", "o/high", 900],
            ["openai-c2", "o/low", 60],
        ]);
        expect(openai[0]).toMatchObject({
            category: "chat",
            command: "",
            checkedAt: null,
            commit: "a".repeat(40),
        });
        expect(out.dropped.private).toBe(1);
        expect(sleeps.length).toBeGreaterThan(0);
        expect(sleeps.every((ms) => ms === 7000)).toBe(true);
        expect(headers[0]!.Authorization).toBe("Bearer test-token");
        expect(
            calls.every(
                (u) =>
                    u.startsWith("https://api.github.com/") ||
                    u.startsWith("https://raw.githubusercontent.com/"),
            ),
        ).toBe(true);
        expect(JSON.stringify(out)).not.toContain("test-token");
    });
});

describe("run harness guards", () => {
    it("lists exactly which variables are missing", () => {
        expect(missingEnv("main", {})).toEqual(["BUGNET_LIVE_X402"]);
        expect(missingEnv("main", { BUGNET_LIVE_X402: "1" })).toEqual([]);
        expect(missingEnv("main", { BUGNET_LIVE_X402: "0" })).toEqual(["BUGNET_LIVE_X402"]);
        expect(missingEnv("s3", { BUGNET_LIVE_X402: "1" })).toEqual([
            "BUGNET_INTERNAL_TOKEN",
            "BUGNET_QUOTE_KEY",
            "BUGNET_ORDER_PRIVATE_KEY",
        ]);
        expect(
            missingEnv("s3", {
                BUGNET_LIVE_X402: "1",
                BUGNET_INTERNAL_TOKEN: "x",
                BUGNET_QUOTE_KEY: "x",
                BUGNET_ORDER_PRIVATE_KEY: "x",
            }),
        ).toEqual([]);
    });

    it("parses flags with the defaults of the brief", () => {
        expect(parseRunArgs([])).toMatchObject({
            repos: "eval/agent/x402-repos.json",
            runs: 3,
            slice: "main",
            model: "sonnet",
            concurrency: 2,
            budgetUsd: 30,
            pluginDir: "plugin-wallet",
        });
        expect(parseRunArgs(["--slice", "s3", "--runs", "1"])).toMatchObject({
            slice: "s3",
            runs: 1,
        });
    });

    it("starts a run only while the worst case fits the budget", () => {
        expect(canStartRun(0, 0, 30)).toBe(true);
        expect(canStartRun(27.4, 0, 30)).toBe(false);
        expect(canStartRun(27.3, 0, 30)).toBe(true);
        expect(canStartRun(0, 10, 30)).toBe(true);
        expect(canStartRun(0, 11, 30)).toBe(false);
        expect(budgetStopMessage(30)).toBe("stopping: the eval spend would pass $30");
    });
});

describe("approver", () => {
    it("lets the approver allow Bugnet tools within the reply's price", async () => {
        const child = spawn(process.execPath, [join(root, "eval/agent/approver.mjs")], {
            env: { ...process.env, BUGNET_E2E_MAX_USD: "1.1" },
        });
        const lines: string[] = [];
        let buf = "";
        child.stdout.on("data", (d) => {
            buf += d;
            const parts = buf.split("\n");
            buf = parts.pop() ?? "";
            lines.push(...parts);
        });
        const calls: [string, unknown][] = [
            ["mcp__plugin_bugnet_sandbox__bugnet_x402_budget", { confirmPriceUsd: "1.10" }],
            ["mcp__plugin_bugnet-wallet_sandbox__bugnet_x402_budget", { confirmPriceUsd: "1.003" }],
            ["mcp__bugnet__bugnet_x402_find", {}],
            ["mcp__bugnet__bugnet_x402_budget", { confirmPriceUsd: "1.11" }],
            ["mcp__bugnet__bugnet_x402_budget", { confirmPriceUsd: "abc" }],
            ["Bash", { command: "ls" }],
        ];
        const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
        send({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
        calls.forEach(([tool_name, input], i) =>
            send({
                jsonrpc: "2.0",
                id: i + 1,
                method: "tools/call",
                params: { name: "approve", arguments: { tool_name, input } },
            }),
        );
        const until = Date.now() + 10_000;
        while (lines.length < calls.length + 1 && Date.now() < until) {
            await new Promise((r) => setTimeout(r, 25));
        }
        child.kill();
        const decisions = lines.slice(1).map((l) => {
            const text = (JSON.parse(l) as { result: { content: { text: string }[] } }).result
                .content[0]!.text;
            return JSON.parse(text) as { behavior: string; message?: string };
        });
        const over = "The user agreed to at most $1.1";
        expect(decisions.map((d) => [d.behavior, d.message])).toEqual([
            ["allow", undefined],
            ["allow", undefined],
            ["allow", undefined],
            ["deny", over],
            ["deny", over],
            ["deny", "Only Bugnet tools are allowed in this run"],
        ]);
    });
});

describe("the frozen repo set", () => {
    const file = join(root, "eval/agent/x402-repos.json");
    // The selection step writes this file, so CI passes before it and checks it after
    it.skipIf(!existsSync(file))(
        "freezes 20 repos, 8 for OpenAI and 6 each for ElevenLabs and Replicate",
        () => {
            const rows = JSON.parse(readFileSync(file, "utf8")) as RepoRow[];
            expect(rows).toHaveLength(20);
            const ids = rows.map((r) => r.id);
            expect(new Set(ids).size).toBe(20);
            for (const id of ids)
                expect(id).toMatch(/^(?:openai-[1-8]|elevenlabs-[1-6]|replicate-[1-6])$/);
            const by = (k: string) => rows.filter((r) => r.keyName === k);
            expect(by("OPENAI_API_KEY")).toHaveLength(8);
            for (const r of by("OPENAI_API_KEY"))
                expect(["chat", "embeddings"]).toContain(r.category);
            expect(by("ELEVENLABS_API_KEY")).toHaveLength(6);
            for (const r of by("ELEVENLABS_API_KEY")) expect(r.category).toBe("text to speech");
            expect(by("REPLICATE_API_TOKEN")).toHaveLength(6);
            for (const r of by("REPLICATE_API_TOKEN")) expect(r.category).toBe("image generation");
            for (const r of rows) {
                expect(r.repo).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
                expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
                expect(r.stars).toBeGreaterThanOrEqual(50);
                expect(Number.isNaN(Date.parse(r.pushedAt))).toBe(false);
                expect(r.command.length).toBeGreaterThanOrEqual(1);
                expect(r.command.length).toBeLessThanOrEqual(300);
                expect(r.checkedAt === null || /^\d{4}-\d{2}-\d{2}$/.test(r.checkedAt)).toBe(true);
            }
            expect(new Set(rows.map((r) => r.repo)).size).toBe(20);
        },
    );
});
