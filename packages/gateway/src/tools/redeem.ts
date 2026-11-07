// Finishes an order paid outside the MCP client, keeping nothing between calls
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { X402ServiceInfo } from "../gen/bugnet/router/v1/router_pb.ts";
import type { OrderResult, PaidAllowanceOrder } from "../payments/port.ts";
import { GatewayError } from "../router.ts";
import { QuoteError, verifyQuote, type QuoteClaims } from "../quote.ts";
import { indexOf } from "../x402/index.ts";
import {
    buildView,
    paidOrderRefusal,
    paidRetryUnreachable,
    withRefusal,
    x402Fail,
    x402Lines,
} from "../x402/render.ts";
import {
    enableRequestId,
    enableServices,
    enableWaitMs,
    hasOwnReason,
    viewChanges,
} from "../x402/router.ts";
import { readTerms } from "../x402/terms.ts";
import {
    Budget,
    failure,
    handleHash,
    handleInput,
    ok,
    sandboxFailure,
    type Deps,
    type Register,
} from "./common.ts";
import { extendPaid } from "./extend.ts";
import { claimInput, paymentRequiredResult, refusalError, retryCall } from "./orders.ts";
import { placeReserveMs, startPaid } from "./sandbox.ts";

export const redeemInput = z.object({
    orderId: z.string().max(200).describe("orderId from the payment step"),
    claim: claimInput.describe("claim from the payment step"),
    quoteId: z
        .string()
        .max(200)
        .optional()
        .describe("the quoteId bugnet_start was called with, for a new sandbox"),
    handle: handleInput.optional().describe("the sandbox's handle, for an order that adds time"),
});

// The redeem's own words for an error that names its order, so a client reading fields gets it
function orderError(orderId: string, text: string): GatewayError {
    return new GatewayError("invalid", text, null, null, { orderId });
}

// Enables a paid allowance's services from the stored answer, as the budget tool's paid retry does
async function redeemAllowance(
    deps: Deps,
    ctx: ServerContext,
    handle: string,
    order: PaidAllowanceOrder,
    claim: string,
    budget: Budget,
): Promise<CallToolResult> {
    const id = order.orderId;
    const terms = await readTerms(deps, budget.signal(3_000));
    if (terms === null) {
        throw paidRetryUnreachable("x402", "bugnet_redeem", id, { claim, handle: true });
    }
    let services: X402ServiceInfo[];
    try {
        services = await enableServices(
            deps,
            {
                handle,
                ...viewChanges(order.x402),
                requestId: enableRequestId(ctx, ["x402-redeem", id]),
                waitActive: true,
            },
            budget.signal(enableWaitMs),
        );
    } catch (e) {
        if (hasOwnReason(e, "NOT_READY")) {
            throw withRefusal(
                x402Fail("paidRefused", "x402", {
                    reason: "sandbox_ended",
                    refundPending: true,
                    amountMicros: order.amountMicros,
                }),
                id,
                "sandbox_ended",
            );
        }
        // No refusal word, so a client keeps the order whose retry by claim enables it for free
        throw x402Fail("paidNotEnabled", "x402", { amountMicros: order.allowanceMicros });
    }
    const view = buildView({
        account: order.x402,
        feeDue: false,
        router: services,
        refusals: [],
        terms,
        index: indexOf(deps),
    });
    return ok(x402Lines(view, { firstUse: order.firstUse, terms }).join("\n"), {
        handle,
        orderId: id,
        firstUse: order.firstUse,
        x402: view,
    });
}

