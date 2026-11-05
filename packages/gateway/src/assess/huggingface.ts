import type { Finding } from "./assessor.ts";
import { bodyJson, type Fetcher } from "./fetch.ts";
import { evidence, safePath } from "./scan.ts";

export interface HfFile {
    name: string;
    size: number;
}

export interface HfModel {
    id: string;
    files: HfFile[];
    safetensors: Record<string, number> | null;
    ggufParameters: number | null;
    pipelineTag: string | null;
    library: string | null;
    gated: boolean;
    tags: string[];
    downloads: number | null;
    likes: number | null;
    createdAt: string | null;
    flagged: { path: string; level: string }[];
}

export interface HfEnv {
    fetch: Fetcher;
    base: string;
    token: string;
}

export interface ModelReport {
    facts: Record<string, string | number | boolean>;
    findings: Finding[];
    gpu: boolean;
    minMemoryGiB: number | null;
    minDiskGiB: number | null;
}

const GiB = 1024 ** 3;
const listingBytes = 8 * 1024 * 1024;

const expand = [
    "siblings",
    "safetensors",
    "gguf",
    "pipeline_tag",
    "library_name",
    "gated",
    "tags",
    "downloads",
    "likes",
    "createdAt",
    "private",
];

export function modelUrl(base: string, id: string, revision: string | null): string {
    const path = id.split("/").map(encodeURIComponent).join("/");
    const rev = revision ? `/revision/${encodeURIComponent(revision)}` : "";
    const query = ["blobs=true", "securityStatus=true", ...expand.map((e) => `expand[]=${e}`)];
    return `${base.replace(/\/$/, "")}/api/models/${path}${rev}?${query.join("&")}`;
}

export function modelFrom(json: unknown): HfModel | null {
    if (!json || typeof json !== "object") return null;
    const d = json as Record<string, unknown>;
    if (typeof d.id !== "string") return null;
    const files: HfFile[] = [];
    for (const s of Array.isArray(d.siblings) ? (d.siblings as Record<string, unknown>[]) : []) {
        if (typeof s?.rfilename !== "string") continue;
        const lfs = s.lfs as { size?: unknown } | undefined;
        const size =
            typeof s.size === "number" ? s.size : typeof lfs?.size === "number" ? lfs.size : 0;
        files.push({ name: s.rfilename, size });
    }
    const st = d.safetensors as { parameters?: unknown } | undefined;
    const params =
        st && st.parameters && typeof st.parameters === "object"
            ? Object.fromEntries(
                  Object.entries(st.parameters as Record<string, unknown>).filter(
                      (e): e is [string, number] => typeof e[1] === "number",
                  ),
              )
            : null;
    const gguf = d.gguf as { total?: unknown } | undefined;
    const status = d.securityRepoStatus as { filesWithIssues?: unknown } | undefined;
    const flagged = (Array.isArray(status?.filesWithIssues) ? status.filesWithIssues : [])
        .map((f) => f as { path?: unknown; level?: unknown })
        .filter((f) => typeof f.path === "string")
        .map((f) => ({
            path: f.path as string,
            level: typeof f.level === "string" ? f.level : "",
        }));
    return {
        id: d.id,
        files,
        safetensors: params && Object.keys(params).length > 0 ? params : null,
        ggufParameters: typeof gguf?.total === "number" ? gguf.total : null,
        pipelineTag: typeof d.pipeline_tag === "string" ? d.pipeline_tag : null,
        library: typeof d.library_name === "string" ? d.library_name : null,
        gated: d.gated === "auto" || d.gated === "manual" || d.gated === true,
        tags: Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === "string") : [],
        downloads: typeof d.downloads === "number" ? d.downloads : null,
        likes: typeof d.likes === "number" ? d.likes : null,
        createdAt: typeof d.createdAt === "string" ? d.createdAt : null,
        flagged,
    };
}

/* Size maths */

