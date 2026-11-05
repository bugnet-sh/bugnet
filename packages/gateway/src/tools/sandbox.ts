import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
    PlacementState,
    type PackageOption,
    type Placement,
} from "../gen/bugnet/router/v1/router_pb.ts";
import { extensionsFor } from "./extend.ts";
import { signQuote, verifyQuote, QuoteError, type QuotedPackage } from "../quote.ts";
import { GatewayError, fromRouter } from "../router.ts";
import type { OrderResult } from "../payments/port.ts";
import {
    failure,
    handlePattern,
    handleTag,
    ok,
    timeLeft,
    toolUseId,
    usd,
    waitMs,
    withProgress,
    type Deps,
    type Register,
} from "./common.ts";

export const workloads = ["tests", "build", "script", "serve", "inference", "other"] as const;
export const needs = ["ssh", "preview", "secrets", "gpu"] as const;

export const stateName: Record<PlacementState, string> = {
    [PlacementState.UNSPECIFIED]: "unknown",
    [PlacementState.PLACING]: "starting",
    [PlacementState.READY]: "ready",
    [PlacementState.TERMINATING]: "stopping",
    [PlacementState.TERMINATED]: "ended",
    [PlacementState.FAILED]: "failed",
};

function ended(s: PlacementState): boolean {
    return s === PlacementState.TERMINATED || s === PlacementState.FAILED;
}

export function describeSize(p: { vcpu: number; memoryMib: number; gpuCount: number }): string {
    const mem =
        p.memoryMib >= 1024 ? `${Math.round(p.memoryMib / 1024)} GiB` : `${p.memoryMib} MiB`;
    return `${p.vcpu} vCPU / ${mem}${p.gpuCount > 0 ? ` / ${p.gpuCount} GPU` : ""}`;
}

function quoted(o: PackageOption): QuotedPackage {
    const r = o.resources;
    return {
        id: o.packageId,
        priceMicros: Number(o.priceMicros),
        minutes: o.minutes,
        vcpu: r?.vcpu ?? 0,
        memoryMib: r?.memoryMib ?? 0,
        diskGib: r?.diskGib ?? 0,
        gpuCount: r?.gpuCount ?? 0,
    };
}

// Interim choice until the router's estimator recommends a package from the source itself
export function recommend(
    pkgs: QuotedPackage[],
    workload: (typeof workloads)[number],
    expectedMinutes: number | undefined,
): { pkg: QuotedPackage; why: string } | null {
    if (pkgs.length === 0) return null;
    const heavy = workload === "inference" || workload === "build" || workload === "serve";
    const minutes = expectedMinutes ?? (heavy ? 20 : 10);
    const byPrice = [...pkgs].sort((a, b) => a.priceMicros - b.priceMicros);
    const longEnough = byPrice.filter((p) => p.minutes >= minutes);
    const pool = longEnough.length > 0 ? longEnough : byPrice;
    if (heavy) {
        const biggest = Math.max(...pool.map((p) => p.memoryMib));
        const pkg = pool.find((p) => p.memoryMib === biggest) as QuotedPackage;
        return { pkg, why: `${workload} work wants the most memory on offer` };
    }
    const pkg = pool[0] as QuotedPackage;
    const why =
        longEnough.length > 0
            ? `cheapest package that lasts ${minutes} min`
            : `no package lasts ${minutes} min, extend it when needed`;
    return { pkg, why };
}

interface PlacementView {
    state: string;
    packageId: string;
    deadline: string | null;
    timeLeft: string;
    failureReason?: string;
    refundable?: boolean;
    [key: string]: unknown;
}

function placementView(p: Placement | undefined, now: number): PlacementView {
    const deadline = p?.deadline ? timestampDate(p.deadline) : undefined;
    return {
        state: p ? stateName[p.state] : "unknown",
        packageId: p?.packageId ?? "",
        deadline: deadline?.toISOString() ?? null,
        timeLeft: p && ended(p.state) ? "none, the sandbox has ended" : timeLeft(deadline, now),
        ...(p?.failureReason ? { failureReason: p.failureReason } : {}),
        ...(p?.state === PlacementState.FAILED ? { refundable: p.refundable } : {}),
    };
}

const quoteInput = z.object({
    source: z
        .string()
        .max(500)
        .optional()
        .describe("GitHub URL (optionally with a ref), Hugging Face model id, script URL, or omit"),
    workload: z.enum(workloads).default("other"),
    entryCommand: z.string().max(1000).optional(),
    expectedMinutes: z.number().int().min(1).max(1440).optional(),
    needs: z.array(z.enum(needs)).max(4).optional(),
});

