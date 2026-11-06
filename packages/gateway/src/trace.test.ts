import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { afterEach, describe, expect, it } from "vitest";
import { checkSettings, parseSettings, readSecrets, type Config } from "./config.ts";
import {
    GetPlacementResponseSchema,
    PlacementState,
    WatchJobResponseSchema,
    type CreatePlacementRequest,
} from "./gen/bugnet/router/v1/router_pb.ts";
import type { Log } from "./log.ts";
import { createRouterClient } from "./router.ts";
import {
    callTool,
    connectTools,
    packageOption,
    placement,
    routerError,
    testConfig,
    testDeps,
    testHandle,
    type RouterImpl,
} from "./testing/harness.ts";
import { startOtlpReceiver, type ExportedSpan, type OtlpReceiver } from "./testing/otlp.ts";
import { startRouterServer, type TestRouterServer } from "./testing/router-server.ts";
import {
    createTracing,
    handleHashAttr,
    orderTrace,
    orderTraceLabel,
    ratioSampled,
    traceparent,
    type Tracing,
} from "./trace.ts";

// data-plane 20.2.1, pinned in the router's tests too
const vectors = [
    {
        handle: "sbx_incf5d4j2g46mypgm6wajtyic5",
        traceId: "55a4dee648a7a4d0a70cd0a8b24c672f",
        spanId: "69923b8439c47854",
    },
    {
        handle: "sbx_7777777777777777777777777z",
        traceId: "2730084125185d2f596d4359ab9e35eb",
        spanId: "7a5546d2e76201a9",
    },
] as const;

const authorization = "Basic dGVzdC1pbnN0YW5jZTp0ZXN0LXRva2Vu";
const internalToken = "t".repeat(32);

describe("order trace ids", () => {
    it("derive the pinned vectors", () => {
        expect(orderTraceLabel).toBe("bugnet-order-trace-v1|");
        for (const v of vectors) {
            const o = orderTrace(v.handle, 1);
            expect([o.traceId, o.spanId]).toEqual([v.traceId, v.spanId]);
        }
    });

    it("keep both at 1.0, the second at 0.5 and neither at 0.25", () => {
        const flags = (ratio: number) => vectors.map((v) => orderTrace(v.handle, ratio).sampled);
        expect(flags(1)).toEqual([true, true]);
        expect(flags(0.5)).toEqual([false, true]);
        expect(flags(0.25)).toEqual([false, false]);
        expect(flags(0)).toEqual([false, false]);
    });

    it("give the first row's traceparent and log form", () => {
        const o = orderTrace(vectors[0].handle, 1);
        const sc = { traceId: o.traceId, spanId: o.spanId, traceFlags: o.sampled ? 1 : 0 };
        expect(traceparent(sc)).toBe("00-55a4dee648a7a4d0a70cd0a8b24c672f-69923b8439c47854-01");
        expect(handleHashAttr(vectors[0].handle)).toBe("9a5bf94fe52b");
    });

    it("apply the Go ratio rule at its edges", () => {
        expect(ratioSampled("0".repeat(32), 1e-9)).toBe(true);
        expect(ratioSampled("f".repeat(32), 0.999999)).toBe(false);
        expect(ratioSampled("f".repeat(32), 1)).toBe(true);
        expect(ratioSampled("0".repeat(32), 0)).toBe(false);
    });
});

