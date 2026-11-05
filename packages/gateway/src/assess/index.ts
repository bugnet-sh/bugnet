import type { Config } from "../config.ts";
import type { Assessment, AssessInput, Assessor } from "./assessor.ts";

export function createAssessor(_config: Config): Assessor {
    return {
        async assess(input: AssessInput): Promise<Assessment> {
            return {
                recommendation: "local_ok",
                summary: "No assessment yet.",
                categories: [],
                risk: { level: "unknown", findings: [] },
                needs: { gpu: false, minMemoryGiB: null, minDiskGiB: null, workload: "other" },
                source: { kind: "none", ref: input.source ?? "", facts: {} },
            };
        },
    };
}
