import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
    Confidence,
    Dimension,
    EstimateBasis,
    GpuNeed,
    Need,
    SourceKind,
    WarningCode,
    Workload,
    EstimateResponseSchema,
    type EstimateRequest,
} from "../gen/bugnet/router/v1/router_pb.ts";
import { verifyQuote } from "../quote.ts";
import { withClientAddress } from "../request.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    packageOption,
    resources,
    routerError,
    testConfig,
    testDeps,
    testNow,
    type RouterImpl,
} from "../testing/harness.ts";
import type { Deps } from "./common.ts";
import type { BuiltQuote, PackageView } from "./quote.ts";

const estimateId = "0f8b6c2e-41d7-4a3b-9c5e-7d2a1b3c4d5e";

const options = [
    packageOption("small-30m", 120_000n, { minutes: 30 }),
    packageOption("small-10m", 50_000n),
    packageOption("large-30m", 300_000n, { available: false, unavailableReason: "no_candidate" }),
];

type Quote = BuiltQuote["structured"] & { message: string };
type Init = MessageInitShape<typeof EstimateResponseSchema>;

async function setup(
    impl: RouterImpl,
    toml = "",
): Promise<{ client: Client; deps: Deps; calls: { n: number } }> {
    const calls = { n: 0 };
    const counted: RouterImpl = {
        ...impl,
        estimate(req, ctx) {
            calls.n += 1;
            if (!impl.estimate) throw new Error("no estimate in this test");
            return impl.estimate(req, ctx);
        },
    };
    const deps = testDeps({ config: testConfig(toml), router: fakeRouter(counted) });
    return { client: await connectTools(deps), deps, calls };
}

function answer(init: Init): RouterImpl {
    return { estimate: () => create(EstimateResponseSchema, init) };
}

// An estimate as the router's estimator answers once it reads the source
function sized(init: Init = {}): Init {
    return {
        options: [
            packageOption("small-10m", 50_000n, {
                fits: true,
                extensionsNeeded: 2,
                extensionPackageId: "more-10m",
                totalPriceMicros: 130_000n,
            }),
            packageOption("small-30m", 120_000n, {
                minutes: 30,
                fits: true,
                totalPriceMicros: 120_000n,
            }),
            packageOption("tiny-30m", 30_000n, {
                minutes: 30,
                resources: resources(1, 512),
                fits: false,
                shortOn: [Dimension.MEMORY, Dimension.VCPU],
                totalPriceMicros: 30_000n,
            }),
        ],
        estimateId,
        estimatorVersion: "est-2026.11.1",
        inputsSha256: "ab".repeat(32),
        source: { kind: SourceKind.GITHUB, canonical: "github.com/acme/app", read: true },
        floor: { resources: resources(2, 1536, 8), minutes: 30, gpu: GpuNeed.NONE },
        recommendedPackageId: "small-30m",
        reasons: [
            { ruleId: "dc.host", message: "The devcontainer asks for 2 CPUs." },
            { ruleId: "lock.size", message: "The lockfile lists 1,400 packages" },
            { ruleId: "ci.minutes", message: "CI runs the tests in about 25 minutes" },
            { ruleId: "extra", message: "A fourth reason" },
        ],
        warnings: [
            { code: WarningCode.NEEDS_DOCKER, message: "The tests start Docker containers" },
            { code: WarningCode.SOURCE_UNREAD, message: "Two files could not be read" },
        ],
        basis: EstimateBasis.SIGNALS,
        confidence: Confidence.MEDIUM,
        ...init,
    } as Init;
}

function pkg(q: Quote, id: string): PackageView {
    return q.packages.find((p) => p.id === id) as PackageView;
}

