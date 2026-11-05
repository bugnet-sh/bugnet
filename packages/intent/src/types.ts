export type Category =
    // Unfamiliar repos, scripts, installers, packages, proof-of-concept exploits, lure tools
    | "untrusted_code"
    // Text to speech, voice cloning, image or video generation, local LLMs, speech recognition, training
    | "local_ai_model"
    // Linux-only, x86-only, GPU or CUDA tools, drivers, system-wide installs
    | "environment"
    // Disk-wiping scripts, scans, load tests, suspicious file analysis
    | "risky_experiment"
    // Long builds, benchmarks, data processing the user would rather not run locally
    | "heavy_compute";

export type InputKind = "prompt" | "command" | "failure";

export interface Signal {
    id: string;
    category: Category;
    weight: number;
    // The matched words or command part, short
    evidence: string;
}

export interface Classification {
    suggest: boolean;
    // 0 to 1, suggest is score >= the threshold the classifier was tuned with
    score: number;
    category: Category | null;
    signals: Signal[];
    // What the match is about, such as "kokoro" or "github.com/acme/tool"
    subject: string | null;
}

export interface SessionContext {
    os?: "macos" | "linux" | "windows";
    arch?: "arm64" | "x64";
    // The command runs in, or right after, a repository cloned earlier in this session
    clonedThisSession?: boolean;
    // That repository, such as github.com/acme/tool, when the clone was seen
    clonedRepo?: string;
}