const dtypeBytes: Record<string, number> = {
    F64: 8,
    I64: 8,
    U64: 8,
    F32: 4,
    I32: 4,
    U32: 4,
    F16: 2,
    BF16: 2,
    I16: 2,
    U16: 2,
    F8_E4M3: 1,
    F8_E5M2: 1,
    I8: 1,
    U8: 1,
    BOOL: 1,
};

const pickle = /\.(?:bin|pt|pth|ckpt|pkl|pickle)$/i;
const safeWeights = /\.(?:safetensors|gguf|onnx)$/i;
const weightFile =
    /\.(?:safetensors|gguf|onnx|bin|pt|pth|ckpt|pkl|pickle|h5|msgpack|tflite|mlmodel)$/i;

const generation = new Set([
    "text-to-image",
    "image-to-image",
    "text-to-video",
    "image-to-video",
    "video-to-video",
    "text-to-3d",
    "image-to-3d",
    "unconditional-image-generation",
]);

function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) / 2)] ?? 0;
}

// Parameter count written into the name, such as Kokoro-82M or Llama-3.1-8B
export function parametersFromName(id: string): number | null {
    const name = id.split("/").pop() ?? id;
    const m = /(?:^|[-_.])(\d+(?:\.\d+)?)([MBK])(?=$|[-_.])/i.exec(name);
    if (!m) return null;
    const scale = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] as string).toUpperCase() as "K" | "M" | "B"];
    return Number(m[1]) * scale;
}

export function humanCount(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
    if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
    return `${Math.round(n / 1e3)}K`;
}

function ceilTenth(n: number): number {
    return Math.ceil(n * 10) / 10;
}

// Weights the runtime loads, preferring the parameter count over summing every file variant
export function modelSize(m: HfModel): {
    parameters: number | null;
    weightsBytes: number | null;
    totalBytes: number;
} {
    const totalBytes = m.files.reduce((a, f) => a + f.size, 0);
    if (m.safetensors) {
        let parameters = 0;
        let bytes = 0;
        for (const [dtype, count] of Object.entries(m.safetensors)) {
            parameters += count;
            bytes += count * (dtypeBytes[dtype.toUpperCase()] ?? 2);
        }
        return { parameters, weightsBytes: bytes, totalBytes };
    }
    const gguf = m.files.filter((f) => /\.gguf$/i.test(f.name));
    if (gguf.length > 0) {
        return {
            parameters: m.ggufParameters ?? parametersFromName(m.id),
            weightsBytes: median(gguf.map((f) => f.size)),
            totalBytes,
        };
    }
    const weights = m.files.filter((f) => weightFile.test(f.name));
    const preferred = [/\.safetensors$/i, pickle, /\.onnx$/i, weightFile]
        .map((re) => weights.filter((f) => re.test(f.name)))
        .find((group) => group.length > 0);
    const weightsBytes = preferred ? preferred.reduce((a, f) => a + f.size, 0) : null;
    return { parameters: parametersFromName(m.id), weightsBytes, totalBytes };
}

