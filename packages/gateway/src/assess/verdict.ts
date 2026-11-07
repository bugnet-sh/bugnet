/**
 * Turns a source report, the planned commands and the task text into a bugnet_assess verdict.
 *
 * Risk comes from the scanner's findings, intent categories from @bugnet/intent, and fit from
 * comparing the needs with the user's machine. The recommendation follows fixed rules. High risk,
 * or heavy AI that does not fit, is strongly recommended. Medium risk, any intent category, or
 * code that could not be checked is recommended. Everything else may run locally.
 */
import {
    classifyCommand,
    classifyPrompt,
    type Classification,
    type SessionContext,
} from "@bugnet/intent";
import type {
    ApiKey,
    Assessment,
    AssessInput,
    Finding,
    LocalMachine,
    Recommendation,
    Workload,
} from "./assessor.ts";
import { evidence, scanCommand, severityRank, sortFindings } from "./scan.ts";

export interface SourceReport {
    kind: Assessment["source"]["kind"];
    ref: string;
    name: string;
    // Something was read and scanned, so the absence of findings means something
    checked: boolean;
    // Nothing failed on the way, so the report may be cached
    complete: boolean;
    facts: Record<string, string | number | boolean>;
    findings: Finding[];
    categories: string[];
    gpu: boolean;
    cuda: boolean;
    minMemoryGiB: number | null;
    minDiskGiB: number | null;
    workload: Workload | null;
    apiKeys: ApiKey[];
    otherSecrets: string[];
}

export const maxCommands = 20;

/* Local machine */

export function normaliseOs(os: string | undefined): SessionContext["os"] | undefined {
    if (!os) return undefined;
    if (/mac|darwin|osx/i.test(os)) return "macos";
    if (/win/i.test(os)) return "windows";
    if (/linux|ubuntu|debian|fedora|arch|wsl/i.test(os)) return "linux";
    return undefined;
}

export function normaliseArch(arch: string | undefined): SessionContext["arch"] | undefined {
    if (!arch) return undefined;
    if (/arm|aarch|apple|\bm[1-9]\b/i.test(arch)) return "arm64";
    if (/x64|x86[-_]?64|amd64|intel|x86/i.test(arch)) return "x64";
    return undefined;
}

function sessionContext(local: LocalMachine | undefined): SessionContext {
    const ctx: SessionContext = {};
    const os = normaliseOs(local?.os);
    const arch = normaliseArch(local?.arch);
    if (os) ctx.os = os;
    if (arch) ctx.arch = arch;
    return ctx;
}

const nvidia =
    /nvidia|geforce|rtx|gtx|quadro|tesla|cuda|\b(?:a100|h100|h200|l4|l40s?|t4|a10g?|v100)\b/i;
const noGpu = /^(?:none|no|n\/a|false|0|integrated|cpu|cpu only)?$/i;
const appleGpu = /apple|\bm[1-9]\b|mps|metal/i;

function machineText(local: LocalMachine): string {
    const parts = [
        local.os,
        local.arch,
        local.ramGiB !== undefined ? `${local.ramGiB} GiB` : "",
        local.gpu ? `GPU ${local.gpu}` : "",
    ];
    return evidence(`this machine: ${parts.filter(Boolean).join(", ")}`);
}

