import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { Assessment, Assessor } from "../assess/assessor.ts";
import { parseSettings, type Config } from "../config.ts";
import { silentLog } from "../log.ts";
import type { Payments } from "../payments/port.ts";
import type { RouterClient } from "../router.ts";
import { verifyQuote } from "../quote.ts";
import { assessDescription, registerAssessTool } from "./assess.ts";
import type { Deps } from "./common.ts";

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
        expect(text.trim().endsWith("Ask the user before bugnet_start.")).toBe(true);
        expect(requirements).toMatchObject({ gpu: true });
        expect(seen.input).toMatchObject({
            task: "run flux",
            source: "black-forest-labs/FLUX.1-schnell",
        });
        const quote = r.structuredContent?.quote as { quoteId: string };
        const claims = verifyQuote(deps.config.secrets.quoteKey, quote.quoteId, now);
        expect(claims.source).toBe("black-forest-labs/FLUX.1-schnell");
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
        const summary = r.structuredContent?.assessment.summary ?? "";
        expect(summary).toMatch(
            /^Needs about 770\.4 GiB of memory, this machine has 16 GiB\. No Bugnet package is large enough/,
        );
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