describe("telemetry settings", () => {
    const example = new URL("../../../config/example.toml", import.meta.url);
    const on = (lines: string[]) => () =>
        checkSettings(
            parseSettings(['[payments]\nmode = "dev"', "[telemetry]", ...lines].join("\n")),
        );

    it("are off by default and listed in config/example.toml", () => {
        const t = parseSettings("").telemetry;
        expect(t).toEqual({
            traces: false,
            otlp_endpoint: "",
            sample_ratio: 1,
            environment: "main",
            export_timeout: 10_000,
            batch_timeout: 5000,
            batch_size: 512,
            queue_size: 2048,
        });
        expect(parseSettings(readFileSync(example, "utf8")).telemetry).toEqual(t);
    });

    it("refuse an endpoint that is missing, plain to another host or carries a user", () => {
        expect(on(["traces = true"])).toThrow(/needs telemetry.otlp_endpoint/);
        expect(
            on(["traces = true", 'otlp_endpoint = "http://tempo.example:4318/v1/traces"']),
        ).toThrow(/https, or http to a loopback host/);
        expect(on(["traces = true", 'otlp_endpoint = "ftp://127.0.0.1/v1/traces"'])).toThrow(
            /https, or http to a loopback host/,
        );
        expect(
            on(["traces = true", 'otlp_endpoint = "https://u:p@otlp.example/otlp/v1/traces"']),
        ).toThrow(/user or password/);
        for (const ok of [
            "http://127.0.0.1:4318/v1/traces",
            "http://[::1]:4318/v1/traces",
            "https://otlp-gateway-prod-eu-west-2.grafana.net/otlp/v1/traces",
        ]) {
            expect(on(["traces = true", `otlp_endpoint = "${ok}"`])).not.toThrow();
        }
        expect(on(['otlp_endpoint = "http://tempo.example:4318/v1/traces"'])).not.toThrow();
    });

    it("refuse a ratio outside 0 to 1, sizes out of range and a bad environment", () => {
        expect(() => parseSettings("[telemetry]\nsample_ratio = 1.5")).toThrow(/sample_ratio/);
        expect(() => parseSettings("[telemetry]\nqueue_size = 0")).toThrow(/queue_size/);
        expect(() => parseSettings('[telemetry]\nenvironment = "Prod EU"')).toThrow(/environment/);
        expect(() => parseSettings("[telemetry]\ntrace = true")).toThrow(/telemetry.trace\b/);
        expect(on(["batch_size = 4096"])).toThrow(/batch_size is over/);
    });

    it("take the authorization from the environment only", () => {
        const s = parseSettings('[payments]\nmode = "dev"');
        const env = {
            BUGNET_INTERNAL_TOKEN: internalToken,
            BUGNET_QUOTE_KEY: Buffer.alloc(32).toString("base64"),
            BUGNET_ORDER_PRIVATE_KEY: Buffer.alloc(32).toString("base64"),
        };
        expect(readSecrets(env, s).otlpAuthorization).toBe("");
        const withAuth = { ...env, BUGNET_OTLP_AUTHORIZATION: authorization };
        expect(readSecrets(withAuth, s).otlpAuthorization).toBe(authorization);
    });
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
});

interface Logged {
    msg: string;
    fields?: Record<string, unknown>;
}

function recordLog(lines: Logged[]): Log {
    const push = (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields });
    return { info: push, warn: push, error: push };
}

interface Fixture {
    receiver: OtlpReceiver;
    router: TestRouterServer;
    tracing: Tracing;
    deps: ReturnType<typeof testDeps>;
    logs: Logged[];
    // Flushes the queue, then gives every exported span
    flush(): Promise<ExportedSpan[]>;
}

interface FixtureOptions {
    toml?: string;
    env?: NodeJS.ProcessEnv;
    status?: number;
}

async function traced(impl: RouterImpl, opts: FixtureOptions = {}): Promise<Fixture> {
    const receiver = await startOtlpReceiver(opts.status);
    cleanups.push(() => receiver.close());
    const router = await startRouterServer(impl);
    cleanups.push(() => router.close());
    const config: Config = testConfig(
        [
            "[router]",
            `url = "${router.url}"`,
            "[telemetry]",
            "traces = true",
            `otlp_endpoint = "${receiver.url}"`,
            // Spans leave only on shutdown, which proves the flush
            'batch_timeout = "1h"',
            opts.toml ?? "",
        ].join("\n"),
    );
    config.secrets.otlpAuthorization = authorization;
    const logs: Logged[] = [];
    const tracing = createTracing(config, recordLog(logs), {
        version: "0.1.0",
        env: opts.env ?? {},
    }) as Tracing;
    cleanups.push(() => tracing.shutdown());
    const deps = testDeps({
        config,
        router: createRouterClient(config, [tracing.interceptor]),
        tracing,
    });
    return {
        receiver,
        router,
        tracing,
        deps,
        logs,
        flush: async () => {
            await tracing.shutdown();
            return receiver.spans();
        },
    };
}

