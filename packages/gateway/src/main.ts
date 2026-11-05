import { ConfigError, loadConfig, type Config } from "./config.ts";
import { startTlsFront } from "./front/index.ts";
import { jsonLog } from "./log.ts";
import { DevPayments } from "./payments/dev.ts";
import { HttpPayments } from "./payments/http.ts";
import type { Payments } from "./payments/port.ts";
import { createRouterClient } from "./router.ts";
import { startHttp } from "./server.ts";
import { createAssessor } from "./assess/index.ts";

function configPath(argv: string[]): string {
    const i = argv.findIndex((a) => a === "-config" || a === "--config");
    const path = i >= 0 ? argv[i + 1] : undefined;
    if (!path) throw new ConfigError("usage: bugnet-gateway -config FILE");
    return path;
}

function payments(cfg: Config): Payments {
    if (cfg.payments.mode === "dev") {
        return new DevPayments(cfg.secrets.orderPrivateKey as Buffer, cfg.payments.order_token_ttl);
    }
    return new HttpPayments(cfg.payments.url, cfg.secrets.paymentsToken);
}

const log = jsonLog("gateway");
try {
    const config = loadConfig(configPath(process.argv.slice(2)));
    const deps = {
        config,
        router: createRouterClient(config.router.url, config.secrets.internalToken),
        payments: payments(config),
        assessor: createAssessor(config),
        log,
        now: Date.now,
    };
    const http = await startHttp(deps);
    const front = config.front.tls_addr ? await startTlsFront(config, http, log) : undefined;
    log.info("listening", {
        addr: config.listen_addr,
        tls: config.front.tls_addr || undefined,
        payments: config.payments.mode,
        router: config.router.url,
    });
    if (front) process.on("SIGHUP", () => front.reload());
    const stop = () => {
        const closing = [new Promise((r) => http.close(r)), front?.close()];
        void Promise.all(closing).then(() => process.exit(0));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
} catch (e) {
    log.error(e instanceof ConfigError ? e.message : `start failed: ${(e as Error).message}`);
    process.exit(1);
}
