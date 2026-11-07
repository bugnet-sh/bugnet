import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
    PlacementState,
    type CreatePlacementRequest,
    type ExtendPlacementRequest,
} from "../gen/bugnet/router/v1/router_pb.ts";
import { signQuote } from "../quote.ts";
import {
    callTool,
    connectTools,
    devOrder,
    fakeRouter,
    placement,
    recordingLog,
    routerError,
    testDeps,
    testHandle,
    testNow,
    testPayments,
    tokenClaims,
    type RouterImpl,
    type TestPayments,
} from "../testing/harness.ts";
import { handleHash, type Deps } from "./common.ts";

const startTerms = {
    kind: "start",
    packageId: "small-30m",
    amountMicros: 250_000,
    description: "d",
} as const;
const extendTerms = {
    kind: "extend",
    packageId: "more-10m",
    amountMicros: 40_000,
    description: "d",
    handleSha256: handleHash(testHandle),
} as const;

function startRouter(created: CreatePlacementRequest[]): RouterImpl {
    return {
        createPlacement: (req) => {
            created.push(req);
            return { handle: testHandle, placement: placement(PlacementState.READY) };
        },
        getPlacement: () => ({ placement: placement(PlacementState.READY) }),
    };
}

function extendRouter(applied: ExtendPlacementRequest[]): RouterImpl {
    return {
        extendPlacement: (req) => {
            applied.push(req);
            return {
                placement: placement(PlacementState.READY, {
                    deadline: timestampFromMs(testNow + 20 * 60_000),
                }),
            };
        },
        checkExtendPlacement: () => {
            throw new Error("no check on a redeem");
        },
    };
}

async function setup(
    impl: RouterImpl,
    payments: TestPayments = testPayments(undefined, { requirePayment: true }),
) {
    const { log, lines } = recordingLog();
    const deps: Deps = testDeps({ router: fakeRouter(impl), payments, log });
    return { client: await connectTools(deps), deps, payments, lines };
}

const quote = (deps: Deps) =>
    signQuote(deps.config.secrets.quoteKey, {
        requirements: { ssh: true, preview: false, gpu: false, secrets: false },
        github: false,
        estimateId: "0f8b6c2e-41d7-4a3b-9c5e-7d2a1b3c4d5e",
        expiresAt: testNow - 60_000,
    });

