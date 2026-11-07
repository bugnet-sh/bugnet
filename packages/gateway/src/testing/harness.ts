// Tests reach the tools through connectTools, the MCP path a real client takes
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
    Code,
    ConnectError,
    createClient,
    createRouterTransport,
    type ServiceImpl,
} from "@connectrpc/connect";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { Assessor } from "../assess/assessor.ts";
import { createSafeFetcher, type Fetcher, type RawFetch } from "../assess/fetch.ts";
import { parseSettings, type Config } from "../config.ts";
import {
    PackageOptionSchema,
    PlacementSchema,
    PlacementState,
    ResourcesSchema,
    SandboxRouterService,
    type PackageOption,
    type Placement,
    type Resources,
} from "../gen/bugnet/router/v1/router_pb.ts";
import { silentLog, type Log } from "../log.ts";
import { DevPayments, devTerms } from "../payments/dev.ts";
export { DevPayments, type DevPaymentsOptions } from "../payments/dev.ts";
import type { OrderClaims } from "../payments/ordertoken.ts";
import type {
    OrderRequest,
    OrderResult,
    OrderTerms,
    Payments,
    X402AccountAnswer,
    X402ConfigureResult,
    X402SellerStats,
    X402Setup,
    X402Terms,
} from "../payments/port.ts";
import { errorInfoType, retryInfoType, type RouterClient } from "../router.ts";
import { buildMcpServer } from "../server.ts";
import type { Deps, Register } from "../tools/common.ts";
import { base58Encode } from "../x402/lines.ts";

export const testNow = Date.parse("2026-11-05T12:00:00Z");
export const testHandle = "sbx_abcdefghijklmnopqrstuvwxyz";
export const testOrderSeed = Buffer.alloc(32, 9);
export const testPayTo = base58Encode(createHash("sha256").update("bugnet test payee").digest());
export const otherPayTo = base58Encode(createHash("sha256").update("bugnet other payee").digest());

/* Router */

export type RouterImpl = Partial<ServiceImpl<typeof SandboxRouterService>>;

// Methods left out of impl answer Unimplemented, as a router without that task answers
export function fakeRouter(impl: RouterImpl = {}): RouterClient {
    const full: Record<string, unknown> = {};
    for (const m of SandboxRouterService.methods) {
        const given = (impl as Record<string, unknown>)[m.localName];
        full[m.localName] =
            given ??
            (() => {
                throw new ConnectError(`${m.name} is not implemented`, Code.Unimplemented);
            });
    }
    const transport = createRouterTransport((router) => {
        router.service(SandboxRouterService, full as RouterImpl);
    });
    return createClient(SandboxRouterService, transport);
}

export function errorInfoDetail(reason: string): { type: string; value: Uint8Array } {
    const value = new BinaryWriter()
        .tag(1, WireType.LengthDelimited)
        .string(reason)
        .tag(2, WireType.LengthDelimited)
        .string("bugnet.router")
        .finish();
    return { type: errorInfoType, value };
}

// Zero fields are left out, as the Go router's marshaller does
export function retryInfoDetail(delayMs: number): { type: string; value: Uint8Array } {
    const seconds = Math.floor(delayMs / 1000);
    const nanos = (delayMs % 1000) * 1e6;
    const w = new BinaryWriter().tag(1, WireType.LengthDelimited).fork();
    if (seconds) w.tag(1, WireType.Varint).int64(seconds);
    if (nanos) w.tag(2, WireType.Varint).int32(nanos);
    return { type: retryInfoType, value: w.join().finish() };
}

export interface RouterErrorOptions {
    retryAfterMs?: number;
    message?: string;
}

// A refusal as the router sends it, with an ErrorInfo reason and an optional RetryInfo delay
export function routerError(
    code: Code,
    reason?: string,
    opts: RouterErrorOptions = {},
): ConnectError {
    const err = new ConnectError(opts.message ?? "refused", code);
    if (reason) err.details.push(errorInfoDetail(reason));
    if (opts.retryAfterMs !== undefined) err.details.push(retryInfoDetail(opts.retryAfterMs));
    return err;
}

type Fields<T> = Partial<Omit<T, "$typeName" | "$unknown">>;

