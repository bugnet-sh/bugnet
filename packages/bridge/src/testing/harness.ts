// Drives the real gateway and a fake secrets route that opens boxes with the development key
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { chmod, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { startHttp } from "@bugnet/gateway/server";
import {
    fakeRouter,
    testConfig,
    testDeps,
    testHandle,
    testNow,
    type RouterImpl,
    type TestPayments,
} from "@bugnet/gateway/testing";
import {
    canonicalHeaderNames,
    canonicalHosts,
    type PinnedKey,
    type SealingKey,
} from "@bugnet/seal";
import { developmentKey, developmentPinned, openSealed } from "@bugnet/seal/testing";
import { Client, type ElicitResult } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildBridgeServer, type BridgeDeps, type BridgePay } from "../bridge.ts";
import { stderrLog, type Log } from "../log.ts";
import { PaidOrders, type PublicOrderState } from "../orders.ts";
import type { OrderPayer, PayOutcome, PaymentStep } from "../pay.ts";
import { RemoteGateway, type RemoteTools } from "../remote.ts";
import type { KeychainAnswer, SourceDeps } from "../secrets/sources.ts";

export { testHandle, testNow };

export const testGrant = "bnsp_" + "Q".repeat(54);
export const testBinding = "OBXJLGDEAIOSVKA3MUGPJH7GA3JWFK6REMWM2ZV5VCAXW2GLGUIQ";

async function listen(server: HttpServer): Promise<string> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: HttpServer): Promise<void> {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
}

/* Gateway */

export interface FakeGateway {
    url: string;
    close(): Promise<void>;
}

export const grantRouter: RouterImpl = {
    createSecretPutGrant: () => ({
        putGrant: testGrant,
        expiresAt: timestampFromMs(testNow + 600_000),
    }),
};

export async function fakeGateway(
    impl: RouterImpl = grantRouter,
    over: Parameters<typeof testDeps>[0] = {},
): Promise<FakeGateway> {
    const config = testConfig(
        'listen_addr = "127.0.0.1:0"\n[tools]\nrequire_user_approval = false',
    );
    const http = await startHttp(testDeps({ config, router: fakeRouter(impl), ...over }));
    const port = (http.address() as AddressInfo).port;
    return { url: `http://127.0.0.1:${port}/mcp`, close: () => close(http) };
}

/* Secrets route */

export interface RouteRequest {
    method: string;
    path: string;
    headers: IncomingMessage["headers"];
    body: string;
}

export interface OpenedSecret {
    path: string;
    body: {
        spec: { name: string; hosts: string[]; headerNames: string[]; fetchOnly: boolean };
        value: { keyId: string; box: string };
        idempotencyKey: string;
    };
    payload: Record<string, unknown>;
}

export interface Canned {
    // Only the next request with this method takes it, any request when left out
    method?: "GET" | "PUT";
    // 0 drops the connection without an answer
    status: number;
    error: string;
    retryAfter?: string;
}

export interface FakeSecretsRoute {
    url: string;
    requests: RouteRequest[];
    opened: OpenedSecret[];
    keys: SealingKey[];
    // Answers queued for the next requests, before any check runs
    canned: Canned[];
    // What a PUT that passes every check answers
    outcome: { state: "APPLYING" | "ACTIVE" | "FAILED"; failureReason: string };
    close(): Promise<void>;
}

const devListed: SealingKey = {
    keyId: developmentKey.keyId,
    publicKey: developmentKey.publicKey,
    binding: testBinding,
};

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