export function assessFit(
    needs: { gpu: boolean; minMemoryGiB: number | null },
    cuda: boolean,
    local: LocalMachine | undefined,
): Assessment["fit"] {
    if (!local) return { level: "unknown", findings: [] };
    const os = normaliseOs(local.os);
    const gpu = local.gpu?.trim();
    const known = os !== undefined || gpu !== undefined || local.ramGiB !== undefined;
    const findings: Finding[] = [];
    const where = machineText(local);
    if (needs.gpu) {
        const hasNvidia = gpu !== undefined && nvidia.test(gpu);
        const apple = os === "macos" || (gpu !== undefined && appleGpu.test(gpu));
        const none = gpu !== undefined && noGpu.test(gpu);
        if (cuda && !hasNvidia && (apple || gpu !== undefined)) {
            findings.push({
                id: "local_no_cuda",
                severity: "medium",
                title: "Needs an NVIDIA CUDA GPU, which this machine does not have",
                evidence: where,
            });
        } else if (none) {
            findings.push({
                id: "local_no_gpu",
                severity: "medium",
                title: "Needs a GPU, and this machine reports none",
                evidence: where,
            });
        } else if (apple && !hasNvidia) {
            findings.push({
                id: "local_apple_gpu",
                severity: "low",
                title: "Built for NVIDIA GPUs, on a Mac it runs slower through Metal or on the CPU",
                evidence: where,
            });
        }
    }
    const ram = local.ramGiB;
    if (needs.minMemoryGiB !== null && ram !== undefined) {
        if (needs.minMemoryGiB > ram) {
            findings.push({
                id: "local_memory",
                severity: "medium",
                title: `Needs about ${needs.minMemoryGiB} GiB of memory, this machine has ${ram} GiB`,
                evidence: where,
            });
        } else if (needs.minMemoryGiB > ram * 0.75) {
            findings.push({
                id: "local_memory_tight",
                severity: "low",
                title: `Needs about ${needs.minMemoryGiB} GiB of memory, most of this machine's ${ram} GiB`,
                evidence: where,
            });
        }
    }
    const worst = Math.max(-1, ...findings.map((f) => severityRank(f.severity)));
    const level = !known
        ? "unknown"
        : worst >= severityRank("medium")
          ? "does_not_fit"
          : worst >= severityRank("low")
            ? "tight"
            : "fits";
    return { level, findings };
}

/* Workload */

const workloadPatterns: [Workload, RegExp][] = [
    [
        "tests",
        /\b(?:pytest|tox|nox|jest|vitest|mocha|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|go\s+test|cargo\s+test|make\s+(?:test|check)|mvn\s+test|gradlew?\s+test)\b/i,
    ],
    [
        "serve",
        /\b(?:uvicorn|gunicorn|flask\s+run|streamlit\s+run|gradio|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev|serve)|ollama\s+serve|llama-server|webui\.sh|launch\.py)\b|--listen\b|--port\b/i,
    ],
    [
        "inference",
        /\b(?:ollama\s+run|llama-cli|whisper|txt2img|img2img|inference|infer|predict)\b/i,
    ],
    [
        "build",
        /\b(?:make|cmake|ninja|cargo\s+build|go\s+build|docker\s+build|(?:npm|pnpm|yarn|bun)\s+run\s+build|mvn\s+package|gradlew?\s+build|python3?\s+-m\s+build)\b/i,
    ],
    [
        "script",
        /\b(?:python3?|node|bash|sh|ruby|perl|deno\s+run|bun)\s+\S+\.(?:py|js|mjs|ts|sh|rb|pl)\b/i,
    ],
];

export function workloadFromCommands(commands: string[]): Workload | null {
    for (const [workload, re] of workloadPatterns) {
        if (commands.some((c) => re.test(c))) return workload;
    }
    return null;
}

const gpuCommand = /\bnvidia-smi\b|--gpus\b|\bcuda\b|--device[=\s]+cuda/i;

/* Summary */

const categoryOrder = [
    "untrusted_code",
    "risky_experiment",
    "local_ai_model",
    "environment",
    "heavy_compute",
];

const categoryPhrase: Record<string, string> = {
    untrusted_code: "it runs code nobody has vetted",
    risky_experiment: "it can damage or expose the machine it runs on",
    local_ai_model: "it installs an AI model and its runtime, often several GB",
    environment: "it needs system setup this machine may not have",
    heavy_compute: "it is heavy compute work",
};

