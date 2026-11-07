import { beforeEach, describe, expect, it } from "vitest";
import {
    testHandle,
    testNow,
    testOrderSeed,
    testPayments,
    testTerms,
    tokenClaims,
    otherPayTo,
    testPayTo,
} from "../testing/harness.ts";
import { handleHash } from "../tools/common.ts";
import { serviceId, solanaNetwork, usdcAsset, urlParts } from "../x402/lines.ts";
import { DevPayments, devTerms } from "./dev.ts";
import {
    allowancePackageId,
    type NewOrderRequest,
    type X402Account,
    type X402Refund,
    type X402ServicePin,
} from "./port.ts";

const h = handleHash(testHandle);
const signal = () => AbortSignal.timeout(2_000);
const chat = "https://agent402.tools/v1/auto/chat/completions";
const pin = (p: Partial<X402ServicePin> = {}): X402ServicePin => ({
    serviceId: serviceId("POST", "agent402.tools", "/v1/auto/"),
    method: "POST",
    host: "agent402.tools",
    prefix: "/v1/auto/",
    url: chat,
    maxPriceMicros: 10_000,
    payTo: testPayTo,
    listed: "indexed",
    pinnedFrom: "probe",
    probe: { at: "2026-11-05T12:00:00.000Z", status: 402, accepted: { scheme: "exact" } },
    ...p,
});
const other = (i: number) =>
    pin({
        serviceId: serviceId("POST", `s${i}.example`, "/v1/"),
        host: `s${i}.example`,
        prefix: "/v1/",
        url: `https://s${i}.example/v1/x`,
    });
const allowance = (p: Partial<NewOrderRequest> = {}): NewOrderRequest => ({
    kind: "allowance",
    packageId: allowancePackageId,
    handleSha256: h,
    amountMicros: 1_003_000,
    allowanceMicros: 1_000_000,
    feeMicros: 3_000,
    description: "x402",
    x402: { services: [pin()] },
    idempotencyKey: "toolu_allowance_0001",
    ...p,
});
// A later order on an account whose fee is paid, each under its own key since dev uses the key as orderId
const topUp = (key: string, p: Partial<NewOrderRequest> = {}) =>
    allowance({ idempotencyKey: key, amountMicros: 1_000_000, feeMicros: 0, ...p });
const hB = handleHash("sbx_bbbbbbbbbbbbbbbbbbbbbbbbbb");
const view: X402Account = {
    state: "open",
    fundedMicros: 1_000_000,
    spentMicros: 0,
    heldMicros: 0,
    leftMicros: 1_000_000,
    allowanceRoomMicros: 4_000_000,
    paidCalls: 0,
    pendingCalls: 0,
    spendPerMinuteMicros: 500_000,
    services: [
        {
            serviceId: "xs_w5a4htopmpzmmhos",
            method: "POST",
            host: "agent402.tools",
            prefix: "/v1/auto/",
            url: chat,
            paidPath: null,
            maxPriceMicros: 10_000,
            payTo: testPayTo,
            listed: "indexed",
            state: "enabled",
        },
    ],
};

let dev: DevPayments;
beforeEach(() => {
    dev = new DevPayments(testOrderSeed, 600_000, () => testNow);
});

