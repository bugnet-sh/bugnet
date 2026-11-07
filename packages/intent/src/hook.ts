/**
 * The Claude Code hook behind the Bugnet plugin, bundled to plugin/hooks/bugnet-hook.mjs.
 *
 * Modes, one per hook event: "prompt" (UserPromptSubmit) reads the user's message, "command"
 * (PreToolUse on Bash) reads the command about to run, "failure" (PostToolUseFailure on Bash)
 * reads a failed command and its error, and "track" (PostToolUse) records repositories cloned this
 * session and whether Bugnet was already used. Everything is computed on this machine; nothing is
 * sent anywhere.
 *
 * A hint is one factual paragraph added to the agent's context. At most one hint per category and
 * two per session are given, none once a Bugnet tool has been used, and BUGNET_HINTS=off turns
 * them all off (quiet keeps only failure hints). Any error exits 0 with no output.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { clonesIn } from "./command.ts";
import { classifyCommand, classifyFailure, classifyPrompt, hintFor } from "./index.ts";
import { clip } from "./normalize.ts";
import type { Classification, SessionContext } from "./types.ts";

export type Mode = "prompt" | "command" | "failure" | "track";

export interface HookInput {
    session_id?: string;
    hook_event_name?: string;
    cwd?: string;
    prompt?: string;
    tool_name?: string;
    tool_input?: { command?: unknown };
    error?: unknown;
}

export interface State {
    hinted: string[];
    clonedDirs: string[];
    // The repository each cloned directory holds, such as github.com/acme/tool
    clonedRepos: Record<string, string>;
    bugnetUsed: boolean;
    // Set by the first prompt, since only its hint can say that nothing was offered
    prompted: boolean;
}

export interface Env {
    hints: "normal" | "quiet" | "off";
    stateDir: string;
    platform: NodeJS.Platform;
    arch: string;
    plugin: string;
}

const maxHintsPerSession = 2;
const stateTtlMs = 2 * 24 * 3600 * 1000;

// The hint names the skill of whichever plugin carries this hook
export function pluginName(env: NodeJS.ProcessEnv): string {
    try {
        const root = env.CLAUDE_PLUGIN_ROOT;
        if (!root) return "bugnet";
        const manifest = JSON.parse(
            readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"),
        ) as { name?: unknown };
        return typeof manifest.name === "string" && /^[a-z0-9-]{1,64}$/.test(manifest.name)
            ? manifest.name
            : "bugnet";
    } catch {
        return "bugnet";
    }
}

export function envFrom(env: NodeJS.ProcessEnv): Env {
    const raw = (env.BUGNET_HINTS ?? env.CLAUDE_PLUGIN_OPTION_HINTS ?? "normal").toLowerCase();
    const hints = raw === "off" || raw === "quiet" ? raw : "normal";
    const base = env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "bugnet-plugin");
    return {
        hints,
        stateDir: join(base, "hints"),
        platform: process.platform,
        arch: process.arch,
        plugin: pluginName(env),
    };
}

function stateFile(env: Env, session: string): string {
    return join(env.stateDir, `${session.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100)}.json`);
}

export function loadState(env: Env, session: string): State {
    try {
        const s = JSON.parse(readFileSync(stateFile(env, session), "utf8")) as Partial<State>;
        const repos = s.clonedRepos;
        return {
            hinted: Array.isArray(s.hinted) ? s.hinted : [],
            clonedDirs: Array.isArray(s.clonedDirs) ? s.clonedDirs : [],
            clonedRepos: repos && typeof repos === "object" && !Array.isArray(repos) ? repos : {},
            bugnetUsed: s.bugnetUsed === true,
            prompted: s.prompted === true,
        };
    } catch {
        return { hinted: [], clonedDirs: [], clonedRepos: {}, bugnetUsed: false, prompted: false };
    }
}

export function saveState(env: Env, session: string, state: State): void {
    mkdirSync(env.stateDir, { recursive: true });
    writeFileSync(stateFile(env, session), JSON.stringify(state));
}

// Old sessions' files go once a while, so the directory never grows without bound
function prune(env: Env, now: number): void {
    if (Math.random() > 0.05) return;
    for (const f of readdirSync(env.stateDir)) {
        const p = join(env.stateDir, f);
        if (now - statSync(p).mtimeMs > stateTtlMs) rmSync(p, { force: true });
    }
}

function persist(env: Env, session: string, state: State, now: number): void {
    saveState(env, session, state);
    try {
        prune(env, now);
    } catch {
        // Pruning is housekeeping, a failure here never costs the hint
    }
}

// Directories a command clones into, resolved against the hook's cwd, and their repositories
export function clonedDirs(command: string, cwd: string): { dir: string; repo: string }[] {
    return clonesIn(command).map((c) => ({
        dir: isAbsolute(c.dir) ? c.dir : resolve(cwd, c.dir),
        repo: c.repo,
    }));
}

// The cloned directory the command runs in, if any, found from the cwd and any cd in it
function clonedAt(state: State, cwd: string, command: string): string | null {
    const cds = [...clip(command).matchAll(/\bcd\s+(['"]?)([^\s'";&|]+)\1/g)].map((m) =>
        resolve(cwd, m[2] as string),
    );
    for (const d of [cwd, ...cds]) {
        const c = state.clonedDirs.find((c) => d === c || d.startsWith(`${c}/`));
        if (c) return c;
    }
    return null;
}

function osOf(env: Env): SessionContext["os"] {
    if (env.platform === "darwin") return "macos";
    if (env.platform === "win32") return "windows";
    return "linux";
}

function mentionsBugnet(text: string): boolean {
    return /bugnet/i.test(text);
}

function output(event: string, text: string): string {
    return JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: text },
    });
}

// Returns the JSON line to print, or null for no hint
export function runHook(mode: Mode, input: HookInput, env: Env, now = Date.now()): string | null {
    if (env.hints === "off") return null;
    const session = input.session_id || "unknown";
    const cwd = input.cwd || process.cwd();
    const state = loadState(env, session);
    const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";

    if (mode === "track") {
        if (/bugnet/i.test(input.tool_name ?? "")) state.bugnetUsed = true;
        const fresh = clonedDirs(command, cwd).filter((c) => !state.clonedDirs.includes(c.dir));
        if (fresh.length > 0 || state.bugnetUsed) {
            state.clonedDirs.push(...fresh.map((c) => c.dir));
            state.clonedDirs = state.clonedDirs.slice(-20);
            for (const c of fresh) state.clonedRepos[c.dir] = c.repo;
            state.clonedRepos = Object.fromEntries(
                state.clonedDirs.flatMap((d) => {
                    const repo = state.clonedRepos[d];
                    return repo ? [[d, repo]] : [];
                }),
            );
            saveState(env, session, state);
        }
        return null;
    }
    const firstPrompt = mode === "prompt" && !state.prompted;
    // Every prompt rewrites the file, so an active session's file never ages into pruning
    if (mode === "prompt") {
        state.prompted = true;
        persist(env, session, state, now);
    }
    if (state.bugnetUsed || state.hinted.length >= maxHintsPerSession) return null;
    if (env.hints === "quiet" && mode !== "failure") return null;

    const dir = mode === "prompt" ? null : clonedAt(state, cwd, command);
    const ctx: SessionContext = {
        os: osOf(env),
        arch: env.arch === "arm64" ? "arm64" : "x64",
        clonedThisSession: dir !== null,
        ...(dir && state.clonedRepos[dir] ? { clonedRepo: state.clonedRepos[dir] } : {}),
    };
    let c: Classification;
    if (mode === "prompt") {
        const prompt = input.prompt ?? "";
        if (mentionsBugnet(prompt)) return null;
        c = classifyPrompt(prompt, ctx);
    } else if (mode === "command") {
        if (mentionsBugnet(command)) return null;
        c = classifyCommand(command, ctx);
    } else {
        const error = typeof input.error === "string" ? input.error : "";
        c = classifyFailure(command, error, ctx);
    }
    if (!c.suggest || !c.category) return null;
    const key = c.category;
    if (state.hinted.includes(key)) return null;
    const text = hintFor(c, mode, firstPrompt, env.plugin);
    if (!text) return null;
    state.hinted.push(key);
    persist(env, session, state, now);
    const event =
        input.hook_event_name ??
        { prompt: "UserPromptSubmit", command: "PreToolUse", failure: "PostToolUseFailure" }[mode];
    return output(event, text);
}

async function readStdin(limit = 1 << 20): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        size += (chunk as Buffer).length;
        if (size > limit) break;
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv: string[]): Promise<void> {
    try {
        const mode = argv[0] as Mode;
        if (!["prompt", "command", "failure", "track"].includes(mode)) return;
        const input = JSON.parse(await readStdin()) as HookInput;
        const out = runHook(mode, input, envFrom(process.env));
        if (out) process.stdout.write(`${out}\n`);
    } catch {
        // Hints are optional, so a hook problem never reaches the user
    }
}
