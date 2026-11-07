import { describe, expect, it } from "vitest";
import { dependencyKeys, isApiKeyName, keyNamePattern } from "./keys.ts";

describe("dependencyKeys", () => {
    it("is the S 5.5 table", () => {
        expect(dependencyKeys).toEqual({
            openai: "OPENAI_API_KEY",
            anthropic: "ANTHROPIC_API_KEY",
            "@anthropic-ai/sdk": "ANTHROPIC_API_KEY",
            elevenlabs: "ELEVENLABS_API_KEY",
            "@elevenlabs/elevenlabs-js": "ELEVENLABS_API_KEY",
            replicate: "REPLICATE_API_TOKEN",
            "fal-client": "FAL_KEY",
            "@fal-ai/client": "FAL_KEY",
            "google-genai": "GEMINI_API_KEY",
            "google-generativeai": "GEMINI_API_KEY",
            "@google/genai": "GEMINI_API_KEY",
            cohere: "COHERE_API_KEY",
            groq: "GROQ_API_KEY",
            "groq-sdk": "GROQ_API_KEY",
            "exa-py": "EXA_API_KEY",
            "exa-js": "EXA_API_KEY",
            mistralai: "MISTRAL_API_KEY",
            "@mistralai/mistralai": "MISTRAL_API_KEY",
        });
    });
});

describe("isApiKeyName", () => {
    it("accepts the table, the suffixes and the index's names", () => {
        for (const v of Object.values(dependencyKeys))
            expect(isApiKeyName(v, new Set())).toBe(true);
        expect(isApiKeyName("X_API_KEY", new Set())).toBe(true);
        expect(isApiKeyName("X_API_TOKEN", new Set())).toBe(true);
        expect(isApiKeyName("SERPER_KEY", new Set(["SERPER_KEY"]))).toBe(true);
    });

    it("refuses other secrets", () => {
        for (const n of ["JWT_SECRET", "SECRET_KEY", "NEXTAUTH_SECRET"]) {
            expect(isApiKeyName(n, new Set())).toBe(false);
        }
        expect(isApiKeyName("SERPER_KEY", new Set())).toBe(false);
    });
});

describe("keyNamePattern", () => {
    it("matches an environment variable name", () => {
        expect(keyNamePattern.test("OPENAI_API_KEY")).toBe(true);
        for (const n of ["openai", "A", "A".repeat(65)]) expect(keyNamePattern.test(n)).toBe(false);
    });
});
