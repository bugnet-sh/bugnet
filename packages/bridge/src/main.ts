import { homedir } from "node:os";
import { join } from "node:path";
import { pinnedKeys } from "@bugnet/seal";
import type { KeyPairSigner } from "@solana/kit";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildBridgeServer, version } from "./bridge.ts";
import { type Command, ConfigError, loadCommand, usage } from "./config.ts";
import { bugnetDir, loadWallet, runKeyCommand } from "./keyfile.ts";
import { KeyPayer, routeAllowances } from "./keypay.ts";
import { type Log, stderrLog } from "./log.ts";
import { orderStatus, PaidOrders } from "./orders.ts";
import { type OrderPayer, PayCli } from "./pay.ts";
import { RemoteGateway } from "./remote.ts";
import { runSecurity } from "./secrets/sources.ts";
import { SpendLedger } from "./spend.ts";

type Serve = Extract<Command, { kind: "serve" }>;

// The pay CLI by default; the wallet file only when the fixed settings file says pay_signer = "key",
// and then for x402 allowances only when it also says key_pays_allowances = true
function choosePayer(command: Serve, log: Log): OrderPayer | null {
    const s = command.settings;
    const cli = s.pay_command
        ? new PayCli({ command: s.pay_command, origin: s.pay_origin, env: process.env, log })
        : null;
    if (command.signer.paySigner !== "key") return cli;
    const home = process.env.HOME;
    let wallet: Promise<KeyPairSigner> | undefined;
    const key = new KeyPayer({
        origin: s.pay_origin,
        settings: command.signer,
        signer: () => {
            wallet ??= loadWallet(home, process.cwd()).catch((e: unknown) => {
                wallet = undefined;
                throw e;
            });
            return wallet;
        },
        ledger: new SpendLedger({ path: join(bugnetDir(home), "spend.json") }),
        log,
    });
    return routeAllowances(key, cli, command.signer.keyPaysAllowances);
}

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
    if (command.kind === "key-new" || command.kind === "key-import") {
        const out = await runKeyCommand(command, process.env.HOME, process.cwd());
        process.stdout.write(out.stdout);
        process.stderr.write(out.stderr);
        return out.code;
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
    const payer = choosePayer(command, log);
    // Outlives one server, so a paid order is still held when the client reconnects
    const orders = new PaidOrders(Date.now);
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
                pay: {
                    origin: s.pay_origin,
                    payer,
                    pins: {
                        payTo: command.signer.payTo,
                        allowancePayTo: command.signer.allowancePayTo,
                    },
                    orders,
                    status: (id, signal) => orderStatus(s.pay_origin, id, signal),
                },
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
