import { setTimeout as sleep } from "node:timers/promises";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PackageOption, Placement } from "../gen/bugnet/router/v1/router_pb.ts";
import type { OrderRequest, PaidOrder } from "../payments/port.ts";
import { toolCallSignal } from "../request.ts";
import { GatewayError, errorReason, fromRouter } from "../router.ts";
import {
    approvalMeta,
    Budget,
    handleHash,
    handleTag,
    ok,
    sandboxFailure,
    timeLeft,
    toolUseId,
    usd,
    type Deps,
    type Register,
    handleInput,
} from "./common.ts";
import {
    abandonedFields,
    claimAsked,
    claimInput,
    isPaidRetry,
    paymentRequiredResult,
    refusalError,
    retryCall,
} from "./orders.ts";
import { describeSize } from "./sandbox.ts";

// A first refusal with these codes means the router recorded nothing, so the order is refunded
const notApplied = new Set([
    Code.PermissionDenied,
    Code.InvalidArgument,
    Code.NotFound,
    Code.FailedPrecondition,
]);

export interface ExtensionView {
    packageId: string;
    minutes: number;
    priceUsd: string;
    available: boolean;
    reason?: string;
}

export function extensionView(o: PackageOption): ExtensionView {
    return {
        packageId: o.packageId,
        minutes: o.minutes,
        priceUsd: usd(o.priceMicros),
        available: o.available,
        ...(o.unavailableReason ? { reason: o.unavailableReason } : {}),
    };
}

// Lists the ways to extend a sandbox, empty when the router cannot say
export async function extensionsFor(deps: Deps, handle: string): Promise<ExtensionView[]> {
    try {
        const res = await deps.router.listExtensions({ handle });
        return res.options.map(extensionView);
    } catch {
        return [];
    }
}

// What ExtendPlacement and its retries need after the payment
const applyReserveMs = 8_000;
// Less than this left sends no further ExtendPlacement
const attemptMs = 1_000;

type Applied =
    | { placement: Placement | undefined }
    | { ambiguous: true }
    | { refused: Error }
    | { unsent: true };

// Retries an extension whose answer was lost, since the same order token applies at most once
async function applyExtension(
    deps: Deps,
    handle: string,
    orderToken: string,
    budget: Budget,
): Promise<Applied> {
    const tool = toolCallSignal();
    for (let attempt = 0; attempt < 3; attempt++) {
        if (tool?.aborted || budget.left() < attemptMs) {
            return attempt === 0 ? { unsent: true } : { ambiguous: true };
        }
        try {
            const res = await deps.router.extendPlacement(
                { handle, orderToken },
                { timeoutMs: budget.ms(deps.config.router.timeout) },
            );
            return { placement: res.placement };
        } catch (e) {
            const code = e instanceof ConnectError ? e.code : null;
            if (attempt === 0 && code !== null && notApplied.has(code))
                return { refused: e as Error };
            if (attempt > 0 && code === Code.PermissionDenied) return { ambiguous: true };
            if (attempt > 0 && code !== null && notApplied.has(code)) {
                return { refused: e as Error };
            }
            const pause = 1000 * (attempt + 1);
            if (attempt === 2 || budget.left() < pause + attemptMs) break;
            try {
                await sleep(pause, undefined, tool ? { signal: tool } : {});
            } catch {
                break;
            }
        }
    }
    return { ambiguous: true };
}

export interface ExtendPaidOptions {
    minutes: number | null;
    retry: string;
}

