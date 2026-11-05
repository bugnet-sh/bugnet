import { describe, expect, it } from "vitest";
import { classifyFailure } from "./index.ts";

describe("classifyFailure", () => {
    it.each([
        ["python app.py", "AssertionError: Torch not compiled with CUDA enabled", "cuda_missing"],
        [
            "nvidia-smi",
            "zsh: command not found: nvidia-smi\nnvidia-smi: command not found",
            "cuda_missing",
        ],
        [
            "pip install flash-attn",
            "OSError: CUDA_HOME environment variable is not set. Please set it to your CUDA install root.",
            "cuda_missing",
        ],
        [
            "python gen.py",
            "RuntimeError: MPS backend out of memory (MPS allocated: 17.5 GB)",
            "gpu_out_of_memory",
        ],
        [
            "python train.py",
            "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB",
            "gpu_out_of_memory",
        ],
        [
            "docker pull big/image",
            "write /var/lib/docker/tmp/x: no space left on device",
            "disk_full",
        ],
        ["python train.py", "Exit code 137\nKilled", "killed_out_of_memory"],
        ["python embed.py", "zsh: killed     python embed.py", "killed_out_of_memory"],
        [
            "pip install requests",
            "error: externally-managed-environment\n\nThis environment is externally managed",
            "externally_managed",
        ],
        [
            "pip install -r requirements.txt",
            "error: subprocess-exited-with-error\n  Building wheel for xformers (setup.py) ... error\n  ERROR: Failed building wheel for xformers",
            "ml_wheel_build",
        ],
        [
            "pip install torch==2.3.0+cu121",
            "ERROR: Could not find a version that satisfies the requirement torch==2.3.0+cu121 (from versions: 2.2.2, 2.3.0)",
            "ml_wheel_build",
        ],
        ["./tool", "zsh: exec format error: ./tool", "exec_format"],
        [
            "./bin/server",
            "bash: ./bin/server: cannot execute binary file: Exec format error",
            "exec_format",
        ],
        [
            "npm install",
            "npm error code EBADPLATFORM\nnpm error notsup Unsupported platform for x@1.0.0",
            "platform_unsupported",
        ],
        ["./setup.sh", "This tool only supports Linux. Detected: darwin", "platform_unsupported"],
        ["sudo apt-get install foo", "sudo: apt-get: command not found", "platform_unsupported"],
        [
            "docker compose up",
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
            "docker_daemon",
        ],
    ])("recognises the local failure of %s", (command, error, id) => {
        const c = classifyFailure(command, error, { os: "macos" });
        expect(c.suggest).toBe(true);
        expect(c.signals[0]?.id).toBe(id);
        expect(c.subject).toBe(command);
    });

    it.each([
        ["npm test", "FAIL src/app.test.ts\n  adds numbers\n    expect(received).toBe(expected)"],
        [
            "tsc",
            "src/index.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
        ],
        ["cargo build", "error[E0308]: mismatched types\n --> src/main.rs:4:13"],
        ["pytest", "E   ModuleNotFoundError: No module named 'foo'"],
        ["go test ./...", "--- FAIL: TestParse (0.00s)\n    parse_test.go:12: got 1 want 2"],
        ["npm run build", "Error: Cannot find module './config'"],
        ["python app.py", "Traceback (most recent call last):\nKeyError: 'user_id'"],
        ["git push", "error: failed to push some refs to 'origin'"],
        ["make", "main.c:3:1: error: unknown type name 'strng'"],
        ["eslint .", "  12:5  error  'x' is assigned a value but never used  no-unused-vars"],
    ])("ignores the ordinary failure of %s", (command, error) => {
        expect(classifyFailure(command, error, { os: "macos" }).suggest).toBe(false);
    });

    it("returns nothing for empty error output", () => {
        expect(classifyFailure("npm test", "", {})).toMatchObject({ suggest: false, signals: [] });
    });

    it("finds the cause at the end of very long output", () => {
        const error = `${"building...\n".repeat(5_000)}RuntimeError: CUDA out of memory`;
        expect(classifyFailure("python train.py", error, {}).signals[0]?.id).toBe(
            "gpu_out_of_memory",
        );
    });
});