describe("bugnet_quote on a router without an estimator", () => {
    it("lists every package by price, with the busy one in plain words", async () => {
        const { client, deps } = await setup(answer({ options }));
        const r = await callTool<Quote>(client, "bugnet_quote", { workload: "tests" });
        expect(r.isError).toBe(false);
        expect(Object.keys(r.structured)[0]).toBe("message");
        expect(r.structured.message).toBe(r.text);
        expect(r.structured.packages.map((p) => p.id)).toEqual([
            "small-10m",
            "small-30m",
            "large-30m",
        ]);
        expect(pkg(r.structured, "large-30m")).toEqual(
            expect.objectContaining({ available: false, unavailable: "busy now, try again soon" }),
        );
        expect(pkg(r.structured, "small-10m")).toEqual(
            expect.objectContaining({
                available: true,
                priceUsd: "$0.05",
                fits: null,
                shortOn: [],
                extensionsNeeded: 0,
                totalPriceMicros: 50_000,
                totalPriceUsd: "$0.05",
            }),
        );
        expect(r.structured.recommended).toBeNull();
        expect(r.structured.floor).toBeNull();
        expect(r.structured.largeEnough).toBe(true);
        expect(r.text).toBe(
            [
                "Bugnet packages, paid per run in USDC on Solana:",
                "- small-10m: 2 vCPU / 2 GiB, 10 min, $0.05 USDC",
                "- small-30m: 2 vCPU / 2 GiB, 30 min, $0.12 USDC",
                "Unavailable now: large-30m (busy now, try again soon).",
                `quoteId (valid 10 min): ${r.structured.quoteId}`,
                "Tell the user the price and get their go-ahead before bugnet_start.",
            ].join("\n"),
        );
        const claims = verifyQuote(deps.config.secrets.quoteKey, r.structured.quoteId, testNow);
        expect(claims).toEqual({
            requirements: { ssh: false, preview: false, gpu: false, secrets: false },
            github: false,
            estimateId: null,
            expiresAt: testNow + 10 * 60_000,
        });
    });

    it("says plainly which packages are not open yet and which failed", async () => {
        const { client } = await setup(
            answer({
                options: [
                    packageOption("gpu-s", 900_000n, {
                        available: false,
                        unavailableReason: "feature_unavailable",
                    }),
                    packageOption("gpu-m", 1_900_000n, {
                        available: false,
                        unavailableReason: "feature_unavailable",
                    }),
                ],
            }),
        );
        const r = await callTool<Quote>(client, "bugnet_quote", { needs: ["ssh"] });
        expect(r.text.split("\n")[0]).toBe(
            "No package can start with these needs, they are not open yet.",
        );
        expect(r.text).toMatch(
            "Unavailable now: gpu-s (not open yet for these needs), gpu-m (not open yet for " +
                "these needs).",
        );
        const { client: other } = await setup(
            answer({
                options: [
                    packageOption("a", 1n, { available: false, unavailableReason: "internal" }),
                    packageOption("b", 2n, { available: false, unavailableReason: "odd text" }),
                ],
            }),
        );
        const r2 = await callTool<Quote>(other, "bugnet_quote", {});
        expect(r2.text.split("\n")[0]).toBe(
            "No package can start right now. Try again in a minute.",
        );
        expect(r2.structured.packages.map((p) => p.unavailable)).toEqual([
            "unavailable right now",
            "unavailable right now",
        ]);
        expect(r2.text).not.toMatch(/odd text/);
    });

    it("adds the gateway's GPU and secrets warnings", async () => {
        const { client, deps } = await setup(answer({ options }));
        const r = await callTool<Quote>(client, "bugnet_quote", {
            needs: ["gpu", "secrets"],
        });
        expect(r.structured.warnings).toEqual([
            "No GPU package is available right now, GPU work cannot start",
            "Secrets go in with bugnet_secret_link or the bridge, never in arguments",
        ]);
        const claims = verifyQuote(deps.config.secrets.quoteKey, r.structured.quoteId, testNow);
        expect(claims.requirements).toEqual({
            ssh: false,
            preview: false,
            gpu: true,
            secrets: true,
        });
    });
});