// Applies a paid extension order, retrying while the router's answer is lost
export async function extendPaid(
    deps: Deps,
    handle: string,
    order: PaidOrder,
    budget: Budget,
    opts: ExtendPaidOptions,
): Promise<CallToolResult> {
    const applied = await applyExtension(deps, handle, order.orderToken, budget);
    if ("refused" in applied) {
        await deps.payments
            .abandon(order.orderId, "not_applied", budget.lastSignal(10_000))
            .catch((x) => deps.log.error("abandon failed", { err: String(x) }));
        const err = fromRouter(applied.refused, "extend");
        // A not_ready kind would let sandboxFailure swap the refund sentence for "has ended"
        throw new GatewayError(
            err.kind === "not_ready" ? "precondition" : err.kind,
            `${err.message}. The extension was not applied and the payment is refunded`,
            null,
            null,
            abandonedFields(order.orderId),
        );
    }
    if ("unsent" in applied) {
        throw new GatewayError(
            "timeout",
            `extend: order ${order.orderId} is paid, but too little time was left to ` +
                `apply it. ${opts.retry} applies it`,
        );
    }
    if ("ambiguous" in applied) {
        throw new GatewayError(
            "unavailable",
            "extend: the sandbox service did not confirm the extension. Check the " +
                "deadline with bugnet_status before paying again, and if it did not " +
                `move, ${opts.retry} applies the paid order`,
        );
    }
    const p = applied.placement;
    const deadline = p?.deadline ? timestampDate(p.deadline) : undefined;
    deps.log.info("placement extended", {
        handle: handleTag(handle),
        orderId: order.orderId,
    });
    const left = timeLeft(deadline, deps.now());
    const meta =
        order.paymentResponse !== undefined
            ? { "x402/payment-response": order.paymentResponse }
            : undefined;
    return ok(
        (opts.minutes !== null
            ? `Extended by ${opts.minutes} min.`
            : `Extended with ${order.packageId}.`) +
            ` New deadline ${deadline?.toISOString()}, time left ${left}.`,
        {
            orderId: order.orderId,
            packageId: order.packageId,
            deadline: deadline?.toISOString() ?? null,
            timeLeft: left,
        },
        meta,
    );
}