// Checks the bridge's PUT as the route and the proxy would, answering 400 with the first problem
async function checkPut(
    path: string,
    raw: string,
    keys: SealingKey[],
): Promise<OpenedSecret | string> {
    let body: OpenedSecret["body"];
    try {
        body = JSON.parse(raw) as OpenedSecret["body"];
    } catch {
        return "bad_json";
    }
    if (!same(Object.keys(body), ["spec", "value", "idempotencyKey"])) return "unknown_field";
    if (!same(Object.keys(body.spec), ["name", "hosts", "headerNames", "fetchOnly"])) {
        return "unknown_field";
    }
    if (!same(Object.keys(body.value), ["keyId", "box"])) return "unknown_field";
    if (path !== `/v1/secrets/${body.spec.name}`) return "name_mismatch";
    if (!same(canonicalHosts(body.spec.hosts), body.spec.hosts)) return "host_refused";
    if (!same(canonicalHeaderNames(body.spec.headerNames), body.spec.headerNames)) {
        return "header_refused";
    }
    const key = keys.find((k) => k.keyId === body.value.keyId);
    if (!key) return "key_unknown";
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(await openSealed(body.value.box)) as Record<string, unknown>;
    } catch {
        return "box_unopened";
    }
    const bound = {
        v: 1,
        binding: key.binding,
        name: body.spec.name,
        hosts: body.spec.hosts,
        headers: body.spec.headerNames,
        fetchOnly: body.spec.fetchOnly,
    };
    const rest: Record<string, unknown> = { ...payload };
    delete rest.value;
    if (!same(rest, bound) || typeof payload.value !== "string") return "binding_mismatch";
    return { path, body, payload };
}

export async function fakeSecretsRoute(grant = testGrant): Promise<FakeSecretsRoute> {
    const state = {
        requests: [] as RouteRequest[],
        opened: [] as OpenedSecret[],
        keys: [devListed],
        canned: [] as Canned[],
        outcome: { state: "ACTIVE", failureReason: "" } as FakeSecretsRoute["outcome"],
    };
    const http = createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (c: string) => (body += c));
        req.on("end", () => {
            void (async () => {
                const path = (req.url ?? "/").split("?")[0] as string;
                state.requests.push({ method: req.method ?? "", path, headers: req.headers, body });
                const answer = (status: number, doc: unknown, headers = {}) =>
                    res
                        .writeHead(status, { "content-type": "application/json", ...headers })
                        .end(JSON.stringify(doc));
                const refuse = (status: number, error: string, headers = {}) =>
                    answer(status, { error, message: `refused, ${error}` }, headers);
                const at = state.canned.findIndex((c) => !c.method || c.method === req.method);
                const next = at >= 0 ? state.canned.splice(at, 1)[0] : undefined;
                if (next?.status === 0) {
                    res.socket?.destroy();
                    return;
                }
                if (next) {
                    const h = next.retryAfter ? { "retry-after": next.retryAfter } : {};
                    return refuse(next.status, next.error, h);
                }
                if (req.headers.origin || req.headers["sec-fetch-site"]) {
                    return refuse(400, "browser_refused");
                }
                if (req.headers.authorization !== `Bearer ${grant}`) {
                    return refuse(401, "put_grant_invalid");
                }
                if (req.method === "GET" && path === "/v1/sealing-key") {
                    return answer(200, { sealingKeys: state.keys });
                }
                if (req.method === "PUT" && path.startsWith("/v1/secrets/")) {
                    const checked = await checkPut(path, body, state.keys);
                    if (typeof checked === "string") return refuse(400, checked);
                    const replaced = state.opened.some(
                        (o) => o.body.spec.name === checked.body.spec.name,
                    );
                    state.opened.push(checked);
                    return answer(200, {
                        secret: {
                            spec: checked.body.spec,
                            updatedAt: "2026-11-05T12:00:01Z",
                            ...state.outcome,
                        },
                        replaced,
                    });
                }
                return refuse(404, "not_found");
            })();
        });
    });
    const url = await listen(http);
    return Object.assign(state, { url, close: () => close(http) });
}

/* Bridge */

export interface LogLines {
    log: Log;
    lines: string[];
}

export function recordingLog(): LogLines {
    const lines: string[] = [];
    return { log: stderrLog((l) => lines.push(l)), lines };
}

export function testSources(over: Partial<SourceDeps> = {}): SourceDeps {
    return {
        env: {},
        cwd: process.cwd(),
        home: process.cwd(),
        platform: "darwin",
        keychain: async (): Promise<KeychainAnswer> => ({ code: 44, stdout: "" }),
        ...over,
    };
}

export type Elicit = (message: string) => ElicitResult | Promise<ElicitResult>;