const placing = () =>
    create(GetPlacementResponseSchema, { placement: placement(PlacementState.PLACING) });
const routerMethod = (m: string) => `bugnet.router.v1.SandboxRouterService/${m}`;

function parsedTraceparent(header: string | null) {
    const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/.exec(header ?? "");
    if (!m) throw new Error(`no traceparent in ${String(header)}`);
    return { traceId: m[1] as string, spanId: m[2] as string, sampled: m[3] === "01" };
}

function only(spans: ExportedSpan[], name: string): ExportedSpan {
    const found = spans.filter((s) => s.name === name);
    expect(found, name).toHaveLength(1);
    return found[0] as ExportedSpan;
}

describe("tracing off", () => {
    it("builds nothing and sends no trace header", async () => {
        const receiver = await startOtlpReceiver();
        cleanups.push(() => receiver.close());
        const router = await startRouterServer({ getPlacement: placing });
        cleanups.push(() => router.close());
        const config = testConfig(
            `[router]\nurl = "${router.url}"\n[telemetry]\notlp_endpoint = "${receiver.url}"`,
        );
        const tracing = createTracing(config, recordLog([]), { version: "0.1.0" });
        expect(tracing).toBeUndefined();
        const deps = testDeps({ config, router: createRouterClient(config, []) });
        const client = await connectTools(deps);
        await callTool(client, "bugnet_status", { handle: testHandle });
        expect(router.calls).toHaveLength(1);
        expect(router.calls[0]?.header.get("traceparent")).toBeNull();
        expect(router.calls[0]?.header.get("tracestate")).toBeNull();
        expect(receiver.requests).toHaveLength(0);
    });
});

