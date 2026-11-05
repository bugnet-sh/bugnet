/**
 * Cheap facts about the user's computer for hint text: OS, CPU architecture, memory, cores, free
 * disk, whether an NVIDIA driver is present and which credential folders exist in the home folder.
 *
 * Everything comes from Node's os and fs modules, so no other program runs and nothing is read
 * from inside the credential folders. Each fact is null when it cannot be found.
 */
import { existsSync, statfsSync } from "node:fs";
import { cpus, homedir, totalmem } from "node:os";
import { join } from "node:path";

export interface MachineFacts {
    os: "macos" | "linux" | "windows";
    arch: "arm64" | "x64";
    ramGiB: number | null;
    cores: number | null;
    freeDiskGiB: number | null;
    usedDiskGiB: number | null;
    // False on macOS, which has no NVIDIA driver, and null where only a program could tell
    nvidia: boolean | null;
    // Home folders that hold keys or tokens, such as .ssh, that exist on this computer
    secrets: string[];
}

const secretDirs = [".ssh", ".aws", ".config/gcloud", ".kube", ".config/gh", ".docker", ".npmrc"];

const gib = (bytes: number) => Math.round(bytes / 2 ** 30);

function tryOr<T>(f: () => T, fallback: T): T {
    try {
        return f();
    } catch {
        return fallback;
    }
}

export function osName(platform: NodeJS.Platform): MachineFacts["os"] {
    if (platform === "darwin") return "macos";
    if (platform === "win32") return "windows";
    return "linux";
}

export function gatherFacts(
    platform: NodeJS.Platform,
    arch: string,
    dir: string,
    home = tryOr(homedir, ""),
): MachineFacts {
    const os = osName(platform);
    const disk = tryOr(() => statfsSync(dir), null) ?? tryOr(() => statfsSync(home), null);
    const free = disk ? disk.bavail * disk.bsize : null;
    const total = disk ? disk.blocks * disk.bsize : null;
    const nvidia =
        os === "macos"
            ? false
            : os === "linux"
              ? tryOr(() => existsSync("/proc/driver/nvidia/version"), null)
              : null;
    return {
        os,
        arch: arch === "arm64" ? "arm64" : "x64",
        ramGiB: tryOr(() => gib(totalmem()), null),
        cores: tryOr(() => cpus().length || null, null),
        freeDiskGiB: free !== null ? gib(free) : null,
        usedDiskGiB: free !== null && total !== null ? gib(total - free) : null,
        nvidia,
        secrets: home
            ? secretDirs.filter((d) => tryOr(() => existsSync(join(home, d)), false))
            : [],
    };
}
