import type { Config } from "../config.ts";
import type { Assessment, AssessInput, Assessor, Finding } from "./assessor.ts";
import { TtlCache } from "./cache.ts";
import { createSafeFetcher, FetchRefused, type Fetcher } from "./fetch.ts";
import { readGithub } from "./github.ts";
import { analyseModel, readHuggingface } from "./huggingface.ts";
import { evidence, safePath, scanRepo, shift } from "./scan.ts";
import { readScript, urlFindings } from "./script.ts";
import { githubAlternative, parseSource, sourceName, sourceRef, type Source } from "./source.ts";
import { combine, type SourceReport } from "./verdict.ts";

export const cacheEntries = 500;

export interface AssessorOptions {
    fetch?: Fetcher;
    now?: () => number;
}

interface ReadEnv {
    fetch: Fetcher;
    config: Config;
    now: () => number;
}

function emptyReport(src: Source): SourceReport {
    return {
        kind: src.kind,
        ref: sourceRef(src),
        name: sourceName(src),
        checked: false,
        complete: true,
        facts: {},
        findings: [],
        categories: [],
        gpu: false,
        cuda: false,
        minMemoryGiB: null,
        minDiskGiB: null,
        workload: null,
    };
}

function failureNote(e: unknown): { finding: Finding; complete: boolean } {
    if (e instanceof FetchRefused) {
        const finding: Finding = {
            id: "source_refused",
            severity: "info",
            title: `Not fetched, ${e.message}`,
        };
        if (e.host) finding.evidence = safePath(e.host);
        return { finding, complete: true };
    }
    const name = (e as { name?: unknown } | null)?.name;
    if (name === "AbortError" || name === "TimeoutError") {
        return {
            finding: { id: "source_timeout", severity: "info", title: "The check ran out of time" },
            complete: false,
        };
    }
    return {
        finding: {
            id: "source_unreachable",
            severity: "info",
            title: "The source could not be reached",
        },
        complete: false,
    };
}

async function readGithubSource(
    env: ReadEnv,
    src: Extract<Source, { kind: "github" }>,
    report: SourceReport,
    signal: AbortSignal,
): Promise<void> {
    const a = env.config.assess;
    const snap = await readGithub(
        {
            fetch: env.fetch,
            api: a.github_api,
            raw: a.github_raw,
            token: env.config.secrets.githubToken,
            maxFileBytes: a.max_file_bytes,
        },
        src,
        signal,
    );
    const scan = scanRepo(snap, env.now());
    report.complete = snap.complete;
    report.checked =
        snap.info !== null && snap.tree.length > 0 && (snap.picked === 0 || snap.files.length > 0);
    report.facts = scan.facts;
    report.findings = scan.findings;
    if (snap.info) report.name = `${snap.info.owner}/${snap.info.repo}`;
    if (scan.needs.ml) {
        report.categories.push("local_ai_model");
        report.workload = "inference";
    }
    report.gpu = scan.needs.gpu;
    report.cuda = scan.needs.cuda;
    if (src.asset) {
        report.findings.push({
            id: "binary_download",
            severity: shift("medium", scan.trust),
            title: "The link is a prebuilt release file, not the repo's source code",
            evidence: evidence(src.asset),
        });
    }
}

async function readHuggingfaceSource(
    env: ReadEnv,
    src: Extract<Source, { kind: "huggingface" }>,
    report: SourceReport,
    signal: AbortSignal,
): Promise<void> {
    const res = await readHuggingface(
        {
            fetch: env.fetch,
            base: env.config.assess.huggingface,
            token: env.config.secrets.huggingfaceToken,
        },
        src,
        signal,
    );
    report.complete = res.complete;
    report.findings = res.notes;
    report.categories.push("local_ai_model");
    report.workload = "inference";
    if (!res.model) return;
    const m = analyseModel(res.model, env.now());
    report.checked = true;
    report.name = res.model.id;
    report.facts = m.facts;
    report.findings.push(...m.findings);
    report.gpu = m.gpu;
    report.minMemoryGiB = m.minMemoryGiB;
    report.minDiskGiB = m.minDiskGiB;
}

async function readUrlSource(
    env: ReadEnv,
    src: Extract<Source, { kind: "url" }>,
    report: SourceReport,
    signal: AbortSignal,
): Promise<void> {
    report.workload = "script";
    report.findings = urlFindings(src.url);
    if (!src.url.startsWith("https:")) return;
    if (!env.config.assess.scan_urls) {
        report.findings.push({
            id: "url_checks_off",
            severity: "info",
            title: "Script URL checks are turned off",
        });
        return;
    }
    const res = await readScript(
        { fetch: env.fetch, maxFileBytes: env.config.assess.max_file_bytes },
        src.url,
        signal,
    );
    report.checked = res.checked;
    report.complete = res.complete;
    report.facts = res.facts;
    report.findings.push(...res.findings);
}

async function readOne(env: ReadEnv, src: Source, signal: AbortSignal): Promise<SourceReport> {
    const report = emptyReport(src);
    try {
        if (src.kind === "github") await readGithubSource(env, src, report, signal);
        else if (src.kind === "huggingface") await readHuggingfaceSource(env, src, report, signal);
        else if (src.kind === "url") await readUrlSource(env, src, report, signal);
    } catch (e) {
        const note = failureNote(e);
        report.findings.push(note.finding);
        report.complete = report.complete && note.complete;
    }
    return report;
}

export async function readSource(
    env: ReadEnv,
    src: Source,
    signal: AbortSignal,
): Promise<SourceReport> {
    const report = await readOne(env, src, signal);
    const alt = githubAlternative(src);
    if (!alt || report.findings[0]?.id !== "hf_not_found") return report;
    const gh = await readOne(env, alt, signal);
    if (gh.findings[0]?.id !== "github_not_found") return gh;
    return {
        ...report,
        categories: [],
        workload: null,
        findings: [
            {
                id: "source_not_found",
                severity: "info",
                title: "Not found as a Hugging Face model or a GitHub repo, or it is private",
            },
        ],
    };
}

export function createAssessor(config: Config, opts: AssessorOptions = {}): Assessor {
    const fetch = opts.fetch ?? createSafeFetcher({ timeoutMs: config.assess.fetch_timeout });
    const now = opts.now ?? Date.now;
    const cache = new TtlCache<SourceReport>(config.assess.cache_ttl, cacheEntries, now);
    const env: ReadEnv = { fetch, config, now };
    return {
        async assess(input: AssessInput, signal: AbortSignal): Promise<Assessment> {
            const src = parseSource(input.source);
            let report = src.kind === "none" ? undefined : cache.get(src.key);
            if (!report) {
                report = await readSource(env, src, signal);
                if (src.kind !== "none" && report.complete) cache.set(src.key, report);
                if (src.kind === "none" && src.crafted) {
                    report.findings.push({
                        id: "crafted_source",
                        severity: "medium",
                        title: `The link was not checked because ${src.reason}, a sign it was made to mislead`,
                    });
                } else if (src.kind === "none" && input.source?.trim()) {
                    report.findings.push({
                        id: "source_unrecognised",
                        severity: "info",
                        title: `Source not checked, ${src.reason}`,
                    });
                }
            }
            return combine(input, structuredClone(report));
        },
    };
}