describe("tracing on", () => {
    it("continues a tool call about a handle into the router in the order trace", async () => {
        const f = await traced({ getPlacement: placing });
        const client = await connectTools(f.deps);
        const r = await callTool(client, "bugnet_status", { handle: testHandle });
        expect(r.isError).toBe(false);
        const order = orderTrace(testHandle, 1);
        const sent = parsedTraceparent(f.router.calls[0]?.header.get("traceparent") ?? null);
        expect(sent.traceId).toBe(order.traceId);
        expect(sent.sampled).toBe(true);

        const spans = await f.flush();
        const tool = only(spans, "bugnet_status");
        expect(tool).toMatchObject({
            traceId: order.traceId,
            parentSpanId: order.spanId,
            kind: 2,
            attributes: { "bugnet.handle_hash": handleHashAttr(testHandle) },
        });
        const call = only(spans, routerMethod("GetPlacement"));
        expect(call).toMatchObject({
            traceId: order.traceId,
            spanId: sent.spanId,
            parentSpanId: tool.spanId,
            kind: 3,
            attributes: {
                "rpc.system.name": "connectrpc",
                "rpc.method": routerMethod("GetPlacement"),
                "rpc.response.status_code": "OK",
                "bugnet.handle_hash": handleHashAttr(testHandle),
            },
            events: 0,
            status: { code: 0, message: "" },
        });
        expect(call.resource).toEqual({
            "service.name": "bugnet-gateway",
            "service.version": "0.1.0",
            "deployment.environment.name": "main",
        });
    });

    it("exports over OTLP protobuf with gzip and the authorization, and leaks no secret", async () => {
        const f = await traced({ getPlacement: placing });
        const client = await connectTools(f.deps);
        await callTool(client, "bugnet_status", { handle: testHandle });
        await f.flush();
        expect(f.receiver.requests.length).toBeGreaterThan(0);
        for (const req of f.receiver.requests) {
            expect(req.headers["content-type"]).toBe("application/x-protobuf");
            expect(req.headers["content-encoding"]).toBe("gzip");
            expect(req.headers.authorization).toBe(authorization);
            const body = req.body.toString("latin1");
            for (const secret of [testHandle, internalToken, authorization, "sbx_"]) {
                expect(body).not.toContain(secret);
            }
        }
    });

    it("keeps bugnet_start in its own trace until the handle exists, then links the order to it", async () => {
        const seen: { create?: CreatePlacementRequest } = {};
        const f = await traced({
            estimate: () => ({ options: [packageOption("small-10m", 50_000n)] }),
            createPlacement: (req) => {
                seen.create = req;
                return { handle: testHandle, placement: placement(PlacementState.PLACING) };
            },
            getPlacement: () => ({ placement: placement(PlacementState.READY) }),
        });
        const client = await connectTools(f.deps);
        const q = await callTool<{ quoteId: string }>(client, "bugnet_quote", {
            workload: "script",
        });
        const r = await callTool(client, "bugnet_start", {
            quoteId: q.structured.quoteId,
            packageId: "small-10m",
            confirmPriceUsd: "0.05",
        });
        expect(r.isError).toBe(false);
        const order = orderTrace(testHandle, 1);
        const header = (m: string) =>
            parsedTraceparent(
                f.router.calls.find((c) => c.method === m)?.header.get("traceparent") ?? null,
            );

        const spans = await f.flush();
        const start = only(spans, "bugnet_start");
        expect(start.parentSpanId).toBe("");
        expect(start.traceId).not.toBe(order.traceId);
        expect(start.attributes["bugnet.handle_hash"]).toBeUndefined();

        const create = only(spans, routerMethod("CreatePlacement"));
        expect(create).toMatchObject({ traceId: start.traceId, parentSpanId: start.spanId });
        expect(header("CreatePlacement").traceId).toBe(start.traceId);

        const waits = spans.filter((s) => s.name === routerMethod("GetPlacement"));
        expect(waits.length).toBeGreaterThan(0);
        for (const w of waits) {
            expect(w).toMatchObject({ traceId: order.traceId, parentSpanId: order.spanId });
            expect(w.links).toEqual([
                {
                    traceId: start.traceId,
                    spanId: start.spanId,
                    attributes: { "bugnet.link": "request" },
                },
            ]);
        }
        expect(header("GetPlacement").traceId).toBe(order.traceId);

        const quote = only(spans, "bugnet_quote");
        expect(quote.traceId).not.toBe(start.traceId);
        expect(seen.create?.orderToken).toBeTruthy();
        for (const req of f.receiver.requests) {
            const body = req.body.toString("latin1");
            expect(body).not.toContain(testHandle);
            expect(body).not.toContain(seen.create?.orderToken as string);
        }
    });

    it("sets the sampled flag by the ratio rule and exports only kept orders", async () => {
        const f = await traced({ getPlacement: placing }, { toml: "sample_ratio = 0.5" });
        const client = await connectTools(f.deps);
        for (const v of vectors) await callTool(client, "bugnet_status", { handle: v.handle });
        const sent = f.router.calls.map((c) => parsedTraceparent(c.header.get("traceparent")));
        expect(sent.map((s) => [s.traceId, s.sampled])).toEqual([
            [vectors[0].traceId, false],
            [vectors[1].traceId, true],
        ]);
        const traces = new Set((await f.flush()).map((s) => s.traceId));
        expect([...traces]).toEqual([vectors[1].traceId]);
    });

    it("joins a server stream about a handle to the order trace", async () => {
        const f = await traced({
            async *watchJob() {
                yield create(WatchJobResponseSchema, { cursor: "c1" });
            },
        });
        const frames = [];
        for await (const fr of f.deps.router.watchJob({ handle: testHandle, jobId: "j_x" })) {
            frames.push(fr);
        }
        expect(frames).toHaveLength(1);
        const order = orderTrace(testHandle, 1);
        const sent = parsedTraceparent(f.router.calls[0]?.header.get("traceparent") ?? null);
        expect(sent.traceId).toBe(order.traceId);
        const span = only(await f.flush(), routerMethod("WatchJob"));
        expect(span).toMatchObject({
            parentSpanId: order.spanId,
            attributes: { "rpc.response.status_code": "OK" },
        });
    });

    it("marks only router faults as errors and names the reason", async () => {
        const answers = [
            routerError(Code.NotFound),
            routerError(Code.ResourceExhausted, "RATE_LIMITED", { retryAfterMs: 1000 }),
            routerError(Code.Internal),
            routerError(Code.FailedPrecondition, "not_found"),
        ];
        const f = await traced({
            getPlacement: () => {
                throw answers.shift();
            },
        });
        for (let i = 0; i < 4; i++) {
            await f.deps.router.getPlacement({ handle: testHandle }).catch(() => undefined);
        }
        const spans = (await f.flush()).filter((s) => s.name === routerMethod("GetPlacement"));
        const seen = spans.map((s) => [
            s.attributes["rpc.response.status_code"],
            s.attributes["error.type"],
            s.status.code,
            s.status.message,
        ]);
        expect(seen).toEqual([
            ["NOT_FOUND", "NOT_FOUND", 0, ""],
            ["RESOURCE_EXHAUSTED", "RATE_LIMITED", 0, ""],
            ["INTERNAL", "INTERNAL", 2, "INTERNAL"],
            ["FAILED_PRECONDITION", "FAILED_PRECONDITION", 0, ""],
        ]);
    });

    it("ignores OTEL_ variables and names them once", async () => {
        const env = {
            OTEL_EXPORTER_OTLP_HEADERS: "x-hostile=1",
            OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=stolen",
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:9/v1/traces",
            OTEL_EXPORTER_OTLP_COMPRESSION: "none",
            OTEL_TRACES_SAMPLER: "always_off",
            OTEL_SDK_DISABLED: "true",
            OTEL_RESOURCE_ATTRIBUTES: "service.name=hostile",
        };
        const saved = { ...process.env };
        Object.assign(process.env, env);
        cleanups.push(() => {
            for (const k of Object.keys(env)) delete process.env[k];
            Object.assign(process.env, saved);
        });
        const f = await traced({ getPlacement: placing }, { env: process.env });
        const client = await connectTools(f.deps);
        await callTool(client, "bugnet_status", { handle: testHandle });
        const spans = await f.flush();
        expect(spans.map((s) => s.name)).toContain("bugnet_status");
        expect(spans[0]?.resource["service.name"]).toBe("bugnet-gateway");
        for (const req of f.receiver.requests) {
            expect(req.headers["x-hostile"]).toBeUndefined();
            expect(req.headers.authorization).toBe(authorization);
            expect(req.headers["content-encoding"]).toBe("gzip");
        }
        const warned = f.logs.filter((l) => l.msg === "OTEL_ variables are ignored");
        expect(warned).toHaveLength(1);
        expect(warned[0]?.fields?.names).toEqual(expect.arrayContaining(Object.keys(env)));
        expect(JSON.stringify(f.logs)).not.toContain("stolen");
    });

    it("logs a refused export with its status and never the header", async () => {
        const f = await traced({ getPlacement: placing }, { status: 401 });
        const client = await connectTools(f.deps);
        const r = await callTool(client, "bugnet_status", { handle: testHandle });
        expect(r.isError).toBe(false);
        await f.flush();
        expect(f.receiver.requests.length).toBeGreaterThan(0);
        expect(f.logs).toContainEqual({
            msg: "trace export failed",
            fields: { failures: 1, status: 401 },
        });
        expect(JSON.stringify(f.logs)).not.toContain(authorization);
    });
});