const startInput = z.object({
    quoteId: z.string().max(4000).describe("quoteId from bugnet_quote or bugnet_assess"),
    packageId: z.string().max(100),
    confirmPriceUsd: z
        .string()
        .max(20)
        .describe(
            "The package price you told the user, such as 0.05, shown in the approval prompt",
        ),
    orderId: z.string().max(200).optional().describe("orderId from an earlier payment step"),
    payment: z
        .unknown()
        .optional()
        .describe("x402 PaymentPayload for this order if your wallet tool produced one"),
});

const handleInput = z.string().regex(handlePattern, "a sandbox handle starting with sbx_");

export interface QuoteRequest {
    source?: string | undefined;
    workload: (typeof workloads)[number];
    expectedMinutes?: number | undefined;
    needs?: (typeof needs)[number][] | undefined;
    minMemoryGiB?: number | null | undefined;
    minDiskGiB?: number | null | undefined;
}

export interface BuiltQuote {
    text: string;
    structured: {
        quoteId: string;
        expiresAt: string;
        packages: (QuotedPackage & { priceUsd: string })[];
        recommended: { packageId: string; priceUsd: string; why: string } | null;
        // False when the work states a memory or disk need that no package on offer meets
        largeEnough: boolean;
        warnings: string[];
    };
}

// A zero size means the router did not report it, so it cannot rule a package out
function meetsSize(p: QuotedPackage, memoryGiB: number | null, diskGiB: number | null): boolean {
    const memory = memoryGiB === null || p.memoryMib === 0 || p.memoryMib >= memoryGiB * 1024;
    const disk = diskGiB === null || p.diskGib === 0 || p.diskGib >= diskGiB;
    return memory && disk;
}

export function sizeText(memoryGiB: number | null, diskGiB: number | null): string {
    const parts = [
        memoryGiB !== null ? `${memoryGiB} GiB of memory` : "",
        diskGiB !== null ? `${diskGiB} GiB of disk` : "",
    ].filter(Boolean);
    return `about ${parts.join(" and ")}`;
}

// Prices the packages that can start now and signs them into a quoteId bugnet_start accepts
export async function buildQuote(
    deps: Deps,
    args: QuoteRequest,
    signal?: AbortSignal,
): Promise<BuiltQuote> {
    const wantGpu = args.needs?.includes("gpu") ?? false;
    const requirements = {
        ssh: args.needs?.includes("ssh") ?? false,
        preview: args.needs?.includes("preview") ?? false,
        gpu: wantGpu,
    };
    const est = await deps.router.estimate({ requirements }, signal ? { signal } : {});
    const all = est.options.map(quoted);
    const available = est.options.filter((o) => o.available).map(quoted);
    const warnings: string[] = [];
    if (wantGpu && !available.some((p) => p.gpuCount > 0)) {
        warnings.push("No GPU package is available right now, GPU work cannot start");
    }
    if (args.needs?.includes("secrets")) {
        warnings.push("Secrets go in with bugnet_secret_link or the bridge, never in arguments");
    }
    const memoryGiB = args.minMemoryGiB ?? null;
    const diskGiB = args.minDiskGiB ?? null;
    const kind = wantGpu ? available.filter((p) => p.gpuCount > 0) : available;
    const sized = kind.filter((p) => meetsSize(p, memoryGiB, diskGiB));
    const largeEnough = kind.length === 0 || sized.length > 0;
    if (!largeEnough) {
        warnings.push(`No package is large enough for ${sizeText(memoryGiB, diskGiB)}`);
    }
    const rec = recommend(sized, args.workload, args.expectedMinutes);
    const expiresAt = deps.now() + deps.config.limits.quote_ttl;
    const quoteId = signQuote(deps.config.secrets.quoteKey, {
        packages: available,
        requirements,
        source: args.source ?? "",
        expiresAt,
    });
    const lines = [...available]
        .sort((a, b) => a.priceMicros - b.priceMicros)
        .map(
            (p) =>
                `- ${p.id}: ${describeSize(p)}, ${p.minutes} min, ${usd(p.priceMicros)} USDC` +
                (rec?.pkg.id === p.id ? " (recommended)" : ""),
        );
    const unavailable = all.length - available.length;
    const text = [
        available.length > 0
            ? "Bugnet packages, paid per run in USDC on Solana:"
            : "No package can start right now. Try again in a minute.",
        ...lines,
        rec ? `Recommended: ${rec.pkg.id} because ${rec.why}.` : "",
        unavailable > 0 ? `${unavailable} more packages are unavailable now.` : "",
        ...warnings.map((w) => `Warning: ${w}.`),
        `quoteId (valid 10 min): ${quoteId}`,
        "Tell the user the price and get their go-ahead before bugnet_start.",
    ]
        .filter(Boolean)
        .join("\n");
    return {
        text,
        structured: {
            quoteId,
            expiresAt: new Date(expiresAt).toISOString(),
            packages: available.map((p) => ({ ...p, priceUsd: usd(p.priceMicros) })),
            recommended: rec
                ? { packageId: rec.pkg.id, priceUsd: usd(rec.pkg.priceMicros), why: rec.why }
                : null,
            largeEnough,
            warnings,
        },
    };
}

