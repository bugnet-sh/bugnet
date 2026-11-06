import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
    BootstrapState,
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
    handleTag,
    ok,
    timeLeft,
    toolUseId,
    usd,
    waitMs,
    withProgress,
    type Deps,
    type Register,
    handleInput,
} from "./common.ts";
import { describeSize, quoted, unavailableWords } from "./quote.ts";
import { fetchAfterStart, sentence, sourceView, unplacedNote, type SourceView } from "./source.ts";

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
// A code such as no_candidate, never free text that could carry a provider's words
const failureCode = /^[a-z0-9_]{1,64}$/i;

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
        ...(p && failureCode.test(p.failureReason) ? { failureReason: p.failureReason } : {}),
        ...(p?.state === PlacementState.FAILED ? { refundable: p.refundable } : {}),
        ...(p?.terminationReason
            ? { terminationReason: terminationText(p.terminationReason) }
            : {}),
        // Names the key file for bugnet_ssh before the key exists
        ...(p && !ended(p.state) && aliasShape.test(p.sshAlias) ? { sshAlias: p.sshAlias } : {}),
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

// Claude Code shows the model only structuredContent, so the guide rides beside the x402 fields
export function paymentRequiredResult(r: Extract<OrderResult, { status: "payment_required" }>) {
    const guide = [
        `Payment required for order ${r.orderId}.`,
        "If an x402-capable wallet is connected it pays automatically.",
        r.payUrl ? `Otherwise the user can pay at ${r.payUrl}.` : "",
        `After paying, call the same tool again with orderId "${r.orderId}".`,
    ]
        .filter(Boolean)
        .join(" ");
    const result: CallToolResult = {
        isError: true,
        structuredContent: {
            ...(r.paymentRequired as unknown as Record<string, unknown>),
            message: guide,
            orderId: r.orderId,
            ...(r.payUrl ? { payUrl: r.payUrl } : {}),
        },
        // The x402 MCP transport reads the requirement from the first text block
        content: [
            { type: "text", text: JSON.stringify(r.paymentRequired) },
            { type: "text", text: guide },
        ],
    };
    return result;
}

// Requirements 12 gives every tool 45 s, and Codex aborts at 60 s, so a start plans within 40 s
export const startBudgetMs = 40_000;
// What CreatePlacement and a first look at the sandbox need after the payment
const placeReserveMs = 12_000;
// The repo fetch's own cap, left out when less than this remains
const fetchMs = 5_000;

class Budget {
    private readonly until: number;
    constructor(private readonly now: () => number) {
        this.until = now() + startBudgetMs;
    }
    left(): number {
        return Math.max(0, this.until - this.now());
    }
    // A signal for one step, cut to its own cap and to what the call has left
    signal(capMs: number, keepMs = 0): AbortSignal {
        return AbortSignal.timeout(Math.max(1, Math.min(capMs, this.left() - keepMs)));
    }
}

// After the payment, a failure that does not prove the router recorded nothing leaves the order open
function afterPayment(err: GatewayError, orderId: string): GatewayError {
    const unsure = ["timeout", "unavailable", "internal"].includes(err.kind);
    if (!unsure) return err;
    return new GatewayError(
        err.kind,
        `${err.message}. Order ${orderId} was paid and may still start a sandbox, so tell the ` +
            "user before starting another",
        err.retryAfterMs,
        err.reason,
    );
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
    const why = unavailableWords(o.unavailableReason);
    const others = open && open.length > 0 ? `. The packages open now are ${open.join(", ")}` : "";
    return new GatewayError("invalid", `package ${packageId} is ${why}${others}`);
}

