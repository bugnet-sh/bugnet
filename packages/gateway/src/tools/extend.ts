import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { z } from "zod";
import type { PackageOption, Placement } from "../gen/bugnet/router/v1/router_pb.ts";
import { GatewayError, errorReason, fromRouter } from "../router.ts";
import {
    handleHash,
    handlePattern,
    handleTag,
    ok,
    sandboxFailure,
    timeLeft,
    toolUseId,
    usd,
    type Deps,
    type Register,
} from "./common.ts";
import { describeSize, paymentRequiredResult } from "./sandbox.ts";

const handleInput = z.string().regex(handlePattern, "a sandbox handle starting with sbx_");

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

type Applied = { placement: Placement | undefined } | { ambiguous: true } | { refused: Error };

// Retries an extension whose answer was lost, since the same order token applies at most once
async function applyExtension(deps: Deps, handle: string, orderToken: string): Promise<Applied> {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await deps.router.extendPlacement({ handle, orderToken });
            return { placement: res.placement };
        } catch (e) {
            const code = e instanceof ConnectError ? e.code : null;
            if (attempt === 0 && code !== null && notApplied.has(code))
                return { refused: e as Error };
            if (attempt > 0 && code === Code.PermissionDenied) return { ambiguous: true };
            if (attempt > 0 && code !== null && notApplied.has(code)) {
                return { refused: e as Error };
            }
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
    }
    return { ambiguous: true };
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
            inputSchema: z.object({
                handle: handleInput,
                packageId: z.string().max(100),
                confirmPriceUsd: z
                    .string()
                    .max(20)
                    .describe(
                        "The extension price you told the user, shown in the approval prompt",
                    ),
                orderId: z.string().max(200).optional(),
                payment: z.unknown().optional(),
            }),
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
                let check;
                try {
                    check = await deps.router.checkExtendPlacement({
                        handle: args.handle,
                        packageId: args.packageId,
                    });
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
                if (!pkg) throw new GatewayError("internal", "extend: the router gave no price");
                const price = Number(pkg.priceMicros);
                const priced = Number.parseFloat(args.confirmPriceUsd.replace(/^\$/, ""));
                if (!Number.isFinite(priced) || Math.abs(priced * 1e6 - price) > 0.5) {
                    throw new GatewayError(
                        "invalid",
                        `extend: ${pkg.packageId} costs ${usd(price)}, tell the user that price ` +
                            "and pass it as confirmPriceUsd",
                    );
                }
                const payment = ctx.mcpReq._meta?.["x402/payment"] ?? args.payment;
                const key = toolUseId(ctx);
                const order = await deps.payments.order(
                    {
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
                    },
                    AbortSignal.timeout(30_000),
                );
                if (order.status === "payment_required") return paymentRequiredResult(order);
                if (order.status === "refused") {
                    throw new GatewayError("denied", `payment refused: ${order.reason}`);
                }
                const applied = await applyExtension(deps, args.handle, order.orderToken);
                if ("refused" in applied) {
                    await deps.payments
                        .abandon(order.orderId, "not_applied", AbortSignal.timeout(10_000))
                        .catch((x) => deps.log.error("abandon failed", { err: String(x) }));
                    const err = fromRouter(applied.refused, "extend");
                    throw new GatewayError(
                        err.kind,
                        `${err.message}. The extension was not applied and the payment is refunded`,
                    );
                }
                if ("ambiguous" in applied) {
                    throw new GatewayError(
                        "unavailable",
                        "extend: the sandbox service did not confirm the extension. Check the " +
                            "deadline with bugnet_status before paying again",
                    );
                }
                const p = applied.placement;
                const deadline = p?.deadline ? timestampDate(p.deadline) : undefined;
                deps.log.info("placement extended", {
                    handle: handleTag(args.handle),
                    orderId: order.orderId,
                });
                const left = timeLeft(deadline, deps.now());
                const meta =
                    order.paymentResponse !== undefined
                        ? { "x402/payment-response": order.paymentResponse }
                        : undefined;
                return ok(
                    `Extended by ${pkg.minutes} min. New deadline ${deadline?.toISOString()}, ` +
                        `time left ${left}.`,
                    {
                        orderId: order.orderId,
                        packageId: pkg.packageId,
                        deadline: deadline?.toISOString() ?? null,
                        timeLeft: left,
                    },
                    meta,
                );
            } catch (e) {
                return sandboxFailure(deps, args.handle, e, "extend");
            }
        },
    );
};
