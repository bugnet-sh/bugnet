import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { PlacementState, type ExtendPlacementRequest } from "../gen/bugnet/router/v1/router_pb.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    packageOption,
    placement,
    routerError,
    testDeps,
    testHandle,
    testNow,
    testPayments,
    type RouterImpl,
    type TestPayments,
} from "../testing/harness.ts";
import { handleHash } from "./common.ts";

const more = packageOption("more-10m", 40_000n);
const extended = placement(PlacementState.READY, {
    deadline: timestampFromMs(testNow + 20 * 60_000),
});

async function connect(impl: RouterImpl): Promise<{ client: Client; payments: TestPayments }> {
    const payments = testPayments();
    const deps = testDeps({ router: fakeRouter(impl), payments });
    return { client: await connectTools(deps), payments };
}

const args = (price = "0.04") => ({
    handle: testHandle,
    packageId: "more-10m",
    confirmPriceUsd: price,
});

const checked: RouterImpl = {
    checkExtendPlacement: () => ({ placement: placement(), package: more }),
    listExtensions: () => ({ options: [more] }),
};

describe("bugnet_extend", () => {
    it("pays for the extension and returns the new deadline", async () => {
        const applied: ExtendPlacementRequest[] = [];
        const { client, payments } = await connect({
            ...checked,
            extendPlacement: (req) => {
                applied.push(req);
                return { placement: extended };
            },
        });
        const r = await callTool<{ deadline: string; timeLeft: string; orderId: string }>(
            client,
            "bugnet_extend",
            args(),
            { toolUseId: "toolu_ext" },
        );
        expect(r.isError).toBe(false);
        expect(r.structured).toEqual({
            message: "Extended by 10 min. New deadline 2026-11-05T12:20:00.000Z, time left 20 min.",
            orderId: "toolu_ext",
            packageId: "more-10m",
            deadline: "2026-11-05T12:20:00.000Z",
            timeLeft: "20 min",
        });
        expect(payments.orders).toEqual([
            expect.objectContaining({
                kind: "extend",
                packageId: "more-10m",
                amountMicros: 40_000,
                handleSha256: handleHash(testHandle),
                idempotencyKey: "toolu_ext",
            }),
        ]);
        expect(applied).toHaveLength(1);
        expect(applied[0]?.orderToken).toBeTruthy();
    });

    it("refuses a price other than the extension's before any order", async () => {
        const { client, payments } = await connect(checked);
        const r = await callTool(client, "bugnet_extend", args("0.4"));
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "extend: more-10m costs $0.04, tell the user that price and pass it as " +
                "confirmPriceUsd.",
        );
        expect(payments.orders).toEqual([]);
    });

    it("lists the options for a package that does not extend this sandbox", async () => {
        const { client } = await connect({
            ...checked,
            checkExtendPlacement() {
                throw routerError(Code.InvalidArgument);
            },
        });
        const r = await callTool(client, "bugnet_extend", { ...args(), packageId: "small-10m" });
        expect(r.text).toBe(
            "extend: small-10m does not extend this sandbox, the options are more-10m ($0.04).",
        );
    });

    it("says when an extension would pass the longest lifetime", async () => {
        const { client } = await connect({
            checkExtendPlacement() {
                throw routerError(Code.FailedPrecondition, "EXCEEDS_LIFETIME");
            },
        });
        const r = await callTool(client, "bugnet_extend", args());
        expect(r.text).toMatch(/^extend: that would pass the longest time a sandbox can run/);
    });

    it("reports NOT_READY on an ended sandbox as expired", async () => {
        const { client, payments } = await connect({
            checkExtendPlacement() {
                throw routerError(Code.FailedPrecondition, "NOT_READY");
            },
            getPlacement: () => ({ placement: placement(PlacementState.TERMINATED) }),
        });
        const r = await callTool(client, "bugnet_extend", args());
        expect(r.text).toMatch(/^extend: this sandbox has ended/);
        expect(payments.orders).toEqual([]);
    });

    it("abandons the order when the router refuses the extension outright", async () => {
        const { client, payments } = await connect({
            ...checked,
            extendPlacement() {
                throw routerError(Code.PermissionDenied, "WALLET_BLOCKED");
            },
        });
        const r = await callTool(client, "bugnet_extend", args(), { toolUseId: "toolu_x" });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/^extend: the paying wallet is blocked/);
        expect(r.text).toMatch(/not applied and the payment is refunded/);
        expect(payments.abandoned).toEqual([{ orderId: "toolu_x", reason: "not_applied" }]);
    });

    it("keeps the refund wording when the refusal is a bare NotFound", async () => {
        const { client, payments } = await connect({
            ...checked,
            extendPlacement() {
                throw routerError(Code.NotFound);
            },
            getPlacement: () => ({ placement: placement() }),
        });
        const r = await callTool(client, "bugnet_extend", args());
        expect(r.text).toMatch(/not applied and the payment is refunded/);
        expect(payments.abandoned).toHaveLength(1);
    });

    it("retries an extension whose answer was lost", async () => {
        let calls = 0;
        const { client, payments } = await connect({
            ...checked,
            extendPlacement() {
                calls += 1;
                if (calls === 1) throw routerError(Code.Unavailable);
                return { placement: extended };
            },
        });
        const r = await callTool<{ timeLeft: string }>(client, "bugnet_extend", args());
        expect(r.structured.timeLeft).toBe("20 min");
        expect(calls).toBe(2);
        expect(payments.abandoned).toEqual([]);
    });
});
