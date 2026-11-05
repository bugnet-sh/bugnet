import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
    PlacementState,
    type PackageOption,
    type Placement,
} from "../gen/bugnet/router/v1/router_pb.ts";
import { extensionsFor } from "./extend.ts";
import { verifyQuote, QuoteError, type QuoteClaims } from "../quote.ts";
import { GatewayError, errorReason, fromRouter } from "../router.ts";
import type { OrderResult } from "../payments/port.ts";
import {
    approvalMeta,
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
import { describeSize, quoted } from "./quote.ts";
import { fetchAfterStart, sentence, sourceView, type SourceView } from "./source.ts";

export { describeSize } from "./quote.ts";

export const stateName: Record<PlacementState, string> = {
    [PlacementState.UNSPECIFIED]: "unknown",
    [PlacementState.PLACING]: "starting",
    [PlacementState.READY]: "ready",
    [PlacementState.TERMINATING]: "stopping",
    [PlacementState.TERMINATED]: "ended",
    [PlacementState.FAILED]: "failed",
};

// The codes in Placement.termination_reason, in plain words that never name a provider
const terminationWords: Record<string, string> = {
    stop: "stopped with bugnet_stop",
    deadline: "ended at its deadline",
    abuse: "ended for a terms violation",
    control_lost: "ended because Bugnet lost contact with it",
    provider_failed: "ended by the provider",
    sandbox_exited: "the sandbox stopped from inside, for example by a shutdown or a crash",
    wallet_blocked: "ended because the paying wallet is blocked",
    operator: "ended by a Bugnet operator",
};

export function terminationText(code: string): string {
    return Object.hasOwn(terminationWords, code) ? (terminationWords[code] as string) : "ended";
}

const aliasShape = /^[a-z0-9-]{1,40}$/;

function ended(s: PlacementState): boolean {
    return s === PlacementState.TERMINATED || s === PlacementState.FAILED;
}

interface PlacementView {
    state: string;
    packageId: string;
    deadline: string | null;
    timeLeft: string;
    failureReason?: string;
    refundable?: boolean;
    terminationReason?: string;
    sshAlias?: string;
    source?: SourceView;
    [key: string]: unknown;
}

function placementView(p: Placement | undefined, now: number): PlacementView {
    const deadline = p?.deadline ? timestampDate(p.deadline) : undefined;
    const source = sourceView(p?.bootstrap);
    return {
        state: p ? stateName[p.state] : "unknown",
        packageId: p?.packageId ?? "",
        deadline: deadline?.toISOString() ?? null,
        timeLeft: p && ended(p.state) ? "none, the sandbox has ended" : timeLeft(deadline, now),
        ...(p?.failureReason ? { failureReason: p.failureReason } : {}),
        ...(p?.state === PlacementState.FAILED ? { refundable: p.refundable } : {}),
        ...(p?.terminationReason
            ? { terminationReason: terminationText(p.terminationReason) }
            : {}),
        ...(p && aliasShape.test(p.sshAlias) ? { sshAlias: p.sshAlias } : {}),
        ...(source ? { source } : {}),
    };
}

function sshLine(alias: string | undefined): string {
    if (!alias) return "";
    return (
        `SSH alias ${alias}. bugnet_ssh takes the public key of ` +
        `ssh-keygen -t ed25519 -N "" -f ~/.ssh/bugnet_${alias}.`
    );
}

const startInput = z.object({
    quoteId: z.string().max(200).describe("quoteId from bugnet_quote or bugnet_assess"),
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

function refusal(packageId: string, o: PackageOption, open?: string[]): GatewayError {
    const why =
        o.unavailableReason === "no_candidate"
            ? "is busy now, try again soon"
            : o.unavailableReason === "feature_unavailable"
              ? "is not open yet for these needs"
              : "cannot start right now";
    const others = open && open.length > 0 ? `. The packages open now are ${open.join(", ")}` : "";
    return new GatewayError("invalid", `package ${packageId} ${why}${others}`);
}

// Routers before PricePackage answer Unimplemented, and Estimate still prices the package for them
async function priceForStart(
    deps: Deps,
    packageId: string,
    claims: QuoteClaims,
): Promise<PackageOption> {
    const requirements = claims.requirements;
    let option: PackageOption | undefined;
    try {
        const res = await deps.router.pricePackage(
            { packageId, requirements },
            { signal: AbortSignal.timeout(15_000) },
        );
        option = res.option;
    } catch (e) {
        if (!(e instanceof ConnectError)) throw e;
        if (e.code === Code.InvalidArgument && errorReason(e) === null) {
            throw new GatewayError(
                "invalid",
                `package ${packageId} is not on offer, bugnet_quote lists the packages`,
            );
        }
        if (e.code !== Code.Unimplemented) throw e;
        const est = await deps.router.estimate(
            { requirements },
            { signal: AbortSignal.timeout(15_000) },
        );
        option = est.options.find((o) => o.packageId === packageId);
        if (option && !option.available) {
            const open = est.options.filter((o) => o.available).map((o) => o.packageId);
            throw refusal(packageId, option, open);
        }
    }
    if (!option) {
        throw new GatewayError(
            "invalid",
            `package ${packageId} is not on offer, bugnet_quote lists the packages`,
        );
    }
    if (!option.available) throw refusal(packageId, option);
    return option;
}

export const registerSandboxTools: Register = (server, deps) => {
    server.registerTool(
        "bugnet_start",
        {
            title: "Start a paid Bugnet sandbox",
            description:
                "Starts a cloud sandbox from a quote and charges the package price in USDC. " +
                "Only call it after the user agreed to the price. Returns the sandbox handle, " +
                "the only key to the sandbox, or a payment step to complete first. When the " +
                "quote named a GitHub repo, the ready sandbox has it at ~/src/<repo>.",
            inputSchema: startInput,
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: true,
            },
            _meta: approvalMeta(deps),
        },
        async (args, ctx) => {
            try {
                let claims: QuoteClaims;
                try {
                    claims = verifyQuote(deps.config.secrets.quoteKey, args.quoteId, deps.now());
                } catch (e) {
                    if (e instanceof QuoteError) throw new GatewayError("invalid", e.message);
                    throw e;
                }
                const pkg = quoted(await priceForStart(deps, args.packageId, claims));
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
                        estimateId: claims.estimateId ?? "",
                    });
                } catch (e) {
                    const err = fromRouter(e, "start");
                    // Only these codes mean the router recorded nothing, so Payments refunds it
                    const outright =
                        e instanceof ConnectError &&
                        (e.code === Code.PermissionDenied || e.code === Code.InvalidArgument);
                    if (outright) {
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
                const ready = p?.state === PlacementState.READY;
                const view = placementView(p, deps.now());
                if (ready && claims.github) view.source = await fetchAfterStart(deps, handle);
                const meta =
                    order.paymentResponse !== undefined
                        ? { "x402/payment-response": order.paymentResponse }
                        : undefined;
                const text = [
                    `Sandbox ${view.state}. handle: ${handle}`,
                    ready ? `Time left: ${view.timeLeft} (deadline ${view.deadline}).` : "",
                    p?.state === PlacementState.PLACING
                        ? "Still starting, call bugnet_status with the handle and waitSeconds 25."
                        : "",
                    p?.state === PlacementState.FAILED
                        ? `It failed to start${p.refundable ? ", the payment will be refunded" : ""}.`
                        : "",
                    view.source ? sentence(view.source.note) : "",
                    sshLine(view.sshAlias),
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
                "State, deadline, time left and extension prices of a sandbox, why it ended, " +
                "its SSH alias and where its repo is. Everything is deleted at the deadline, " +
                "so download results first, or extend with bugnet_extend once the user agrees. " +
                "waitSeconds waits for the state to change, for example while it is starting.",
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
                    view.terminationReason ? sentence(view.terminationReason) : "",
                    view.source && !(p && ended(p.state)) ? sentence(view.source.note) : "",
                    ready ? sshLine(view.sshAlias) : "",
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
