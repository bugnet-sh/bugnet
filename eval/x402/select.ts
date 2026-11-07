/**
 * Lists candidate repos for the x402 eval set (spec 11.4) by searching GitHub with the gateway's
 * own token and keeping the repos that pass the rules a script can check.
 *
 * Usage: GITHUB_TOKEN=... tsx eval/x402/select.ts [--out FILE] [--per-key N]
 * The token comes from the environment only, and a person then checks each command by hand.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export interface RepoRow {
    id: string;
    repo: string;
    commit: string;
    keyName: "OPENAI_API_KEY" | "ELEVENLABS_API_KEY" | "REPLICATE_API_TOKEN";
    category: "chat" | "embeddings" | "text to speech" | "image generation";
    command: string;
    stars: number;
    pushedAt: string;
    // YYYY-MM-DD once a person ran the command with a real key
    checkedAt: string | null;
}

export interface RepoFacts {
    repo: string;
    private: boolean;
    stars: number;
    lastCommitAt: string;
    readsKeyFromEnv: boolean;
    envNames: string[];
}

const dayMs = 86_400_000;

export function envReadPattern(keyName: string): RegExp {
    const k = keyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = `["']${k}["']`;
    return new RegExp(
        `os\\.environ\\[${quoted}\\]|os\\.environ\\.get\\(${quoted}|os\\.getenv\\(${quoted}|process\\.env\\.${k}\\b|process\\.env\\[${quoted}\\]`,
    );
}

// Why the repo is dropped, null when it is kept
export function keepRepo(r: RepoFacts, keyName: string, now: number): string | null {
    if (r.private) return "private";
    if (r.stars < 50) return "stars";
    if (now - Date.parse(r.lastCommitAt) > 730 * dayMs) return "stale";
    if (!r.readsKeyFromEnv) return "no env read";
    if (r.envNames.some((n) => n !== keyName && /_(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(n))) {
        return "other secret";
    }
    return null;
}

interface Reply {
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
}
type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<Reply>;

export interface CollectDeps {
    token: string;
    fetch: Fetch;
    sleep: (ms: number) => Promise<void>;
    now: number;
    perKey: number;
    // Repos looked at per key before ranking, so a run stays inside the API's limits
    maxLook?: number;
}

const keys = [
    { keyName: "OPENAI_API_KEY", prefix: "openai", category: "chat" },
    { keyName: "ELEVENLABS_API_KEY", prefix: "elevenlabs", category: "text to speech" },
    { keyName: "REPLICATE_API_TOKEN", prefix: "replicate", category: "image generation" },
] as const;
const languages = ["Python", "JavaScript", "TypeScript"] as const;
const searchGapMs = 7000;
const api = "https://api.github.com";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null ? (v as Obj) : {});

export async function collectCandidates(
    d: CollectDeps,
): Promise<{ rows: RepoRow[]; dropped: Record<string, number> }> {
    const headers = {
        Accept: "application/vnd.github.text-match+json",
        Authorization: `Bearer ${d.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
    };
    const plain = { ...headers, Accept: "application/vnd.github+json" };
    let searches = 0;
    const get = (url: string, h: Record<string, string>) => d.fetch(url, { headers: h });
    const rows: RepoRow[] = [];
    const dropped: Record<string, number> = {};
    const drop = (why: string) => void (dropped[why] = (dropped[why] ?? 0) + 1);

    for (const k of keys) {
        const fragments = new Map<string, string[]>();
        for (const lang of languages) {
            for (let page = 1; page <= 3; page++) {
                if (searches++ > 0) await d.sleep(searchGapMs);
                const q = new URLSearchParams({
                    q: `"${k.keyName}" language:${lang}`,
                    per_page: "100",
                    page: String(page),
                });
                const res = await get(`${api}/search/code?${q}`, headers);
                const items = res.status === 200 ? obj(await res.json()).items : [];
                if (!Array.isArray(items) || items.length === 0) break;
                for (const it of items) {
                    const repo = String(obj(obj(it).repository).full_name ?? "");
                    if (repo === "") continue;
                    const seen = fragments.get(repo) ?? [];
                    for (const m of (obj(it).text_matches as unknown[] | undefined) ?? []) {
                        seen.push(String(obj(m).fragment ?? ""));
                    }
                    fragments.set(repo, seen);
                }
            }
        }
        const read = envReadPattern(k.keyName);
        const kept: Omit<RepoRow, "id">[] = [];
        for (const [repo, frags] of [...fragments].slice(0, d.maxLook ?? 150)) {
            const meta = obj(await (await get(`${api}/repos/${repo}`, plain)).json());
            const facts: RepoFacts = {
                repo,
                private: meta.private === true,
                stars: Number(meta.stargazers_count ?? 0),
                lastCommitAt: "",
                readsKeyFromEnv: frags.some((f) => read.test(f)),
                envNames: [],
            };
            const early = keepRepo(
                { ...facts, lastCommitAt: new Date(d.now).toISOString() },
                k.keyName,
                d.now,
            );
            if (early === "private" || early === "stars") {
                drop(early);
                continue;
            }
            const branch = String(meta.default_branch ?? "main");
            const commit = obj(
                await (await get(`${api}/repos/${repo}/commits/${branch}`, plain)).json(),
            );
            const sha = String(commit.sha ?? "");
            facts.lastCommitAt = String(obj(obj(commit.commit).committer).date ?? "");
            const env = await get(
                `https://raw.githubusercontent.com/${repo}/${sha}/.env.example`,
                {},
            );
            if (env.status === 200) {
                const names = (await env.text()).matchAll(
                    /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,63})\s*=/gm,
                );
                facts.envNames = [...names].map((m) => m[1] as string);
                if (facts.envNames.includes(k.keyName)) facts.readsKeyFromEnv = true;
            }
            const why = keepRepo(facts, k.keyName, d.now);
            if (why !== null) {
                drop(why);
                continue;
            }
            kept.push({
                repo,
                commit: sha,
                keyName: k.keyName,
                category: k.category,
                command: "",
                stars: facts.stars,
                pushedAt: facts.lastCommitAt,
                checkedAt: null,
            });
        }
        kept.sort((a, b) => b.stars - a.stars);
        kept.slice(0, d.perKey).forEach((r, i) => rows.push({ id: `${k.prefix}-c${i + 1}`, ...r }));
    }
    return { rows, dropped };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const argv = process.argv.slice(2);
    const opt = (name: string) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        console.log("GITHUB_TOKEN is not set");
        process.exit(2);
    }
    const out = opt("--out") ?? "eval/x402/candidates.json";
    const { rows, dropped } = await collectCandidates({
        token,
        fetch: ((url, init) => fetch(url, init)) as Fetch,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: Date.now(),
        perKey: Number(opt("--per-key") ?? 20),
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(rows, null, 4)}\n`);
    console.log(`kept ${rows.length} candidates, written to ${out}`);
    for (const [why, n] of Object.entries(dropped)) console.log(`dropped ${n}: ${why}`);
}
