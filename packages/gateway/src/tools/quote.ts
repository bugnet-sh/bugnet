// Without the router's floor, bugnet_assess sizes the work itself and bugnet_quote recommends none
import { z } from "zod";
import { parseSource } from "../assess/source.ts";
import {
    Confidence,
    Dimension,
    EstimateBasis,
    GpuNeed,
    Need,
    SourceKind,
    UnreadReason,
    WarningCode,
    Workload,
    type EstimateResponse,
    type PackageOption,
} from "../gen/bugnet/router/v1/router_pb.ts";
import { isEstimateId, signQuote, type QuotedPackage, type QuoteRequirements } from "../quote.ts";
import { clientAddress } from "../request.ts";
import { quoteLimiter } from "../ratelimit.ts";
import { GatewayError, reasonOf, routerText } from "../router.ts";
import { cleanText } from "../sanitize.ts";
import { failure, ok, usd, type Deps, type Register } from "./common.ts";

export const workloads = ["tests", "build", "script", "serve", "inference", "other"] as const;
export const needs = ["ssh", "preview", "secrets", "gpu"] as const;
export type WorkloadName = (typeof workloads)[number];
export type NeedName = (typeof needs)[number];

const workloadEnum: Record<WorkloadName, Workload> = {
    tests: Workload.TESTS,
    build: Workload.BUILD,
    script: Workload.SCRIPT,
    serve: Workload.SERVE,
    inference: Workload.INFERENCE,
    other: Workload.OTHER,
};

const needEnum: Record<NeedName, Need> = {
    ssh: Need.SSH,
    preview: Need.PREVIEW,
    secrets: Need.SECRETS,
    gpu: Need.GPU,
};

const dimensionName: Record<Dimension, string> = {
    [Dimension.UNSPECIFIED]: "another resource",
    [Dimension.VCPU]: "vCPU",
    [Dimension.MEMORY]: "memory",
    [Dimension.DISK]: "disk",
    [Dimension.GPU]: "GPU",
    [Dimension.GPU_MEMORY]: "GPU memory",
    [Dimension.MINUTES]: "time",
};

const gpuNeedName: Record<GpuNeed, "unknown" | "none" | "recommended" | "required"> = {
    [GpuNeed.UNSPECIFIED]: "unknown",
    [GpuNeed.NONE]: "none",
    [GpuNeed.RECOMMENDED]: "recommended",
    [GpuNeed.REQUIRED]: "required",
};

const basisName: Record<EstimateBasis, string> = {
    [EstimateBasis.UNSPECIFIED]: "none",
    [EstimateBasis.DEFAULTS]: "defaults for the workload",
    [EstimateBasis.SIGNALS]: "the source's files",
    [EstimateBasis.HISTORY]: "past runs of this source",
};

const confidenceName: Record<Confidence, string> = {
    [Confidence.UNSPECIFIED]: "unknown",
    [Confidence.LOW]: "low",
    [Confidence.MEDIUM]: "medium",
    [Confidence.HIGH]: "high",
};

// Size dimensions, as against GPU or minutes, which a larger package of the same kind would cover
const sizeDimensions = new Set([
    Dimension.VCPU,
    Dimension.MEMORY,
    Dimension.DISK,
    Dimension.GPU_MEMORY,
]);

export const shownReasons = 3;

/* Packages */

export function describeSize(p: { vcpu: number; memoryMib: number; gpuCount: number }): string {
    const mem =
        p.memoryMib >= 1024 ? `${Math.round(p.memoryMib / 1024)} GiB` : `${p.memoryMib} MiB`;
    return `${p.vcpu} vCPU / ${mem}${p.gpuCount > 0 ? ` / ${p.gpuCount} GPU` : ""}`;
}

