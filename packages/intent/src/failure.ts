/**
 * Signatures of a local environment that cannot run what was asked, read from a failed command.
 *
 * Only the machine's own limits count here, such as a missing NVIDIA driver, a full disk or the
 * wrong CPU architecture. A failing test or a compile error in the user's code matches none.
 */
import { clip, norm, quoteSafe } from "./normalize.ts";
import { finish, hit, none, type Hit } from "./score.ts";
import type { Category, Classification, SessionContext } from "./types.ts";

interface Signature {
    id: string;
    category: Category;
    re: RegExp;
}

const heavyWheel = String.raw`flash[-_]?attn|xformers|bitsandbytes|deepspeed|triton|auto[-_]?gptq|llama[-_]cpp[-_]python|mamba[-_]ssm|causal[-_]conv1d|vllm|apex|tensorrt|pycuda|cupy|dlib|insightface|tts|pyaudio|sentencepiece|tokenizers|torch\w{0,12}|onnxruntime[\w-]{0,12}|exllamav2|detectron2`;

export const signatures: Signature[] = [
    {
        id: "cuda_missing",
        category: "environment",
        re: /torch not compiled with cuda enabled|no cuda gpus are available|found no nvidia driver|nvidia-smi: (?:command )?not found|cuda is not available|cuda_home environment variable is not set|no cuda runtime is found|libcuda\.so[^\n]{0,60}(?:no such file|cannot open|not found)|could not load (?:dynamic )?library '?libcud\w*|nvcc: (?:command )?not found|cuda driver version is insufficient|nvidia driver on your system is too old|cuda error: no kernel image|requires (?:an? )?(?:nvidia gpu|cuda)|torch\.cuda\.is_available\(\)[^\n]{0,20}false|no nvidia gpu (?:found|detected)/,
    },
    {
        id: "gpu_out_of_memory",
        category: "local_ai_model",
        re: /cuda out of memory|outofmemoryerror: cuda|mps backend out of memory|cublas_status_alloc_failed|cudnn_status_alloc_failed|not enough memory to allocate[^\n]{0,40}(?:gpu|mps|vram)/,
    },
    {
        id: "disk_full",
        category: "heavy_compute",
        re: /no space left on device|errno 28|not enough (?:free )?disk space|insufficient (?:free )?(?:disk )?space|disk quota exceeded/,
    },
    {
        id: "killed_out_of_memory",
        category: "heavy_compute",
        re: /(?:^|\n)\s*killed(?::\s*9)?\s*(?:\n|$)|\b(?:zsh|bash|sh): (?:line \d+: )?(?:\d+ )?killed\b|\b\d+ killed\s|exit code 137\b|killed by signal 9|signal: killed|\bsigkill\b|\bout of memory\b|cannot allocate memory|memoryerror|oom[- ]?kill\w*|std::bad_alloc|javascript heap out of memory/,
    },
    {
        id: "externally_managed",
        category: "environment",
        re: /externally-managed-environment/,
    },
    {
        id: "ml_wheel_build",
        category: "environment",
        re: new RegExp(
            String.raw`(?:failed (?:building wheel|to build)|could not build wheels|building wheel for [\w.-]{1,80} \(pyproject\.toml\) did not run successfully|error: subprocess-exited-with-error)[^\n]{0,120}?(?:${heavyWheel})|(?<![\w-])(?:${heavyWheel})[^\n]{0,60}?(?:failed (?:building wheel|to build))|could not find a version that satisfies the requirement (?:torch|torchvision|torchaudio)[^\s]{0,40}\+cu\d+`,
        ),
    },
    {
        id: "exec_format",
        category: "environment",
        re: /exec format error|bad cpu type in executable|cannot execute binary file|illegal instruction|mach-o, but wrong architecture|incompatible architecture|have 'arm64', need 'x86_64'|have 'x86_64', need 'arm64e?'/,
    },
    {
        id: "platform_unsupported",
        category: "environment",
        // npm warns about optional packages for other platforms during ordinary installs
        re: /(?:^|\n)(?!npm warn)[^\n]*?(?:unsupported platform|ebadplatform)|platform (?:is )?not supported|not supported on (?:this platform|darwin|macos|mac os|windows|win32|arm64)|only (?:supported|works|runs|available) on linux|only supports? linux|supports? only linux|linux[- ]only|requires linux|is not a supported wheel on this platform|does not match the detected host platform|(?:apt-get|apt|systemctl|modprobe|dpkg|yum|dnf|lsmod|ldconfig): command not found|is not supported on this (?:os|operating system)/,
    },
    {
        id: "docker_daemon",
        category: "environment",
        re: /cannot connect to the docker daemon|is the docker daemon running|docker: command not found|docker daemon is not running|failed to connect to the docker api|error during connect:[^\n]{0,80}docker/,
    },
];

// Long error output keeps its start and end, where tools print the cause
function excerpt(error: string): string {
    return norm(
        clip(error.length > 12_000 ? `${error.slice(0, 4_000)}\n${error.slice(-8_000)}` : error),
    );
}

export function classifyFailure(
    command: string,
    error: string,
    _ctx: SessionContext = {},
): Classification {
    const text = excerpt(error);
    if (text === "") return none;
    const hits: Hit[] = [];
    const subject = quoteSafe(command.split("\n")[0] ?? "", 50) || "a local command";
    for (const s of signatures) {
        const m = s.re.exec(text);
        if (m) hits.push(hit(s.id, s.category, 6, m[0], subject));
    }
    if (hits.length === 0) return none;
    return finish(hits.slice(0, 1).concat(hits.slice(1).map((h) => ({ ...h, weight: 1 }))));
}
