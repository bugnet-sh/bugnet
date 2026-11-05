import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
    PlacementState,
    type CreatePlacementRequest,
    type GetPlacementRequest,
} from "../gen/bugnet/router/v1/router_pb.ts";
import { signQuote, verifyQuote } from "../quote.ts";
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
import type { Deps } from "./common.ts";

const options = [
    packageOption("small-10m", 50_000n),
    packageOption("small-30m", 120_000n, { minutes: 30 }),
    packageOption("large-30m", 300_000n, { available: false, unavailableReason: "no_candidate" }),
];

interface Setup {
    client: Client;
    deps: Deps;
    payments: TestPayments;
    clock: { now: number };
}

async function setup(impl: RouterImpl, payments = testPayments()): Promise<Setup> {
    const clock = { now: testNow };
    const deps = testDeps({ router: fakeRouter(impl), payments, now: () => clock.now });
    return { client: await connectTools(deps), deps, payments, clock };
}

async function quoteId(client: Client): Promise<string> {
    const q = await callTool<{ quoteId: string }>(client, "bugnet_quote", { workload: "script" });
    return q.structured.quoteId;
}

const startArgs = (id: string, price = "0.05") => ({
    quoteId: id,
    packageId: "small-10m",
    confirmPriceUsd: price,
});

describe("bugnet_quote", () => {
    it("lists the packages that can start, recommends one and signs a quote", async () => {
        const { client, deps } = await setup({ estimate: () => ({ options }) });
        const r = await callTool<{
            message: string;
            quoteId: string;
            packages: { id: string; priceUsd: string }[];
            recommended: { packageId: string; priceUsd: string };
        }>(client, "bugnet_quote", { workload: "tests", expectedMinutes: 20 });
        expect(r.isError).toBe(false);
        expect(Object.keys(r.structured)[0]).toBe("message");
        expect(r.structured.message).toBe(r.text);
        expect(r.structured.packages.map((p) => p.id)).toEqual(["small-10m", "small-30m"]);
        expect(r.structured.recommended).toEqual(
            expect.objectContaining({ packageId: "small-30m", priceUsd: "$0.12" }),
        );
        expect(r.structured.message).toMatch(/1 more packages are unavailable now/);
        const claims = verifyQuote(deps.config.secrets.quoteKey, r.structured.quoteId, testNow);
        expect(claims.expiresAt).toBe(testNow + 10 * 60_000);
    });

    it("carries the needs into the estimate and the quote", async () => {
        let asked: unknown;
        const { client, deps } = await setup({
            estimate: (req) => {
                asked = req.requirements;
                return { options };
            },
        });
        const r = await callTool<{ quoteId: string; warnings: string[] }>(client, "bugnet_quote", {
            needs: ["ssh", "gpu"],
        });
        expect(asked).toEqual(expect.objectContaining({ ssh: true, preview: false, gpu: true }));
        expect(r.structured.warnings[0]).toMatch(/No GPU package/);
        const claims = verifyQuote(deps.config.secrets.quoteKey, r.structured.quoteId, testNow);
        expect(claims.requirements).toEqual({
            ssh: true,
            preview: false,
            gpu: true,
            secrets: false,
        });
    });

    it("reports a rate limit with its RetryInfo delay", async () => {
        const { client } = await setup({
            estimate() {
                throw routerError(Code.ResourceExhausted, "RATE_LIMITED", { retryAfterMs: 3000 });
            },
        });
        const r = await callTool(client, "bugnet_quote", {});
        expect(r.isError).toBe(true);
        expect(r.text).toBe("quote: too many requests for now. Retry after 3 s.");
    });

    it("says where secrets go when the router finds one in the arguments", async () => {
        const { client } = await setup({
            estimate() {
                throw routerError(Code.InvalidArgument, "SECRET_IN_ARGUMENT");
            },
        });
        const r = await callTool(client, "bugnet_quote", { entryCommand: "run --token x" });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/bugnet_secret_link/);
    });
});