export function analyseModel(m: HfModel, now: number): ModelReport {
    const { parameters, weightsBytes, totalBytes } = modelSize(m);
    const facts: ModelReport["facts"] = { model: m.id, files: m.files.length };
    if (m.pipelineTag) facts.pipelineTag = safePath(m.pipelineTag);
    if (m.library) facts.library = safePath(m.library);
    if (parameters) {
        facts.parameters = humanCount(parameters);
        facts.parameterCount = parameters;
    }
    if (weightsBytes !== null) facts.weightsGiB = Math.round((weightsBytes / GiB) * 100) / 100;
    facts.totalFilesGiB = Math.round((totalBytes / GiB) * 100) / 100;
    facts.gated = m.gated;
    if (m.downloads !== null) facts.downloads = m.downloads;
    if (m.likes !== null) facts.likes = m.likes;
    if (m.createdAt) facts.createdAt = m.createdAt.slice(0, 10);
    const license = m.tags.find((t) => t.startsWith("license:"));
    if (license) facts.license = safePath(license.slice("license:".length));

    const findings: Finding[] = [];
    const pickles = m.files.filter((f) => pickle.test(f.name));
    if (pickles.length > 0 && !m.files.some((f) => safeWeights.test(f.name))) {
        const names = pickles.slice(0, 2).map((f) => f.name);
        const more = pickles.length > 2 ? ` and ${pickles.length - 2} more` : "";
        findings.push({
            id: "pickle_weights",
            severity: "medium",
            title: "Weights are only in pickle files, and loading a pickle can run code",
            evidence: evidence(`${names.join(", ")}${more}`),
        });
    }
    if (m.tags.includes("custom_code")) {
        findings.push({
            id: "remote_code",
            severity: "medium",
            title: "The model ships its own Python code, which runs when it is loaded",
            evidence: "tag custom_code, needs trust_remote_code",
        });
    }
    for (const f of m.flagged.slice(0, 3)) {
        const bad = /unsafe|malicious|danger/i.test(f.level);
        findings.push({
            id: "hf_scan_flagged",
            severity: bad ? "high" : "medium",
            title: "Hugging Face's own scanner flagged a file in this model",
            evidence: evidence(`${f.path}${f.level ? ` (${f.level})` : ""}`),
        });
    }
    if (m.gated) {
        findings.push({
            id: "gated_model",
            severity: "info",
            title: "Gated model, downloading it needs a Hugging Face token with accepted terms",
        });
    }
    const createdDays = m.createdAt ? (now - Date.parse(m.createdAt)) / 86_400_000 : null;
    if (m.downloads !== null && m.downloads < 100 && createdDays !== null && createdDays < 30) {
        findings.push({
            id: "hf_little_used",
            severity: "low",
            title: "New model with very few downloads",
            evidence: `${m.downloads} downloads, created ${m.createdAt?.slice(0, 10)}`,
        });
    }

    const weightsGiB = weightsBytes !== null ? weightsBytes / GiB : null;
    const effectiveParams = parameters ?? (weightsBytes !== null ? weightsBytes / 2 : 0);
    return {
        facts,
        findings,
        gpu: generation.has(m.pipelineTag ?? "") || effectiveParams > 3e9,
        minMemoryGiB: weightsGiB !== null ? ceilTenth(weightsGiB * 1.2 + 1) : null,
        minDiskGiB: totalBytes > 0 ? Math.ceil(totalBytes / GiB) + 1 : null,
    };
}

function notFound(): Finding {
    return {
        id: "hf_not_found",
        severity: "info",
        title: "Model not found on Hugging Face, or it is private",
    };
}

export async function readHuggingface(
    env: HfEnv,
    src: { id: string; revision: string | null },
    signal: AbortSignal,
): Promise<{ model: HfModel | null; notes: Finding[]; complete: boolean }> {
    const res = await env.fetch(modelUrl(env.base, src.id, src.revision), {
        signal,
        maxBytes: listingBytes,
        headers: { accept: "application/json" },
        ...(env.token ? { originHeaders: { authorization: `Bearer ${env.token}` } } : {}),
    });
    if (res.status === 401 || res.status === 404) {
        return { model: null, notes: [notFound()], complete: true };
    }
    if (res.status === 429) {
        return {
            model: null,
            notes: [
                {
                    id: "hf_rate_limited",
                    severity: "info",
                    title: "Hugging Face rate limit reached, the model was not checked",
                },
            ],
            complete: false,
        };
    }
    if (res.status !== 200) {
        return {
            model: null,
            notes: [
                {
                    id: "hf_error",
                    severity: "info",
                    title: `Hugging Face answered ${res.status} for this model`,
                },
            ],
            complete: false,
        };
    }
    const json = bodyJson(res);
    // The gateway's token may see private models, which must look the same as missing ones
    if ((json as { private?: unknown } | null)?.private === true) {
        return { model: null, notes: [notFound()], complete: true };
    }
    const model = modelFrom(json);
    if (!model) {
        return {
            model: null,
            notes: [
                {
                    id: "hf_error",
                    severity: "info",
                    title: "Hugging Face returned model details in an unknown shape",
                },
            ],
            complete: false,
        };
    }
    return { model, notes: [], complete: true };
}
