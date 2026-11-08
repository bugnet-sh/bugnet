import { Code } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import type { Assessment, Assessor } from "../assess/assessor.ts";
import {
    fakeFetch,
    githubRoutes,
    keyedRepo,
    leakedKeyValue,
    now as assessNow,
} from "../assess/fixtures.ts";
import { createAssessor } from "../assess/index.ts";
import { combine } from "../assess/verdict.ts";
import {
    Confidence,
    Dimension,
    EstimateBasis,
    GpuNeed,
    Need,
    SourceKind,
    WarningCode,
    Workload,
    type EstimateRequest,
} from "../gen/bugnet/router/v1/router_pb.ts";
import { withClientAddress } from "../request.ts";
import type { RouterClient } from "../router.ts";
import { verifyQuote } from "../quote.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    recordingLog,
    routerError,
    testConfig,
    testDeps,
    testNow,
    testPayments,
    type RouterImpl,
} from "../testing/harness.ts";
import {
    assessDescription,
    renderAssessment,
    tooLargeSummary,
    unavailableSummary,
} from "./assess.ts";
import { buildQuote, type BuiltQuote } from "./quote.ts";

const now = testNow;

const assessment: Assessment = {
    recommendation: "sandbox_strongly_recommended",
    summary:
        "Needs about 27.6 GiB of memory, this machine has 16 GiB. A Bugnet cloud sandbox can run it on rented hardware instead.",
    categories: ["local_ai_model"],
    risk: {
        level: "low",
        findings: Array.from({ length: 10 }, (_, i) => ({
            id: `rule_${i}`,
            severity: "low" as const,
            title: `Finding ${i}`,
            evidence: `excerpt ${i}`,
        })),
    },
    needs: { gpu: true, minMemoryGiB: 27.6, minDiskGiB: 55, workload: "inference" },
    fit: {
        level: "does_not_fit",
        findings: [
            { id: "local_memory", severity: "medium", title: "Needs about 27.6 GiB of memory" },
        ],
    },
    apiKeys: [],
    otherSecrets: [],
    source: {
        kind: "huggingface",
        ref: "huggingface.co/black-forest-labs/FLUX.1-schnell",
        facts: {},
    },
};

function option(
    id: string,
    priceMicros: bigint,
    gpuCount: number,
    memoryMib: number,
    diskGib = 100,
) {
    return {
        packageId: id,
        priceMicros,
        minutes: 30,
        available: true,
        resources: { vcpu: 4, memoryMib, diskGib, gpuCount },
    };
}

async function connect(
    router: RouterImpl,
    seen: { input?: unknown } = {},
    result: Assessment = assessment,
    toml = "",
) {
    const assessor: Assessor = {
        async assess(input) {
            seen.input = input;
            return result;
        },
    };
    const deps = testDeps({ router: fakeRouter(router), assessor, config: testConfig(toml) });
    const client = await connectTools(deps);
    return { client, deps };
}

type Result = {
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: { assessment: Assessment; quote: { quoteId: string } | null };
};