export function quoted(o: PackageOption): QuotedPackage {
    const r = o.resources;
    return {
        id: o.packageId,
        priceMicros: Number(o.priceMicros),
        minutes: o.minutes,
        vcpu: r?.vcpu ?? 0,
        memoryMib: r?.memoryMib ?? 0,
        diskGib: r?.diskGib ?? 0,
        gpuCount: r?.gpuCount ?? 0,
    };
}

// The router's fixed unavailable_reason codes in plain words
export function unavailableWords(code: string): string {
    if (code === "no_candidate") return "busy now, try again soon";
    if (code === "feature_unavailable") return "not open yet for these needs";
    return "unavailable right now";
}

export interface PackageView extends QuotedPackage {
    priceUsd: string;
    available: boolean;
    unavailable?: string;
    // Null while the router gives no floor to fit against
    fits: boolean | null;
    shortOn: string[];
    extensionsNeeded: number;
    extensionPackageId?: string;
    totalPriceMicros: number;
    totalPriceUsd: string;
}

function packageView(o: PackageOption, sized: boolean): PackageView {
    const total = sized && o.totalPriceMicros > 0n ? Number(o.totalPriceMicros) : null;
    const p = quoted(o);
    return {
        ...p,
        priceUsd: usd(p.priceMicros),
        available: o.available,
        ...(!o.available ? { unavailable: unavailableWords(o.unavailableReason) } : {}),
        fits: sized ? o.fits : null,
        shortOn: sized ? [...new Set(o.shortOn.map((d) => dimensionName[d]))] : [],
        extensionsNeeded: sized ? o.extensionsNeeded : 0,
        ...(sized && o.extensionPackageId ? { extensionPackageId: o.extensionPackageId } : {}),
        totalPriceMicros: total ?? p.priceMicros,
        totalPriceUsd: usd(total ?? p.priceMicros),
    };
}

/* Gateway sizing */

// The gateway's own choice, used only by bugnet_assess while the router gives no floor
export function recommend(
    pkgs: QuotedPackage[],
    workload: WorkloadName,
    expectedMinutes: number | undefined,
): { pkg: QuotedPackage; why: string } | null {
    if (pkgs.length === 0) return null;
    const heavy = workload === "inference" || workload === "build" || workload === "serve";
    const minutes = expectedMinutes ?? (heavy ? 20 : 10);
    const byPrice = [...pkgs].sort((a, b) => a.priceMicros - b.priceMicros);
    const longEnough = byPrice.filter((p) => p.minutes >= minutes);
    const pool = longEnough.length > 0 ? longEnough : byPrice;
    // Memory is a reason only when the packages that last long enough differ in it
    if (heavy && new Set(pool.map((p) => p.memoryMib)).size > 1) {
        const biggest = Math.max(...pool.map((p) => p.memoryMib));
        const pkg = pool.find((p) => p.memoryMib === biggest) as QuotedPackage;
        return { pkg, why: `${workload} work wants the most memory on offer` };
    }
    const pkg = pool[0] as QuotedPackage;
    const why =
        longEnough.length > 0
            ? `cheapest package that lasts ${minutes} min`
            : `no package lasts ${minutes} min, extend it when needed`;
    return { pkg, why };
}

// A zero size means the router did not report it, so it cannot rule a package out
function meetsSize(p: QuotedPackage, memoryGiB: number | null, diskGiB: number | null): boolean {
    const memory = memoryGiB === null || p.memoryMib === 0 || p.memoryMib >= memoryGiB * 1024;
    const disk = diskGiB === null || p.diskGib === 0 || p.diskGib >= diskGiB;
    return memory && disk;
}

export function sizeText(memoryGiB: number | null, diskGiB: number | null): string {
    const parts = [
        memoryGiB !== null ? `${memoryGiB} GiB of memory` : "",
        diskGiB !== null ? `${diskGiB} GiB of disk` : "",
    ].filter(Boolean);
    return `about ${parts.join(" and ")}`;
}

/* Router sizing */