describe("bugnet_redeem", () => {
    it("is free and carries no approval marker", async () => {
        const { client } = await setup({});
        const tool = (await client.listTools()).tools.find((t) => t.name === "bugnet_redeem");
        expect(tool?.title).toBe("Redeem a Bugnet order (free)");
        expect(tool?._meta?.["anthropic/requiresUserInteraction"]).toBeUndefined();
        expect(tool?.annotations).toEqual({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        });
    });

    it("starts a paid start order from an expired quote with orderId and claim only", async () => {
        const created: CreatePlacementRequest[] = [];
        const { client, deps, payments, lines } = await setup(startRouter(created));
        const { orderId, claim } = await devOrder(payments, startTerms);
        const r = await callTool(
            client,
            "bugnet_redeem",
            { orderId, claim, quoteId: quote(deps) },
            { toolUseId: "toolu_red" },
        );
        expect(r.isError).toBe(false);
        expect(r.structured).toEqual(expect.objectContaining({ handle: testHandle, orderId }));
        expect(payments.orders).toEqual([{ orderId, claim }]);
        expect(created[0]?.requirements?.ssh).toBe(true);
        expect(created[0]?.estimateId).toBe("0f8b6c2e-41d7-4a3b-9c5e-7d2a1b3c4d5e");
        expect(tokenClaims(created[0]?.orderToken as string).order_id).toBe(orderId);
        expect(lines.join("\n")).not.toContain(claim);
    });

    it("asks for the quoteId when a start order comes without it", async () => {
        const created: CreatePlacementRequest[] = [];
        const { client, payments } = await setup(startRouter(created));
        const { orderId, claim } = await devOrder(payments, startTerms);
        const r = await callTool(client, "bugnet_redeem", { orderId, claim });
        expect(r.text).toBe(
            `redeem: order ${orderId} is paid and starts a new sandbox. Call bugnet_redeem again ` +
                `with orderId "${orderId}", claim "${claim}" and quoteId, the quoteId ` +
                "bugnet_start was called with.",
        );
        expect(created).toEqual([]);
    });

    it("refuses a handle on a start order", async () => {
        const { client, deps, payments } = await setup(startRouter([]));
        const { orderId, claim } = await devOrder(payments, startTerms);
        const r = await callTool(client, "bugnet_redeem", {
            orderId,
            claim,
            quoteId: quote(deps),
            handle: testHandle,
        });
        const text =
            `redeem: order ${orderId} is not for that sandbox. Check the handle, and leave it ` +
            "out when the order starts a new sandbox.";
        expect(r.text).toBe(text);
        expect(r.structured).toEqual({ message: text, orderId, refusal: "terms_mismatch" });
    });

    it("extends with the right handle from the stored order", async () => {
        const applied: ExtendPlacementRequest[] = [];
        const { client, payments, lines } = await setup(extendRouter(applied));
        const { orderId, claim } = await devOrder(payments, extendTerms);
        const r = await callTool(client, "bugnet_redeem", { orderId, claim, handle: testHandle });
        expect(r.structured).toEqual({
            message:
                "Extended with more-10m. New deadline 2026-11-05T12:20:00.000Z, time left 20 min.",
            orderId,
            packageId: "more-10m",
            deadline: "2026-11-05T12:20:00.000Z",
            timeLeft: "20 min",
        });
        expect(payments.orders).toEqual([{ orderId, claim, handleSha256: handleHash(testHandle) }]);
        expect(applied).toHaveLength(1);
        expect(lines.join("\n")).not.toContain(claim);
    });

    it("sends an extend order without a handle to bugnet_extend, the same each time", async () => {
        const applied: ExtendPlacementRequest[] = [];
        const { client, payments } = await setup(extendRouter(applied));
        const { orderId, claim } = await devOrder(payments, extendTerms);
        const text =
            `redeem: order ${orderId} is paid and adds time to a sandbox. Call bugnet_extend ` +
            "with that sandbox's handle, the same packageId and confirmPriceUsd, orderId " +
            `"${orderId}" and claim "${claim}".`;
        expect((await callTool(client, "bugnet_redeem", { orderId, claim })).text).toBe(text);
        expect((await callTool(client, "bugnet_redeem", { orderId, claim })).text).toBe(text);
        expect(payments.orders).toEqual([
            { orderId, claim },
            { orderId, claim },
        ]);
        expect(applied).toEqual([]);
    });

    it("refuses a handle the paid order was not made for", async () => {
        const applied: ExtendPlacementRequest[] = [];
        const other = `sbx_${"b".repeat(26)}`;
        const payments = testPayments(() => ({
            status: "paid",
            orderId: "ord_w",
            orderToken: "t",
            payer: "P",
            kind: "extend",
            packageId: "more-10m",
            amountMicros: 40_000,
            handleSha256: handleHash(other),
        }));
        const { client } = await setup(extendRouter(applied), payments);
        const r = await callTool(client, "bugnet_redeem", {
            orderId: "ord_w",
            claim: "C".repeat(43),
            handle: testHandle,
        });
        expect(r.text).toBe("redeem: order ord_w is not for that sandbox, check the handle.");
        expect(applied).toEqual([]);
    });

    it("says an order is not paid yet and opens no new one", async () => {
        const { client, deps, payments } = await setup(startRouter([]));
        const { orderId, claim } = await devOrder(payments, startTerms, { paid: false });
        const quoteId = quote(deps);
        const r = await callTool(client, "bugnet_redeem", { orderId, claim, quoteId });
        expect(r.isError).toBe(true);
        expect(r.text.split("\n")[1]).toBe(
            `Order ${orderId} is not paid yet, and a payment can take a few seconds to confirm. ` +
                `Next: pay at http://127.0.0.1:8787/o/${orderId} with a Solana wallet holding ` +
                `USDC, then call bugnet_redeem with orderId and claim (orderId "${orderId}", ` +
                `claim "${claim}", quoteId "${quoteId}"). Show the user the link, since they pay ` +
                "in their own browser. The x402 maxTimeoutSeconds limits a wallet's signed " +
                "payment, not the user's time to pay.",
        );
        expect(payments.orders).toEqual([{ orderId, claim }]);
        expect(payments.dev.status(orderId).body.state).toBe("unpaid");
    });

    it("asks to call again while the payment is still confirming", async () => {
        const payments = testPayments(() => ({
            status: "refused",
            orderId: "ord_s",
            reason: "settling",
            retryAfterSeconds: 2,
        }));
        const { client } = await setup({}, payments);
        const r = await callTool(client, "bugnet_redeem", {
            orderId: "ord_s",
            claim: "C".repeat(43),
        });
        expect(r.text).toBe(
            "redeem: the payment for order ord_s is still confirming. Call again with the same " +
                "orderId and claim, and do not pay again. Retry after 2 s.",
        );
    });

    it("gives two clients redeeming one order the same token and the same sandbox", async () => {
        const created: CreatePlacementRequest[] = [];
        const { client, deps, payments } = await setup(startRouter(created));
        const other = await connectTools(deps);
        const { orderId, claim } = await devOrder(payments, startTerms);
        const args = { orderId, claim, quoteId: quote(deps) };
        const a = await callTool<{ handle: string }>(client, "bugnet_redeem", args);
        const b = await callTool<{ handle: string }>(other, "bugnet_redeem", args);
        expect([a.structured.handle, b.structured.handle]).toEqual([testHandle, testHandle]);
        expect(created).toHaveLength(2);
        expect(created[1]?.orderToken).toBe(created[0]?.orderToken);
        expect(payments.abandoned).toEqual([]);
    });

    it("marks an order the router refused outright as abandoned", async () => {
        const refuse = () => {
            throw routerError(Code.PermissionDenied, "WALLET_BLOCKED");
        };
        const { client, deps, payments } = await setup({
            createPlacement: refuse,
            extendPlacement: refuse,
        });
        const started = await devOrder(payments, startTerms);
        const s = await callTool(client, "bugnet_redeem", {
            ...started,
            quoteId: quote(deps),
        });
        expect(s.structured).toEqual({
            message: s.text,
            orderId: started.orderId,
            refusal: "abandoned",
        });
        const extended = await devOrder(payments, extendTerms);
        const e = await callTool(client, "bugnet_redeem", { ...extended, handle: testHandle });
        expect(e.text).toMatch(/not applied and the payment is refunded/);
        expect(e.structured).toEqual({
            message: e.text,
            orderId: extended.orderId,
            refusal: "abandoned",
        });
        expect(payments.abandoned.map((a) => a.orderId)).toEqual([
            started.orderId,
            extended.orderId,
        ]);
    });

    it("keeps orderId and claim in a bad quoteId's answer and redeems nothing", async () => {
        const { client, payments } = await setup(startRouter([]));
        const { orderId, claim } = await devOrder(payments, startTerms);
        const r = await callTool(client, "bugnet_redeem", { orderId, claim, quoteId: "q3.bad" });
        expect(r.text).toBe(
            "malformed quote id, copy it in full or call bugnet_quote again. Keep orderId " +
                `"${orderId}" and claim "${claim}" on the next bugnet_redeem, so the order is not ` +
                "paid twice.",
        );
        expect(payments.orders).toEqual([]);
    });
});