export function paymentRequiredResult(r: Extract<OrderResult, { status: "payment_required" }>) {
    const guide = [
        `Payment required for order ${r.orderId}.`,
        "If an x402-capable wallet or the Bugnet bridge is connected it pays automatically.",
        r.payUrl ? `Otherwise the user can pay at ${r.payUrl}.` : "",
        `After paying, call the same tool again with orderId "${r.orderId}".`,
    ]
        .filter(Boolean)
        .join(" ");
    const result: CallToolResult = {
        isError: true,
        structuredContent: r.paymentRequired as unknown as Record<string, unknown>,
        // The x402 MCP transport reads the requirement from the first text block
        content: [
            { type: "text", text: JSON.stringify(r.paymentRequired) },
            { type: "text", text: guide },
        ],
    };
    return result;
}

async function waitReady(
    deps: Deps,
    handle: string,
    first: Placement | undefined,
    budgetMs: number,
    signal: AbortSignal,
): Promise<Placement | undefined> {
    let p = first;
    const until = deps.now() + budgetMs;
    while (p && p.state === PlacementState.PLACING && deps.now() < until) {
        const wait = Math.min(until - deps.now(), 25_000);
        const res = await deps.router.getPlacement(
            { handle, waitMs: wait, knownState: PlacementState.PLACING },
            { signal },
        );
        p = res.placement;
    }
    return p;
}