export interface QuoteFloor {
    vcpu: number;
    memoryGiB: number;
    diskGiB: number;
    gpu: "unknown" | "none" | "recommended" | "required";
    gpuCount?: number;
    gpuMemoryGiB?: number;
    minutes: number;
    downloadGiB?: number;
    contextTokens?: number;
    basis: string;
    confidence: string;
    partial?: true;
}

const tenth = (n: number) => Math.round(n * 10) / 10;

function floorView(est: EstimateResponse): QuoteFloor | null {
    if (est.basis === EstimateBasis.UNSPECIFIED) return null;
    const f = est.floor;
    const r = f?.resources;
    const download = f ? Number(f.downloadBytes) : 0;
    return {
        vcpu: r?.vcpu ?? 0,
        memoryGiB: tenth((r?.memoryMib ?? 0) / 1024),
        diskGiB: r?.diskGib ?? 0,
        gpu: gpuNeedName[f?.gpu ?? GpuNeed.UNSPECIFIED],
        ...(r?.gpuCount ? { gpuCount: r.gpuCount } : {}),
        ...(r?.gpuMemoryGib ? { gpuMemoryGiB: r.gpuMemoryGib } : {}),
        minutes: f?.minutes ?? 0,
        ...(download > 0 ? { downloadGiB: tenth(download / 2 ** 30) } : {}),
        ...(f?.contextTokens ? { contextTokens: f.contextTokens } : {}),
        basis: basisName[est.basis],
        confidence: confidenceName[est.confidence],
        ...(est.partial ? { partial: true as const } : {}),
    };
}

export function floorText(f: QuoteFloor): string {
    const gpu =
        f.gpu === "required"
            ? `a GPU${f.gpuMemoryGiB ? ` with ${f.gpuMemoryGiB} GiB` : ""}`
            : f.gpu === "recommended"
              ? "a GPU helps"
              : "";
    const parts = [
        f.vcpu ? `${f.vcpu} vCPU` : "",
        f.memoryGiB ? `${f.memoryGiB} GiB of memory` : "",
        f.diskGiB ? `${f.diskGiB} GiB of disk` : "",
        gpu,
        f.minutes ? `about ${f.minutes} min` : "",
        f.downloadGiB ? `${f.downloadGiB} GiB to download` : "",
    ].filter(Boolean);
    const sure = f.confidence !== "unknown" ? `, ${f.confidence} confidence` : "";
    const from = `from ${f.basis}${sure}${f.partial ? ", partly read" : ""}`;
    return `${parts.join(", ") || "no floor"}, ${from}`;
}

// No package of the right kind is large enough, as against none being free or none having a GPU
function routerTooLarge(est: EstimateResponse): boolean {
    if (est.warnings.some((w) => w.code === WarningCode.TOO_LARGE)) return true;
    const rightKind = est.options.filter((o) => !o.shortOn.includes(Dimension.GPU));
    return (
        rightKind.length > 0 &&
        rightKind.every((o) => !o.fits && o.shortOn.some((d) => sizeDimensions.has(d)))
    );
}

function sentenceOf(text: string): string {
    return routerText(cleanText(text)).trim().replace(/\.+$/, "");
}

/* Quotes */

export interface QuoteRequest {
    source?: string | undefined;
    workload: WorkloadName;
    entryCommand?: string | undefined;
    expectedMinutes?: number | undefined;
    needs?: NeedName[] | undefined;
    // bugnet_assess's own sizing, used only while the router gives no floor
    fallback?: { minMemoryGiB: number | null; minDiskGiB: number | null } | undefined;
}

export interface Recommended {
    packageId: string;
    priceUsd: string;
    totalPriceUsd: string;
    extensionsNeeded: number;
    why?: string;
}

export interface BuiltQuote {
    text: string;
    // The first line of text, which tells closed needs from a short wait when no package starts
    headline: string;
    structured: {
        quoteId: string;
        expiresAt: string;
        recommended: Recommended | null;
        packages: PackageView[];
        reasons: string[];
        warnings: string[];
        // The router's sizing, null while its estimator gives none
        floor: QuoteFloor | null;
        // False when no package on offer is large enough for the work
        largeEnough: boolean;
    };
}