export const registerExtendTool: Register = (server, deps) => {
    server.registerTool(
        "bugnet_extend",
        {
            title: "Extend a Bugnet sandbox (paid)",
            description:
                "Adds paid time to a running sandbox. bugnet_status lists the extension packages " +
                "with their prices. Only call it after the user agreed to the price, passed as " +
                "confirmPriceUsd. Returns the new deadline, or a payment step to complete first.",
            inputSchema: z
                .object({
                    handle: handleInput,
                    packageId: z.string().max(100),
                    confirmPriceUsd: z
                        .string()
                        .max(20)
                        .describe(
                            "The extension price you told the user, shown in the approval prompt",
                        ),
                    orderId: z.string().max(200).optional(),
                    claim: claimInput
                        .optional()
                        .describe("claim from the payment step, sent with its orderId"),
                    payment: z.unknown().optional(),
                })
                .refine((a) => a.claim === undefined || a.orderId !== undefined, {
                    message: "claim goes with the orderId of its payment step",
                    path: ["claim"],
                }),
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
                const payment = ctx.mcpReq._meta?.["x402/payment"] ?? args.payment;
                const paidRetry = isPaidRetry(args, payment);
                const key = toolUseId(ctx);
                const budget = new Budget(deps);
                let request: OrderRequest;
                let minutes: number | null = null;
                if (paidRetry) {
                    // The order holds its own terms, so the price is not asked again
                    request = {
                        orderId: args.orderId,
                        claim: args.claim,
                        handleSha256: handleHash(args.handle),
                        ...(key ? { idempotencyKey: key } : {}),
                    };
                } else {
                    let check;
                    try {
                        check = await deps.router.checkExtendPlacement(
                            { handle: args.handle, packageId: args.packageId },
                            { timeoutMs: budget.ms(15_000, applyReserveMs + 5_000) },
                        );
                    } catch (e) {
                        if (e instanceof ConnectError && e.code === Code.InvalidArgument) {
                            const options = await extensionsFor(deps, args.handle);
                            const list = options
                                .map((o) => `${o.packageId} (${o.priceUsd})`)
                                .join(", ");
                            throw new GatewayError(
                                "invalid",
                                `extend: ${args.packageId} does not extend this sandbox` +
                                    (list ? `, the options are ${list}` : ""),
                            );
                        }
                        if (e instanceof ConnectError && errorReason(e) === "EXCEEDS_LIFETIME") {
                            throw new GatewayError(
                                "invalid",
                                "extend: that would pass the longest time a sandbox can run, " +
                                    "download what you need before the deadline",
                            );
                        }
                        throw e;
                    }
                    const pkg = check.package;
                    if (!pkg)
                        throw new GatewayError("internal", "extend: the router gave no price");
                    const price = Number(pkg.priceMicros);
                    const priced = Number.parseFloat(args.confirmPriceUsd.replace(/^\$/, ""));
                    if (!Number.isFinite(priced) || Math.abs(priced * 1e6 - price) > 0.5) {
                        throw new GatewayError(
                            "invalid",
                            `extend: ${pkg.packageId} costs ${usd(price)}, tell the user that price ` +
                                "and pass it as confirmPriceUsd",
                        );
                    }
                    if (budget.left() < applyReserveMs + 5_000) {
                        throw new GatewayError(
                            "timeout",
                            "extend: Bugnet answered slowly, so nothing was charged. Calling " +
                                "bugnet_extend again extends it",
                        );
                    }
                    minutes = pkg.minutes;
                    // A claim never goes with a payment, which Payments settles before the claim
                    request = {
                        kind: "extend",
                        packageId: pkg.packageId,
                        amountMicros: price,
                        description:
                            `Bugnet sandbox extension, ${pkg.minutes} min` +
                            (pkg.resources ? ` on ${describeSize(pkg.resources)}` : ""),
                        handleSha256: handleHash(args.handle),
                        ...(args.orderId ? { orderId: args.orderId } : {}),
                        ...(payment !== undefined ? { payment } : {}),
                        ...(key ? { idempotencyKey: key } : {}),
                    };
                }
                let order = await deps.payments.order(
                    request,
                    budget.signal(30_000, applyReserveMs),
                );
                let byClaim = paidRetry;
                if (claimAsked(order, args, payment)) {
                    // Asking with the claim alone moves no money
                    order = await deps.payments.order(
                        {
                            orderId: args.orderId,
                            claim: args.claim,
                            handleSha256: handleHash(args.handle),
                            ...(key ? { idempotencyKey: key } : {}),
                        },
                        budget.signal(30_000, applyReserveMs),
                    );
                    byClaim = true;
                }
                if (order.status === "payment_required") {
                    return paymentRequiredResult(order, {
                        tool: "bugnet_extend",
                        ...(args.orderId ? { sentOrderId: args.orderId } : {}),
                        ...(args.claim ? { sentClaim: args.claim } : {}),
                        withHandle: true,
                    });
                }
                if (order.status === "refused") {
                    throw refusalError(order, "extend", "bugnet_extend", {
                        ...(args.orderId ? { sentOrderId: args.orderId } : {}),
                        ...(args.claim ? { sentClaim: args.claim } : {}),
                        paymentSent: payment !== undefined,
                    });
                }
                const id = order.orderId;
                if (order.kind !== "extend") {
                    const next = byClaim
                        ? retryCall("bugnet_redeem", id, { claim: args.claim }) +
                          ", plus the quoteId bugnet_start was called with"
                        : retryCall("bugnet_start", id, { payment: true });
                    throw new GatewayError(
                        "invalid",
                        `extend: order ${id} starts a new sandbox, call ${next}`,
                    );
                }
                if (order.handleSha256 !== handleHash(args.handle)) {
                    throw new GatewayError(
                        "invalid",
                        `extend: order ${id} is not for that sandbox, check the handle`,
                    );
                }
                return await extendPaid(deps, args.handle, order, budget, {
                    minutes,
                    retry: retryCall(
                        "bugnet_extend",
                        id,
                        byClaim
                            ? { claim: args.claim }
                            : payment !== undefined
                              ? { payment: true }
                              : {},
                    ),
                });
            } catch (e) {
                return sandboxFailure(deps, args.handle, e, "extend");
            }
        },
    );
};
