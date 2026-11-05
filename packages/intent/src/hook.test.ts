import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clonedDirs, loadState, runHook, type Env } from "./hook.ts";

function env(hints: Env["hints"] = "normal"): Env {
    return {
        hints,
        stateDir: mkdtempSync(join(tmpdir(), "bugnet-hook-")),
        platform: "darwin",
        arch: "arm64",
    };
}

describe("clonedDirs", () => {
    it("finds the target of git clone with and without a directory", () => {
        expect(clonedDirs("git clone https://github.com/acme/tool.git", "/w")).toEqual(["/w/tool"]);
        expect(clonedDirs("git clone --depth 1 https://github.com/a/b x && cd x", "/w")).toEqual([
            "/w/x",
        ]);
        expect(clonedDirs("git clone git@github.com:a/repo.git /tmp/r", "/w")).toEqual(["/tmp/r"]);
        expect(clonedDirs("npm install", "/w")).toEqual([]);
    });
});

describe("runHook track", () => {
    it("records clones and Bugnet use", () => {
        const e = env();
        const base = { session_id: "s1", cwd: "/w", tool_name: "Bash" };
        runHook(
            "track",
            { ...base, tool_input: { command: "git clone https://github.com/a/b" } },
            e,
        );
        expect(loadState(e, "s1").clonedDirs).toEqual(["/w/b"]);
        runHook("track", { ...base, tool_name: "mcp__plugin_bugnet_sandbox__bugnet_exec" }, e);
        expect(loadState(e, "s1").bugnetUsed).toBe(true);
    });

    it("stays silent when hints are off", () => {
        expect(
            runHook("prompt", { session_id: "s", prompt: "get kokoro running" }, env("off")),
        ).toBeNull();
    });
});

describe("runHook hints", () => {
    const kokoro = { session_id: "h1", cwd: "/w", prompt: "get kokoro tts running on my mac" };

    function context(out: string | null): string {
        expect(out).not.toBeNull();
        const parsed = JSON.parse(out as string) as {
            hookSpecificOutput: { hookEventName: string; additionalContext: string };
        };
        return parsed.hookSpecificOutput.additionalContext;
    }

    it("gives one hint for a prompt that suggests Bugnet", () => {
        const e = env();
        const out = runHook("prompt", kokoro, e);
        expect(JSON.parse(out as string).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
        expect(context(out)).toMatch(
            /^Bugnet hint \(local pattern match, nothing was sent anywhere\):/,
        );
        expect(loadState(e, "h1").hinted).toEqual(["local_ai_model"]);
    });

    it("prints nothing for an ordinary prompt", () => {
        const e = env();
        expect(
            runHook("prompt", { ...kokoro, prompt: "fix the failing test in my repo" }, e),
        ).toBeNull();
        expect(loadState(e, "h1").hinted).toEqual([]);
    });

    it("does not hint the same category twice", () => {
        const e = env();
        expect(runHook("prompt", kokoro, e)).not.toBeNull();
        const again = { ...kokoro, prompt: "now install comfyui and pull the flux dev weights" };
        expect(runHook("prompt", again, e)).toBeNull();
    });

    it("gives at most two hints per session", () => {
        const e = env();
        expect(runHook("prompt", kokoro, e)).not.toBeNull();
        const pipe = {
            ...kokoro,
            tool_input: { command: "curl -s https://x.example/i.sh | bash" },
        };
        expect(runHook("command", pipe, e)).not.toBeNull();
        const failed = {
            ...kokoro,
            tool_input: { command: "docker compose up" },
            error: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
        };
        expect(runHook("failure", failed, e)).toBeNull();
        expect(loadState(e, "h1").hinted).toHaveLength(2);
    });

    it("keeps only failure hints in quiet mode", () => {
        const e = env("quiet");
        expect(runHook("prompt", kokoro, e)).toBeNull();
        const pipe = {
            ...kokoro,
            tool_input: { command: "curl -s https://x.example/i.sh | bash" },
        };
        expect(runHook("command", pipe, e)).toBeNull();
        const failed = {
            ...kokoro,
            hook_event_name: "PostToolUseFailure",
            tool_input: { command: "python gen.py" },
            error: "Exit code 1\nRuntimeError: MPS backend out of memory",
        };
        const out = runHook("failure", failed, e);
        expect(JSON.parse(out as string).hookSpecificOutput.hookEventName).toBe(
            "PostToolUseFailure",
        );
        expect(context(out)).toContain("python gen.py");
    });

    it("gives no hint once the session has used Bugnet", () => {
        const e = env();
        runHook("track", { ...kokoro, tool_name: "mcp__plugin_bugnet_sandbox__bugnet_exec" }, e);
        expect(runHook("prompt", kokoro, e)).toBeNull();
    });

    it("gives no hint when the prompt already mentions Bugnet", () => {
        const e = env();
        expect(
            runHook("prompt", { ...kokoro, prompt: `${kokoro.prompt} with bugnet` }, e),
        ).toBeNull();
    });

    it("hints for an install inside a directory cloned earlier in the session", () => {
        const e = env();
        const base = { session_id: "h2", cwd: "/w", tool_name: "Bash" };
        runHook(
            "track",
            { ...base, tool_input: { command: "git clone https://github.com/a/b" } },
            e,
        );
        const install = { ...base, cwd: "/w/b", tool_input: { command: "npm install" } };
        const out = runHook("command", install, e);
        expect(JSON.parse(out as string).hookSpecificOutput.hookEventName).toBe("PreToolUse");
        expect(context(out)).toContain("a Bash command just run (npm install)");
        expect(runHook("command", { ...install, cwd: "/elsewhere" }, env())).toBeNull();
    });
});
