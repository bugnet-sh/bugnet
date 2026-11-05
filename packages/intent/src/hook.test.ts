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