describe("bugnet_assess tool", () => {
    it("is listed as a free, read-only, always-loaded tool with a factual description", async () => {
        const { client } = await connect({});
        const { tools } = await client.listTools();
        const t = tools.find((x) => x.name === "bugnet_assess");
        expect(t?.title).toBe("Check whether to use a Bugnet sandbox (free)");
        expect(t?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
        expect(t?._meta?.["anthropic/alwaysLoad"]).toBe(true);
        expect(assessDescription.length).toBeLessThan(900);
        const first = assessDescription.split(". ")[0] as string;
        for (const word of [
            "untrusted",
            "repo",
            "script",
            "installer",
            "AI model",
            "text to speech",
            "image generation",
            "local LLM",
            "GPU",
        ]) {
            expect(first).toContain(word);
        }
        expect(assessDescription).not.toMatch(/best|amazing|always use|you should/i);
    });

    it("returns the verdict, at most eight findings, needs and a GPU quote", async () => {
        const seen: { input?: unknown } = {};
        let asked: EstimateRequest | undefined;
        const { client, deps } = await connect(
            {
                estimate(req) {
                    asked = req;
                    return {
                        options: [
                            option("cpu-s", 50_000n, 0, 4096),
                            option("gpu-m", 900_000n, 1, 32768),
                        ],
                    };
                },
            },
            seen,
        );
        const r = (await client.callTool({
            name: "bugnet_assess",
            arguments: {
                task: "run flux",
                source: "black-forest-labs/FLUX.1-schnell",
                local: { os: "macOS", ramGiB: 16, gpu: "Apple M2" },
            },
        })) as Result;
        expect(r.isError).toBeFalsy();
        const text = r.content.map((c) => c.text).join("\n");
        expect(text).toMatch(
            /^Recommendation: sandbox_strongly_recommended\. Needs about 27\.6 GiB/,
        );
        expect(text).toMatch(/Findings \(8 of 11\)/);
        expect(text.match(/^- /gm)).toHaveLength(8);
        expect(text).toMatch(/- medium: Needs about 27\.6 GiB of memory/);
        expect(text).toMatch(
            /Needs: GPU yes, memory about 27\.6 GiB, disk about 55 GiB, workload inference\. Fit with this machine: does_not_fit\./,
        );
        expect(text).toMatch(
            /Recommended package: gpu-m, 4 vCPU \/ 32 GiB \/ 1 GPU, 30 min, \$0\.90 USDC/,
        );
        expect(text).toMatch(/quoteId \(valid 10 min\): q3\./);
        expect(text.trim().endsWith("Ask the user before bugnet_start.")).toBe(true);
        expect(asked?.requirements).toMatchObject({ gpu: true });
        expect(asked).toMatchObject({
            source: "black-forest-labs/FLUX.1-schnell",
            workload: Workload.INFERENCE,
        });
        expect(seen.input).toMatchObject({
            task: "run flux",
            source: "black-forest-labs/FLUX.1-schnell",
        });
        const quote = r.structuredContent?.quote as { quoteId: string; floor: unknown };
        expect(quote.floor).toBeNull();
        const claims = verifyQuote(deps.config.secrets.quoteKey, quote.quoteId, now);
        expect(claims.requirements.gpu).toBe(true);
        expect(r.structuredContent?.assessment.recommendation).toBe("sandbox_strongly_recommended");
    });

    it("never recommends a package smaller than the memory and disk the work needs", async () => {
        const huge: Assessment = {
            ...assessment,
            needs: { gpu: true, minMemoryGiB: 770.4, minDiskGiB: 643, workload: "inference" },
            fit: {
                level: "does_not_fit",
                findings: [
                    {
                        id: "local_memory",
                        severity: "medium",
                        title: "Needs about 770.4 GiB of memory, this machine has 16 GiB",
                    },
                ],
            },
        };
        const { client } = await connect(
            {
                estimate: () => ({
                    options: [
                        option("cpu-s", 50_000n, 0, 4096),
                        option("gpu-m", 900_000n, 1, 32768),
                    ],
                }),
            },
            {},
            huge,
        );
        const r = (await client.callTool({
            name: "bugnet_assess",
            arguments: { source: "deepseek-ai/DeepSeek-R1" },
        })) as Result;
        const text = r.content.map((c) => c.text).join("\n");
        expect(text).not.toMatch(/Recommended package/);
        expect(text).not.toMatch(/sandbox can run/);
        expect(text).toMatch(/No package is large enough, 2 others are in the quote/);
        expect(text).toMatch(
            /Warning: No package is large enough for about 770\.4 GiB of memory and 643 GiB of disk\./,
        );
        const summary = r.structuredContent?.assessment.summary ?? "";
        expect(summary).toMatch(
            /^Needs about 770\.4 GiB of memory, this machine has 16 GiB\. No Bugnet package is large enough/,
        );
    });

    it("gives the router call a signal that aborts when the quote budget runs out", async () => {
        let seen: AbortSignal | undefined;
        let abortedAtCall: boolean | undefined;
        const { client, deps } = await connect({
            estimate(_req, ctx) {
                seen = ctx.signal;
                abortedAtCall = ctx.signal.aborted;
                return { options: [option("cpu-s", 50_000n, 0, 4096)] };
            },
        });
        await client.callTool({ name: "bugnet_assess", arguments: { source: "acme/model" } });
        expect(seen).toBeInstanceOf(AbortSignal);
        expect(abortedAtCall).toBe(false);
        const stop = new AbortController();
        const hang = buildQuote(
            {
                ...deps,
                router: {
                    estimate: ((_req: unknown, opts?: { signal?: AbortSignal }) =>
                        new Promise((_resolve, reject) => {
                            opts?.signal?.addEventListener("abort", () =>
                                reject(new Error("aborted")),
                            );
                        })) as unknown as RouterClient["estimate"],
                } as RouterClient,
            },
            { workload: "other" },
            stop.signal,
        );
        stop.abort();
        await expect(hang).rejects.toThrow("aborted");
    });

    it("still returns the assessment when the router is down", async () => {
        const { client } = await connect({
            estimate() {
                throw routerError(Code.Unavailable, undefined, { message: "connect refused" });
            },
        });
        const r = (await client.callTool({
            name: "bugnet_assess",
            arguments: { source: "acme/model" },
        })) as Result;
        expect(r.isError).toBeFalsy();
        const text = r.content.map((c) => c.text).join("\n");
        expect(text).toMatch(/No quote: prices are unavailable right now/);
        expect(text).toMatch(/Ask the user before bugnet_start\.$/);
        expect(r.structuredContent?.quote).toBeNull();
        expect(r.structuredContent?.assessment.summary).toBe(assessment.summary);
    });

    it("refuses more than twenty commands", async () => {
        const { client } = await connect({});
        const r = (await client.callTool({
            name: "bugnet_assess",
            arguments: { commands: Array.from({ length: 21 }, () => "ls") },
        })) as Result;
        expect(r.isError).toBe(true);
    });
});

describe("bugnet_assess with the router's estimator", () => {
    const floored = (init: Record<string, unknown> = {}) => ({
        options: [
            { ...option("gpu-m", 900_000n, 1, 32768), fits: false, shortOn: [Dimension.MEMORY] },
            {
                ...option("gpu-l", 1_800_000n, 1, 65536, 200),
                fits: true,
                totalPriceMicros: 1_800_000n,
            },
        ],
        estimateId: "0f8b6c2e-41d7-4a3b-9c5e-7d2a1b3c4d5e",
        basis: EstimateBasis.SIGNALS,
        confidence: Confidence.HIGH,
        floor: {
            resources: { vcpu: 8, memoryMib: 40960, diskGib: 80, gpuCount: 1, gpuMemoryGib: 24 },
            minutes: 30,
            gpu: GpuNeed.REQUIRED,
        },
        recommendedPackageId: "gpu-l",
        reasons: [{ ruleId: "hf.weights", message: "The weights take 23.8 GiB" }],
        warnings: [{ code: WarningCode.GATED_MODEL, message: "The model is gated" }],
        source: { kind: SourceKind.HUGGINGFACE_MODEL },
        ...init,
    });

    it("takes the floor, warnings and recommended package from the router", async () => {
        const { client } = await connect({ estimate: () => floored() });
        const r = (await client.callTool({
            name: "bugnet_assess",
            arguments: { source: "black-forest-labs/FLUX.1-schnell" },
        })) as Result;
        const quote = r.structuredContent?.quote as unknown as BuiltQuote["structured"];
        expect(quote.floor).toEqual(
            expect.objectContaining({ memoryGiB: 40, diskGiB: 80, gpu: "required" }),
        );
        expect(quote.recommended?.packageId).toBe("gpu-l");
        expect(quote.warnings).toEqual(["The model is gated"]);
        const a = r.structuredContent?.assessment as Assessment;
        expect(a.needs).toEqual({
            gpu: true,
            minMemoryGiB: 40,
            minDiskGiB: 80,
            workload: "inference",
        });
        expect(a.summary).toBe(assessment.summary);
        expect(a.risk).toEqual(assessment.risk);
        const text = r.content.map((c) => c.text).join("\n");
        expect(text).toMatch(
            /^Needs: GPU yes, memory about 40 GiB, disk about 80 GiB, workload inference\./m,
        );
        expect(text).toMatch(
            /^Recommended package: gpu-l, 4 vCPU \/ 64 GiB \/ 1 GPU, 30 min, \$1\.80 USDC\.$/m,
        );
        expect(text).toMatch(/^Why: The weights take 23\.8 GiB\.$/m);
        expect(text).toMatch(/^Warning: The model is gated\.$/m);
    });

    it("keeps the assessor's sizing for what the router's floor leaves unknown", async () => {
        const { client } = await connect({
            estimate: () =>
                floored({
                    floor: { resources: { vcpu: 2, memoryMib: 0, diskGib: 0 }, minutes: 10 },
                }),
        });
        const r = (await client.callTool({
            name: "bugnet_assess",
            arguments: { source: "black-forest-labs/FLUX.1-schnell" },
        })) as Result;
        expect(r.structuredContent?.assessment.needs).toEqual(assessment.needs);
    });

    it("says no package is large enough from the router's floor", async () => {
        const { client } = await connect({
            estimate: () =>
                floored({
                    recommendedPackageId: "",
                    options: [
                        {
                            ...option("gpu-m", 900_000n, 1, 32768),
                            fits: false,
                            shortOn: [Dimension.MEMORY],
                        },
                    ],
                    warnings: [{ code: WarningCode.TOO_LARGE, message: "No package has 40 GiB" }],
                }),
        });
        const r = (await client.callTool({
            name: "bugnet_assess",
            arguments: { source: "black-forest-labs/FLUX.1-schnell" },
        })) as Result;
        const a = r.structuredContent?.assessment as Assessment;
        expect(a.summary).toBe(
            "Needs about 27.6 GiB of memory. No Bugnet package is large enough for about 40 GiB " +
                "of memory and 80 GiB of disk either, so a smaller or quantised variant is the " +
                "way to run it.",
        );
        const text = r.content.map((c) => c.text).join("\n");
        expect(text).toMatch(/No package is large enough, 1 others are in the quote/);
    });

    it("says no package can start when the router's pick is busy", async () => {
        const { client } = await connect({
            estimate: () => {
                const busy = floored();
                busy.options[1] = { ...busy.options[1], available: false } as never;
                return busy;
            },
        });
        const r = (await client.callTool({
            name: "bugnet_assess",
            arguments: { source: "black-forest-labs/FLUX.1-schnell" },
        })) as Result;
        const a = r.structuredContent?.assessment as Assessment;
        expect(a.summary).toMatch(/No Bugnet GPU sandbox is available right now/);
    });

    it("quotes without the source when the router refuses it", async () => {
        const asked: string[] = [];
        const { client } = await connect({
            estimate(req) {
                asked.push(req.source);
                if (req.source) throw routerError(Code.InvalidArgument, "SOURCE_INVALID");
                return { options: [option("cpu-s", 50_000n, 0, 4096)] };
            },
        });
        const r = (await client.callTool({
            name: "bugnet_assess",
            arguments: { source: "black-forest-labs/FLUX.1-schnell" },
        })) as Result;
        expect(asked).toEqual(["black-forest-labs/FLUX.1-schnell", ""]);
        expect(r.structuredContent?.quote).not.toBeNull();
    });

    it("quotes with the agent's needs and its first command, so the start keeps them", async () => {
        let asked: EstimateRequest | undefined;
        const { client } = await connect({
            estimate(req) {
                asked = req;
                return { options: [option("cpu-s", 50_000n, 0, 4096)] };
            },
        });
        const long = "npm run dev -- " + "é".repeat(600);
        await client.callTool({
            name: "bugnet_assess",
            arguments: {
                task: "run the app and call OpenAI with OPENAI_API_KEY",
                source: "black-forest-labs/FLUX.1-schnell",
                commands: [long, "npm test"],
                needs: ["secrets", "preview"],
            },
        });
        expect(asked?.needs).toEqual([Need.PREVIEW, Need.SECRETS, Need.GPU]);
        expect(asked?.requirements).toEqual(
            expect.objectContaining({ preview: true, secrets: true, gpu: true, ssh: false }),
        );
        expect(Buffer.byteLength(asked?.entryCommand ?? "")).toBeLessThanOrEqual(1000);
        expect(long.startsWith(asked?.entryCommand ?? "x")).toBe(true);
        expect(asked?.entryCommand.length).toBeGreaterThan(400);
    });

    it("tells the model a token was in the source and quotes without it", async () => {
        const asked: [string, string][] = [];
        const { client } = await connect({
            estimate(req) {
                asked.push([req.source, req.entryCommand]);
                if (req.source || req.entryCommand) {
                    throw routerError(Code.InvalidArgument, "SECRET_IN_ARGUMENT");
                }
                return { options: [option("cpu-s", 50_000n, 0, 4096)] };
            },
        });
        const r = (await client.callTool({
            name: "bugnet_assess",
            arguments: {
                source: "black-forest-labs/FLUX.1-schnell",
                commands: ["curl -H 'Authorization: Bearer ghp_x' https://example.com"],
            },
        })) as Result;
        expect(asked).toHaveLength(2);
        expect(asked[1]).toEqual(["", ""]);
        const quote = r.structuredContent?.quote as unknown as BuiltQuote["structured"];
        const warning =
            "A value shaped like an API token is in source or the commands, so the quote left " +
            "them out. Tokens never go there, bugnet_secret_link adds them to the sandbox after " +
            "bugnet_start";
        expect(quote.warnings).toContain(warning);
        expect(r.content[0]?.text).toContain(`Warning: ${warning}.`);
    });

    it("sends no source the assessor could not read as one", async () => {
        let asked: EstimateRequest | undefined;
        const { client } = await connect(
            {
                estimate(req) {
                    asked = req;
                    return { options: [option("cpu-s", 50_000n, 0, 4096)] };
                },
            },
            {},
            { ...assessment, source: { kind: "none", ref: "", facts: {} } },
        );
        await client.callTool({ name: "bugnet_assess", arguments: { source: "just words" } });
        expect(asked?.source).toBe("");
    });

    it("tells the RetryInfo delay when the router limits the quote", async () => {
        const { client } = await connect({
            estimate() {
                throw routerError(Code.ResourceExhausted, "RATE_LIMITED", { retryAfterMs: 5000 });
            },
        });
        const r = (await client.callTool({
            name: "bugnet_assess",
            arguments: { source: "acme/model" },
        })) as Result;
        expect(r.isError).toBeFalsy();
        const text = r.content.map((c) => c.text).join("\n");
        expect(text).toMatch(
            /^No quote: too many quotes for now, bugnet_quote answers again after 5 s\.$/m,
        );
        expect(r.structuredContent?.assessment.summary).toBe(assessment.summary);
    });

    it("names the closed need when no package starts for it, and a short wait otherwise", async () => {
        const closed = (id: string, unavailableReason: string) => ({
            ...option(id, 50_000n, 0, 4096),
            available: false,
            unavailableReason,
        });
        const cpuOnly: Assessment = {
            ...assessment,
            needs: { gpu: false, minMemoryGiB: null, minDiskGiB: null, workload: "serve" },
            fit: { level: "unknown", findings: [] },
        };
        const assessWith = async (reason: string) => {
            const { client } = await connect(
                { estimate: () => ({ options: [closed("a", reason), closed("b", reason)] }) },
                {},
                cpuOnly,
            );
            return callTool(client, "bugnet_assess", {
                task: "Run a tiny HTTP server and give me a link to it",
                needs: ["preview"],
            });
        };
        const shut = await assessWith("feature_unavailable");
        expect(shut.isError).toBe(false);
        expect(shut.text).toMatch(
            /^No package can start with the need preview, which is not open yet\. A quote without it may list packages that start\.$/m,
        );
        expect(shut.text).not.toMatch(/^No package can start right now/m);
        expect(shut.text).not.toMatch(/quoteId/);
        const busy = await assessWith("no_candidate");
        expect(busy.text).toMatch(/^No package can start right now\. Try again in a minute\.$/m);
    });

    it("is limited per client address before any source is read", async () => {
        const seen: { input?: unknown } = {};
        const assessor: Assessor = {
            async assess(input) {
                seen.input = input;
                return assessment;
            },
        };
        const deps = testDeps({
            config: testConfig("[limits]\nquote_burst = 1"),
            router: fakeRouter({
                estimate: () => ({ options: [option("cpu-s", 50_000n, 0, 4096)] }),
            }),
            assessor,
        });
        const client = await connectTools(deps);
        const call = () =>
            withClientAddress("198.51.100.4", () =>
                callTool(client, "bugnet_assess", { source: "acme/model" }),
            );
        expect((await call()).isError).toBe(false);
        seen.input = undefined;
        const limited = await call();
        expect(limited.isError).toBe(true);
        expect(limited.text).toBe(
            "assess: too many quotes and checks from this address for now. Retry after 5 s.",
        );
        expect(seen.input).toBeUndefined();
    });
});

describe("renderAssessment", () => {
    it("notes that the user has not seen a check that favours a sandbox", () => {
        const shared = /The user has not seen this check, so share it before any local install/;
        expect(renderAssessment(assessment, null)).toMatch(shared);
        const fine: Assessment = { ...assessment, recommendation: "local_ok" };
        const text = renderAssessment(fine, null);
        expect(text).not.toMatch(shared);
        expect(text.endsWith("Ask the user before bugnet_start.")).toBe(true);
    });
});

describe("unavailableSummary", () => {
    it("never promises a sandbox when no GPU package can start", () => {
        const gpuWork: Assessment = {
            ...assessment,
            needs: { ...assessment.needs, gpu: true },
            fit: { level: "unknown", findings: [] },
        };
        const s = unavailableSummary(gpuWork);
        expect(s).toMatch(/No Bugnet GPU sandbox is available right now/);
        expect(s).not.toMatch(/can run/);
    });

    it("says no package offers the work's needs yet, never to try again soon", () => {
        const s = unavailableSummary(
            { ...assessment, needs: { ...assessment.needs, gpu: false } },
            true,
        );
        expect(s).toMatch(/No Bugnet package offers what it needs yet\.$/);
        expect(s).not.toMatch(/try again/);
    });

    it("drops the summary's sandbox sentence once no sandbox can start", () => {
        const s = unavailableSummary({
            ...assessment,
            summary:
                "No red flags found in acme/model (9.56 GiB of weights), but it installs an AI model. A Bugnet sandbox keeps that off the user's machine.",
            fit: { level: "unknown", findings: [] },
        });
        expect(s).toBe(
            "No red flags found in acme/model (9.56 GiB of weights), but it installs an AI model. No Bugnet GPU sandbox is available right now, so Bugnet cannot run it yet.",
        );
    });
});

describe("summaries once no package fits or starts", () => {
    const pipe = {
        id: "pipe_to_shell",
        severity: "high" as const,
        title: "The installer pipes a remote script into a shell",
    };
    for (const name of ["install.sh", "vercel/next.js", "Qwen/Qwen2.5-7B"]) {
        it(`keep whole sentences for ${name}`, () => {
            const a = combine(
                {},
                {
                    kind: "url",
                    ref: name,
                    name,
                    checked: true,
                    complete: true,
                    facts: {},
                    findings: [pipe],
                    categories: [],
                    gpu: false,
                    cuda: false,
                    minMemoryGiB: 64,
                    minDiskGiB: null,
                    workload: null,
                    apiKeys: [],
                    otherSecrets: [],
                },
            );
            expect(unavailableSummary(a)).toBe(
                "The installer pipes a remote script into a shell. No Bugnet package can start right now, try again in a minute.",
            );
            expect(tooLargeSummary(a)).toMatch(
                /^The installer pipes a remote script into a shell\. No Bugnet package is large enough/,
            );
        });
    }
});

const on = "[x402]\nenabled = true";
const keyed: Assessment = {
    ...assessment,
    apiKeys: [{ name: "OPENAI_API_KEY", from: "dependency", package: "openai" }],
    otherSecrets: ["JWT_SECRET"],
};

describe("renderAssessment API key lines", () => {
    it("names the keys, both ways to get one, and the other secrets, just before the needs line", () => {
        const lines = renderAssessment(keyed, null, { x402Enabled: true }).split("\n");
        const at = lines.findIndex((l) => l.startsWith("Needs: "));
        expect(lines.slice(at - 2, at)).toEqual([
            "API keys the code reads: OPENAI_API_KEY (openai). In a sandbox, bugnet_secret_link adds a key the user has, and bugnet_x402_find finds pay-per-call APIs that need none.",
            "Other secrets the code reads: JWT_SECRET. A random value usually works in a sandbox.",
        ]);
    });
    it("keeps only the first sentence with x402 off", () => {
        expect(renderAssessment(keyed, null).split("\n")).toContain(
            "API keys the code reads: OPENAI_API_KEY (openai).",
        );
    });
    it("lists keys without a package bare", () => {
        const a: Assessment = {
            ...assessment,
            apiKeys: [
                { name: "ELEVENLABS_API_KEY", from: "dependency", package: "elevenlabs" },
                { name: "MY_API_KEY", from: "env_example" },
            ],
        };
        expect(renderAssessment(a, null)).toContain(
            "API keys the code reads: ELEVENLABS_API_KEY (elevenlabs), MY_API_KEY.",
        );
    });
});

describe("bugnet_assess API keys and the secrets need", () => {
    async function asked(
        result: Assessment,
        toml: string,
        payments?: ReturnType<typeof testPayments>,
    ) {
        let req: EstimateRequest | undefined;
        const assessor: Assessor = { assess: async () => result };
        const deps = testDeps({
            router: fakeRouter({
                estimate(r) {
                    req = r;
                    return { options: [option("cpu-s", 50_000n, 0, 4096)] };
                },
            }),
            assessor,
            config: testConfig(toml),
            ...(payments ? { payments } : {}),
        });
        const client = await connectTools(deps);
        const r = await callTool(client, "bugnet_assess", { source: "acme/tool" });
        return { req, text: r.text };
    }

    it("adds the secrets need only for API keys with [x402] on", async () => {
        const onRun = await asked(keyed, on);
        expect(onRun.req?.needs).toContain(Need.SECRETS);
        expect(onRun.req?.requirements?.secrets).toBe(true);
        const offRun = await asked(keyed, "");
        expect(offRun.req?.needs).not.toContain(Need.SECRETS);
        expect(offRun.text).toContain("API keys the code reads: OPENAI_API_KEY (openai).");
        expect(offRun.text).not.toContain("bugnet_x402_find");
    });
    it("follows the deploy switch, not the terms", async () => {
        const run = await asked(keyed, on, testPayments(undefined, { terms: { enabled: false } }));
        expect(run.req?.needs).toContain(Need.SECRETS);
        expect(run.text).toContain("bugnet_x402_find finds pay-per-call APIs that need none.");
    });
    it("never adds the need for other secrets", async () => {
        const run = await asked({ ...assessment, otherSecrets: ["JWT_SECRET"] }, on);
        expect(run.req?.needs).not.toContain(Need.SECRETS);
        expect(run.text).toContain("Other secrets the code reads: JWT_SECRET.");
    });
    it("never returns or logs a value from the env example", async () => {
        const { log, lines } = recordingLog();
        const { fetch } = fakeFetch(githubRoutes(keyedRepo()));
        const config = testConfig(on);
        const deps = testDeps({
            router: fakeRouter({
                estimate: () => ({ options: [option("cpu-s", 50_000n, 0, 4096)] }),
            }),
            assessor: createAssessor(config, { fetch, now: () => assessNow }),
            log,
            config,
        });
        const client = await connectTools(deps);
        const r = await callTool(client, "bugnet_assess", {
            source: "https://github.com/acme/tool",
        });
        expect(JSON.stringify(r)).not.toContain(leakedKeyValue);
        expect(lines.join("\n")).not.toContain(leakedKeyValue);
        expect(r.text).toContain(
            "API keys the code reads: ANTHROPIC_API_KEY (@anthropic-ai/sdk), FAL_KEY (fal-client), OPENAI_API_KEY (openai). In a sandbox,",
        );
    });
});