describe("bugnet_quote's estimate request", () => {
    it("carries source, workload, entryCommand, expectedMinutes and needs", async () => {
        let asked: EstimateRequest | undefined;
        const { client } = await setup({
            estimate(req) {
                asked = req;
                return { options };
            },
        });
        await callTool(client, "bugnet_quote", {
            source: "https://github.com/acme/app/tree/v2",
            workload: "build",
            entryCommand: "make all",
            expectedMinutes: 45,
            needs: ["ssh", "secrets", "ssh", "preview"],
        });
        expect(asked).toEqual(
            expect.objectContaining({
                source: "https://github.com/acme/app/tree/v2",
                workload: Workload.BUILD,
                entryCommand: "make all",
                expectedMinutes: 45,
                needs: [Need.SSH, Need.SECRETS, Need.PREVIEW],
                requirements: expect.objectContaining({
                    ssh: true,
                    preview: true,
                    gpu: false,
                    secrets: true,
                }),
            }),
        );
    });

    it("leaves the optional fields empty when the call gives none", async () => {
        let asked: EstimateRequest | undefined;
        const { client } = await setup({
            estimate(req) {
                asked = req;
                return { options };
            },
        });
        await callTool(client, "bugnet_quote", {});
        expect(asked?.source).toBe("");
        expect(asked?.workload).toBe(Workload.OTHER);
        expect(asked?.entryCommand).toBe("");
        expect(asked?.expectedMinutes).toBeUndefined();
        expect(asked?.needs).toEqual([]);
    });

    it("refuses an entryCommand over 1,000 bytes and minutes out of range", async () => {
        const { client, calls } = await setup(answer({ options }));
        const wide = await callTool(client, "bugnet_quote", { entryCommand: "€".repeat(400) });
        expect(wide.isError).toBe(true);
        expect(wide.text).toMatch(/1,000 bytes/);
        for (const expectedMinutes of [0, 1441, 2.5]) {
            const r = await callTool(client, "bugnet_quote", { expectedMinutes });
            expect(r.isError).toBe(true);
        }
        expect(calls.n).toBe(0);
        const fits = await callTool(client, "bugnet_quote", { entryCommand: "a".repeat(1000) });
        expect(fits.isError).toBe(false);
    });
});