export function requirementsOf(wants: readonly NeedName[] | undefined): QuoteRequirements {
    const set = new Set(wants ?? []);
    return {
        ssh: set.has("ssh"),
        preview: set.has("preview"),
        gpu: set.has("gpu"),
        secrets: set.has("secrets"),
    };
}

export function estimate(
    deps: Deps,
    args: QuoteRequest,
    signal?: AbortSignal,
): Promise<EstimateResponse> {
    const wants = [...new Set(args.needs ?? [])];
    return deps.router.estimate(
        {
            requirements: requirementsOf(wants),
            source: args.source ?? "",
            workload: workloadEnum[args.workload],
            entryCommand: args.entryCommand ?? "",
            ...(args.expectedMinutes !== undefined
                ? { expectedMinutes: args.expectedMinutes }
                : {}),
            needs: wants.map((n) => needEnum[n]),
        },
        signal ? { signal } : {},
    );
}

function recommendation(
    est: EstimateResponse,
    views: PackageView[],
    args: QuoteRequest,
    warnings: string[],
): { rec: Recommended | null; largeEnough: boolean } {
    const available = views.filter((v) => v.available);
    const wantGpu = args.needs?.includes("gpu") ?? false;
    const asRec = (v: PackageView, why?: string): Recommended => ({
        packageId: v.id,
        priceUsd: v.priceUsd,
        totalPriceUsd: v.totalPriceUsd,
        extensionsNeeded: v.extensionsNeeded,
        ...(why ? { why } : {}),
    });
    if (est.basis !== EstimateBasis.UNSPECIFIED) {
        const pick = available.find((v) => v.id === est.recommendedPackageId);
        return { rec: pick ? asRec(pick) : null, largeEnough: !routerTooLarge(est) };
    }
    if (!args.fallback) return { rec: null, largeEnough: true };
    const { minMemoryGiB, minDiskGiB } = args.fallback;
    const kind = wantGpu ? available.filter((p) => p.gpuCount > 0) : available;
    const sized = kind.filter((p) => meetsSize(p, minMemoryGiB, minDiskGiB));
    const largeEnough = kind.length === 0 || sized.length > 0;
    if (!largeEnough) {
        warnings.push(`No package is large enough for ${sizeText(minMemoryGiB, minDiskGiB)}`);
    }
    const r = recommend(sized, args.workload, args.expectedMinutes);
    const pick = r ? sized.find((v) => v.id === r.pkg.id) : undefined;
    return { rec: pick && r ? asRec(pick, r.why) : null, largeEnough };
}

function packageLine(p: PackageView, rec: Recommended | null): string {
    const fit =
        p.fits === false
            ? `, does not fit${p.shortOn.length > 0 ? `, short on ${p.shortOn.join(" and ")}` : ""}`
            : "";
    const n = p.extensionsNeeded;
    const extended =
        n > 0
            ? `, ${p.totalPriceUsd} in all with ${n} extension${n > 1 ? "s" : ""}` +
              (p.extensionPackageId ? ` of ${p.extensionPackageId}` : "")
            : "";
    return (
        `- ${p.id}: ${describeSize(p)}, ${p.minutes} min, ${p.priceUsd} USDC` +
        (rec?.packageId === p.id ? " (recommended)" : "") +
        fit +
        extended
    );
}

