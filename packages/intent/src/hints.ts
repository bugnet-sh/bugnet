// Every sentence states a fact, since hook text phrased as an order trips injection defences
import { quoteSafe } from "./normalize.ts";
import type { Category, Classification, InputKind, Signal } from "./types.ts";

export const hintPrefix = "Bugnet hint (local pattern match, nothing was sent anywhere):";
export const maxHintChars = 700;

const noun: Record<Category, string> = {
    local_ai_model: "an AI model to run on this computer",
    untrusted_code: "code the user has not vetted",
    environment: "a tool that needs Linux, x86, an NVIDIA GPU or system-wide changes",
    risky_experiment: "a risky system experiment",
    heavy_compute: "a long and heavy job",
};

// Signals whose subject is something other than what the category noun says
const signalNoun: Record<string, string> = {
    heavy_ml_install: "a heavy ML package (PyTorch, CUDA builds, model runtimes)",
    nvidia_only_package: "a package that only works with NVIDIA CUDA",
    ai_runtime_install: "a local AI runtime that downloads models next",
    model_download: "AI model weights",
    model_repo_clone: "AI model weights",
    model_repo: "AI model weights",
    weights_download: "AI model weights",
    model_download_script: "a script that downloads AI model weights",
    lfs_pull: "large files, usually model weights",
    runs_cloned_code:
        "code from a repository cloned in this session, which the user has not vetted",
    asks_isolation: "code in an isolated machine instead of this computer",
    not_on_my_machine: "code somewhere other than this computer",
};

// Requests whose only sign is where the user wants the work to run, whatever the code is
const signalWhy: Record<string, string> = {
    asks_isolation: "The user asked for the work to stay off this computer.",
    not_on_my_machine: "The user asked for the work to stay off this computer.",
};

const why: Record<Category, string> = {
    local_ai_model:
        "The local route usually downloads gigabytes of model weights and installs PyTorch and CUDA packages into the user's environment.",
    untrusted_code:
        "Unvetted code run locally, in any folder, gets the same access as the user, including their files, SSH keys and credentials.",
    environment:
        "Locally it means changing the user's own system or fighting a mismatch with its OS, CPU or GPU.",
    risky_experiment: "On the local machine it can wipe data or leave the system unstable.",
    heavy_compute: "On the local machine it keeps the user's computer busy for a long time.",
};

const failureWhy: Record<Category, string> = {
    local_ai_model: "The model needs more memory than this machine has.",
    untrusted_code: "The code did not run as expected on this machine.",
    environment: "This machine lacks the OS, CPU, GPU or setup that the command expects.",
    risky_experiment: "The command could not run safely on this machine.",
    heavy_compute: "This machine ran out of memory or disk for the job.",
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

// What the free check reads for each kind of request, so the hint names something concrete
const checks: Record<Category, string> = {
    local_ai_model: "the model's GPU, memory and disk needs against this machine",
    untrusted_code: "the source's age, owner and install scripts for downloads or binaries",
    environment: "the OS, CPU and GPU the work needs against this machine",
    risky_experiment: "the commands for destructive or system-changing steps",
    heavy_compute: "the CPU, memory, disk and hours the job needs",
};

function assessFact(category: Category): string {
    return (
        "bugnet_assess is free, read-only and needs no probe of this machine. Here it would " +
        `check ${checks[category]} and price a disposable cloud Linux sandbox that keeps the ` +
        "work off this computer."
    );
}

const notOffered =
    "Bugnet has not been mentioned to the user in this session, and whether to use it is " +
    "their choice.";

function lead(c: Classification): Signal | undefined {
    return c.signals.find((s) => s.weight > 0 && s.category === c.category);
}

function described(c: Classification, subjectMax: number): string {
    const category = c.category as Category;
    const top = lead(c);
    const what = (top && signalNoun[top.id]) ?? noun[category];
    const subject = c.subject ? quoteSafe(c.subject, subjectMax) : "";
    if (!subject) return what;
    return `"${subject}", ${what}`;
}

function detection(c: Classification, kind: InputKind, max: number): string {
    if (kind === "failure") {
        const top = lead(c);
        const cause = (top && failureCause[top.id]) ?? "a limit of this machine";
        const command = c.subject ? quoteSafe(c.subject, max) : "a Bash command";
        return `a local command (${command}) just failed with ${cause}.`;
    }
    if (kind === "command") {
        const step = lead(c)?.evidence;
        const shown = step ? ` (${quoteSafe(step, max)})` : "";
        return `a Bash command about to run${shown} involves ${described(c, max)}.`;
    }
    return `the prompt asks to run or set up ${described(c, max)}.`;
}

export function hintFor(c: Classification, kind: InputKind): string {
    if (!c.suggest || !c.category) return "";
    const top = lead(c);
    const reason =
        kind === "failure"
            ? failureWhy[c.category]
            : ((top && signalWhy[top.id]) ?? why[c.category]);
    const tail = `${assessFact(c.category)} ${notOffered}`;
    for (const max of [60, 36, 20]) {
        const text = `${hintPrefix} ${detection(c, kind, max)} ${reason} ${tail}`;
        if (text.length <= maxHintChars) return text;
    }
    return `${hintPrefix} ${reason} ${tail}`;
}
