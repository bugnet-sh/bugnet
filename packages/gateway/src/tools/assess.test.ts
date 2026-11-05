import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { Assessment, Assessor } from "../assess/assessor.ts";
import { parseSettings, type Config } from "../config.ts";
import { silentLog } from "../log.ts";
import type { Payments } from "../payments/port.ts";
import type { RouterClient } from "../router.ts";
import { verifyQuote } from "../quote.ts";
import { assessDescription, registerAssessTool, unavailableSummary, userLines } from "./assess.ts";
import type { Deps } from "./common.ts";
import { buildQuote } from "./sandbox.ts";

const now = Date.parse("2026-11-05T12:00:00Z");

function config(): Config {
    return {
        ...parseSettings(""),
        secrets: {
            internalToken: "",
            quoteKey: Buffer.alloc(32, 3),
            orderPrivateKey: null,
            paymentsToken: "",
            githubToken: "",
            huggingfaceToken: "",
        },
    };
}

const assessment: Assessment = {
    recommendation: "sandbox_strongly_recommended",
    summary:
        "Needs about 27.6 GiB of memory, this machine has 16 GiB. A Bugnet cloud sandbox can run it.",
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
    router: Partial<RouterClient>,
    seen: { input?: unknown } = {},
    result: Assessment = assessment,
) {
    const assessor: Assessor = {
        async assess(input) {
            seen.input = input;
            return result;
        },
    };
    const deps: Deps = {
        config: config(),
        router: router as RouterClient,
        payments: {} as Payments,
        assessor,
        log: silentLog,
        now: () => now,
    };
    const server = new McpServer({ name: "t", version: "0" });
    registerAssessTool(server, deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    return { client, deps };
}

type Result = {
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: {
        forUser: string;
        assessment: Assessment;
        quote: { quoteId: string } | null;
    };
};

describe("bugnet_assess tool", () => {
    it("is listed as a free, read-only, always-loaded tool with a factual description", async () => {
        const { client } = await connect({});
        const { tools } = await client.listTools();
        const t = tools.find((x) => x.name === "bugnet_assess");
        expect(t?.title).toBe("Check whether to use a Bugnet sandbox (free)");
        expect(t?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
        expect(t?._meta?.["anthropic/alwaysLoad"]).toBe(true);
        expect(assessDescription.length).toBeLessThan(1300);
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
        let requirements: unknown;
        const { client, deps } = await connect(
            {
                estimate: (async (req: { requirements: unknown }) => {
                    requirements = req.requirements;
                    return {
                        options: [
                            option("cpu-s", 50_000n, 0, 4096),
                            option("gpu-m", 900_000n, 1, 32768),
                        ],
                    };
                }) as unknown as RouterClient["estimate"],
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
        expect(text).toMatch(/quoteId \(valid 10 min\): q1\./);
        expect(text).toMatch(
            /For the user, in one or two sentences before anything is fetched, installed or run locally:\nVerdict: a disposable Bugnet cloud sandbox is strongly recommended\. Needs about 27\.6 GiB/,
        );
        expect(text).toMatch(
            /Price: \$0\.90 USDC for 30 min \(gpu-m, 4 vCPU \/ 32 GiB \/ 1 GPU\), paid per run on Solana/,
        );
        expect(text).toMatch(/Question: use the Bugnet sandbox, or their own computer\?/);
        expect(text.trim().endsWith("Bugnet is not offered again for this task.")).toBe(true);
        expect(requirements).toMatchObject({ gpu: true });
        expect(seen.input).toMatchObject({
            task: "run flux",
            source: "black-forest-labs/FLUX.1-schnell",
        });
        const quote = r.structuredContent?.quote as { quoteId: string };
        const claims = verifyQuote(deps.config.secrets.quoteKey, quote.quoteId, now);
        expect(claims.source).toBe("black-forest-labs/FLUX.1-schnell");
        expect(r.structuredContent?.assessment.recommendation).toBe("sandbox_strongly_recommended");
        expect(Object.keys(r.structuredContent ?? {})[0]).toBe("forUser");
        expect(r.structuredContent?.forUser).toMatch(
            /^For the user, in one or two sentences before anything is fetched, installed or run locally: Verdict: /,
        );
        expect(r.structuredContent?.forUser).toMatch(/Question: use the Bugnet sandbox/);
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
        const estimate = (async () => ({
            options: [option("cpu-s", 50_000n, 0, 4096), option("gpu-m", 900_000n, 1, 32768)],
        })) as unknown as RouterClient["estimate"];
        const { client } = await connect({ estimate }, {}, huge);
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
        expect(text).toMatch(/No Bugnet offer to make: Needs about 770\.4 GiB of memory/);
        expect(text).not.toMatch(/Question:/);
        const summary = r.structuredContent?.assessment.summary ?? "";
        expect(summary).toMatch(
            /^Needs about 770\.4 GiB of memory, this machine has 16 GiB\. No Bugnet package is large enough/,
        );
    });

    it("gives the router call a signal that aborts when the quote budget runs out", async () => {
        let seen: AbortSignal | undefined;
        const { client, deps } = await connect({
            estimate: (async (_req: unknown, opts?: { signal?: AbortSignal }) => {
                seen = opts?.signal;
                return { options: [option("cpu-s", 50_000n, 0, 4096)] };
            }) as unknown as RouterClient["estimate"],
        });
        await client.callTool({ name: "bugnet_assess", arguments: { source: "acme/model" } });
        expect(seen).toBeInstanceOf(AbortSignal);
        expect(seen?.aborted).toBe(false);
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
            estimate: (async () => {
                throw new Error("connect ECONNREFUSED");
            }) as unknown as RouterClient["estimate"],
        });
        const r = (await client.callTool({
            name: "bugnet_assess",
            arguments: { source: "acme/model" },
        })) as Result;
        expect(r.isError).toBeFalsy();
        const text = r.content.map((c) => c.text).join("\n");
        expect(text).toMatch(/No quote: prices are unavailable right now/);
        expect(text).toMatch(/Price: not available right now, bugnet_quote gives one later\./);
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

describe("userLines", () => {
    it("says there is no offer to make when the check found nothing", () => {
        const fine: Assessment = {
            ...assessment,
            recommendation: "local_ok",
            summary: "No risk signals found in acme/tool. Running it locally looks fine.",
            categories: [],
            risk: { level: "low", findings: [] },
            fit: { level: "fits", findings: [] },
        };
        const text = userLines(fine, null).join("\n");
        expect(text).toMatch(
            /^No Bugnet offer to make: this check found nothing that calls for a sandbox, unless/,
        );
        expect(text).toMatch(/If offered, price: not available right now/);
        expect(text).not.toMatch(/Question:/);
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
