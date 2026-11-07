import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayError } from "../router.ts";
import { abandonReason, HttpPayments, paymentsUnavailableText } from "./http.ts";
import type { OrderRequest } from "./port.ts";

interface Seen {
    method: string | undefined;
    path: string | undefined;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
}

const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map((s) => new Promise((r) => s.close(r)).then(() => undefined)),
    );
});

async function payments(answer: {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
}): Promise<{ client: HttpPayments; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            seen.push({
                method: req.method,
                path: req.url,
                headers: req.headers,
                body: raw ? JSON.parse(raw) : undefined,
            });
            res.writeHead(answer.status, answer.headers);
            if (typeof answer.body === "string") res.end(answer.body);
            else if (answer.body !== undefined) res.end(JSON.stringify(answer.body));
            else res.end();
        });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return { client: new HttpPayments(`http://127.0.0.1:${port}`, "tok"), seen };
}

const req: OrderRequest = {
    kind: "start",
    packageId: "small-10m",
    amountMicros: 50_000,
    description: "Bugnet sandbox",
    idempotencyKey: "toolu_1",
};
const sig = () => AbortSignal.timeout(5_000);

describe("HttpPayments.order", () => {
    it("posts the order with the bearer token and returns the answer", async () => {
        const paid = {
            status: "paid",
            orderId: "ord_1",
            orderToken: "t",
            payer: "P",
            kind: "start",
            packageId: "small-10m",
            amountMicros: 50_000,
        };
        const { client, seen } = await payments({ status: 200, body: paid });
        expect(await client.order(req, sig())).toEqual(paid);
        expect(seen).toEqual([
            expect.objectContaining({
                method: "POST",
                path: "/v1/orders",
                headers: expect.objectContaining({
                    "content-type": "application/json",
                    authorization: "Bearer tok",
                }),
                body: req,
            }),
        ]);
    });

    it.each([
        {
            status: "payment_required",
            orderId: "ord_1",
            claim: "C".repeat(43),
            payUrl: "https://pay.bugnet.sh/o/ord_1",
            paymentRequired: { x402Version: 2, accepts: [] },
        },
        { status: "refused", orderId: "ord_1", reason: "settling", retryAfterSeconds: 3 },
    ])("returns a 200 $status answer as it came", async (body) => {
        const { client } = await payments({ status: 200, body });
        expect(await client.order(req, sig())).toEqual(body);
    });

    it("throws when a 2xx answer has no status", async () => {
        const { client } = await payments({ status: 200, body: {} });
        await expect(client.order(req, sig())).rejects.toThrow(
            "payments answered without a status",
        );
    });

    it.each([
        [400, { status: "refused", reason: "bad_request" }, {}, "bad_request"],
        [413, { status: "refused", reason: "bad_request" }, { Connection: "close" }, "bad_request"],
        [401, { status: "refused", reason: "unauthorized" }, {}, "unauthorized"],
        [401, undefined, {}, "unauthorized"],
        [404, { error: "not_found" }, {}, "bad_request"],
        [409, "not json", {}, "bad_request"],
    ])("maps a %i answer to a refusal", async (status, body, headers, reason) => {
        const { client } = await payments({ status, body, headers });
        expect(await client.order(req, sig())).toEqual({ status: "refused", reason });
    });

    it.each([500, 503])("says the payment service did not answer on %i", async (status) => {
        const { client } = await payments({ status, body: { error: "down" } });
        await expect(client.order(req, sig())).rejects.toMatchObject({
            kind: "unavailable",
            message: "the payment service did not answer, try again in a minute",
        });
        expect(paymentsUnavailableText).toBe(
            "the payment service did not answer, try again in a minute",
        );
    });

    it("says the payment service did not answer when nothing listens", async () => {
        const dead = createServer();
        await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
        const { port } = dead.address() as AddressInfo;
        await new Promise((r) => dead.close(r));
        const client = new HttpPayments(`http://127.0.0.1:${port}`, "tok");
        const err = await client.order(req, sig()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(GatewayError);
        expect(err).toMatchObject({ kind: "unavailable", message: paymentsUnavailableText });
    });

    it("rejects with the caller's abort reason", async () => {
        const { client } = await payments({ status: 200, body: {} });
        const reason = new Error("gave up");
        await expect(client.order(req, AbortSignal.abort(reason))).rejects.toBe(reason);
    });
});

describe("abandonReason", () => {
    it("strips control characters, trims and cuts to 200", () => {
        expect(abandonReason(" not_applied ")).toBe("not_applied");
        expect(abandonReason("a\u0000b\u001fc\u007fd\u0085")).toBe("abcd");
        expect(abandonReason("x".repeat(250))).toBe("x".repeat(200));
        expect(abandonReason("   ")).toBe("abandoned");
        expect(abandonReason("\u0000\n")).toBe("abandoned");
    });
});

describe("HttpPayments.abandon", () => {
    it("posts the cleaned reason to the order's abandon path", async () => {
        const { client, seen } = await payments({ status: 204 });
        await client.abandon("a/b", "denied\n", sig());
        expect(seen[0]).toEqual(
            expect.objectContaining({
                method: "POST",
                path: "/v1/orders/a%2Fb/abandon",
                body: { reason: "denied" },
            }),
        );
    });

    it("counts 404 as done", async () => {
        const { client } = await payments({
            status: 404,
            body: { status: "refused", reason: "order_unknown" },
        });
        await expect(client.abandon("ord_1", "denied", sig())).resolves.toBeUndefined();
    });

    it("rejects any other 4xx with its reason, and a 5xx as unavailable", async () => {
        const bad = await payments({
            status: 400,
            body: { status: "refused", reason: "bad_request" },
        });
        await expect(bad.client.abandon("ord_1", "x", sig())).rejects.toThrow(
            "abandon refused: bad_request",
        );
        const down = await payments({ status: 503 });
        await expect(down.client.abandon("ord_1", "x", sig())).rejects.toMatchObject({
            kind: "unavailable",
        });
    });
});
