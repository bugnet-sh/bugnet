import { createHash } from "node:crypto";

export interface Log {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
}

// JSON lines on stderr, since stdout carries the MCP stdio transport
export function stderrLog(write: (line: string) => void = (l) => process.stderr.write(l)): Log {
    const line = (level: string, msg: string, fields?: Record<string, unknown>) =>
        write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + "\n");
    return {
        info: (m, f) => line("info", m, f),
        warn: (m, f) => line("warn", m, f),
        error: (m, f) => line("error", m, f),
    };
}

export const silentLog: Log = { info() {}, warn() {}, error() {} };

// Logs carry a short hash, since the handle itself is the sandbox's only credential
export function handleTag(handle: string): string {
    return `h:${createHash("sha256").update(handle).digest("hex").slice(0, 12)}`;
}