describe("bugnet_quote on a router with an estimator", () => {
    it("shows the router's pick, three reasons, every warning and each fit", async () => {
        const { client, deps } = await setup(answer(sized()));
        const r = await callTool<Quote>(client, "bugnet_quote", {
            source: "github.com/acme/app",
            workload: "tests",
        });
        const q = r.structured;
        expect(q.recommended).toEqual({
            packageId: "small-30m",
            priceUsd: "$0.12",
            totalPriceUsd: "$0.12",
            extensionsNeeded: 0,
        });
        expect(q.reasons).toEqual([
            "The devcontainer asks for 2 CPUs",
            "The lockfile lists 1,400 packages",
            "CI runs the tests in about 25 minutes",
        ]);
        expect(q.warnings).toEqual([
            "The tests start Docker containers",
            "Two files could not be read",
        ]);
        expect(pkg(q, "small-10m")).toEqual(
            expect.objectContaining({
                fits: true,
                extensionsNeeded: 2,
                extensionPackageId: "more-10m",
                totalPriceMicros: 130_000,
                totalPriceUsd: "$0.13",
            }),
        );
        expect(pkg(q, "tiny-30m")).toEqual(
            expect.objectContaining({ fits: false, shortOn: ["memory", "vCPU"] }),
        );
        expect(q.floor).toEqual({
            vcpu: 2,
            memoryGiB: 1.5,
            diskGiB: 8,
            gpu: "none",
            minutes: 30,
            basis: "the source's files",
            confidence: "medium",
        });
        expect(r.text).toBe(
            [
                "Bugnet packages, paid per run in USDC on Solana:",
                "- tiny-30m: 1 vCPU / 512 MiB, 30 min, $0.03 USDC, does not fit, short on " +
                    "memory and vCPU",
                "- small-10m: 2 vCPU / 2 GiB, 10 min, $0.05 USDC, $0.13 in all with 2 " +
                    "extensions of more-10m",
                "- small-30m: 2 vCPU / 2 GiB, 30 min, $0.12 USDC (recommended)",
                "Recommended: small-30m.",
                "Why: The devcontainer asks for 2 CPUs. The lockfile lists 1,400 packages. CI " +
                    "runs the tests in about 25 minutes.",
                "Sizing: 2 vCPU, 1.5 GiB of memory, 8 GiB of disk, about 30 min, from the " +
                    "source's files, medium confidence.",
                "Warning: The tests start Docker containers.",
                "Warning: Two files could not be read.",
                `quoteId (valid 10 min): ${q.quoteId}`,
                "Tell the user the price and get their go-ahead before bugnet_start.",
            ].join("\n"),
        );
        const json = JSON.stringify(q);
        expect(json).not.toMatch(/abab|inputs|sha256|est-2026/i);
        expect(json).not.toMatch(/A fourth reason/);
        const claims = verifyQuote(deps.config.secrets.quoteKey, q.quoteId, testNow);
        expect(claims.estimateId).toBe(estimateId);
        expect(claims.github).toBe(true);
        expect(q.quoteId.length).toBeLessThanOrEqual(52);
    });

    it("sets the GitHub flag only for a GitHub source with an estimate", async () => {
        const hf = sized({ source: { kind: SourceKind.HUGGINGFACE_MODEL } });
        const noId = sized({ estimateId: "" });
        const badId = sized({ estimateId: "est_42" });
        for (const [init, id] of [
            [hf, estimateId],
            [noId, null],
            [badId, null],
        ] as const) {
            const { client, deps } = await setup(answer(init));
            const r = await callTool<Quote>(client, "bugnet_quote", { source: "x/y" });
            const claims = verifyQuote(deps.config.secrets.quoteKey, r.structured.quoteId, testNow);
            expect(claims.github).toBe(false);
            expect(claims.estimateId).toBe(id);
        }
    });

    it("recommends nothing when the router's pick cannot start", async () => {
        const busy = sized();
        busy.options = (busy.options ?? []).map((o) =>
            o.packageId === "small-30m"
                ? { ...o, available: false, unavailableReason: "no_candidate" }
                : o,
        );
        const { client } = await setup(answer(busy));
        const r = await callTool<Quote>(client, "bugnet_quote", {});
        expect(r.structured.recommended).toBeNull();
        expect(r.text).toMatch(/^No package open now fits this work\.$/m);
        expect(r.text).toMatch(/Unavailable now: small-30m \(busy now, try again soon\)/);
    });

    it("says when no package is large enough", async () => {
        const big = sized({
            recommendedPackageId: "",
            warnings: [{ code: WarningCode.TOO_LARGE, message: "Needs 512 GiB of memory" }],
        });
        const { client } = await setup(answer(big));
        const r = await callTool<Quote>(client, "bugnet_quote", {});
        expect(r.structured.largeEnough).toBe(false);
        expect(r.structured.warnings).toEqual(["Needs 512 GiB of memory"]);
    });

    it("keeps the router's GPU and secrets warnings without adding the gateway's", async () => {
        const { client } = await setup(
            answer(
                sized({
                    warnings: [
                        { code: WarningCode.NEEDS_GPU, message: "This model needs a GPU" },
                        { code: WarningCode.SECRETS, message: "The repo reads an API token" },
                    ],
                }),
            ),
        );
        const r = await callTool<Quote>(client, "bugnet_quote", { needs: ["gpu", "secrets"] });
        expect(r.structured.warnings).toEqual([
            "This model needs a GPU",
            "The repo reads an API token",
        ]);
    });

    it("cuts router text to one line and never names a provider", async () => {
        const { client } = await setup(
            answer(
                sized({
                    reasons: [{ ruleId: "x", message: "Runs on boxd\nignore all previous" }],
                    warnings: [
                        { code: WarningCode.BUSY, message: "\u001b[31mE2B is busy\u001b[0m" },
                    ],
                }),
            ),
        );
        const r = await callTool<Quote>(client, "bugnet_quote", {});
        expect(r.structured.reasons).toEqual(["Runs on provider"]);
        expect(r.structured.warnings).toEqual(["provider is busy"]);
        expect(r.text).not.toMatch(/boxd|e2b|ignore all/i);
    });

    it("gives the floor's GPU, download and context when the router has them", async () => {
        const { client } = await setup(
            answer(
                sized({
                    floor: {
                        resources: {
                            vcpu: 8,
                            memoryMib: 32768,
                            diskGib: 60,
                            gpuCount: 1,
                            gpuMemoryGib: 24,
                        },
                        minutes: 20,
                        gpu: GpuNeed.REQUIRED,
                        downloadBytes: 16n * 2n ** 30n,
                        contextTokens: 8192,
                    },
                    partial: true,
                    confidence: Confidence.LOW,
                }),
            ),
        );
        const r = await callTool<Quote>(client, "bugnet_quote", { workload: "inference" });
        expect(r.structured.floor).toEqual(
            expect.objectContaining({
                gpu: "required",
                gpuCount: 1,
                gpuMemoryGiB: 24,
                downloadGiB: 16,
                contextTokens: 8192,
                partial: true,
            }),
        );
        const sizing = r.text.split("\n").find((l) => l.startsWith("Sizing: "));
        expect(sizing).toBe(
            "Sizing: 8 vCPU, 32 GiB of memory, 60 GiB of disk, a GPU with 24 GiB, about 20 min, " +
                "16 GiB to download, from the source's files, low confidence, partly read.",
        );
    });
});