describe("bugnet_start", () => {
    function startRouter(seen: { create?: CreatePlacementRequest; waits: GetPlacementRequest[] }) {
        return {
            estimate: () => ({ options }),
            createPlacement: (req: CreatePlacementRequest) => {
                seen.create = req;
                return { handle: testHandle, placement: placement(PlacementState.PLACING) };
            },
            getPlacement: (req: GetPlacementRequest) => {
                seen.waits.push(req);
                return { placement: placement(PlacementState.READY) };
            },
        } satisfies RouterImpl;
    }

    it("pays, starts and waits for the sandbox to be ready", async () => {
        const seen: { create?: CreatePlacementRequest; waits: GetPlacementRequest[] } = {
            waits: [],
        };
        const { client, payments } = await setup(startRouter(seen));
        const id = await quoteId(client);
        const r = await callTool<{
            message: string;
            handle: string;
            orderId: string;
            state: string;
            timeLeft: string;
        }>(client, "bugnet_start", startArgs(id), { toolUseId: "toolu_start" });
        expect(r.isError).toBe(false);
        expect(r.structured).toEqual(
            expect.objectContaining({
                handle: testHandle,
                orderId: "toolu_start",
                state: "ready",
                timeLeft: "10 min",
            }),
        );
        expect(r.structured.message).toMatch(new RegExp(`handle: ${testHandle}`));
        expect(payments.orders).toEqual([
            expect.objectContaining({
                kind: "start",
                packageId: "small-10m",
                amountMicros: 50_000,
                idempotencyKey: "toolu_start",
            }),
        ]);
        expect(seen.create?.orderToken).toBeTruthy();
        expect(seen.waits[0]).toEqual(
            expect.objectContaining({ handle: testHandle, knownState: PlacementState.PLACING }),
        );
    });

    it("refuses a price other than the package's before any order", async () => {
        const { client, payments } = await setup(startRouter({ waits: [] }));
        const id = await quoteId(client);
        const r = await callTool(client, "bugnet_start", startArgs(id, "99"));
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "small-10m costs $0.05, tell the user that price and pass it as confirmPriceUsd.",
        );
        expect(payments.orders).toEqual([]);
        expect((await callTool(client, "bugnet_start", startArgs(id, "$0.05"))).isError).toBe(
            false,
        );
    });

    it("refuses an expired quote", async () => {
        const { client, clock, payments } = await setup(startRouter({ waits: [] }));
        const id = await quoteId(client);
        clock.now = testNow + 11 * 60_000;
        const r = await callTool(client, "bugnet_start", startArgs(id));
        expect(r.isError).toBe(true);
        expect(r.text).toBe("quote expired, call bugnet_quote again.");
        expect(payments.orders).toEqual([]);
    });

    it("refuses a quote signed with another key and a package not on offer", async () => {
        const { client } = await setup(startRouter({ waits: [] }));
        const forged = signQuote(Buffer.alloc(32, 1), {
            requirements: { ssh: false, preview: false, gpu: false, secrets: false },
            github: false,
            estimateId: null,
            expiresAt: testNow + 60_000,
        });
        const r = await callTool(client, "bugnet_start", startArgs(forged));
        expect(r.text).toMatch(/does not verify/);
        const id = await quoteId(client);
        const gone = await callTool(client, "bugnet_start", {
            ...startArgs(id),
            packageId: "large-30m",
        });
        expect(gone.text).toBe(
            "package large-30m cannot start right now, the packages open now are small-10m, " +
                "small-30m.",
        );
    });

    it("returns the payment step when the order is unpaid", async () => {
        const payments = testPayments((req) => ({
            status: "payment_required",
            orderId: "ord_1",
            paymentRequired: { x402Version: 2, accepts: [{ amount: String(req.amountMicros) }] },
        }));
        const { client } = await setup(startRouter({ waits: [] }), payments);
        const id = await quoteId(client);
        const r = await callTool(client, "bugnet_start", startArgs(id));
        expect(r.isError).toBe(true);
        expect(r.structured).toEqual({ x402Version: 2, accepts: [{ amount: "50000" }] });
        expect(r.text).toMatch(/call the same tool again with orderId "ord_1"/);
    });

    it.each(["WALLET_BLOCKED", "PAYER_REQUIRED"])(
        "abandons the order when the router refuses it outright with %s",
        async (reason) => {
            const { client, payments } = await setup({
                ...startRouter({ waits: [] }),
                createPlacement() {
                    throw routerError(Code.PermissionDenied, reason);
                },
            });
            const r = await callTool(client, "bugnet_start", startArgs(await quoteId(client)), {
                toolUseId: "toolu_w",
            });
            expect(r.isError).toBe(true);
            expect(r.text).toMatch(/^start: the (paying wallet is blocked|order named no)/);
            expect(payments.abandoned).toEqual([{ orderId: "toolu_w", reason: "denied" }]);
        },
    );

    it("keeps the order when the wallet is busy or rate limited", async () => {
        let reason = "WALLET_BUSY";
        const { client, payments } = await setup({
            ...startRouter({ waits: [] }),
            createPlacement() {
                throw routerError(Code.ResourceExhausted, reason, {
                    ...(reason === "WALLET_RATE_LIMITED" ? { retryAfterMs: 30_000 } : {}),
                });
            },
        });
        const busy = await callTool(client, "bugnet_start", startArgs(await quoteId(client)));
        expect(busy.text).toMatch(/bugnet_stop/);
        expect(busy.text).toMatch(/refunded/);
        reason = "WALLET_RATE_LIMITED";
        const limited = await callTool(client, "bugnet_start", startArgs(await quoteId(client)));
        expect(limited.text).toMatch(/Retry after 30 s\.$/);
        expect(payments.abandoned).toEqual([]);
        expect(payments.orders).toHaveLength(2);
    });

    it("says a failed start is refunded", async () => {
        const { client } = await setup({
            estimate: () => ({ options }),
            createPlacement: () => ({
                handle: testHandle,
                placement: placement(PlacementState.FAILED, {
                    refundable: true,
                    failureReason: "no_candidate",
                }),
            }),
        });
        const r = await callTool<{ state: string; refundable: boolean }>(
            client,
            "bugnet_start",
            startArgs(await quoteId(client)),
        );
        expect(r.structured).toEqual(
            expect.objectContaining({ state: "failed", refundable: true }),
        );
        expect(r.text).toMatch(/failed to start, the payment will be refunded/);
    });
});

