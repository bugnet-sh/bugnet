import { describe, expect, it } from "vitest";
import { parseSettings, type Config } from "../config.ts";
import { createAssessor } from "./index.ts";

// Hits the real GitHub and Hugging Face APIs, so it runs only on request
const live = process.env.BUGNET_LIVE_ASSESS === "1";

function config(): Config {
    return {
        ...parseSettings(""),
        secrets: {
            internalToken: "",
            quoteKey: Buffer.alloc(32, 1),
            orderPrivateKey: null,
            paymentsToken: "",
            githubToken: process.env.GITHUB_TOKEN ?? "",
            huggingfaceToken: process.env.HF_TOKEN ?? "",
        },
    };
}

describe.skipIf(!live)("live assess smoke", () => {
    const assessor = createAssessor(config());
    const mac = { os: "macOS", arch: "arm64", ramGiB: 16, gpu: "Apple M2" };

    it("reads openai/whisper from GitHub as a low-risk AI repo", async () => {
        const r = await assessor.assess(
            { source: "github.com/openai/whisper", local: mac },
            AbortSignal.timeout(12_000),
        );
        console.log("whisper", JSON.stringify({ ...r, source: { ...r.source } }));
        expect(r.risk.findings.map((f) => f.id)).not.toContain("github_rate_limited");
        expect(r.source.kind).toBe("github");
        expect(r.source.facts).toMatchObject({ repo: "openai/whisper", license: "MIT" });
        expect(r.source.facts.stars as number).toBeGreaterThan(50_000);
        expect(r.risk.level).toBe("low");
        expect(r.categories).toContain("local_ai_model");
        expect(r.recommendation).toBe("sandbox_recommended");
    });

    it("follows GitHub's redirect for a renamed repo", async () => {
        const r = await assessor.assess(
            { source: "https://github.com/ggerganov/llama.cpp" },
            AbortSignal.timeout(12_000),
        );
        console.log("llama.cpp", JSON.stringify({ facts: r.source.facts, risk: r.risk }));
        expect(r.risk.findings.map((f) => f.id)).not.toContain("github_rate_limited");
        expect(r.source.facts.repo).toBe("ggml-org/llama.cpp");
        expect(r.risk.findings.map((f) => f.id)).not.toContain("lookalike_name");
    });

    it("reads hexgrad/Kokoro-82M from Hugging Face with its sizes", async () => {
        const r = await assessor.assess(
            { source: "hexgrad/Kokoro-82M", local: mac },
            AbortSignal.timeout(12_000),
        );
        console.log("kokoro", JSON.stringify(r));
        expect(r.source.kind).toBe("huggingface");
        expect(r.source.facts).toMatchObject({ parameters: "82M", pipelineTag: "text-to-speech" });
        expect(r.risk.findings.map((f) => f.id)).toContain("pickle_weights");
        expect(r.needs.gpu).toBe(false);
        expect(r.needs.minMemoryGiB as number).toBeGreaterThan(1);
        expect(r.needs.minMemoryGiB as number).toBeLessThan(3);
    });
});
