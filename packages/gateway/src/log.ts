export interface Log {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
}

// JSON lines on stderr, so stdout stays free for the bridge's stdio transport
export function jsonLog(service: string): Log {
    const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
        process.stderr.write(
            JSON.stringify({ t: new Date().toISOString(), level, service, msg, ...fields }) + "\n",
        );
    };
    return {
        info: (m, f) => write("info", m, f),
        warn: (m, f) => write("warn", m, f),
        error: (m, f) => write("error", m, f),
    };
}

export const silentLog: Log = { info() {}, warn() {}, error() {} };
