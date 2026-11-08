import { ConfigError, loadConfig } from "./config.ts";
import { jsonLog } from "./log.ts";
import { startGateway } from "./start.ts";

function configPath(argv: string[]): string {
    const i = argv.findIndex((a) => a === "-config" || a === "--config");
    const path = i >= 0 ? argv[i + 1] : undefined;
    if (!path) throw new ConfigError("usage: bugnet-gateway -config FILE");
    return path;
}

const log = jsonLog("gateway");
try {
    const gateway = await startGateway(loadConfig(configPath(process.argv.slice(2))), log);
    const stop = () => void gateway.stop().then(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
} catch (e) {
    log.error(e instanceof ConfigError ? e.message : `start failed: ${(e as Error).message}`);
    process.exit(1);
}