describe("bugnet_status", () => {
    it("shows the state, the time left and the extensions on offer", async () => {
        const { client } = await setup({
            getPlacement: () => ({ placement: placement() }),
            listExtensions: () => ({
                options: [
                    packageOption("more-10m", 40_000n),
                    packageOption("more-60m", 200_000n, { minutes: 60, available: false }),
                ],
            }),
        });
        const r = await callTool<{
            message: string;
            state: string;
            timeLeft: string;
            extensions: { packageId: string; available: boolean }[];
        }>(client, "bugnet_status", { handle: testHandle });
        expect(r.structured.state).toBe("ready");
        expect(r.structured.timeLeft).toBe("10 min");
        expect(r.structured.extensions).toHaveLength(2);
        expect(r.structured.message).toMatch(
            /Extend with bugnet_extend: more-10m \+10 min \$0\.04$/,
        );
    });

    it("waits for a starting sandbox to change state", async () => {
        const asked: GetPlacementRequest[] = [];
        const { client } = await setup({
            getPlacement: (req) => {
                asked.push(req);
                return {
                    placement: placement(
                        req.waitMs ? PlacementState.READY : PlacementState.PLACING,
                    ),
                };
            },
        });
        const r = await callTool<{ state: string }>(client, "bugnet_status", {
            handle: testHandle,
            waitSeconds: 10,
        });
        expect(r.structured.state).toBe("ready");
        expect(asked[1]).toEqual(
            expect.objectContaining({ waitMs: 10_000, knownState: PlacementState.PLACING }),
        );
    });

    it("says an ended sandbox has no time left and an unknown handle is unknown", async () => {
        let known = true;
        const { client } = await setup({
            getPlacement() {
                if (!known) throw routerError(Code.NotFound);
                return { placement: placement(PlacementState.TERMINATED) };
            },
        });
        const ended = await callTool<{ timeLeft: string }>(client, "bugnet_status", {
            handle: testHandle,
        });
        expect(ended.structured.timeLeft).toBe("none, the sandbox has ended");
        known = false;
        const r = await callTool(client, "bugnet_status", { handle: testHandle });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/^status: no sandbox has this handle/);
    });
});

describe("bugnet_stop", () => {
    it("stops the sandbox and reports the time used", async () => {
        const { client } = await setup({
            stopPlacement: () => ({
                placement: placement(PlacementState.TERMINATED, {
                    readyAt: timestampFromMs(testNow - 90_000),
                }),
            }),
        });
        const r = await callTool<{ state: string; usedSeconds: number }>(client, "bugnet_stop", {
            handle: testHandle,
        });
        expect(r.structured).toEqual(
            expect.objectContaining({
                message: "Sandbox ended, used for about 90 s.",
                state: "ended",
                usedSeconds: 90,
            }),
        );
    });

    it("reports the service as unavailable without the router's wording", async () => {
        const { client } = await setup({
            stopPlacement() {
                throw routerError(Code.Unavailable, undefined, { message: "e2b is down" });
            },
        });
        const r = await callTool(client, "bugnet_stop", { handle: testHandle });
        expect(r.text).toBe("stop: the sandbox service is unavailable.");
    });
});
