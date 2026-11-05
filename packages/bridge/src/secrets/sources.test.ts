import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SourceError, checkSource, readSource, type Source, type SourceDeps } from "./sources.ts";

let root = "";
let deps: SourceDeps;
const signal = new AbortController().signal;

async function read(source: Source, over: Partial<SourceDeps> = {}): Promise<string> {
    const d = { ...deps, ...over };
    return readSource(await checkSource(source, d), d, signal);
}

beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "bugnet-sources-")));
    await mkdir(join(root, "project"));
    await mkdir(join(root, "home"));
    await mkdir(join(root, "elsewhere"));
    await writeFile(join(root, "project", ".env"), "HF_TOKEN=hf_project\nEMPTY=\n");
    await writeFile(join(root, "home", "keys.env"), "GH_TOKEN='ghp_home'\n");
    await writeFile(join(root, "elsewhere", ".env"), "HF_TOKEN=hf_outside\n");
    await writeFile(join(root, "project", "big.env"), "X=" + "a".repeat(70 * 1024) + "\n");
    await symlink(join(root, "elsewhere", ".env"), join(root, "project", "link.env"));
    deps = {
        env: { HF_TOKEN: "hf_env", BLANK: "" },
        cwd: join(root, "project"),
        home: join(root, "home"),
        platform: "darwin",
        keychain: async (args) =>
            args.includes("known") ? { code: 0, stdout: "kc_value\n" } : { code: 44, stdout: "" },
    };
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("environment sources", () => {
    it("reads a set variable and names an unset or empty one", async () => {
        expect(await read({ type: "env", variable: "HF_TOKEN" })).toBe("hf_env");
        await expect(read({ type: "env", variable: "NOPE" })).rejects.toThrow(
            "NOPE is not set in the environment the bridge runs in",
        );
        await expect(read({ type: "env", variable: "BLANK" })).rejects.toThrow("BLANK is empty");
    });

    it("refuses a value over 64 KiB", async () => {
        const env = { BIG: "x".repeat(64 * 1024 + 1) };
        await expect(read({ type: "env", variable: "BIG" }, { env })).rejects.toThrow(
            "BIG is over 64 KiB",
        );
    });
});

describe(".env sources", () => {
    it("reads a key from the working folder and from home", async () => {
        expect(await read({ type: "dotenv", path: ".env", key: "HF_TOKEN" })).toBe("hf_project");
        const inHome = join(root, "home", "keys.env");
        expect(await read({ type: "dotenv", path: inHome, key: "GH_TOKEN" })).toBe("ghp_home");
    });

    it("labels the source with the file's real path", async () => {
        const c = await checkSource({ type: "dotenv", path: "./.env", key: "HF_TOKEN" }, deps);
        expect(c.label).toBe(`HF_TOKEN in ${join(root, "project", ".env")}`);
    });

    it("refuses a file outside both folders, also through a symlink", async () => {
        const outside = join(root, "elsewhere", ".env");
        await expect(
            checkSource({ type: "dotenv", path: outside, key: "HF_TOKEN" }, deps),
        ).rejects.toThrow(/is outside the working folder and the home folder/);
        await expect(
            checkSource({ type: "dotenv", path: "link.env", key: "HF_TOKEN" }, deps),
        ).rejects.toThrow(SourceError);
        await expect(
            checkSource({ type: "dotenv", path: "../elsewhere/.env", key: "HF_TOKEN" }, deps),
        ).rejects.toThrow(SourceError);
    });

    it("names a missing file, a missing key, a directory and a file over 1 MiB", async () => {
        await expect(read({ type: "dotenv", path: "none.env", key: "K" })).rejects.toThrow(
            "no file at none.env",
        );
        await expect(read({ type: "dotenv", path: ".env", key: "OTHER" })).rejects.toThrow(
            /has no OTHER$/,
        );
        await expect(read({ type: "dotenv", path: ".env", key: "EMPTY" })).rejects.toThrow(
            /EMPTY in .* is empty/,
        );
        await expect(read({ type: "dotenv", path: ".", key: "K" })).rejects.toThrow(
            "is not a regular file",
        );
        await expect(read({ type: "dotenv", path: "big.env", key: "X" })).rejects.toThrow(
            "over 64 KiB",
        );
    });
});

describe("keychain sources", () => {
    it("runs security find-generic-password and drops its newline", async () => {
        const seen: string[][] = [];
        const keychain: SourceDeps["keychain"] = async (args) => {
            seen.push(args);
            return { code: 0, stdout: "kc_value\n" };
        };
        const source = { type: "keychain" as const, service: "known", account: "me" };
        expect(await read(source, { keychain })).toBe("kc_value");
        expect(seen).toEqual([["find-generic-password", "-w", "-s", "known", "-a", "me"]]);
    });

    it("names a missing item and refuses off macOS", async () => {
        await expect(read({ type: "keychain", service: "unknown" })).rejects.toThrow(
            "no keychain item matches macOS keychain item unknown",
        );
        await expect(
            checkSource({ type: "keychain", service: "known" }, { ...deps, platform: "linux" }),
        ).rejects.toThrow("keychain sources work on macOS only");
    });

    it("never repeats what security printed when it fails", async () => {
        const keychain: SourceDeps["keychain"] = async () => ({ code: 51, stdout: "" });
        await expect(read({ type: "keychain", service: "known" }, { keychain })).rejects.toThrow(
            "the keychain did not give macOS keychain item known",
        );
    });
});
