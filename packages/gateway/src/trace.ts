/**
 * OpenTelemetry trace continuation into the router, one trace per order (data-plane 20.13).
 *
 * The gateway is stateless, so a call about a sandbox finds its order's trace by deriving the ids
 * from the handle, as every other party does (20.2.1). Each tool call gets a span, and each router
 * call a client span whose traceparent the router continues. While telemetry.traces is off nothing
 * is built, no header is sent and no exporter connects. No global provider, context manager or
 * propagator is set, and no OTEL_ variable changes anything, since settings live in TOML and the
 * environment holds secrets only. Spans name a sandbox only by bugnet.handle_hash.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import {
    ROOT_CONTEXT,
    SpanKind,
    SpanStatusCode,
    TraceFlags,
    isSpanContextValid,
    trace,
    type Attributes,
    type Context,
    type Link,
    type Span,
    type SpanContext,
} from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPExporterBase } from "@opentelemetry/otlp-exporter-base";
import {
    createOtlpHttpExportDelegate,
    httpAgentFactoryFromOptions,
} from "@opentelemetry/otlp-exporter-base/node-http";
import {
    ProtobufTraceSerializer,
    TraceExporterMetricsHelper,
} from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
    BatchSpanProcessor,
    SamplingDecision,
    TracerProvider,
    type ReadableSpan,
    type Sampler,
    type SpanExporter,
} from "@opentelemetry/sdk-trace";
import type { Config } from "./config.ts";
import type { Log } from "./log.ts";
import { errorReason } from "./router.ts";
import { handlePattern } from "./tools/common.ts";

export interface OrderTrace {
    traceId: string;
    // The order root span, which router-api emits as bugnet.order
    spanId: string;
    sampled: boolean;
}

// Pinned with the router, which derives the same ids
export const orderTraceLabel = "bugnet-order-trace-v1|";

// The OpenTelemetry Go SDK's TraceIDRatioBased, as OpenTelemetry JS's own sampler differs
export function ratioSampled(traceId: string, ratio: number): boolean {
    if (ratio >= 1) return true;
    if (ratio <= 0) return false;
    const x = BigInt(`0x${traceId.slice(16, 32)}`) >> 1n;
    return x < BigInt(Math.trunc(ratio * 2 ** 63));
}

export function orderTrace(handle: string, ratio: number): OrderTrace {
    const inner = createHash("sha256").update(handle).digest();
    const d = createHash("sha256").update(orderTraceLabel).update(inner).digest();
    const traceId = d.subarray(0, 16).toString("hex");
    return {
        traceId,
        spanId: d.subarray(16, 24).toString("hex"),
        sampled: ratioSampled(traceId, ratio),
    };
}

// The handle's log form without its h: prefix, the only way a span names a sandbox
export function handleHashAttr(handle: string): string {
    return createHash("sha256").update(handle).digest("hex").slice(0, 12);
}

export function traceparent(sc: SpanContext): string {
    const flags = sc.traceFlags & TraceFlags.SAMPLED ? "01" : "00";
    return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

function handleIn(message: unknown): string | undefined {
    if (typeof message !== "object" || message === null) return undefined;
    const h = (message as { handle?: unknown }).handle;
    return typeof h === "string" && handlePattern.test(h) ? h : undefined;
}

// ParentBased on the Go rule, so with equal ratios an order is kept or dropped whole
function orderSampler(ratio: number): Sampler {
    return {
        shouldSample(ctx, traceId) {
            const parent = trace.getSpanContext(ctx);
            const keep =
                parent && isSpanContextValid(parent)
                    ? (parent.traceFlags & TraceFlags.SAMPLED) !== 0
                    : ratioSampled(traceId, ratio);
            return {
                decision: keep ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD,
            };
        },
        toString: () => `OrderSampler{${ratio}}`,
    };
}

const serverFaults = new Set([
    Code.Unknown,
    Code.DeadlineExceeded,
    Code.Unimplemented,
    Code.Internal,
    Code.Unavailable,
    Code.DataLoss,
]);

function upperCode(code: Code): string {
    return Code[code].replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
}

// Records how a router call ended, with an error status only for a fault on the router's side
function finish(span: Span, err: unknown): void {
    if (err === undefined) {
        span.setAttribute("rpc.response.status_code", "OK");
    } else {
        const ce = ConnectError.from(err);
        const code = upperCode(ce.code);
        const reason = errorReason(ce);
        const type = reason && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason) ? reason : code;
        span.setAttributes({ "rpc.response.status_code": code, "error.type": type });
        if (serverFaults.has(ce.code)) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: type });
        }
    }
    span.end();
}

async function* endWith<T>(messages: AsyncIterable<T>, span: Span): AsyncGenerator<T> {
    let err: unknown;
    try {
        yield* messages;
    } catch (e) {
        err = e;
        throw e;
    } finally {
        finish(span, err);
    }
}

type RouterRequest = Parameters<ReturnType<Interceptor>>[0];

// A server stream sends its one request message as a stream, so the handle needs a peek
async function peekHandle(req: RouterRequest): Promise<[string | undefined, RouterRequest]> {
    if (!req.stream) return [handleIn(req.message), req];
    if (req.method.methodKind !== "server_streaming") return [undefined, req];
    const it = req.message[Symbol.asyncIterator]();
    const first = await it.next();
    async function* replay() {
        if (first.done) return;
        yield first.value;
        for (let n = await it.next(); !n.done; n = await it.next()) yield n.value;
    }
    return [first.done ? undefined : handleIn(first.value), { ...req, message: replay() }];
}

// Export failures log at most once a minute with a count and the HTTP status, never a header
function quietExporter(inner: SpanExporter, log: Log): SpanExporter {
    let failures = 0;
    let loggedAt = Number.NEGATIVE_INFINITY;
    return {
        export(spans: ReadableSpan[], done) {
            inner.export(spans, (result) => {
                if (result.code !== ExportResultCode.SUCCESS) {
                    failures += 1;
                    if (Date.now() - loggedAt >= 60_000) {
                        loggedAt = Date.now();
                        const status = (result.error as { code?: unknown } | undefined)?.code;
                        log.warn("trace export failed", {
                            failures,
                            status: typeof status === "number" ? status : undefined,
                        });
                        failures = 0;
                    }
                }
                done(result);
            });
        },
        shutdown: () => inner.shutdown(),
        forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
    };
}

// Every option explicit, as the stock exporter would merge OTEL_ variables in
function otlpExporter(t: Config["telemetry"], authorization: string): SpanExporter {
    const headers: Record<string, string> = { "Content-Type": "application/x-protobuf" };
    if (authorization) headers.Authorization = authorization;
    const delegate = createOtlpHttpExportDelegate(
        {
            url: t.otlp_endpoint,
            headers: async () => ({ ...headers }),
            agentFactory: httpAgentFactoryFromOptions({ keepAlive: true }),
            compression: "gzip",
            timeoutMillis: t.export_timeout,
            concurrencyLimit: 4,
        },
        ProtobufTraceSerializer,
        "otlp_http_span_exporter",
        TraceExporterMetricsHelper,
        undefined,
    );
    return new OTLPExporterBase<ReadableSpan[]>(delegate);
}

export interface Tracing {
    // Puts traceparent on every router call, outermost so it also times the others
    readonly interceptor: Interceptor;
    // Runs one tool call under its span, in the order's trace when its arguments name a handle
    tool<T>(name: string, args: unknown, work: () => T | Promise<T>): Promise<T>;
    // Exports the spans still queued, waiting at most timeoutMs
    shutdown(timeoutMs?: number): Promise<void>;
}

export interface TracingOptions {
    version: string;
    env?: NodeJS.ProcessEnv;
}

// Undefined while telemetry.traces is off, so nothing is built
export function createTracing(
    config: Pick<Config, "telemetry" | "secrets">,
    log: Log,
    opts: TracingOptions,
): Tracing | undefined {
    const t = config.telemetry;
    if (!t.traces) return undefined;
    const ignored = Object.keys(opts.env ?? process.env).filter((k) => k.startsWith("OTEL_"));
    if (ignored.length > 0) log.warn("OTEL_ variables are ignored", { names: ignored });
    const exporter = quietExporter(otlpExporter(t, config.secrets.otlpAuthorization ?? ""), log);
    const provider = new TracerProvider({
        resource: resourceFromAttributes({
            "service.name": "bugnet-gateway",
            "service.version": opts.version,
            "deployment.environment.name": t.environment,
        }),
        sampler: orderSampler(t.sample_ratio),
        spanLimits: {
            attributeCountLimit: 32,
            attributeValueLengthLimit: 256,
            linkCountLimit: 4,
            attributePerLinkCountLimit: 4,
            eventCountLimit: 0,
            attributePerEventCountLimit: 0,
        },
        spanProcessors: [
            new BatchSpanProcessor({
                exporter,
                maxExportBatchSize: t.batch_size,
                maxQueueSize: t.queue_size,
                scheduledDelayMillis: t.batch_timeout,
                exportTimeoutMillis: t.export_timeout,
            }),
        ],
    });
    const tracer = provider.getTracer("bugnet-gateway", opts.version);
    const active = new AsyncLocalStorage<Span>();

    // All-zero ids mean no order trace, a 2^-64 chance the spec leaves to each party's own trace
    const orderOf = (handle: string | undefined): OrderTrace | undefined => {
        if (!handle) return undefined;
        const o = orderTrace(handle, t.sample_ratio);
        return /^0+$/.test(o.traceId) || /^0+$/.test(o.spanId) ? undefined : o;
    };
    const orderRoot = (o: OrderTrace): Context =>
        trace.setSpanContext(ROOT_CONTEXT, {
            traceId: o.traceId,
            spanId: o.spanId,
            traceFlags: o.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
            isRemote: true,
        });

    const interceptor: Interceptor = (next) => async (incoming) => {
        const [handle, req] = await peekHandle(incoming);
        const order = orderOf(handle);
        const current = active.getStore();
        let parent = current ? trace.setSpan(ROOT_CONTEXT, current) : ROOT_CONTEXT;
        const links: Link[] = [];
        // bugnet_start learns the handle mid-call, so its later calls join the order and link back
        if (order && current?.spanContext().traceId !== order.traceId) {
            parent = orderRoot(order);
            if (current) {
                links.push({
                    context: current.spanContext(),
                    attributes: { "bugnet.link": "request" },
                });
            }
        }
        const method = `${req.service.typeName}/${req.method.name}`;
        const attributes: Attributes = { "rpc.system.name": "connectrpc", "rpc.method": method };
        if (handle) attributes["bugnet.handle_hash"] = handleHashAttr(handle);
        const span = tracer.startSpan(method, { kind: SpanKind.CLIENT, attributes, links }, parent);
        req.header.set("traceparent", traceparent(span.spanContext()));
        const state = span.spanContext().traceState?.serialize();
        if (state) req.header.set("tracestate", state);
        try {
            const res = await next(req);
            if (!res.stream) {
                finish(span, undefined);
                return res;
            }
            return { ...res, message: endWith(res.message, span) };
        } catch (e) {
            finish(span, e);
            throw e;
        }
    };

    return {
        interceptor,
        async tool(name, args, work) {
            const handle = handleIn(args);
            const order = orderOf(handle);
            const attributes: Attributes = handle
                ? { "bugnet.handle_hash": handleHashAttr(handle) }
                : {};
            const parent = order ? orderRoot(order) : ROOT_CONTEXT;
            const span = tracer.startSpan(name, { kind: SpanKind.SERVER, attributes }, parent);
            try {
                const result = await active.run(span, work);
                if ((result as { isError?: unknown } | null)?.isError === true) {
                    span.setAttribute("error.type", "TOOL_ERROR");
                }
                return result;
            } catch (e) {
                span.setAttribute("error.type", "INTERNAL");
                span.setStatus({ code: SpanStatusCode.ERROR, message: "INTERNAL" });
                throw e;
            } finally {
                span.end();
            }
        },
        async shutdown(timeoutMs = 5000) {
            let timer: NodeJS.Timeout | undefined;
            const late = new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            });
            await Promise.race([provider.shutdown().catch(() => undefined), late]);
            clearTimeout(timer);
        },
    };
}
