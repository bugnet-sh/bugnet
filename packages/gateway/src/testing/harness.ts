/**
 * Test harness for the gateway's tools.
 *
 * Tests build Deps with testDeps, give it a router from fakeRouter and call the tools through
 * connectTools, the MCP path a real client takes. Only tests import this file, which ESLint
 * enforces for everything else under src.
 */
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
import { silentLog } from "../log.ts";
import { DevPayments } from "../payments/dev.ts";
import type { OrderRequest, OrderResult, Payments } from "../payments/port.ts";
import { errorInfoType, retryInfoType, type RouterClient } from "../router.ts";
import { buildMcpServer } from "../server.ts";
import type { Deps, Register } from "../tools/common.ts";

export const testNow = Date.parse("2026-11-05T12:00:00Z");
export const testHandle = "sbx_abcdefghijklmnopqrstuvwxyz";
export const testOrderSeed = Buffer.alloc(32, 9);

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

export interface TestPayments extends Payments {
    readonly orders: OrderRequest[];
    readonly abandoned: { orderId: string; reason: string }[];
}

// Dev payments that settle at once, recording every order and abandon, unless answer decides
export function testPayments(
    answer?: (req: OrderRequest) => OrderResult | Promise<OrderResult>,
): TestPayments {
    const dev = new DevPayments(testOrderSeed, 10 * 60_000, () => testNow);
    const orders: OrderRequest[] = [];
    const abandoned: { orderId: string; reason: string }[] = [];
    return {
        mode: "dev",
        orders,
        abandoned,
        async order(req) {
            orders.push(req);
            return answer ? answer(req) : dev.order(req);
        },
        async abandon(orderId, reason) {
            abandoned.push({ orderId, reason });
        },
    };
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