// File names such as package.json keep their case at the start of a sentence
export function sentence(s: string): string {
    const t = s.replace(/[.\s]+$/, "");
    const first = t.split(" ")[0] ?? "";
    if (/[./]/.test(first)) return `${t}.`;
    return `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
}

function compact(n: number): string {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
    return String(n);
}

function factText(report: SourceReport): string {
    const f = report.facts;
    if (report.kind === "github" && typeof f.stars === "number") {
        const year = typeof f.createdAt === "string" ? f.createdAt.slice(0, 4) : "";
        const license = f.license && f.license !== "none" ? `, ${f.license}` : "";
        return ` (${compact(f.stars)} stars, since ${year}${license})`;
    }
    if (report.kind === "huggingface") {
        const parts = [
            typeof f.parameters === "string" ? `${f.parameters} parameters` : "",
            typeof f.weightsGiB === "number" ? `${f.weightsGiB} GiB of weights` : "",
        ].filter(Boolean);
        return parts.length > 0 ? ` (${parts.join(", ")})` : "";
    }
    return "";
}

interface SummaryInput {
    recommendation: Recommendation;
    report: SourceReport;
    risk: Finding | undefined;
    fit: Finding | undefined;
    categories: string[];
    unverified: boolean;
    checked: boolean;
}

// Closing sentences that say what a Bugnet sandbox would do, with {} for the source name
const claims = {
    contain:
        "Running {} in a disposable Bugnet sandbox keeps it away from the user's files, keys and accounts.",
    rent: "A Bugnet cloud sandbox can run {} on rented hardware instead.",
    safer: "A disposable Bugnet sandbox is safer than running {} on this machine.",
    unchecked:
        "Unchecked code is safer in a disposable Bugnet sandbox, which can run it from a working link or uploaded files without touching the user's computer.",
    offMachine: "A Bugnet sandbox keeps that off the user's machine.",
};

function claim(kind: keyof typeof claims, it = ""): string {
    return claims[kind].replace("{}", it);
}

// Matches the claim's fixed text from the end, since names such as vercel/next.js hold periods
export function withoutSandboxClaim(summary: string): string {
    for (const template of Object.values(claims)) {
        const [head = "", tail] = template.split("{}");
        if (tail === undefined) {
            if (summary.endsWith(` ${head}`)) return summary.slice(0, -head.length - 1);
            continue;
        }
        if (!summary.endsWith(tail)) continue;
        const at = summary.lastIndexOf(` ${head}`, summary.length - tail.length - 1);
        if (at >= 0) return summary.slice(0, at);
    }
    return summary;
}

// Work Bugnet is never offered for, keyed by the policy signal @bugnet/intent reports
const policyTails: Record<string, string> = {
    abuse: "Bugnet is never offered for crypto mining, floods, DDoS, mass scanning, credential stuffing or mass messaging, so there is no Bugnet option for this.",
    lan_scan:
        "A scan of a local network needs that network, which a cloud sandbox cannot reach, so there is no Bugnet option for this.",
};

export function refusedByPolicy(summary: string): boolean {
    return Object.values(policyTails).some((t) => summary.endsWith(t));
}

export function summarise(s: SummaryInput): string {
    const name = s.report.name;
    const it = name || "it";
    if (s.recommendation === "sandbox_strongly_recommended") {
        if (s.risk && s.risk.severity === "high") {
            return `${sentence(s.risk.title)} ${claim("contain", it)}`;
        }
        if (s.fit) {
            return `${sentence(s.fit.title)} ${claim("rent", it)}`;
        }
    }
    if (s.recommendation === "sandbox_recommended") {
        if (s.risk && severityRank(s.risk.severity) >= severityRank("medium")) {
            return `${sentence(s.risk.title)} ${claim("safer", it)}`;
        }
        if (s.unverified) {
            const why = s.report.findings.find((f) => f.severity === "info");
            const reason = why ? ` (${why.title})` : "";
            return `${name || "The source"} could not be checked${reason}, so there is no evidence about the code either way. ${claim("unchecked")}`;
        }
        const cat = categoryOrder.find((c) => s.categories.includes(c));
        const phrase = (cat && categoryPhrase[cat]) || "it fits work better kept off this machine";
        if (s.checked) {
            return `No red flags found${name ? ` in ${name}` : ""}${factText(s.report)}, but ${phrase}. ${claim("offMachine")}`;
        }
        return `${sentence(phrase)} ${claim("offMachine")}`;
    }
    if (!s.checked) {
        const why = s.report.findings.find((f) => f.severity === "info");
        if (why) return `${sentence(why.title)} There is no evidence either way.`;
        return "No source or commands to check, so there is no evidence either way.";
    }
    return `No risk signals found${name ? ` in ${name}` : ""}${factText(s.report)}. Running it locally looks fine.`;
}

/* Combining */

function addCategory(set: Set<string>, policy: Set<string>, run: () => Classification): void {
    try {
        const c = run();
        if (c.suggest && c.category) set.add(c.category);
        for (const sig of c.signals) if (Object.hasOwn(policyTails, sig.id)) policy.add(sig.id);
    } catch {
        return;
    }
}

export function combine(input: AssessInput, report: SourceReport): Assessment {
    const ctx = sessionContext(input.local);
    const commands = (input.commands ?? []).slice(0, maxCommands);
    const categories = new Set(report.categories);
    const policy = new Set<string>();
    const raw: Finding[] = [...report.findings];
    for (const cmd of commands) {
        raw.push(...scanCommand(cmd));
        addCategory(categories, policy, () => classifyCommand(cmd, ctx));
    }
    const task = input.task?.trim();
    if (task) addCategory(categories, policy, () => classifyPrompt(task, ctx));

    const findings = sortFindings(raw);
    const top = findings[0];
    const checked = report.checked || commands.length > 0;
    const topRank = top ? severityRank(top.severity) : -1;
    const level: Assessment["risk"]["level"] =
        topRank >= severityRank("high")
            ? "high"
            : topRank >= severityRank("medium")
              ? "medium"
              : checked
                ? "low"
                : "unknown";
    if (level === "high" || level === "medium") {
        if (report.kind === "github" || report.kind === "url") categories.add("untrusted_code");
    }

    const needs: Assessment["needs"] = {
        gpu: report.gpu || commands.some((c) => gpuCommand.test(c)),
        minMemoryGiB: report.minMemoryGiB,
        minDiskGiB: report.minDiskGiB,
        workload:
            input.workload ??
            report.workload ??
            workloadFromCommands(commands) ??
            (report.kind === "url" ? "script" : "other"),
    };
    const fit = assessFit(needs, report.cuda, input.local);
    const fitTop = sortFindings(fit.findings)[0];

    const heavyAi = categories.has("local_ai_model") || needs.gpu;
    const unverified =
        !report.checked && (report.kind === "github" || report.kind === "url") && level !== "high";
    let recommendation: Recommendation = "local_ok";
    if (level === "high" || (heavyAi && fit.level === "does_not_fit")) {
        recommendation = "sandbox_strongly_recommended";
    } else if (level === "medium" || categories.size > 0 || unverified) {
        recommendation = "sandbox_recommended";
    }
    const cats = categoryOrder.filter((c) => categories.has(c));
    cats.push(...[...categories].filter((c) => !categoryOrder.includes(c)));
    const base = summarise({
        recommendation,
        report,
        risk: top,
        fit: fit.level === "does_not_fit" ? fitTop : undefined,
        categories: cats,
        unverified,
        checked,
    });
    const stop = Object.keys(policyTails).find((id) => policy.has(id));
    const summary = stop ? `${withoutSandboxClaim(base)} ${policyTails[stop]}` : base;
    return {
        recommendation,
        summary,
        categories: cats,
        risk: { level, findings: findings.slice(0, 30) },
        needs,
        fit,
        apiKeys: report.apiKeys,
        otherSecrets: report.otherSecrets,
        source: { kind: report.kind, ref: report.ref, facts: report.facts },
    };
}
