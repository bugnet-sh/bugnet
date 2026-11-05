// packages/intent/src/hook.ts
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// packages/intent/src/index.ts
var none = {
  suggest: false,
  score: 0,
  category: null,
  signals: [],
  subject: null
};
function classifyPrompt(_text, _ctx = {}) {
  return none;
}
function classifyCommand(_command, _ctx = {}) {
  return none;
}
function classifyFailure(_command, _error, _ctx = {}) {
  return none;
}
function hintFor(_c, _kind) {
  return "";
}

// packages/intent/src/hook.ts
var maxHintsPerSession = 2;
var stateTtlMs = 2 * 24 * 3600 * 1e3;
function envFrom(env) {
  const raw = (env.BUGNET_HINTS ?? env.CLAUDE_PLUGIN_OPTION_HINTS ?? "normal").toLowerCase();
  const hints = raw === "off" || raw === "quiet" ? raw : "normal";
  const base = env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "bugnet-plugin");
  return { hints, stateDir: join(base, "hints"), platform: process.platform, arch: process.arch };
}
function stateFile(env, session) {
  return join(env.stateDir, `${session.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100)}.json`);
}
function loadState(env, session) {
  try {
    const s = JSON.parse(readFileSync(stateFile(env, session), "utf8"));
    return {
      hinted: Array.isArray(s.hinted) ? s.hinted : [],
      clonedDirs: Array.isArray(s.clonedDirs) ? s.clonedDirs : [],
      bugnetUsed: s.bugnetUsed === true
    };
  } catch {
    return { hinted: [], clonedDirs: [], bugnetUsed: false };
  }
}
function saveState(env, session, state) {
  mkdirSync(env.stateDir, { recursive: true });
  writeFileSync(stateFile(env, session), JSON.stringify(state));
}
function prune(env, now) {
  if (Math.random() > 0.05) return;
  for (const f of readdirSync(env.stateDir)) {
    const p = join(env.stateDir, f);
    if (now - statSync(p).mtimeMs > stateTtlMs) rmSync(p, { force: true });
  }
}
var cloneRe = /\bgit\s+clone\b(?:\s+--?[\w-]+(?:[= ](?!https?:|git@)\S+)?)*\s+(['"]?)((?:https?:\/\/|git@)[^\s'"]+)\1(?:\s+(['"]?)([^\s'";&|]+)\3)?/g;
function clonedDirs(command, cwd) {
  const out = [];
  for (const m of command.matchAll(cloneRe)) {
    const url = m[2];
    const name = m[4] ?? url.replace(/\.git$/, "").replace(/\/+$/, "").split(/[/:]/).pop();
    if (name) out.push(isAbsolute(name) ? name : resolve(cwd, name));
  }
  return out;
}
function inCloned(state, cwd, command) {
  const cds = [...command.matchAll(/\bcd\s+(['"]?)([^\s'";&|]+)\1/g)].map(
    (m) => resolve(cwd, m[2])
  );
  return [cwd, ...cds].some(
    (d) => state.clonedDirs.some((c) => d === c || d.startsWith(`${c}/`))
  );
}
function osOf(env) {
  if (env.platform === "darwin") return "macos";
  if (env.platform === "win32") return "windows";
  return "linux";
}
function mentionsBugnet(text) {
  return /bugnet/i.test(text);
}
function output(event, text) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text }
  });
}
function runHook(mode, input, env, now = Date.now()) {
  if (env.hints === "off") return null;
  const session = input.session_id || "unknown";
  const cwd = input.cwd || process.cwd();
  const state = loadState(env, session);
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (mode === "track") {
    if (/bugnet/i.test(input.tool_name ?? "")) state.bugnetUsed = true;
    const dirs = clonedDirs(command, cwd).filter((d) => !state.clonedDirs.includes(d));
    if (dirs.length > 0 || state.bugnetUsed) {
      state.clonedDirs.push(...dirs);
      state.clonedDirs = state.clonedDirs.slice(-20);
      saveState(env, session, state);
    }
    return null;
  }
  if (state.bugnetUsed || state.hinted.length >= maxHintsPerSession) return null;
  if (env.hints === "quiet" && mode !== "failure") return null;
  const ctx = {
    os: osOf(env),
    arch: env.arch === "arm64" ? "arm64" : "x64",
    clonedThisSession: mode !== "prompt" && inCloned(state, cwd, command)
  };
  let c;
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
  const text = hintFor(c, mode);
  if (!text) return null;
  state.hinted.push(key);
  saveState(env, session, state);
  try {
    prune(env, now);
  } catch {
  }
  const event = input.hook_event_name ?? { prompt: "UserPromptSubmit", command: "PreToolUse", failure: "PostToolUseFailure" }[mode];
  return output(event, text);
}
async function readStdin(limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function main(argv) {
  try {
    const mode = argv[0];
    if (!["prompt", "command", "failure", "track"].includes(mode)) return;
    const input = JSON.parse(await readStdin());
    const out = runHook(mode, input, envFrom(process.env));
    if (out) process.stdout.write(`${out}
`);
  } catch {
  }
}

// packages/intent/src/hook-main.ts
await main(process.argv.slice(2));
