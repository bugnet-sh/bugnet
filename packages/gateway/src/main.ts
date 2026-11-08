import { ConfigError, loadConfig } from "./config.ts";
import { startTlsFront } from "./front/index.ts";
import { jsonLog } from "./log.ts";
import { paymentsFor } from "./payments/index.ts";
import { createRouterClient } from "./router.ts";
import { startHttp, version } from "./server.ts";
import { createTracing } from "./trace.ts";
import { createAssessor } from "./assess/index.ts";
import { watchHostsSeen } from "./x402/index.ts";
import { refreshPayai } from "./x402/search.ts";
import { pollTerms } from "./x402/terms.ts";

function configPath(argv: string[]): string {
    const i = argv.findIndex((a) => a === "-config" || a === "--config");
    const path = i >= 0 ? argv[i + 1] : undefined;
    if (!path) throw new ConfigError("usage: bugnet-gateway -config FILE");
    return path;
}

const log = jsonLog("gateway");
try {
    const config = loadConfig(configPath(process.argv.slice(2)));
    const tracing = createTracing(config, log, { version });
    const deps = {
        config,
        router: createRouterClient(config, tracing ? [tracing.interceptor] : []),
        payments: paymentsFor(config),
        assessor: createAssessor(config),
        log,
        now: Date.now,
        tracing,
    };
    const x402Stops = config.x402.enabled
        ? [pollTerms(deps), watchHostsSeen(config.x402, log), refreshPayai(deps)]
        : [];
    const http = await startHttp(deps);
    const front = config.front.tls_addr ? await startTlsFront(config, http, log) : undefined;
    log.info("listening", {
        addr: config.listen_addr,
        tls: config.front.tls_addr || undefined,
        payments: config.payments.mode,
        router: config.router.url,
        traces: config.telemetry.traces,
    });
    if (config.payments.mode === "http" && config.router.provider_names.length === 0) {
        log.warn("router.provider_names is empty, so router text reaches agents unscrubbed");
    }
    if (front) process.on("SIGHUP", () => front.reload());
    const stop = () => {
        for (const s of x402Stops) s();
        const closing = [new Promise((r) => http.close(r)), front?.close()];
        void Promise.all(closing)
            .then(() => tracing?.shutdown())
            .then(() => process.exit(0));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
} catch (e) {
    log.error(e instanceof ConfigError ? e.message : `start failed: ${(e as Error).message}`);
    process.exit(1);
}
