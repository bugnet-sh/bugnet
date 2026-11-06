import { homedir } from "node:os";
import { pinnedKeys } from "@bugnet/seal";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildBridgeServer, version } from "./bridge.ts";
import { ConfigError, loadCommand, usage } from "./config.ts";
import { stderrLog } from "./log.ts";
import { RemoteGateway } from "./remote.ts";
import { runSecurity } from "./secrets/sources.ts";

async function main(): Promise<number> {
    let command;
    try {
        command = loadCommand(process.argv.slice(2));
    } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        process.stderr.write(`bugnet-mcp: ${e.message}\n\n${usage}`);
        return 2;
    }
    if (command.kind === "help") {
        process.stdout.write(usage);
        return 0;
    }
    if (command.kind === "version") {
        process.stdout.write(`${version}\n`);
        return 0;
    }
    const s = command.settings;
    const log = stderrLog();
    const remote = new RemoteGateway({
        url: s.gateway_url,
        version,
        connectTimeoutMs: s.connect_timeout,
        callTimeoutMs: s.call_timeout,
        log,
    });
    const started = new Set<string>();
    // The instructions come from the gateway, so the bridge connects before it answers anything
    await remote.connect().catch((e: unknown) => {
        log.warn("gateway not reachable yet", { gateway: s.gateway_url, err: String(e) });
    });
    serveStdio(
        () =>
            buildBridgeServer({
                remote,
                route: { baseUrl: s.secrets_url, timeoutMs: s.secrets_timeout },
                pinned: pinnedKeys,
                sources: {
                    env: process.env,
                    cwd: process.cwd(),
                    home: homedir(),
                    platform: process.platform,
                    keychain: runSecurity,
                },
                log,
                now: Date.now,
                started,
            }),
        { onerror: (e) => log.warn("mcp error", { err: e.message }) },
    );
    log.info("bridge serving", { gateway: s.gateway_url, version });
    return -1;
}

main().then(
    (code) => {
        if (code >= 0) process.exitCode = code;
    },
    (e: unknown) => {
        process.stderr.write(`bugnet-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
    },
);