// Routers before PricePackage answer Unimplemented, and Estimate still prices the package for them
async function priceForStart(
    deps: Deps,
    packageId: string,
    claims: QuoteClaims,
    signal: () => AbortSignal,
): Promise<PackageOption> {
    const requirements = claims.requirements;
    let option: PackageOption | undefined;
    try {
        const res = await deps.router.pricePackage(
            { packageId, requirements },
            { signal: signal() },
        );
        option = res.option;
    } catch (e) {
        if (!(e instanceof ConnectError)) throw e;
        const reason = errorReason(e);
        if (e.code === Code.InvalidArgument && reason === "NOT_START_PACKAGE") {
            throw new GatewayError(
                "invalid",
                `package ${packageId} only extends a running sandbox with bugnet_extend, a start ` +
                    "takes a package bugnet_quote lists",
            );
        }
        if (e.code === Code.InvalidArgument && (reason === null || reason === "PACKAGE_UNKNOWN")) {
            throw new GatewayError(
                "invalid",
                `package ${packageId} is not on offer, bugnet_quote lists the packages`,
            );
        }
        if (e.code !== Code.Unimplemented) throw e;
        const est = await deps.router.estimate({ requirements }, { signal: signal() });
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
                "quote named a GitHub repo, the result says where the repo is or how to get it.",
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
                const budget = new Budget(deps.now);
                const pkg = quoted(
                    await priceForStart(deps, args.packageId, claims, () =>
                        budget.signal(15_000, placeReserveMs),
                    ),
                );
                const priced = Number.parseFloat(args.confirmPriceUsd.replace(/^\$/, ""));
                if (!Number.isFinite(priced) || Math.abs(priced * 1e6 - pkg.priceMicros) > 0.5) {
                    throw new GatewayError(
                        "invalid",
                        `${args.packageId} costs ${usd(pkg.priceMicros)}, tell the user that price ` +
                            "and pass it as confirmPriceUsd",
                    );
                }
                if (budget.left() < placeReserveMs + 5_000) {
                    throw new GatewayError(
                        "timeout",
                        "start: Bugnet answered slowly, so nothing was charged. Calling " +
                            "bugnet_start again starts it",
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
                    budget.signal(30_000, placeReserveMs),
                );
                if (order.status === "payment_required") return paymentRequiredResult(order);
                if (order.status === "refused") {
                    throw new GatewayError("denied", `payment refused: ${order.reason}`);
                }
                let created;
                try {
                    created = await deps.router.createPlacement(
                        {
                            orderToken: order.orderToken,
                            requirements: claims.requirements,
                            estimateId: claims.estimateId ?? "",
                        },
                        { signal: AbortSignal.timeout(Math.max(budget.left(), placeReserveMs)) },
                    );
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
                    throw afterPayment(err, order.orderId);
                }
                const handle = created.handle;
                const keep = claims.github ? fetchMs + 1_000 : 0;
                const waitBudget = Math.min(25_000, budget.left() - keep);
                // Past the deadline the handle still goes back, as a sandbox that is starting
                const p = await withProgress(ctx, "starting the sandbox", (signal) =>
                    waitReady(deps, handle, created.placement, waitBudget, signal),
                ).catch((e: unknown) => {
                    deps.log.warn("wait for ready failed", { handle: handleTag(handle) });
                    if (created.placement) return created.placement;
                    throw e;
                });
                deps.log.info("placement started", {
                    handle: handleTag(handle),
                    state: p ? stateName[p.state] : "unknown",
                });
                const ready = p?.state === PlacementState.READY;
                const view = placementView(p, deps.now());
                if (ready && claims.github && budget.left() >= fetchMs) {
                    view.source = await fetchAfterStart(deps, handle, fetchMs);
                } else if (claims.githubUnplaced) {
                    view.source = { state: "not_fetched", note: unplacedNote };
                }
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
                // A start that saw the sandbox still starting left the fetch to the first look at it ready
                if (ready && p?.bootstrap?.state === BootstrapState.PENDING) {
                    view.source = await fetchAfterStart(deps, args.handle, fetchMs);
                }
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
                const deadline = p?.deadline ? timestampDate(p.deadline).getTime() : Infinity;
                // Placement has no end time, and a sandbox never runs past its deadline
                const end = Math.min(deps.now(), deadline);
                const usedSeconds = ready ? Math.max(0, Math.round((end - ready) / 1000)) : 0;
                const view = { ...placementView(p, deps.now()), usedSeconds };
                return ok(`Sandbox ${view.state}, used for about ${usedSeconds} s.`, view);
            } catch (e) {
                return failure(e, "stop");
            }
        },
    );
};
