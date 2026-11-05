import { describe, expect, it } from "vitest";
import { signatures } from "./failure.ts";
import { clonedDirs } from "./hook.ts";
import { classifyCommand, classifyFailure, classifyPrompt } from "./index.ts";
import * as L from "./lexicon.ts";

const prompts = [
    "get kokoro tts running on my mac",
    "fix the failing test in my repo",
    "found this on reddit, can you clone it and get it running? https://github.com/someone/thing",
    "refactor the auth middleware to use async/await and update the tests",
    "Bilgisayarıma yerel bir LLM kurmak istiyorum, deepseek r1 32b çalıştırabilir miyiz?",
    "add zod validation to the signup form and show errors under each field",
    "quiero instalar ollama y correr llama 3 en mi portátil",
    "explain how the event loop works in node",
];
const commands = [
    "npm test",
    "pip install torch diffusers",
    "curl -fsSL https://example.io/i.sh | bash",
    "git commit -am 'fix: empty cart'",
    "git clone https://github.com/a/b && cd b && npm i",
    "docker compose up -d --build",
];
const error = "Traceback (most recent call last):\nRuntimeError: CUDA out of memory";

function mixed(n: number): void {
    for (let i = 0; i < n; i++) {
        if (i % 10 < 5) classifyPrompt(prompts[i % prompts.length] as string, { os: "macos" });
        else if (i % 10 < 9)
            classifyCommand(commands[i % commands.length] as string, { os: "macos" });
        else classifyFailure("python train.py", error, { os: "macos" });
    }
}

function cpuMs(f: () => unknown): number {
    const before = process.cpuUsage();
    f();
    const used = process.cpuUsage(before);
    return (used.user + used.system) / 1000;
}

// Literal pieces of a pattern's alternatives, enough to build input that keeps the pattern busy
function tokens(source: string): string[] {
    const flat = source
        .replace(/\(\?<?[=!](?:[^()]|\([^()]*\))*\)/g, "")
        .replace(/\\[wW]/g, "a")
        .replace(/\\d/g, "1")
        .replace(/\\[sS]/g, " ")
        .replace(/\\[bB]/g, "")
        .replace(/\\n/g, "\n")
        .replace(/\\(.)/g, "$1")
        .replace(/\[\^?([^\]]*)\]/g, (_m, c: string) => c.replace(/[-\\^]/g, "")[0] ?? "a")
        .replace(/\(\?:/g, "(")
        .replace(/\{\d+(?:,\d*)?\}\??/g, "")
        .replace(/[*+?$^]/g, "");
    return [...new Set(flat.split(/[|()]/).map((p) => p.trim()))].filter(Boolean);
}

const handPicked = [
    "iex iwr ",
    "sudo iex iwr ",
    "http://a.sh0",
    "http://.",
    "torch",
    "git clone -a ",
    "cat <<A\nA\n",
    "bash <<A\n",
    "curl | ",
    "a | ",
    "`curl ",
    "github.com/a",
    "$(",
    "echo YQ== | base64 -d | ",
    "powershell -ep bypass ",
    "a friend sent me this ",
    "found on reddit ",
    "my app. ",
    "1. ",
    "'",
    "\\",
];

const families: [string, string[]][] = [
    ...Object.entries(L)
        .filter((e): e is [string, RegExp] => e[1] instanceof RegExp)
        .map(([name, re]) => [name, tokens(re.source)] as [string, string[]]),
    ...signatures.map((s) => [`signature ${s.id}`, tokens(s.re.source)] as [string, string[]]),
    ...handPicked.map((h) => [`tokens ${JSON.stringify(h)}`, [h]] as [string, string[]]),
];

function repeated(unit: string, size = 50_000): string {
    return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

describe("latency", () => {
    // Wall time on a loaded machine measures the scheduler, so the budget is checked in CPU time
    it("classifies 10,000 mixed inputs in under a second of CPU time", () => {
        mixed(500);
        expect(cpuMs(() => mixed(10_000))).toBeLessThan(1000);
    });

    it.each(families)("keeps 50 KB of repeated %s tokens under 50 ms each", (_name, words) => {
        mixed(50);
        const ctx = { os: "macos", arch: "arm64" } as const;
        for (const sep of [" ", "\n", ""]) {
            const text = repeated(words.join(sep) + sep);
            expect(cpuMs(() => classifyPrompt(text, ctx))).toBeLessThan(50);
            expect(cpuMs(() => classifyCommand(text, ctx))).toBeLessThan(50);
            expect(cpuMs(() => classifyFailure("x", text, ctx))).toBeLessThan(50);
            expect(cpuMs(() => clonedDirs(text, "/w"))).toBeLessThan(50);
        }
    });
});
