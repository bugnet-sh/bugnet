import { describe, expect, it } from "vitest";
import { now } from "./fixtures.ts";
import {
    analyseModel,
    humanCount,
    modelFrom,
    modelSize,
    modelUrl,
    parametersFromName,
    type HfModel,
} from "./huggingface.ts";

const GiB = 1024 ** 3;

function model(over: Partial<HfModel> = {}): HfModel {
    return {
        id: "acme/model",
        files: [],
        safetensors: null,
        ggufParameters: null,
        pipelineTag: null,
        library: null,
        gated: false,
        tags: [],
        downloads: 50_000,
        likes: 100,
        createdAt: "2025-01-01T00:00:00.000Z",
        flagged: [],
        ...over,
    };
}

describe("Hugging Face API shape", () => {
    it("asks for file sizes, safetensors counts and the scan status", () => {
        const url = modelUrl("https://huggingface.co/", "hexgrad/Kokoro-82M", null);
        expect(url).toMatch(/^https:\/\/huggingface\.co\/api\/models\/hexgrad\/Kokoro-82M\?/);
        for (const part of [
            "blobs=true",
            "securityStatus=true",
            "expand[]=siblings",
            "expand[]=safetensors",
            "expand[]=private",
        ]) {
            expect(url).toContain(part);
        }
        expect(modelUrl("https://huggingface.co", "a/b", "v1.0")).toContain(
            "/api/models/a/b/revision/v1.0?",
        );
    });

    it("reads the live response shape", () => {
        const m = modelFrom({
            _id: "x",
            id: "black-forest-labs/FLUX.1-schnell",
            siblings: [
                {
                    rfilename: "flux1-schnell.safetensors",
                    size: 23_782_506_688,
                    lfs: { size: 23_782_506_688 },
                },
                { rfilename: "README.md", size: 3000 },
                { rfilename: "odd.bin", lfs: { size: 5 } },
                { nope: true },
            ],
            safetensors: { parameters: { BF16: 11_891_178_560 }, total: 11_891_178_560 },
            pipeline_tag: "text-to-image",
            library_name: "diffusers",
            gated: "auto",
            tags: ["diffusers", "license:apache-2.0"],
            securityRepoStatus: {
                scansDone: true,
                filesWithIssues: [{ path: "odd.bin", level: "unsafe" }],
            },
        });
        expect(m).toMatchObject({
            files: [
                { name: "flux1-schnell.safetensors", size: 23_782_506_688 },
                { name: "README.md", size: 3000 },
                { name: "odd.bin", size: 5 },
            ],
            safetensors: { BF16: 11_891_178_560 },
            pipelineTag: "text-to-image",
            library: "diffusers",
            gated: true,
            flagged: [{ path: "odd.bin", level: "unsafe" }],
        });
        expect(modelFrom({ error: "nope" })).toBeNull();
    });
});