export const registerSandboxTools: Register = (server, deps) => {
    server.registerTool(
        "bugnet_quote",
        {
            title: "Quote a Bugnet sandbox (free)",
            description:
                "Free price quote for a Bugnet cloud sandbox: packages, prices, the recommended " +
                "one and why. Always quote and tell the user the price before bugnet_start. " +
                "The quoteId is valid for 10 minutes.",
            inputSchema: quoteInput,
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, ctx) => {
            try {
                const q = await buildQuote(deps, args, ctx.mcpReq.signal);
                return ok(q.text, q.structured);
            } catch (e) {
                return failure(e, "quote");
            }
        },
    );

    server.registerTool(
        "bugnet_start",
        {
            title: "Start a paid Bugnet sandbox",
            description:
                "Starts a cloud sandbox from a quote and charges the package price in USDC. " +
                "Only call it after the user agreed to the price. Returns the sandbox handle, " +
                "the only key to the sandbox, or a payment step to complete first.",
            inputSchema: startInput,
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: true,
            },
            _meta: { "anthropic/requiresUserInteraction": true },
        },
        async (args, ctx) => {
            try {
                let claims;
                try {
                    claims = verifyQuote(deps.config.secrets.quoteKey, args.quoteId, deps.now());
                } catch (e) {
                    if (e instanceof QuoteError) throw new GatewayError("invalid", e.message);
                    throw e;
                }
                const pkg = claims.packages.find((p) => p.id === args.packageId);
                if (!pkg) {
                    throw new GatewayError(
                        "invalid",
                        `package ${args.packageId} is not in the quote`,
                    );
                }
                const priced = Number.parseFloat(args.confirmPriceUsd.replace(/^\$/, ""));
                if (!Number.isFinite(priced) || Math.abs(priced * 1e6 - pkg.priceMicros) > 0.5) {
                    throw new GatewayError(
                        "invalid",
                        `${args.packageId} costs ${usd(pkg.priceMicros)}, tell the user that price ` +
                            "and pass it as confirmPriceUsd",
                    );
                }
                const payment = ctx.mcpReq._meta?.["x402/payment"] ?? args.payment;
                const order = await deps.payments.order(
                    {
                        kind: "start",
                        packageId: pkg.id,
                        amountMicros: pkg.priceMicros,
                        description: `Bugnet sandbox ${describeSize(pkg)}, ${pkg.minutes} min`,
                        ...(args.orderId ? { orderId: args.orderId } : {}),
                        ...(payment !== undefined ? { payment } : {}),
                        ...(toolUseId(ctx) ? { idempotencyKey: toolUseId(ctx) } : {}),
                    },
                    AbortSignal.timeout(30_000),
                );
                if (order.status === "payment_required") return paymentRequiredResult(order);
                if (order.status === "refused") {
                    throw new GatewayError("denied", `payment refused: ${order.reason}`);
                }
                let created;
                try {
                    created = await deps.router.createPlacement({
                        orderToken: order.orderToken,
                        requirements: claims.requirements,
                    });
                } catch (e) {
                    const err = fromRouter(e, "start");
                    if (err.kind === "denied" || err.kind === "invalid") {
                        await deps.payments
                            .abandon(order.orderId, err.kind, AbortSignal.timeout(10_000))
                            .catch((x) => deps.log.error("abandon failed", { err: String(x) }));
                    }
                    throw err;
                }
                const handle = created.handle;
                const p = await withProgress(ctx, "starting the sandbox", (signal) =>
                    waitReady(deps, handle, created.placement, 25_000, signal),
                );
                deps.log.info("placement started", {
                    handle: handleTag(handle),
                    state: p ? stateName[p.state] : "unknown",
                });
                const view = placementView(p, deps.now());
                const meta =
                    order.paymentResponse !== undefined
                        ? { "x402/payment-response": order.paymentResponse }
                        : undefined;
                const ready = p?.state === PlacementState.READY;
                const text = [
                    `Sandbox ${view.state}. handle: ${handle}`,
                    ready ? `Time left: ${view.timeLeft} (deadline ${view.deadline}).` : "",
                    p?.state === PlacementState.PLACING
                        ? "Still starting, call bugnet_status with the handle and waitSeconds 25."
                        : "",
                    p?.state === PlacementState.FAILED
                        ? `It failed to start${p.refundable ? ", the payment will be refunded" : ""}.`
                        : "",
                    "Keep the handle, it is the only key to this sandbox. Commands run as root " +
                        "or as a user with passwordless sudo: use $HOME, prefix system changes with sudo.",
                ]
                    .filter(Boolean)
                    .join("\n");
                return ok(text, { handle, orderId: order.orderId, ...view }, meta);
            } catch (e) {
                return failure(e, "start");
            }
        },
    );

    server.registerTool(
        "bugnet_status",
        {
            title: "Bugnet sandbox status",
            description:
                "State, deadline and time left of a sandbox. waitSeconds waits for the state " +
                "to change, for example while it is starting.",
            inputSchema: z.object({
                handle: handleInput,
                waitSeconds: z.number().int().min(0).max(45).optional(),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, ctx) => {
            try {
                let p = (await deps.router.getPlacement({ handle: args.handle })).placement;
                const wait = waitMs(deps, args.waitSeconds ?? 0);
                if (p && wait > 0 && !ended(p.state)) {
                    const known = p.state;
                    p = await withProgress(ctx, "waiting for the sandbox", async (signal) => {
                        const res = await deps.router.getPlacement(
                            { handle: args.handle, waitMs: wait, knownState: known },
                            { signal },
                        );
                        return res.placement;
                    });
                }
                const view = placementView(p, deps.now());
                const ready = p?.state === PlacementState.READY;
                const extensions = ready ? await extensionsFor(deps, args.handle) : [];
                const offer = extensions.filter((x) => x.available);
                const text = [
                    `Sandbox ${view.state}, package ${view.packageId}, time left ${view.timeLeft}` +
                        (view.deadline ? ` (deadline ${view.deadline})` : "") +
                        (view.failureReason ? `, reason ${view.failureReason}` : "") +
                        ".",
                    offer.length > 0
                        ? "Extend with bugnet_extend: " +
                          offer
                              .map((x) => `${x.packageId} +${x.minutes} min ${x.priceUsd}`)
                              .join(", ")
                        : "",
                ]
                    .filter(Boolean)
                    .join("\n");
                return ok(text, { ...view, extensions });
            } catch (e) {
                return failure(e, "status");
            }
        },
    );

    server.registerTool(
        "bugnet_stop",
        {
            title: "Stop a Bugnet sandbox",
            description:
                "Destroys the sandbox and everything in it. Download what you need first. " +
                "Unused paid time is not refunded.",
            inputSchema: z.object({ handle: handleInput }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (args) => {
            try {
                const res = await deps.router.stopPlacement({ handle: args.handle });
                const p = res.placement;
                const ready = p?.readyAt ? timestampDate(p.readyAt).getTime() : null;
                const usedSeconds = ready
                    ? Math.max(0, Math.round((deps.now() - ready) / 1000))
                    : 0;
                const view = { ...placementView(p, deps.now()), usedSeconds };
                return ok(`Sandbox ${view.state}, used for about ${usedSeconds} s.`, view);
            } catch (e) {
                return failure(e, "stop");
            }
        },
    );
};
