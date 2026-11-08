// Starts the gateway from a loaded config, for main.ts and for test harnesses that swap one dependency
import type { Fetcher } from "./assess/fetch.ts";
import { createAssessor } from "./assess/index.ts";
import type { Config } from "./config.ts";
import { startTlsFront } from "./front/index.ts";
import type { Log } from "./log.ts";
import { paymentsFor } from "./payments/index.ts";
import { createRouterClient } from "./router.ts";
import { startHttp, version } from "./server.ts";
import { createTracing } from "./trace.ts";
import { watchHostsSeen } from "./x402/index.ts";
import { refreshPayai } from "./x402/search.ts";
import { pollTerms } from "./x402/terms.ts";

export interface StartOverrides {
    // Only a local x402 stack replaces the probe fetcher, to reach its fake seller
    x402Fetch?: Fetcher;
}

export interface RunningGateway {
    stop(): Promise<void>;
}

export async function startGateway(
    config: Config,
    log: Log,
    overrides: StartOverrides = {},
): Promise<RunningGateway> {
    const tracing = createTracing(config, log, { version });
    const deps = {
        config,
        router: createRouterClient(config, tracing ? [tracing.interceptor] : []),
        payments: paymentsFor(config),
        assessor: createAssessor(config),
        log,
        now: Date.now,
        tracing,
        ...(overrides.x402Fetch ? { x402Fetch: overrides.x402Fetch } : {}),
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
    return {
        async stop() {
            for (const s of x402Stops) s();
            await Promise.all([new Promise((r) => http.close(r)), front?.close()]);
            await tracing?.shutdown();
        },
    };
}
