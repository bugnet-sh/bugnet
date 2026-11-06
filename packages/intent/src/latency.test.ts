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

// This thread's CPU time, so neither other threads such as the GC's nor a busy machine count
function cpuMs(f: () => unknown): number {
    const usage = (prev?: NodeJS.CpuUsage) =>
        typeof process.threadCpuUsage === "function"
            ? process.threadCpuUsage(prev)
            : process.cpuUsage(prev);
    const before = usage();
    f();
    const used = usage(before);
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

const patterns: [string, RegExp][] = [
    ...Object.entries(L).filter((e): e is [string, RegExp] => e[1] instanceof RegExp),
    ...signatures.map((s) => [`signature ${s.id}`, s.re] as [string, RegExp]),
];

// Every match of a pattern, counted without keeping them
function scan(re: RegExp, s: string): number {
    let n = 0;
    re.lastIndex = 0;
    for (let m = re.exec(s); m !== null && re.global; m = re.exec(s)) {
        n++;
        if (m[0] === "") re.lastIndex++;
    }
    return n;
}

describe("latency", () => {
    // Wall time on a loaded machine measures the scheduler, so the budget is checked in CPU time
    it("classifies 10,000 mixed inputs in under a second of CPU time", () => {
        mixed(500);
        expect(cpuMs(() => mixed(10_000))).toBeLessThan(1000);
    });

    // Efficiency cores take twice the CPU time of performance cores, a catastrophic regex takes seconds
    it.each(families)("keeps 50 KB of repeated %s tokens under 100 ms each", (_name, words) => {
        mixed(50);
        const ctx = { os: "macos", arch: "arm64" } as const;
        for (const sep of [" ", "\n", "", "-", "."]) {
            const text = repeated(words.join(sep) + sep);
            expect(cpuMs(() => classifyPrompt(text, ctx))).toBeLessThan(100);
            expect(cpuMs(() => classifyCommand(text, ctx))).toBeLessThan(100);
            expect(cpuMs(() => classifyFailure("x", text, ctx))).toBeLessThan(100);
            expect(cpuMs(() => clonedDirs(text, "/w"))).toBeLessThan(100);
        }
    });

    // One token alone, repeated or with its last letter stretched, is where nested runs backtrack
    it.each(patterns)("keeps %s linear on one repeated or stretched token", (_name, re) => {
        for (const token of tokens(re.source)) {
            const tail = token.slice(-1);
            for (const text of [repeated(token), token + tail.repeat(50_000)]) {
                expect(cpuMs(() => scan(re, text))).toBeLessThan(25);
            }
        }
    });

    it.each([
        ["a stretched rm flag", "rm -" + "r".repeat(16_000)],
        ["repeated private address octets", repeated("10.")],
        ["a long run of digits after a private prefix", "192.168." + "1".repeat(50_000)],
        ["one setup verb repeated without spaces", repeated("install")],
        ["one Turkish setup verb repeated without spaces", repeated("kurmana")],
        [
            "a large written script run many times",
            `cat > a.sh <<'A'\n${"echo hi; ls -la\n".repeat(750)}A\n${"bash a.sh\n".repeat(1000)}`,
        ],
    ])("classifies %s in under 50 ms", (_name, text) => {
        mixed(50);
        const ctx = { os: "macos", arch: "arm64" } as const;
        expect(cpuMs(() => classifyPrompt(text, ctx))).toBeLessThan(50);
        expect(cpuMs(() => classifyCommand(text, ctx))).toBeLessThan(50);
    });
});