export const registerRedeemTool: Register = (server, deps) => {
    server.registerTool(
        "bugnet_redeem",
        {
            title: "Redeem a Bugnet order (free)",
            description:
                "Finishes an order the user paid at its pay link, at no extra cost: starts the " +
                "sandbox, or adds the time to one. Pass the orderId and claim from the payment " +
                "step, plus the quoteId for a new sandbox or the handle for more time. Call it " +
                "once the user says they paid.",
            inputSchema: redeemInput,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            // The wallet signature was the payment approval, so this tool asks for none
        },
        async (args, ctx) => {
            const { orderId, claim, quoteId, handle } = args;
            try {
                let claims: QuoteClaims | undefined;
                if (quoteId !== undefined) {
                    try {
                        claims = verifyQuote(deps.config.secrets.quoteKey, quoteId, deps.now(), {
                            allowExpired: true,
                        });
                    } catch (e) {
                        if (!(e instanceof QuoteError)) throw e;
                        throw new GatewayError(
                            "invalid",
                            `${e.message}. Keep orderId "${orderId}" and claim "${claim}" on the ` +
                                "next bugnet_redeem, so the order is not paid twice",
                        );
                    }
                }
                const budget = new Budget(deps);
                let order: OrderResult;
                try {
                    // Keeps EnableX402's wait for an allowance, which an extension fits in too
                    order = await deps.payments.order(
                        {
                            orderId,
                            claim,
                            ...(handle !== undefined ? { handleSha256: handleHash(handle) } : {}),
                        },
                        budget.signal(30_000, handle !== undefined ? enableWaitMs : placeReserveMs),
                    );
                } catch {
                    // A redeem is a retry by claim, so the user may have paid
                    throw paidRetryUnreachable("redeem", "bugnet_redeem", orderId, {
                        claim,
                        ...(quoteId !== undefined
                            ? { quoteId }
                            : handle !== undefined
                              ? { handle: true }
                              : {}),
                    });
                }
                if (order.status === "payment_required") {
                    return paymentRequiredResult(order, {
                        tool: "bugnet_redeem",
                        sentOrderId: orderId,
                        sentClaim: claim,
                        ...(quoteId !== undefined ? { quoteId } : {}),
                        withHandle: handle !== undefined,
                    });
                }
                if (order.status === "refused") {
                    throw (
                        paidOrderRefusal(
                            order,
                            quoteId !== undefined ? "start" : "x402",
                            orderId,
                        ) ??
                        refusalError(order, "redeem", "bugnet_redeem", {
                            sentOrderId: orderId,
                            handleSent: handle !== undefined,
                        })
                    );
                }
                const id = order.orderId;
                if (order.kind === "allowance") {
                    if (handle === undefined) {
                        throw orderError(
                            id,
                            `redeem: order ${id} is paid and adds x402 allowance to a sandbox. ` +
                                "Call bugnet_x402_budget with that sandbox's handle, the same " +
                                `amountUsd and confirmPriceUsd, orderId "${id}" and claim ` +
                                `"${claim}"`,
                        );
                    }
                    if (order.handleSha256 !== handleHash(handle)) {
                        throw orderError(
                            id,
                            `redeem: order ${id} is not for that sandbox, check the handle`,
                        );
                    }
                    return await redeemAllowance(deps, ctx, handle, order, claim, budget);
                }
                if (order.kind === "start") {
                    if (!claims) {
                        throw orderError(
                            id,
                            `redeem: order ${id} is paid and starts a new sandbox. Call ` +
                                `bugnet_redeem again with orderId "${id}", claim "${claim}" and ` +
                                "quoteId, the quoteId bugnet_start was called with",
                        );
                    }
                    return await startPaid(deps, ctx, claims, order, budget, {
                        retry: retryCall("bugnet_redeem", id, {
                            claim,
                            ...(quoteId ? { quoteId } : {}),
                        }),
                    });
                }
                if (handle === undefined) {
                    throw orderError(
                        id,
                        `redeem: order ${id} is paid and adds time to a sandbox. Call ` +
                            "bugnet_extend with that sandbox's handle, the same packageId and " +
                            `confirmPriceUsd, orderId "${id}" and claim "${claim}"`,
                    );
                }
                if (order.handleSha256 !== handleHash(handle)) {
                    throw orderError(
                        id,
                        `redeem: order ${id} is not for that sandbox, check the handle`,
                    );
                }
                return await extendPaid(deps, handle, order, budget, {
                    minutes: null,
                    retry: retryCall("bugnet_redeem", id, { claim, handle: true }),
                });
            } catch (e) {
                return handle !== undefined
                    ? await sandboxFailure(deps, handle, e, "redeem")
                    : failure(e, "redeem");
            }
        },
    );
};