export function placement(
    state: PlacementState = PlacementState.READY,
    init: Fields<Placement> = {},
): Placement {
    return create(PlacementSchema, {
        placementId: "p1",
        state,
        packageId: "small-10m",
        createdAt: timestampFromMs(testNow - 60_000),
        ...(state !== PlacementState.PLACING ? { readyAt: timestampFromMs(testNow - 30_000) } : {}),
        deadline: timestampFromMs(testNow + 10 * 60_000),
        ...init,
    });
}

export function resources(vcpu: number, memoryMib: number, diskGib = 10, gpuCount = 0): Resources {
    return create(ResourcesSchema, { vcpu, memoryMib, diskGib, gpuCount });
}

export function packageOption(
    packageId: string,
    priceMicros: bigint,
    init: Fields<PackageOption> = {},
): PackageOption {
    return create(PackageOptionSchema, {
        packageId,
        priceMicros,
        minutes: 10,
        available: true,
        resources: resources(2, 2048),
        ...init,
    });
}

/* Deps */

export function testConfig(toml = ""): Config {
    return {
        ...parseSettings(toml, "test settings"),
        secrets: {
            internalToken: "t".repeat(32),
            quoteKey: Buffer.alloc(32, 7),
            orderPrivateKey: testOrderSeed,
            paymentsToken: "",
            githubToken: "",
            huggingfaceToken: "",
        },
    };
}

export interface TestX402Answers {
    terms?: () => Promise<X402Terms>;
    account?: (handleSha256: string) => Promise<X402AccountAnswer>;
    configure?: (
        handleSha256: string,
        setup: X402Setup,
        requestId: string,
    ) => Promise<X402ConfigureResult>;
    sellers?: (hosts: string[]) => Promise<Record<string, X402SellerStats>>;
}

export interface TestPaymentsOptions {
    requirePayment?: boolean;
    terms?: Partial<X402Terms>;
    // Each left out answers from dev
    x402?: TestX402Answers;
}

export interface TestPayments extends Payments {
    readonly orders: OrderRequest[];
    readonly abandoned: { orderId: string; reason: string }[];
    readonly configures: { handleSha256: string; setup: X402Setup; requestId: string }[];
    readonly dev: DevPayments;
}

// Standard base64 of the JSON, the PAYMENT-REQUIRED header a seller sends
export function paymentRequiredHeader(required: unknown): string {
    return Buffer.from(JSON.stringify(required), "utf8").toString("base64");
}

export function testTerms(patch: Partial<X402Terms> = {}): X402Terms {
    return { ...devTerms, ...patch };
}

// Dev payments that settle at once, recording every order and abandon, unless answer decides
export function testPayments(
    answer?: (req: OrderRequest) => OrderResult | Promise<OrderResult>,
    opts: TestPaymentsOptions = {},
): TestPayments {
    const dev = new DevPayments(testOrderSeed, 10 * 60_000, () => testNow, {
        requirePayment: opts.requirePayment,
        payBaseUrl: "http://127.0.0.1:8787",
        ...(opts.terms ? { terms: opts.terms } : {}),
    });
    const orders: OrderRequest[] = [];
    const abandoned: { orderId: string; reason: string }[] = [];
    const configures: TestPayments["configures"] = [];
    const x402 = opts.x402 ?? {};
    return {
        mode: "dev",
        orders,
        abandoned,
        configures,
        dev,
        x402Terms: (signal) => (x402.terms ? x402.terms() : dev.x402Terms(signal)),
        x402Account: (h, signal) => (x402.account ? x402.account(h) : dev.x402Account(h, signal)),
        async x402Configure(handleSha256, setup, requestId, signal) {
            configures.push({ handleSha256, setup, requestId });
            return x402.configure
                ? x402.configure(handleSha256, setup, requestId)
                : dev.x402Configure(handleSha256, setup, requestId, signal);
        },
        x402Sellers: (hosts, signal) =>
            x402.sellers ? x402.sellers(hosts) : dev.x402Sellers(hosts, signal),
        async order(req) {
            orders.push(req);
            return answer ? answer(req) : dev.order(req);
        },
        async abandon(orderId, reason) {
            abandoned.push({ orderId, reason });
        },
    };
}

// A dev order made on the require-mode ledger, paid unless paid is false
export async function devOrder(
    p: TestPayments,
    terms: OrderTerms,
    opts: { paid?: boolean } = {},
): Promise<{ orderId: string; claim: string }> {
    if (!p.dev.requiresPayment) {
        throw new Error("devOrder needs testPayments(undefined, { requirePayment: true })");
    }
    const r = await p.dev.order(terms);
    if (r.status !== "payment_required" || !r.claim) {
        throw new Error("devOrder expected a payment step with a claim");
    }
    if (opts.paid !== false) p.dev.pay(r.orderId);
    return { orderId: r.orderId, claim: r.claim };
}