function listed(words: readonly string[]): string {
    if (words.length < 2) return words.join("");
    return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

// Every package is closed only because a need is not open yet
export function needsNotOpen(views: readonly PackageView[]): boolean {
    return (
        views.length > 0 &&
        views.every((v) => v.unavailable === unavailableWords("feature_unavailable"))
    );
}

function headline(available: number, views: PackageView[], wants: readonly NeedName[]): string {
    if (available > 0) return "Bugnet packages, paid per run in USDC on Solana:";
    if (needsNotOpen(views)) {
        if (wants.length === 0)
            return "No package can start with these needs, they are not open yet.";
        const one = wants.length === 1;
        return (
            `No package can start with the need${one ? "" : "s"} ${listed(wants)}, which ` +
            `${one ? "is" : "are"} not open yet. A quote without ${one ? "it" : "one of them"} ` +
            "may list packages that start."
        );
    }
    return "No package can start right now. Try again in a minute.";
}

// A GitHub repo the estimator could not see is private or gone, and only a secret fetches it
function privateRepoWarning(est: EstimateResponse, secrets: boolean): string | null {
    const s = est.source;
    if (s?.kind !== SourceKind.GITHUB || s.read || s.unreadReason !== UnreadReason.NOT_FOUND) {
        return null;
    }
    const token = "a GITHUB_TOKEN added with bugnet_secret_link once the sandbox runs";
    return secrets
        ? `The repo could not be read, so it is private or missing. A private one needs ${token}`
        : "The repo could not be read, so it is private or missing. A private one needs a " +
              `quote with needs ["secrets"] and ${token}`;
}

// Prices the packages, takes the router's sizing and signs a quoteId bugnet_start accepts
export async function buildQuote(
    deps: Deps,
    args: QuoteRequest,
    signal?: AbortSignal,
): Promise<BuiltQuote> {
    const est = await estimate(deps, args, signal);
    const requirements = requirementsOf(args.needs);
    const floor = floorView(est);
    const views = est.options.map((o) => packageView(o, floor !== null));
    const byPrice = [...views].sort((a, b) => a.priceMicros - b.priceMicros);
    const available = byPrice.filter((v) => v.available);
    const codes = new Set(est.warnings.map((w) => w.code));
    const warnings = est.warnings.map((w) => sentenceOf(w.message)).filter(Boolean);
    if (requirements.gpu && !codes.has(WarningCode.NEEDS_GPU)) {
        if (!available.some((p) => p.gpuCount > 0)) {
            warnings.push("No GPU package is available right now, GPU work cannot start");
        }
    }
    const unread = privateRepoWarning(est, requirements.secrets);
    if (unread) warnings.push(unread);
    if (requirements.secrets && !codes.has(WarningCode.SECRETS) && available.length > 0) {
        warnings.push(
            "Secrets go in with bugnet_secret_link once the sandbox runs, never in arguments",
        );
    }
    const reasons = est.reasons
        .slice(0, shownReasons)
        .map((r) => sentenceOf(r.message))
        .filter(Boolean);
    const { rec, largeEnough } = recommendation(est, views, args, warnings);
    let estimateId: string | null = null;
    if (isEstimateId(est.estimateId)) estimateId = est.estimateId.toLowerCase();
    else if (est.estimateId) deps.log.warn("estimate id is not a UUID, quoting without it");
    const named = est.source?.kind === SourceKind.GITHUB;
    const github = named && estimateId !== null;
    // A router whose estimate names no source still leaves the agent a GitHub repo to clone
    const asked = parseSource(args.source).kind === "github";
    const expiresAt = deps.now() + deps.config.limits.quote_ttl;
    const quoteId = signQuote(deps.config.secrets.quoteKey, {
        requirements,
        github,
        githubUnplaced: (named || asked) && !github,
        estimateId,
        expiresAt,
    });
    const unavailable = byPrice.filter((v) => !v.available);
    const ttl = Math.round(deps.config.limits.quote_ttl / 60_000);
    const wants = needs.filter((n) => args.needs?.includes(n));
    const startable = available.length > 0;
    const first = headline(available.length, views, wants);
    const text = [
        first,
        ...available.map((p) => packageLine(p, rec)),
        unavailable.length > 0
            ? `Unavailable now: ${unavailable.map((v) => `${v.id} (${v.unavailable})`).join(", ")}.`
            : "",
        rec ? `Recommended: ${rec.packageId}${rec.why ? ` because ${rec.why}` : ""}.` : "",
        !rec && floor && available.length > 0 ? "No package open now fits this work." : "",
        reasons.length > 0 ? `Why: ${reasons.join(". ")}.` : "",
        floor ? `Sizing: ${floorText(floor)}.` : "",
        ...warnings.map((w) => `Warning: ${w}.`),
        startable ? `quoteId (valid ${ttl} min): ${quoteId}` : "",
        startable ? "Tell the user the price and get their go-ahead before bugnet_start." : "",
    ]
        .filter(Boolean)
        .join("\n");
    return {
        text,
        headline: first,
        structured: {
            quoteId,
            expiresAt: new Date(expiresAt).toISOString(),
            recommended: rec,
            packages: byPrice,
            reasons,
            warnings,
            floor,
            largeEnough,
        },
    };
}

/* Limits */

// Estimate is free and needs no account, so each client address gets a bucket of quotes
export function limitQuotes(deps: Deps, what: string): void {
    const wait = quoteLimiter(deps.config.limits).take(clientAddress(), deps.now());
    if (wait === null) return;
    deps.log.info("quote limited", { tool: what });
    throw new GatewayError(
        "rate_limited",
        `${what}: too many quotes and checks from this address for now`,
        wait,
    );
}

/* Tool */

export function quoteFailure(e: unknown, what: string) {
    const reason = reasonOf(e);
    if (reason === "SECRET_IN_ARGUMENT") {
        return failure(
            new GatewayError(
                "invalid",
                `${what}: a value shaped like an API token is in source or entryCommand. Tokens ` +
                    "never go there, bugnet_secret_link adds them to the sandbox after " +
                    "bugnet_start",
                null,
                reason,
            ),
            what,
        );
    }
    if (reason === "FEATURE_UNAVAILABLE") {
        return failure(
            new GatewayError("unsupported", `${what}: not open yet for these needs`, null, reason),
            what,
        );
    }
    return failure(e, what);
}

const entryCommandBytes = 1000;

export function quoteInput() {
    return z.object({
        source: z
            .string()
            .max(500)
            .optional()
            .describe("GitHub URL, optionally with a ref, or a Hugging Face model id"),
        workload: z.enum(workloads).default("other"),
        entryCommand: z
            .string()
            .max(entryCommandBytes)
            .refine((s) => Buffer.byteLength(s) <= entryCommandBytes, "at most 1,000 bytes")
            .optional()
            .describe("The command you plan to run, read for sizing, never run"),
        expectedMinutes: z.number().int().min(1).max(1440).optional(),
        needs: z.array(z.enum(needs)).max(8).optional(),
    });
}

export function quoteDescription(deps: Deps): string {
    const ttl = Math.round(deps.config.limits.quote_ttl / 60_000);
    return (
        "Free price quote for a Bugnet cloud sandbox. Bugnet sizes the work from source, " +
        "workload, entryCommand, expectedMinutes and needs (ssh, preview, secrets, gpu), and " +
        "returns each package's price and fit, the recommended one with its reasons, warnings " +
        `and a quoteId for bugnet_start, valid ${ttl} minutes. Tokens never go in source or ` +
        "entryCommand, bugnet_secret_link adds secrets once the sandbox runs. The user hears " +
        "the price before bugnet_start."
    );
}

export const registerQuoteTool: Register = (server, deps) => {
    server.registerTool(
        "bugnet_quote",
        {
            title: "Quote a Bugnet sandbox (free)",
            description: quoteDescription(deps),
            inputSchema: quoteInput(),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, ctx) => {
            try {
                limitQuotes(deps, "quote");
                const q = await buildQuote(deps, args, ctx.mcpReq.signal);
                return ok(q.text, q.structured);
            } catch (e) {
                return quoteFailure(e, "quote");
            }
        },
    );
};
