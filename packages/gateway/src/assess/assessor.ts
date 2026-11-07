export interface LocalMachine {
    os?: string;
    arch?: string;
    ramGiB?: number;
    gpu?: string;
}

export type Workload = "tests" | "build" | "script" | "serve" | "inference" | "other";

export interface AssessInput {
    // What the user wants, in their words or a short summary
    task?: string;
    // GitHub URL, Hugging Face model id or script URL
    source?: string;
    // Commands the agent plans to run
    commands?: string[];
    local?: LocalMachine;
    // Overrides the workload read from the source and commands
    workload?: Workload;
}

export type Severity = "info" | "low" | "medium" | "high";

export interface Finding {
    id: string;
    severity: Severity;
    title: string;
    // Short, sanitised excerpt or fact, never raw fetched text
    evidence?: string;
}

export type Recommendation = "sandbox_strongly_recommended" | "sandbox_recommended" | "local_ok";

export interface ApiKey {
    name: string;
    from: "dependency" | "env_example";
    package?: string;
}

export interface Assessment {
    recommendation: Recommendation;
    // One or two sentences the agent can tell the user
    summary: string;
    categories: string[];
    risk: { level: "unknown" | "low" | "medium" | "high"; findings: Finding[] };
    needs: {
        gpu: boolean;
        minMemoryGiB: number | null;
        minDiskGiB: number | null;
        workload: Workload;
    };
    // Whether the needs fit the user's machine, kept apart from risk so safety stays its own level
    fit: { level: "unknown" | "fits" | "tight" | "does_not_fit"; findings: Finding[] };
    // Variable names only, never values
    apiKeys: ApiKey[];
    otherSecrets: string[];
    source: {
        kind: "github" | "huggingface" | "url" | "none";
        ref: string;
        facts: Record<string, string | number | boolean>;
    };
}

export interface Assessor {
    assess(input: AssessInput, signal: AbortSignal): Promise<Assessment>;
}