// JSON.parse of packages/gateway/test/fixtures/x402/<name>
export function x402Fixture(name: string): unknown {
    return JSON.parse(
        readFileSync(new URL(`../../test/fixtures/x402/${name}`, import.meta.url), "utf8"),
    );
}

export function recordingLog(): { log: Log; lines: string[] } {
    const lines: string[] = [];
    const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
        lines.push(JSON.stringify({ level, msg, ...fields }));
    };
    return { log: { info: at("info"), warn: at("warn"), error: at("error") }, lines };
}

const noAssessor: Assessor = {
    assess: () => Promise.reject(new Error("this test gave no assessor")),
};

export function testDeps(overrides: Partial<Deps> = {}): Deps {
    return {
        config: testConfig(),
        router: fakeRouter(),
        payments: testPayments(),
        assessor: noAssessor,
        log: silentLog,
        now: () => testNow,
        ...overrides,
    };
}

/* MCP */

export async function connectTools(deps: Deps, extra: Register[] = []): Promise<Client> {
    const server = buildMcpServer(deps, extra);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    return client;
}

export interface ToolResult<S> {
    isError: boolean;
    // The content blocks' text joined by newlines
    text: string;
    // What Claude Code shows the model
    structured: S;
    meta: Record<string, unknown> | undefined;
}

export interface CallOptions {
    toolUseId?: string;
    meta?: Record<string, unknown>;
}

export async function callTool<S = Record<string, unknown>>(
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
    opts: CallOptions = {},
): Promise<ToolResult<S>> {
    const meta = {
        ...opts.meta,
        ...(opts.toolUseId ? { "claudecode/toolUseId": opts.toolUseId } : {}),
    };
    const r = await client.callTool({
        name,
        arguments: args,
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    });
    const blocks = (r.content ?? []) as { type: string; text?: string }[];
    return {
        isError: r.isError === true,
        text: blocks.map((c) => c.text ?? "").join("\n"),
        structured: (r.structuredContent ?? {}) as S,
        meta: r._meta,
    };
}

// The claims of a v1 order token, read without checking its signature
export function tokenClaims(token: string): OrderClaims {
    const segment = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as OrderClaims;
}

/* x402 fetcher */

export type FakeAnswer =
    { status: number; headers?: Record<string, string>; body?: unknown; delayMs?: number } | "hang";

export interface FakeX402Fetch {
    readonly fetch: Fetcher;
    readonly calls: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: string | undefined;
    }[];
    maxInFlight(): number;
}

// Answers by exact URL, an unknown URL is a 404, and a hang or delay ends early on abort
export function fakeX402Fetch(routes: Record<string, FakeAnswer>): FakeX402Fetch {
    const calls: FakeX402Fetch["calls"] = [];
    let inFlight = 0;
    let most = 0;
    const wait = (ms: number | null, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
            if (signal.aborted) return reject(signal.reason);
            const timer = ms === null ? null : setTimeout(done, ms);
            function done() {
                signal.removeEventListener("abort", stop);
                resolve();
            }
            function stop() {
                if (timer !== null) clearTimeout(timer);
                reject(signal.reason);
            }
            signal.addEventListener("abort", stop, { once: true });
        });
    const rawFetch: RawFetch = async (url, init) => {
        calls.push({
            url,
            method: init.method,
            headers: init.headers,
            body: init.body,
        });
        inFlight++;
        most = Math.max(most, inFlight);
        try {
            const answer = routes[url];
            if (answer === "hang") return await wait(null, init.signal).then(() => new Response());
            if (answer === undefined) return new Response("not found", { status: 404 });
            if (answer.delayMs) await wait(answer.delayMs, init.signal);
            const body =
                answer.body === undefined
                    ? null
                    : typeof answer.body === "string"
                      ? answer.body
                      : JSON.stringify(answer.body);
            return new Response(body, { status: answer.status, headers: answer.headers });
        } finally {
            inFlight--;
        }
    };
    return {
        fetch: createSafeFetcher({ timeoutMs: 30_000, rawFetch }),
        calls,
        maxInFlight: () => most,
    };
}
