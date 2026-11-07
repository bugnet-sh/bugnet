// Finishes an order paid outside the MCP client, keeping nothing between calls
import { z } from "zod";
import { GatewayError } from "../router.ts";
import { QuoteError, verifyQuote, type QuoteClaims } from "../quote.ts";
import {
    Budget,
    failure,
    handleHash,
    handleInput,
    sandboxFailure,
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
                const order = await deps.payments.order(
                    {
                        orderId,
                        claim,
                        ...(handle !== undefined ? { handleSha256: handleHash(handle) } : {}),
                    },
                    budget.signal(30_000, placeReserveMs),
                );
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
                    throw refusalError(order, "redeem", "bugnet_redeem", {
                        sentOrderId: orderId,
                        handleSent: handle !== undefined,
                    });
                }
                const id = order.orderId;
                if (order.kind === "allowance") {
                    throw new GatewayError("invalid", "redeem: this order needs a newer gateway");
                }
                if (order.kind === "start") {
                    if (!claims) {
                        throw new GatewayError(
                            "invalid",
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
                    throw new GatewayError(
                        "invalid",
                        `redeem: order ${id} is paid and adds time to a sandbox. Call ` +
                            "bugnet_extend with that sandbox's handle, the same packageId and " +
                            `confirmPriceUsd, orderId "${id}" and claim "${claim}"`,
                    );
                }
                if (order.handleSha256 !== handleHash(handle)) {
                    throw new GatewayError(
                        "invalid",
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