describe("DevPayments x402 ledger", () => {
    it("serves the spec 7.15 terms", async () => {
        const t = await dev.x402Terms(signal());
        expect(t).toEqual({
            enabled: true,
            startWithX402: true,
            network: solanaNetwork,
            asset: usdcAsset,
            sessionFeeMicros: 3_000,
            minAllowanceMicros: 100_000,
            suggestedAllowanceMicros: 1_000_000,
            maxAllowancePerSandboxMicros: 5_000_000,
            maxPricePerCallMicros: 500_000,
            defaultSpendPerMinuteMicros: 500_000,
            minSpendPerMinuteMicros: 10_000,
            maxSpendPerMinuteMicros: 5_000_000,
            maxServices: 5,
            maxNewServicesPerOrder: 5,
            sellerMemoMaxBytes: 32,
            refundMinMicros: 10_000,
            bugnetAddresses: [
                "BDGoY3jhKG54L9PDcj2nNZ6pm6nSBWkGjLn1RbnqSesh",
                "GQmtMBuna52hFqdFqALicXZvzSVwH1QBHpASW1j5Vbr8",
                "FyZhmTLfxhVKmiu22fTA2WrdiqCetW8gLzWHvRpUjUZr",
                "3cGf6FRevfgy1DeGhFDxZdXQm2yTBtaYZETaZb4eq3dg",
            ],
        });
        expect(t).toEqual(devTerms);
    });

    it("answers a sandbox without an account as no account and fee due", async () => {
        expect(await dev.x402Account(h, signal())).toEqual({ x402: null, feeDue: true });
    });

    it("pays an allowance at once, enables its pins and clears feeDue", async () => {
        expect(await dev.order(allowance())).toEqual({
            status: "paid",
            orderId: "toolu_allowance_0001",
            kind: "allowance",
            handleSha256: h,
            payer: "dev",
            amountMicros: 1_003_000,
            allowanceMicros: 1_000_000,
            firstUse: true,
            x402: view,
        });
        expect(await dev.x402Account(h, signal())).toEqual({ x402: view, feeDue: false });
    });

    it("keeps the paid path of an unlisted pin", async () => {
        await dev.order(allowance({ x402: { services: [pin({ listed: "unlisted" })] } }));
        const a = await dev.x402Account(h, signal());
        expect(a.x402?.services[0]).toMatchObject({
            listed: "unlisted",
            paidPath: "/v1/auto/chat/completions",
        });
        expect(urlParts(chat)?.path).toBe("/v1/auto/chat/completions");
    });

    it("answers a repeat of one order from its stored answer", async () => {
        const a = await dev.order(allowance());
        const b = await dev.order(allowance());
        expect(b).toEqual(a);
        expect((await dev.x402Account(h, signal())).x402?.fundedMicros).toBe(1_000_000);
    });

    it("charges the fee once", async () => {
        await dev.order(allowance());
        expect(await dev.order(allowance({ idempotencyKey: "toolu_allowance_0002" }))).toEqual({
            status: "refused",
            reason: "fee_mismatch",
        });
        const r = await dev.order(
            topUp("toolu_allowance_0003", { amountMicros: 500_000, allowanceMicros: 500_000 }),
        );
        expect(r).toMatchObject({ status: "paid", firstUse: false });
        expect(r.status === "paid" && r.kind === "allowance" && r.x402.fundedMicros).toBe(
            1_500_000,
        );
    });

    it.each<[string, Partial<NewOrderRequest>, string]>([
        [
            "too small",
            { allowanceMicros: 99_999, amountMicros: 99_999, feeMicros: 0 },
            "amount_too_small",
        ],
        ["fee missing", { amountMicros: 1_000_000, feeMicros: 0 }, "fee_mismatch"],
        ["no handle", { handleSha256: undefined }, "bad_request"],
        [
            "six services",
            { x402: { services: [pin(), other(1), other(2), other(3), other(4), other(5)] } },
            "too_many_services",
        ],
        [
            "price above ceiling",
            { x402: { services: [pin({ maxPriceMicros: 500_001 })] } },
            "price_above_ceiling",
        ],
        [
            "rate under minimum",
            { x402: { services: [pin()], spendPerMinuteMicros: 9_999 } },
            "spend_rate_out_of_range",
        ],
        [
            "rate over maximum",
            { x402: { services: [pin()], spendPerMinuteMicros: 5_000_001 } },
            "spend_rate_out_of_range",
        ],
        [
            "rate under a service price",
            {
                x402: {
                    services: [pin({ maxPriceMicros: 20_000 })],
                    spendPerMinuteMicros: 10_000,
                },
            },
            "spend_rate_out_of_range",
        ],
        [
            "past the ceiling",
            { allowanceMicros: 5_000_001, amountMicros: 5_003_001 },
            "allowance_ceiling",
        ],
    ])("runs the create checks in spec 7.2 order: %s", async (_n, patch, reason) => {
        expect(await dev.order(allowance(patch))).toEqual({ status: "refused", reason });
    });

    it("refuses more new services than maxNewServicesPerOrder", async () => {
        const d = new DevPayments(testOrderSeed, 600_000, () => testNow, {
            terms: { maxNewServicesPerOrder: 2 },
        });
        const r = await d.order(allowance({ x402: { services: [pin(), other(1), other(2)] } }));
        expect(r).toEqual({ status: "refused", reason: "description_too_long" });
    });

    it("counts services left enabled after the order against maxServices", async () => {
        const first = await dev.order(
            allowance({ x402: { services: [pin(), other(1), other(2), other(3), other(4)] } }),
        );
        expect(first.status).toBe("paid");
        expect(
            await dev.order(topUp("toolu_allowance_0002", { x402: { services: [other(5)] } })),
        ).toEqual({ status: "refused", reason: "too_many_services" });
        const swapped = await dev.order(
            topUp("toolu_allowance_0003", {
                x402: { services: [other(5)], disable: [pin().serviceId] },
            }),
        );
        expect(swapped.status).toBe("paid");
        const a = await dev.x402Account(h, signal());
        expect(a.x402?.services.find((s) => s.serviceId === pin().serviceId)?.state).toBe(
            "disabled",
        );
    });

    it("refuses an allowance past the ceiling at create, without refundPending", async () => {
        const first = await dev.order(
            allowance({ allowanceMicros: 4_000_000, amountMicros: 4_003_000 }),
        );
        expect(first.status).toBe("paid");
        expect(
            await dev.order(
                topUp("toolu_allowance_0002", {
                    allowanceMicros: 1_000_001,
                    amountMicros: 1_000_001,
                }),
            ),
        ).toEqual({ status: "refused", reason: "allowance_ceiling" });
        expect((await dev.x402Account(h, signal())).x402?.allowanceRoomMicros).toBe(1_000_000);
    });

    it("refuses a paid allowance past the ceiling with refundPending", async () => {
        const d = new DevPayments(testOrderSeed, 600_000, () => testNow, {
            requirePayment: true,
            payBaseUrl: "http://127.0.0.1:8787",
        });
        const big = (key: string) =>
            allowance({
                allowanceMicros: 3_000_000,
                amountMicros: 3_003_000,
                idempotencyKey: key,
            });
        const a1 = await d.order(big("toolu_allowance_0001"));
        const a2 = await d.order(big("toolu_allowance_0002"));
        if (a1.status !== "payment_required" || a2.status !== "payment_required") {
            throw new Error("expected payment steps");
        }
        const c1 = a1.claim as string;
        const c2 = a2.claim as string;
        d.pay(a1.orderId);
        d.pay(a2.orderId);
        expect((await d.order({ orderId: a1.orderId, claim: c1 })).status).toBe("paid");
        const refused = {
            status: "refused",
            orderId: a2.orderId,
            reason: "allowance_ceiling",
            refundPending: true,
        };
        expect(await d.order({ orderId: a2.orderId, claim: c2 })).toEqual(refused);
        expect(await d.order({ orderId: a2.orderId, claim: c2 })).toEqual(refused);
    });

    it("signs allowance_micros on start tokens only above 0 and opens an unbound account", async () => {
        const r = await dev.order({
            kind: "start",
            packageId: "small",
            amountMicros: 1_253_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            description: "s",
            x402: { services: [pin()] },
            idempotencyKey: "toolu_start_00001",
        });
        expect(r).toMatchObject({
            status: "paid",
            kind: "start",
            packageId: "small",
            amountMicros: 1_253_000,
            allowanceMicros: 1_000_000,
            firstUse: true,
            x402: view,
        });
        if (r.status !== "paid" || r.kind === "allowance") throw new Error("expected a start");
        expect(tokenClaims(r.orderToken).allowance_micros).toBe(1_000_000);
        expect(await dev.x402Account(h, signal())).toEqual({ x402: null, feeDue: true });
        dev.x402.bind("toolu_start_00001", h);
        expect(await dev.x402Account(h, signal())).toEqual({ x402: view, feeDue: false });
        const plain = await dev.order({
            kind: "start",
            packageId: "small",
            amountMicros: 250_000,
            description: "s",
            idempotencyKey: "toolu_start_00002",
        });
        if (plain.status !== "paid" || plain.kind === "allowance")
            throw new Error("expected start");
        expect(plain).not.toHaveProperty("allowanceMicros");
        expect(plain).not.toHaveProperty("firstUse");
        expect(plain).not.toHaveProperty("x402");
        expect(tokenClaims(plain.orderToken)).not.toHaveProperty("allowance_micros");
    });

    it("refuses x402 on a start while the terms forbid it", async () => {
        const start = (p: Partial<NewOrderRequest> = {}): NewOrderRequest => ({
            kind: "start",
            packageId: "small",
            amountMicros: 1_253_000,
            allowanceMicros: 1_000_000,
            feeMicros: 3_000,
            description: "s",
            x402: { services: [pin()] },
            idempotencyKey: "toolu_start_00001",
            ...p,
        });
        const off = new DevPayments(testOrderSeed, 600_000, () => testNow, {
            terms: { startWithX402: false },
        });
        expect(await off.order(start())).toEqual({
            status: "refused",
            reason: "x402_start_unavailable",
        });
        const disabled = new DevPayments(testOrderSeed, 600_000, () => testNow, {
            terms: { enabled: false },
        });
        expect(await disabled.order(start())).toEqual({
            status: "refused",
            reason: "x402_disabled",
        });
        expect(await disabled.order(allowance())).toEqual({
            status: "refused",
            reason: "x402_disabled",
        });
        expect(await dev.order(start({ feeMicros: 0 }))).toEqual({
            status: "refused",
            reason: "fee_mismatch",
        });
    });

    it("answers firstUse once per fake payer", async () => {
        expect(await dev.order(allowance())).toMatchObject({ firstUse: true });
        expect(
            await dev.order(
                allowance({ handleSha256: hB, idempotencyKey: "toolu_allowance_0002" }),
            ),
        ).toMatchObject({ firstUse: false });
        dev.x402.newPayer();
        expect(
            await dev.order(
                allowance({
                    handleSha256: handleHash("sbx_cccccccccccccccccccccccccc"),
                    idempotencyKey: "toolu_allowance_0003",
                }),
            ),
        ).toMatchObject({ firstUse: true, payer: "dev-1" });
    });

    it("disables, re-prices and limits through configure", async () => {
        await dev.order(allowance());
        expect(
            await dev.x402Configure(
                h,
                { services: [pin({ maxPriceMicros: 20_000 })], spendPerMinuteMicros: 2_000_000 },
                "req_configure_0001",
                signal(),
            ),
        ).toEqual({
            status: "ok",
            x402: {
                ...view,
                spendPerMinuteMicros: 2_000_000,
                services: [{ ...view.services[0]!, maxPriceMicros: 20_000 }],
            },
        });
        const r = await dev.x402Configure(
            h,
            { disable: ["xs_w5a4htopmpzmmhos"] },
            "req_configure_0002",
            signal(),
        );
        expect(r.status === "ok" && r.x402.services[0]?.state).toBe("disabled");
    });

    it.each<[string, string, Parameters<DevPayments["x402Configure"]>[1], string]>([
        ["no account", hB, {}, "no_account"],
        [
            "another method",
            h,
            {
                services: [
                    pin({
                        method: "GET",
                        serviceId: serviceId("GET", "agent402.tools", "/v1/auto/"),
                    }),
                ],
            },
            "needs_payment",
        ],
        ["another payee", h, { services: [pin({ payTo: otherPayTo })] }, "needs_payment"],
        [
            "price above the ceiling",
            h,
            { services: [pin({ maxPriceMicros: 500_001 })] },
            "price_above_ceiling",
        ],
        ["rate under minimum", h, { spendPerMinuteMicros: 9_999 }, "spend_rate_out_of_range"],
        [
            "rate under a price",
            h,
            { services: [pin({ maxPriceMicros: 20_000 })], spendPerMinuteMicros: 10_000 },
            "spend_rate_out_of_range",
        ],
    ])(
        "refuses configure changes that need a payment or break a limit: %s",
        async (_n, handle, setup, reason) => {
            await dev.order(allowance());
            expect(await dev.x402Configure(handle, setup, "req_configure_0008", signal())).toEqual({
                status: "refused",
                reason,
            });
        },
    );

    it("refuses configure on a closed account", async () => {
        await dev.order(allowance());
        dev.x402.patch(h, { state: "closed" });
        expect(await dev.x402Configure(h, {}, "req_configure_0009", signal())).toEqual({
            status: "refused",
            reason: "sandbox_ended",
        });
    });

    it("refuses re-enabling a sixth service in configure", async () => {
        await dev.order(
            allowance({ x402: { services: [pin(), other(1), other(2), other(3), other(4)] } }),
        );
        await dev.order(
            topUp("toolu_allowance_0003", {
                x402: { services: [other(5)], disable: [pin().serviceId] },
            }),
        );
        expect(
            await dev.x402Configure(h, { services: [pin()] }, "req_configure_0006", signal()),
        ).toEqual({ status: "refused", reason: "too_many_services" });
    });

    it("answers a configure resend from its stored answer and refuses a changed one", async () => {
        await dev.order(allowance());
        const a = await dev.x402Configure(
            h,
            { services: [pin({ maxPriceMicros: 20_000 })] },
            "req_configure_0007",
            signal(),
        );
        dev.x402.patch(h, { spentMicros: 5_000 });
        expect(
            await dev.x402Configure(
                h,
                {
                    services: [
                        pin({
                            maxPriceMicros: 20_000,
                            listed: "unlisted",
                            pinnedFrom: "index",
                            probe: { at: "2026-11-05T12:05:00.000Z", status: 200, accepted: null },
                        }),
                    ],
                },
                "req_configure_0007",
                signal(),
            ),
        ).toEqual(a);
        expect(
            await dev.x402Configure(
                h,
                { services: [pin({ maxPriceMicros: 30_000 })] },
                "req_configure_0007",
                signal(),
            ),
        ).toEqual({ status: "refused", reason: "idempotency_conflict" });
    });

    it("shows patched spend, holds, calls, refunds and service states", async () => {
        await dev.order(allowance());
        dev.x402.patch(h, {
            spentMicros: 730_000,
            heldMicros: 20_000,
            paidCalls: 73,
            pendingCalls: 2,
            serviceStates: { xs_w5a4htopmpzmmhos: "unreliable" },
        });
        const a = (await dev.x402Account(h, signal())).x402;
        expect(a).toMatchObject({
            leftMicros: 250_000,
            paidCalls: 73,
            pendingCalls: 2,
            services: [{ state: "unreliable" }],
        });
        expect(a).not.toHaveProperty("refund");
        const refund: X402Refund = {
            state: "pending",
            amountMicros: 250_000,
            keptMicros: 0,
            txs: [],
        };
        dev.x402.patch(h, { state: "closed", refund });
        expect((await dev.x402Account(h, signal())).x402?.refund).toEqual(refund);
    });

    it("answers the next order or configure with a set refusal once", async () => {
        dev.x402.refuseNextOrder({
            reason: "pin_refused",
            serviceId: "xs_w5a4htopmpzmmhos",
            pinReason: "payee_no_usdc_account",
        });
        expect(await dev.order(allowance())).toEqual({
            status: "refused",
            reason: "pin_refused",
            serviceId: "xs_w5a4htopmpzmmhos",
            pinReason: "payee_no_usdc_account",
        });
        expect((await dev.order(allowance())).status).toBe("paid");
        dev.x402.refuseNextConfigure({ reason: "router_unavailable" });
        // @ts-expect-error a configure-only reason is no order refusal
        dev.x402.refuseNextOrder({ reason: "needs_payment" });
        // @ts-expect-error an order-only reason is no configure refusal
        dev.x402.refuseNextConfigure({ reason: "pin_refused" });
        expect(await dev.x402Configure(h, {}, "req_configure_0010", signal())).toEqual({
            status: "refused",
            reason: "router_unavailable",
        });
    });

    it("answers seller stats for the asked hosts only", async () => {
        dev.x402.setSellers({ "a.example": { paidCalls30d: 120, failedPaid30d: 3 } });
        expect(await dev.x402Sellers(["a.example", "b.example"], signal())).toEqual({
            "a.example": { paidCalls30d: 120, failedPaid30d: 3 },
        });
    });

    it("testPayments records configures and answers each x402 call from dev unless the test gives one", async () => {
        const p = testPayments(undefined, {
            x402: { account: async () => ({ x402: null, feeDue: false }) },
        });
        expect(await p.x402Account(h, signal())).toEqual({ x402: null, feeDue: false });
        expect(await p.x402Configure(h, { disable: [] }, "req_configure_0005", signal())).toEqual({
            status: "refused",
            reason: "no_account",
        });
        expect(p.configures).toEqual([
            { handleSha256: h, setup: { disable: [] }, requestId: "req_configure_0005" },
        ]);
        expect(testTerms({ maxServices: 3 })).toEqual({ ...devTerms, maxServices: 3 });
    });

    it("compares a resent allowance order's terms as 7.15 says", async () => {
        const d = new DevPayments(testOrderSeed, 600_000, () => testNow, { requirePayment: true });
        const first = await d.order(allowance());
        if (first.status !== "payment_required") throw new Error("expected a payment step");
        const id = first.orderId;
        const claim = first.claim as string;
        expect(
            await d.order(allowance({ allowanceMicros: 900_000, amountMicros: 903_000 })),
        ).toEqual({
            status: "refused",
            orderId: id,
            reason: "idempotency_conflict",
        });
        const same = await d.order(
            allowance({
                x402: {
                    services: [
                        pin({
                            listed: "unlisted",
                            pinnedFrom: "index",
                            probe: { at: "2026-11-05T12:09:00.000Z", status: 200, accepted: null },
                        }),
                    ],
                },
            }),
        );
        expect(same).toMatchObject({ status: "payment_required", orderId: id });
        expect(
            await d.order({
                orderId: id,
                claim,
                x402: { services: [pin({ maxPriceMicros: 20_000 })] },
            }),
        ).toEqual({ status: "refused", orderId: id, reason: "terms_mismatch" });
    });

    it("refuses at settle with refundPending when the account closed between create and pay", async () => {
        const d = new DevPayments(testOrderSeed, 600_000, () => testNow, { requirePayment: true });
        const a = await d.order(allowance({ idempotencyKey: "toolu_allowance_0001" }));
        if (a.status !== "payment_required") throw new Error("expected a payment step");
        d.pay(a.orderId);
        const b = await d.order(allowance({ idempotencyKey: "toolu_allowance_0002" }));
        if (b.status !== "payment_required") throw new Error("expected a payment step");
        d.pay(b.orderId);
        expect((await d.order({ orderId: a.orderId, claim: a.claim as string })).status).toBe(
            "paid",
        );
        d.x402.patch(h, { state: "closed" });
        expect(await d.order({ orderId: b.orderId, claim: b.claim as string })).toEqual({
            status: "refused",
            orderId: b.orderId,
            reason: "sandbox_ended",
            refundPending: true,
        });
    });

    it("answers a configure disabling an id the account does not hold with needs_payment", async () => {
        await dev.order(allowance());
        expect(
            await dev.x402Configure(
                h,
                { disable: [serviceId("POST", "nobody.example", "/v1/")] },
                "req_configure_0011",
                signal(),
            ),
        ).toEqual({ status: "refused", reason: "needs_payment" });
    });

    it("signs allowance_micros on start tokens only", async () => {
        const r = await dev.order({
            kind: "extend",
            packageId: "more",
            amountMicros: 40_000,
            allowanceMicros: 100_000,
            handleSha256: h,
            description: "e",
            idempotencyKey: "toolu_extend_00001",
        });
        if (r.status !== "paid" || r.kind === "allowance") throw new Error("expected an extend");
        expect(tokenClaims(r.orderToken)).not.toHaveProperty("allowance_micros");
    });

    it.each(["closing", "closed"] as const)(
        "always shows a refund block on a %s account",
        async (state) => {
            await dev.order(allowance());
            dev.x402.patch(h, { state });
            expect((await dev.x402Account(h, signal())).x402?.refund).toEqual({
                state: "waiting",
                amountMicros: 0,
                keptMicros: 0,
                txs: [],
            });
        },
    );
});