export interface BridgeSetup {
    gateway?: string;
    remote?: RemoteTools;
    secretsUrl?: string;
    sources?: SourceDeps;
    pinned?: readonly PinnedKey[];
    era?: "legacy" | "modern";
    // Leave out to connect a client that cannot elicit
    elicit?: Elicit;
    deps?: Partial<BridgeDeps>;
}

export interface ConnectedBridge {
    client: Client;
    remote: RemoteTools;
    lines: string[];
    prompts: string[];
    close(): Promise<void>;
}

export async function connectBridge(setup: BridgeSetup): Promise<ConnectedBridge> {
    const { log, lines } = recordingLog();
    const remote =
        setup.remote ??
        new RemoteGateway({
            url: setup.gateway ?? "http://127.0.0.1:9/mcp",
            version: "test",
            connectTimeoutMs: 5000,
            callTimeoutMs: 15_000,
            log,
        });
    if (remote instanceof RemoteGateway) await remote.connect().catch(() => {});
    const deps: BridgeDeps = {
        remote,
        route: { baseUrl: setup.secretsUrl ?? "http://127.0.0.1:9", timeoutMs: 5000 },
        pinned: setup.pinned ?? developmentPinned,
        sources: setup.sources ?? testSources(),
        log,
        now: () => testNow,
        started: new Set(),
        ...setup.deps,
    };
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => buildBridgeServer(deps), { transport: serverSide });
    const prompts: string[] = [];
    const client = new Client(
        { name: "test", version: "0" },
        {
            ...(setup.era === "modern" ? { versionNegotiation: { mode: "auto" as const } } : {}),
            ...(setup.elicit ? { capabilities: { elicitation: { form: {} } } } : {}),
        },
    );
    const elicit = setup.elicit;
    if (elicit) {
        client.setRequestHandler("elicitation/create", async (req) => {
            const message = (req.params as { message: string }).message;
            prompts.push(message);
            return elicit(message);
        });
    }
    await client.connect(clientSide);
    return {
        client,
        remote,
        lines,
        prompts,
        close: async () => {
            await client.close();
            await handle.close();
            if (remote instanceof RemoteGateway) await remote.close();
        },
    };
}

/* Pay */

const fakePay = fileURLToPath(new URL("./fake-pay.ts", import.meta.url));

// Writes an executable named pay that runs the fake pay server, and returns its path
export async function fakePayCommand(dir: string): Promise<string> {
    const path = join(dir, "pay");
    await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${fakePay}" "$@"\n`);
    await chmod(path, 0o755);
    return path;
}

// The pay link origin of the dev payments the gateway tests serve
export const testPayOrigin = "http://127.0.0.1:8787";

export interface PayingPayer extends OrderPayer {
    calls: { step: PaymentStep; maxMicros: number }[];
    // Resolves when pay is first called
    started: Promise<void>;
}

// Pays a dev order as pay would, after a delay and some progress notes, unless told not to
export function payingPayer(
    payments: TestPayments,
    opts: { delayMs?: number; progress?: number; outcome?: PayOutcome; pays?: boolean } = {},
): PayingPayer {
    let begin = () => {};
    const started = new Promise<void>((resolve) => {
        begin = resolve;
    });
    const calls: PayingPayer["calls"] = [];
    return {
        calls,
        started,
        async pay(step, maxMicros, onProgress) {
            calls.push({ step, maxMicros });
            begin();
            await new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
            for (let i = 0; i < (opts.progress ?? 0); i++) onProgress();
            if (opts.pays ?? true) payments.dev.pay(step.orderId);
            return opts.outcome ?? { kind: "paid" };
        },
    };
}

export function devPay(
    payments: TestPayments,
    payer: OrderPayer | null,
    over: Partial<BridgePay> = {},
): BridgePay {
    return {
        origin: testPayOrigin,
        payer,
        orders: new PaidOrders(Date.now),
        status: async (id) => {
            const a = payments.dev.status(id);
            return a.status === 404 ? null : (a.body.state as PublicOrderState);
        },
        sleep: async () => {},
        ...over,
    };
}