describe("size maths", () => {
    it("reads parameter counts from names", () => {
        expect(parametersFromName("hexgrad/Kokoro-82M")).toBe(82e6);
        expect(parametersFromName("meta-llama/Llama-3.1-8B-Instruct")).toBe(8e9);
        expect(parametersFromName("Qwen/Qwen2.5-1.5B")).toBe(1.5e9);
        expect(parametersFromName("openai/whisper-large-v3")).toBeNull();
        expect(humanCount(82e6)).toBe("82M");
        expect(humanCount(8.03e9)).toBe("8B");
        expect(humanCount(1.54e9)).toBe("1.5B");
    });

    it("weighs safetensors by dtype instead of summing every file variant", () => {
        const m = model({
            safetensors: { F16: 1_543_490_560 },
            files: [
                { name: "model.safetensors", size: 3_087_000_000 },
                { name: "model.fp32-00001-of-00002.safetensors", size: 4_000_000_000 },
                { name: "pytorch_model.bin", size: 3_087_000_000 },
            ],
        });
        const s = modelSize(m);
        expect(s.parameters).toBe(1_543_490_560);
        expect(s.weightsBytes).toBe(1_543_490_560 * 2);
        expect(s.totalBytes).toBe(10_174_000_000);
    });

    it("takes the median GGUF file, since a user downloads one quantisation", () => {
        const m = model({
            id: "acme/Llama-2-7B-GGUF",
            ggufParameters: 6_738_415_616,
            files: [
                { name: "q2.gguf", size: 2e9 },
                { name: "q4.gguf", size: 4e9 },
                { name: "q8.gguf", size: 7e9 },
            ],
        });
        expect(modelSize(m)).toMatchObject({ parameters: 6_738_415_616, weightsBytes: 4e9 });
    });

    it("sums pickle weights when there is nothing else", () => {
        const m = model({
            id: "hexgrad/Kokoro-82M",
            files: [
                { name: "kokoro-v1_0.pth", size: 327_212_226 },
                { name: "voices/af.pt", size: 523_425 },
                { name: "config.json", size: 2351 },
            ],
        });
        expect(modelSize(m)).toMatchObject({
            parameters: 82e6,
            weightsBytes: 327_212_226 + 523_425,
        });
    });

    it("needs weights times 1.2 plus 1 GiB of memory and weights times 1.2 on disk", () => {
        const r = analyseModel(
            model({
                safetensors: { BF16: 8_030_261_248 },
                files: [{ name: "m.safetensors", size: 16 * GiB }],
            }),
            now,
        );
        const weightsGiB = (8_030_261_248 * 2) / GiB;
        expect(r.minMemoryGiB).toBe(Math.ceil((weightsGiB * 1.2 + 1) * 10) / 10);
        expect(r.minMemoryGiB).toBe(19);
        expect(r.minDiskGiB).toBe(18);
        expect(r.gpu).toBe(true);
        expect(r.facts).toMatchObject({ parameters: "8B", weightsGiB: 14.96 });
    });

    it("wants a GPU for image or video generation and for models over about 3B parameters", () => {
        const small = (pipelineTag: string | null, params: number) =>
            analyseModel(model({ pipelineTag, safetensors: { F16: params } }), now).gpu;
        expect(small("text-to-image", 1e9)).toBe(true);
        expect(small("image-to-video", 1e9)).toBe(true);
        expect(small("text-generation", 7e9)).toBe(true);
        expect(small("text-generation", 1.5e9)).toBe(false);
        expect(small("automatic-speech-recognition", 1.54e9)).toBe(false);
    });

    it("sizes a GGUF repo by the one quantisation a user downloads and needs no GPU for it", () => {
        const quants = ["Q2_K", "Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"];
        const r = analyseModel(
            model({
                id: "TheBloke/Llama-2-7B-GGUF",
                ggufParameters: 6_738_415_616,
                pipelineTag: "text-generation",
                files: quants.map((q, i) => ({
                    name: `llama-2-7b.${q}.gguf`,
                    size: (2.8 + i) * GiB,
                })),
            }),
            now,
        );
        expect(r.minDiskGiB).toBe(Math.ceil(4.8 * 1.2));
        expect(r.minDiskGiB).toBeLessThan(10);
        expect(r.gpu).toBe(false);
    });
});

describe("model findings", () => {
    it("flags pickle-only weights as medium, but not when safetensors exist", () => {
        const pickles = analyseModel(
            model({
                files: [
                    { name: "kokoro.pth", size: 1 },
                    { name: "voices/a.pt", size: 1 },
                ],
            }),
            now,
        );
        expect(pickles.findings).toMatchObject([{ id: "pickle_weights", severity: "medium" }]);
        const popular = analyseModel(
            model({ downloads: 11_880_507, files: [{ name: "kokoro.pth", size: 1 }] }),
            now,
        );
        expect(popular.findings).toMatchObject([{ id: "pickle_weights", severity: "low" }]);
        const both = analyseModel(
            model({
                files: [
                    { name: "pytorch_model.bin", size: 1 },
                    { name: "model.safetensors", size: 1 },
                ],
            }),
            now,
        );
        expect(both.findings).toEqual([]);
    });

    it("notes gated models, custom code, scanner flags and brand-new unused models", () => {
        const r = analyseModel(
            model({
                gated: true,
                tags: ["custom_code"],
                flagged: [{ path: "evil.pkl", level: "unsafe" }],
                downloads: 3,
                createdAt: new Date(now - 5 * 86_400_000).toISOString(),
            }),
            now,
        );
        expect(r.findings.map((f) => [f.id, f.severity])).toEqual([
            ["remote_code", "medium"],
            ["hf_scan_flagged", "high"],
            ["gated_model", "info"],
            ["hf_little_used", "low"],
        ]);
    });
});
