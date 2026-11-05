import { describe, expect, it } from "vitest";
import { classifyCommand, classifyFailure, classifyPrompt } from "./index.ts";

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

describe("latency", () => {
    // Wall time on a loaded machine measures the scheduler, so the budget is checked in CPU time
    it("classifies 10,000 mixed inputs in under a second of CPU time", () => {
        mixed(500);
        const before = process.cpuUsage();
        mixed(10_000);
        const used = process.cpuUsage(before);
        expect((used.user + used.system) / 1000).toBeLessThan(1000);
    });
});
