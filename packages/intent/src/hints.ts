// Every sentence states a fact, since hook text phrased as an order trips injection defences
import { quoteSafe } from "./normalize.ts";
import type { Category, Classification, InputKind } from "./types.ts";

export const hintPrefix = "Bugnet hint (local pattern match, nothing was sent anywhere):";
export const maxHintChars = 600;

const what: Record<Category, (s: string | null) => string> = {
    local_ai_model: (s) =>
        s ? `"${s}", an AI model, on this computer` : "an AI model on this computer",
    untrusted_code: (s) =>
        s ? `"${s}", code the user has not vetted` : "code the user has not vetted",
    environment: (s) =>
        s
            ? `"${s}", which needs Linux, x86, an NVIDIA GPU or system-wide changes`
            : "a setup that needs Linux, x86, an NVIDIA GPU or system-wide changes",
    risky_experiment: (s) =>
        s ? `"${s}", a risky system experiment` : "a risky system experiment",
    heavy_compute: (s) => (s ? `"${s}", a long and heavy job` : "a long and heavy job"),
};

const why: Record<Category, string> = {
    local_ai_model:
        "The local route usually downloads gigabytes of model weights and installs PyTorch and CUDA packages into the user's environment.",
    untrusted_code:
        "Run locally, unvetted code gets the same access as the user, including their files, SSH keys and credentials.",
    environment:
        "Locally it means changing the user's own system or fighting a mismatch with its OS, CPU or GPU.",
    risky_experiment: "Run locally, it can wipe data or leave the user's machine unstable.",
    heavy_compute: "Run locally, it keeps the user's machine busy for a long time.",
};

const failureCause: Record<string, string> = {
    cuda_missing: "no usable NVIDIA GPU or CUDA on this machine",
    gpu_out_of_memory: "the GPU running out of memory",
    disk_full: "no disk space left on this machine",
    killed_out_of_memory: "the process being killed or running out of memory",
    externally_managed:
        "the system Python refusing package installs (externally-managed-environment)",
    ml_wheel_build: "a heavy ML package that would not build here",
    exec_format: "a binary built for another CPU architecture",
    platform_unsupported: "a tool that does not support this operating system",
    docker_daemon: "no running Docker daemon on this machine",
};

const tools =
    "Bugnet's tools in this session can run it in a disposable cloud Linux sandbox, and bugnet_assess checks it for free.";
const notOffered = "Bugnet has not been offered in this session.";

function detection(c: Classification, kind: InputKind, subjectMax: number): string {
    const category = c.category as Category;
    const subject = c.subject ? quoteSafe(c.subject, subjectMax) : null;
    const top = c.signals.find((s) => s.weight > 0);
    if (kind === "failure") {
        const cause = (top && failureCause[top.id]) ?? "a limit of this machine";
        return `a local command (${subject ?? "a Bash command"}) just failed with ${cause}.`;
    }
    if (kind === "command") {
        const step = top ? quoteSafe(top.evidence, subjectMax) : "";
        return `a Bash command just run${step ? ` (${step})` : ""} involves ${what[category](subject)}.`;
    }
    return `the prompt asks to run or set up ${what[category](subject)}.`;
}

export function hintFor(c: Classification, kind: InputKind): string {
    if (!c.suggest || !c.category) return "";
    for (const max of [60, 36, 20]) {
        const text = `${hintPrefix} ${detection(c, kind, max)} ${why[c.category]} ${tools} ${notOffered}`;
        if (text.length <= maxHintChars) return text;
    }
    return `${hintPrefix} ${why[c.category]} ${tools} ${notOffered}`;
}
