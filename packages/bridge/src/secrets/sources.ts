import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { maxValueBytes, valueBytes } from "@bugnet/seal";
import { parseDotenv } from "./dotenv.ts";

export type Source =
    | { type: "env"; variable: string }
    | { type: "dotenv"; path: string; key: string }
    | { type: "keychain"; service: string; account?: string | undefined };

// Messages name the source, never the value, which reaches no result, log or error
export class SourceError extends Error {}

export interface KeychainAnswer {
    code: number;
    stdout: string;
}

export interface SourceDeps {
    env: NodeJS.ProcessEnv;
    cwd: string;
    home: string;
    platform: NodeJS.Platform;
    keychain: (args: string[], signal: AbortSignal) => Promise<KeychainAnswer>;
}

const maxDotenvBytes = 1024 * 1024;
const securityTool = "/usr/bin/security";
// security(1) exits with errSecItemNotFound's low byte when nothing matches
const itemNotFound = 44;

export function runSecurity(args: string[], signal: AbortSignal): Promise<KeychainAnswer> {
    return new Promise((done) => {
        execFile(
            securityTool,
            args,
            { encoding: "utf8", maxBuffer: 4 * maxValueBytes, timeout: 120_000, signal },
            (err, stdout) => {
                const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
                done({ code, stdout: err ? "" : stdout });
            },
        );
    });
}

function inside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
}

async function realOrNull(path: string): Promise<string | null> {
    try {
        return await realpath(path);
    } catch {
        return null;
    }
}

// Symlinks are followed first, so a link in the project cannot reach a file outside both roots
async function dotenvPath(path: string, deps: SourceDeps): Promise<string> {
    const real = await realOrNull(resolve(deps.cwd, path));
    if (!real) throw new SourceError(`no file at ${path}`);
    const roots = [await realOrNull(deps.cwd), await realOrNull(deps.home)];
    if (!roots.some((r) => r !== null && inside(r, real))) {
        throw new SourceError(
            `${path} is outside the working folder and the home folder, so the bridge does not ` +
                "read it",
        );
    }
    const s = await stat(real);
    if (!s.isFile()) throw new SourceError(`${path} is not a regular file`);
    if (s.size > maxDotenvBytes) throw new SourceError(`${path} is over 1 MiB`);
    return real;
}

export interface CheckedSource {
    source: Source;
    // How the confirmation prompt names the source, with a .env path made absolute
    label: string;
}

// Checks what can be checked without reading the value, before the user is asked
export async function checkSource(source: Source, deps: SourceDeps): Promise<CheckedSource> {
    switch (source.type) {
        case "env":
            return { source, label: `environment variable ${source.variable}` };
        case "dotenv": {
            const real = await dotenvPath(source.path, deps);
            return { source: { ...source, path: real }, label: `${source.key} in ${real}` };
        }
        case "keychain": {
            if (deps.platform !== "darwin") {
                throw new SourceError("keychain sources work on macOS only");
            }
            const account = source.account ? `, account ${source.account}` : "";
            return { source, label: `macOS keychain item ${source.service}${account}` };
        }
    }
}

function checkedValue(value: string | undefined, where: string): string {
    if (value === undefined || value.length === 0) throw new SourceError(`${where} is empty`);
    if (valueBytes(value) > maxValueBytes) throw new SourceError(`${where} is over 64 KiB`);
    return value;
}

export async function readSource(
    checked: CheckedSource,
    deps: SourceDeps,
    signal: AbortSignal,
): Promise<string> {
    const source = checked.source;
    switch (source.type) {
        case "env": {
            const value = deps.env[source.variable];
            if (value === undefined) {
                throw new SourceError(
                    `${source.variable} is not set in the environment the bridge runs in`,
                );
            }
            return checkedValue(value, source.variable);
        }
        case "dotenv": {
            const real = await dotenvPath(source.path, deps);
            const value = parseDotenv(await readFile(real, "utf8")).get(source.key);
            if (value === undefined) throw new SourceError(`${source.path} has no ${source.key}`);
            return checkedValue(value, `${source.key} in ${source.path}`);
        }
        case "keychain": {
            const args = ["find-generic-password", "-w", "-s", source.service];
            if (source.account) args.push("-a", source.account);
            const r = await deps.keychain(args, signal);
            if (r.code === itemNotFound) {
                throw new SourceError(`no keychain item matches ${checked.label}`);
            }
            if (r.code !== 0) {
                throw new SourceError(`the keychain did not give ${checked.label}`);
            }
            return checkedValue(r.stdout.replace(/\n$/, ""), checked.label);
        }
    }
}
