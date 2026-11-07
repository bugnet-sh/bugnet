import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { devTerms } from "./dev.ts";
import { HttpPayments, paymentsUnavailableText } from "./http.ts";

interface Seen {
    method: string | undefined;
    url: string;
    authorization: string | undefined;
    body: string;
}

const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map((s) => new Promise((r) => s.close(r)).then(() => undefined)),
    );
});

async function serve(
    answer: (req: Seen) => { status: number; body: unknown },
): Promise<{ url: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const entry: Seen = {
                method: req.method,
                url: req.url ?? "",
                authorization: req.headers.authorization,
                body: Buffer.concat(chunks).toString("utf8"),
            };
            seen.push(entry);
            const a = answer(entry);
            res.writeHead(a.status, { "content-type": "application/json" });
            res.end(JSON.stringify(a.body));
        });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const signal = () => AbortSignal.timeout(2_000);

describe("HttpPayments x402 routes", () => {
    it("reads the terms with a GET and the bearer token, dropping unknown keys", async () => {
        const s = await serve(() => ({ status: 200, body: { ...devTerms, extra: 1 } }));
        expect(await new HttpPayments(s.url, "tok").x402Terms(signal())).toEqual(devTerms);
        expect(s.seen).toEqual([
            { method: "GET", url: "/v1/x402/terms", authorization: "Bearer tok", body: "" },
        ]);
    });

    it.each([
        ["no bugnetAddresses", { ...devTerms, bugnetAddresses: [] }],
        ["a negative fee", { ...devTerms, sessionFeeMicros: -1 }],
        ["a fractional ceiling", { ...devTerms, maxPricePerCallMicros: 1.5 }],
        ["no maxServices", { ...devTerms, maxServices: undefined }],
        ["no startWithX402", { ...devTerms, startWithX402: undefined }],
        ["no maxNewServicesPerOrder", { ...devTerms, maxNewServicesPerOrder: undefined }],
        ["no sellerMemoMaxBytes", { ...devTerms, sellerMemoMaxBytes: undefined }],
    ])("answers terms with %s as unavailable", async (_name, body) => {
        const s = await serve(() => ({ status: 200, body }));
        await expect(new HttpPayments(s.url, "tok").x402Terms(signal())).rejects.toMatchObject({
            kind: "unavailable",
            message: paymentsUnavailableText,
        });
    });

    it("reads an account by its encoded handle hash", async () => {
        const s = await serve(() => ({ status: 200, body: { x402: null, feeDue: true } }));
        expect(await new HttpPayments(s.url, "tok").x402Account("ab/cd", signal())).toEqual({
            x402: null,
            feeDue: true,
        });
        expect(s.seen[0]).toMatchObject({ method: "GET", url: "/v1/x402/accounts/ab%2Fcd" });
    });

    it("reads a closed account's refund block, and an account without allowanceRoomMicros as unavailable", async () => {
        const closed = {
            state: "closed",
            fundedMicros: 1_000_000,
            spentMicros: 730_000,
            heldMicros: 0,
            leftMicros: 270_000,
            allowanceRoomMicros: 4_000_000,
            paidCalls: 73,
            pendingCalls: 0,
            spendPerMinuteMicros: 500_000,
            services: [],
            refund: { state: "waiting", amountMicros: 0, keptMicros: 0, txs: [] },
        };
        const s = await serve(() => ({ status: 200, body: { x402: closed, feeDue: false } }));
        expect(await new HttpPayments(s.url, "tok").x402Account("ab", signal())).toEqual({
            x402: closed,
            feeDue: false,
        });
        const noRoom: Partial<typeof closed> = { ...closed };
        delete noRoom.allowanceRoomMicros;
        const t = await serve(() => ({ status: 200, body: { x402: noRoom, feeDue: false } }));
        await expect(
            new HttpPayments(t.url, "tok").x402Account("ab", signal()),
        ).rejects.toMatchObject({ kind: "unavailable" });
    });

    it.each([
        [503, { error: "router_unavailable" }],
        [404, { error: "not_found" }],
        [500, {}],
    ])("answers an account read of %i as unavailable", async (status, body) => {
        const s = await serve(() => ({ status, body }));
        await expect(
            new HttpPayments(s.url, "tok").x402Account("ab", signal()),
        ).rejects.toMatchObject({ kind: "unavailable" });
    });

    it("asks seller stats for at most 20 hosts, and nothing for none", async () => {
        const stats = { "a.example": { paidCalls30d: 120, failedPaid30d: 3 } };
        const s = await serve(() => ({ status: 200, body: stats }));
        const p = new HttpPayments(s.url, "tok");
        const hosts = Array.from({ length: 21 }, (_, i) => `h${i}.example`);
        expect(await p.x402Sellers(hosts, signal())).toEqual(stats);
        expect(new URL(s.seen[0]!.url, "http://x").searchParams.get("hosts")).toBe(
            hosts.slice(0, 20).join(","),
        );
        expect(await p.x402Sellers([], signal())).toEqual({});
        expect(s.seen).toHaveLength(1);
    });

    it("posts configure with empty lists filled in and the minute limit only when given", async () => {
        const s = await serve(() => ({
            status: 200,
            body: { status: "refused", reason: "needs_payment" },
        }));
        const p = new HttpPayments(s.url, "tok");
        expect(
            await p.x402Configure(
                "ab",
                { disable: ["xs_w5a4htopmpzmmhos"] },
                "req_configure_0001",
                signal(),
            ),
        ).toEqual({ status: "refused", reason: "needs_payment" });
        await p.x402Configure(
            "ab",
            { spendPerMinuteMicros: 2_000_000 },
            "req_configure_0002",
            signal(),
        );
        expect(s.seen.map((r) => [r.method, r.url, JSON.parse(r.body)])).toEqual([
            [
                "POST",
                "/v1/x402/configure",
                {
                    handleSha256: "ab",
                    services: [],
                    disable: ["xs_w5a4htopmpzmmhos"],
                    requestId: "req_configure_0001",
                },
            ],
            [
                "POST",
                "/v1/x402/configure",
                {
                    handleSha256: "ab",
                    services: [],
                    disable: [],
                    spendPerMinuteMicros: 2_000_000,
                    requestId: "req_configure_0002",
                },
            ],
        ]);
    });

    it.each([
        [400, { status: "refused", reason: "bad_request" }],
        [401, {}],
    ])("maps a configure %i to a refusal", async (status, body) => {
        const s = await serve(() => ({ status, body }));
        const r = await new HttpPayments(s.url, "tok").x402Configure(
            "ab",
            {},
            "req_configure_0003",
            signal(),
        );
        expect(r).toEqual({
            status: "refused",
            reason: status === 400 ? "bad_request" : "unauthorized",
        });
    });

    it("answers a configure 503 as unavailable", async () => {
        const s = await serve(() => ({ status: 503, body: {} }));
        await expect(
            new HttpPayments(s.url, "tok").x402Configure("ab", {}, "req_configure_0004", signal()),
        ).rejects.toMatchObject({ kind: "unavailable" });
    });

    it.each([
        [400, { status: "refused", reason: "order_unknown" }],
        [200, { status: "refused", reason: "pin_refused" }],
        [200, { status: "refused" }],
    ])(
        "answers a configure %i refusal with an unknown reason as bad_request",
        async (status, body) => {
            const s = await serve(() => ({ status, body }));
            expect(
                await new HttpPayments(s.url, "tok").x402Configure(
                    "ab",
                    {},
                    "req_configure_0005",
                    signal(),
                ),
            ).toEqual({ status: "refused", reason: "bad_request" });
        },
    );
});