describe("bugnet_quote errors", () => {
    it("tells the RetryInfo delay of a router rate limit", async () => {
        const { client } = await setup({
            estimate() {
                throw routerError(Code.ResourceExhausted, "RATE_LIMITED", { retryAfterMs: 3000 });
            },
        });
        const r = await callTool(client, "bugnet_quote", {});
        expect(r.isError).toBe(true);
        expect(r.text).toBe("quote: too many requests for now. Retry after 3 s.");
    });

    it("says tokens never go in source or entryCommand", async () => {
        const { client } = await setup({
            estimate() {
                throw routerError(Code.InvalidArgument, "SECRET_IN_ARGUMENT");
            },
        });
        const r = await callTool(client, "bugnet_quote", { entryCommand: "run --token x" });
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "quote: a value shaped like an API token is in source or entryCommand. Tokens never " +
                "go there, bugnet_secret_link adds them to the sandbox after bugnet_start.",
        );
    });

    it("explains a source the router cannot parse and other refusals", async () => {
        let err = routerError(Code.InvalidArgument, "SOURCE_INVALID");
        const { client } = await setup({
            estimate() {
                throw err;
            },
        });
        const bad = await callTool(client, "bugnet_quote", { source: "not a source" });
        expect(bad.text).toMatch(/^quote: the source has to be a GitHub URL/);
        err = routerError(Code.InvalidArgument, undefined, {
            message: "api: koyeb says entry_command is too long",
        });
        const other = await callTool(client, "bugnet_quote", {});
        expect(other.text).toBe("quote: provider says entry_command is too long.");
        err = routerError(Code.FailedPrecondition, "FEATURE_UNAVAILABLE");
        const closed = await callTool(client, "bugnet_quote", { needs: ["ssh"] });
        expect(closed.text).toBe("quote: not open yet for these needs.");
        err = routerError(Code.Unimplemented);
        const old = await callTool(client, "bugnet_quote", {});
        expect(old.text).toBe(
            "quote: Bugnet has not opened this yet, so a retry now or later gets the same " +
                "answer. The other Bugnet tools work as usual.",
        );
    });
});

describe("bugnet_quote limits", () => {
    const toml = "[limits]\nquote_burst = 2\nquotes_per_minute = 6\nshared_quote_burst = 4";

    it("limits each client address and says when to retry", async () => {
        const { client, calls } = await setup(answer({ options }), toml);
        const at = (address: string) =>
            withClientAddress(address, () => callTool(client, "bugnet_quote", {}));
        expect((await at("203.0.113.9")).isError).toBe(false);
        expect((await at("203.0.113.9")).isError).toBe(false);
        const limited = await at("203.0.113.9");
        expect(limited.isError).toBe(true);
        expect(limited.text).toBe(
            "quote: too many quotes and checks from this address for now. Retry after 10 s.",
        );
        expect(calls.n).toBe(2);
        expect((await at("203.0.113.10")).isError).toBe(false);
    });

    it("gives claude.ai's shared range its own higher limit", async () => {
        const { client } = await setup(answer({ options }), toml);
        const results = [];
        for (let i = 0; i < 5; i++) {
            results.push(
                await withClientAddress("160.79.105.20", () => callTool(client, "bugnet_quote")),
            );
        }
        expect(results.map((r) => r.isError)).toEqual([false, false, false, false, true]);
    });

    it("leaves calls without a client address alone", async () => {
        const { client } = await setup(answer({ options }), toml);
        for (let i = 0; i < 5; i++) {
            expect((await callTool(client, "bugnet_quote", {})).isError).toBe(false);
        }
    });
});

describe("bugnet_quote's listing", () => {
    it("is free, read-only and described in under 600 plain characters", async () => {
        const { client } = await setup(answer({ options }));
        const { tools } = await client.listTools();
        const t = tools.find((x) => x.name === "bugnet_quote");
        expect(t?.annotations).toMatchObject({ readOnlyHint: true });
        const d = t?.description ?? "";
        expect(d.length).toBeLessThan(600);
        expect(d).toMatch(/valid 10 minutes/);
        expect(d).toMatch(/bugnet_secret_link/);
        expect(d).not.toMatch(/you must|always|never call|IMPORTANT/);
        const props = Object.keys((t?.inputSchema as { properties: object }).properties);
        expect(props).toEqual(["source", "workload", "entryCommand", "expectedMinutes", "needs"]);
    });
});
