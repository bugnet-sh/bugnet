// Every sentence states a fact, since hook text phrased as an order trips injection defences
import type { MachineFacts } from "./machine.ts";
import { quoteSafe } from "./normalize.ts";
import type { Category, Classification, InputKind, Signal } from "./types.ts";

export const hintPrefix = "Bugnet hint (local pattern match, nothing was sent anywhere):";
export const maxHintChars = 600;

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

// Used when the hook could not read this computer's facts
const why: Record<Category, string> = {
    local_ai_model:
        "The local route usually downloads gigabytes of model weights and installs PyTorch and CUDA packages into the user's environment.",
    untrusted_code:
        "Unvetted code run locally gets the same access as the user, including their files, SSH keys and credentials.",
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

// Environment signals about the GPU or the OS and CPU, any other is a system-wide change
const gpuSignals =
    /^(?:pasted_)?(?:needs_nvidia|mentions_nvidia|nvidia_only_package|cuda_\w+|gpu_\w+|hardware_gap|cuda_missing)$/;
const osSignals =
    /^(?:pasted_)?(?:needs_linux|needs_x86|kernel_module|exec_format|platform_unsupported)$/;

const tools =
    "Bugnet's tools in this session can run it in a disposable cloud Linux sandbox, paid per run, and bugnet_assess";

// What the free check covers, which is the step the local route would start with
const checks: Partial<Record<Category, string>> = {
    local_ai_model: "checks for free whether it fits this machine",
    untrusted_code: "checks the source remotely for free, with no clone here",
};
const notOffered = "Bugnet has not been offered in this session.";

function lead(c: Classification): Signal | undefined {
    return c.signals.find((s) => s.weight > 0 && s.category === c.category);
}

const osLabel: Record<MachineFacts["os"], string> = {
    macos: "macOS",
    linux: "Linux",
    windows: "Windows",
};

function machineName(f: MachineFacts): string {
    return f.os === "macos" ? "this Mac" : "this computer";
}

function gpuFact(f: MachineFacts): string | null {
    if (f.nvidia === null) return null;
    if (f.nvidia) return "an NVIDIA driver";
    return f.os === "macos" ? "no NVIDIA GPU" : "no NVIDIA driver";
}

// Such as "arm64, 24 GiB RAM, 160 GiB free disk, no NVIDIA GPU", with the OS named off macOS
export function machineSummary(f: MachineFacts, cores = false): string {
    const parts = [f.os === "macos" ? f.arch : `${osLabel[f.os]} ${f.arch}`];
    if (f.ramGiB !== null) parts.push(`${f.ramGiB} GiB RAM`);
    if (cores && f.cores !== null) parts.push(`${f.cores} cores`);
    if (f.freeDiskGiB !== null) parts.push(`${f.freeDiskGiB} GiB free disk`);
    const gpu = gpuFact(f);
    if (gpu) parts.push(gpu);
    return parts.join(", ");
}

function onThis(f: MachineFacts): string {
    return `On ${machineName(f)} (${machineSummary(f)})`;
}

function localInput(f: MachineFacts): string {
    const parts = [`os ${f.os}`, `arch ${f.arch}`];
    if (f.ramGiB !== null) parts.push(`ramGiB ${f.ramGiB}`);
    if (f.nvidia === false) parts.push("gpu none");
    return parts.join(", ");
}

function list(items: string[]): string {
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const weights =
    "weights take from under 1 GB for speech models to tens of GB for image, video and LLMs";

// Longest first, so a hint over the cap can fall back to a shorter consequence
function consequences(c: Classification, f: MachineFacts): string[] {
    const text = consequence(c, f);
    return Array.isArray(text) ? text : [text];
}

function consequence(c: Classification, f: MachineFacts): string | string[] {
    const category = c.category as Category;
    const top = lead(c)?.id ?? "";
    if (category === "local_ai_model") {
        const cuda = f.nvidia === false ? "CUDA-only code runs on CPU or fails, and " : "";
        return [
            `${onThis(f)}, ${cuda}${weights}, plus PyTorch in the user's own Python.`,
            `${onThis(f)}, ${cuda}model weights and PyTorch add gigabytes.`,
        ];
    }
    if (category === "untrusted_code") {
        const reach = (dirs: string[]) => {
            const home = dirs.map((d) => `~/${d}`);
            return home.length > 0 ? `${list(home)}, which exist here` : "the whole home folder";
        };
        const run = `On ${machineName(f)}, it runs with this user's access, including`;
        const scratch = "and a scratch folder or virtualenv does not limit what it can read";
        return [
            `${run} ${reach(f.secrets)}, ${scratch}.`,
            `${run} ${reach(f.secrets.slice(0, 2))}, ${scratch}.`,
        ];
    }
    if (category === "environment") {
        if (gpuSignals.test(top)) {
            if (f.os === "macos")
                return `${onThis(f)}, CUDA code cannot run at all, since macOS has no CUDA.`;
            if (f.nvidia === false)
                return `${onThis(f)}, CUDA code cannot run without an NVIDIA GPU and its driver.`;
            if (f.nvidia)
                return `${onThis(f)}, CUDA toolkit and driver changes apply to the whole system.`;
        }
        if (osSignals.test(top) && f.os !== "linux") {
            const x86 = f.arch === "arm64" ? ", where x86 binaries run only under emulation" : "";
            const via =
                f.os === "windows" ? "WSL or a virtual machine" : "a virtual machine or container";
            return `${onThis(f)}, Linux-only tools need ${via}${x86}.`;
        }
        return `${onThis(f)}, system-wide installs change the system for every project and are hard to undo.`;
    }
    if (category === "risky_experiment") {
        const data = f.usedDiskGiB !== null ? ` with ${f.usedDiskGiB} GiB of files` : "";
        return `On ${machineName(f)}, a mistake reaches its own disk${data} and its running system, while a broken sandbox is simply deleted.`;
    }
    const size = [
        f.cores !== null ? `${f.cores} cores` : "",
        f.ramGiB !== null ? `${f.ramGiB} GiB RAM` : "",
    ].filter(Boolean);
    const has = size.length > 0 ? `${machineName(f)}'s ${list(size)}` : machineName(f);
    return `A multi-hour job keeps ${has} busy for that whole time.`;
}

function failureReason(c: Classification, f: MachineFacts | undefined): string {
    const base = failureWhy[c.category as Category];
    if (!f) return base;
    const parts = [
        f.ramGiB !== null ? `${f.ramGiB} GiB RAM` : "",
        f.freeDiskGiB !== null ? `${f.freeDiskGiB} GiB free disk` : "",
        gpuFact(f) ?? "",
    ].filter(Boolean);
    const name = f.os === "macos" ? "This Mac" : `This ${osLabel[f.os]} ${f.arch} computer`;
    return parts.length > 0 ? `${base} ${name} has ${list(parts)}.` : base;
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

export function hintFor(c: Classification, kind: InputKind, facts?: MachineFacts): string {
    if (!c.suggest || !c.category) return "";
    const top = lead(c);
    const reasons =
        kind === "failure"
            ? [failureReason(c, facts)]
            : top && signalWhy[top.id]
              ? [signalWhy[top.id] as string]
              : facts
                ? consequences(c, facts)
                : [why[c.category]];
    const check = `${tools} ${checks[c.category] ?? "checks it for free"}`;
    const offer = (reason: string) => {
        if (!facts) return `${check}.`;
        if (reason.includes(machineSummary(facts)))
            return `${check}, with those facts as its local input.`;
        return `${check} (local: ${localInput(facts)}).`;
    };
    for (const reason of reasons) {
        for (const tail of [offer(reason), `${check}.`]) {
            for (const max of [60, 36, 20]) {
                const text = `${hintPrefix} ${detection(c, kind, max)} ${reason} ${tail} ${notOffered}`;
                if (text.length <= maxHintChars) return text;
            }
        }
    }
    const reason = reasons[reasons.length - 1] as string;
    const short = `${hintPrefix} ${reason} ${offer(reason)} ${notOffered}`;
    return short.length <= maxHintChars ? short : `${hintPrefix} ${reason} ${check}. ${notOffered}`;
}
