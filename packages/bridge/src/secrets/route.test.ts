import { describe, expect, it } from "vitest";
import { RouteError, getSealingKeys, putSecret, type RouteOptions } from "./route.ts";

const grant = "bnsp_" + "Q".repeat(54);
const signal = new AbortController().signal;
const spec = { name: "HF_TOKEN", hosts: ["huggingface.co"], headerNames: [], fetchOnly: false };
const value = { keyId: "k1", box: "AAAA" };

interface Seen {
    url: string;
    init: RequestInit;
}

function route(answer: (seen: Seen) => Response, seen: Seen[] = []): RouteOptions {
    return {
        baseUrl: "https://secrets.example",
        timeoutMs: 1000,
        fetch: async (url, init) => {
            const s = { url: String(url), init: init ?? {} };
            seen.push(s);
            return answer(s);
        },
    };
}

const json = (status: number, doc: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(doc), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });

async function refusal(p: Promise<unknown>): Promise<RouteError> {
    try {
        await p;
    } catch (e) {
        if (e instanceof RouteError) return e;
        throw e;
    }
    throw new Error("expected a refusal");
}

describe("secrets route client", () => {
    it("sends the grant only in Authorization and the 8.4 body", async () => {
        const seen: Seen[] = [];
        const opts = route(
            () =>
                json(200, {
                    secret: { spec, state: "APPLYING", updatedAt: "x", failureReason: "" },
                    replaced: true,
                }),
            seen,
        );
        const answer = await putSecret(opts, grant, spec, value, "toolu_1", signal);
        expect(answer).toEqual({
            secret: { spec, state: "APPLYING", updatedAt: "x", failureReason: "" },
            replaced: true,
        });
        expect(seen[0]?.url).toBe("https://secrets.example/v1/secrets/HF_TOKEN");
        expect(seen[0]?.init.method).toBe("PUT");
        expect(seen[0]?.init.headers).toEqual({
            authorization: `Bearer ${grant}`,
            accept: "application/json",
            "content-type": "application/json",
        });
        expect(seen[0]?.init.redirect).toBe("error");
        expect(JSON.parse(seen[0]?.init.body as string)).toEqual({
            spec,
            value,
            idempotencyKey: "toolu_1",
        });
        expect(seen[0]?.init.body).not.toContain(grant);
    });

    it("lists the sealing keys", async () => {
        const keys = [{ keyId: "k2", publicKey: "p", binding: "b" }];
        const seen: Seen[] = [];
        const got = await getSealingKeys(
            route(() => json(200, { sealingKeys: keys }), seen),
            grant,
            signal,
        );
        expect(got).toEqual(keys);
        expect(seen[0]?.url).toBe("https://secrets.example/v1/sealing-key");
        expect(seen[0]?.init.method).toBe("GET");
        expect(seen[0]?.init.body).toBeUndefined();
    });

    it.each([
        [401, "put_grant_invalid", /put grant expired/],
        [409, "feature_unavailable", /secrets are not open on this sandbox yet/],
        [409, "not_ready", /not ready or has ended/],
        [400, "host_refused", /cannot be sent to one of those hosts/],
        [400, "key_unknown", /sealing key is no longer current/],
        [404, "", /does not know this sandbox/],
        [500, "", /answered 500/],
    ])("turns %i %j into a fixed sentence", async (status, error, text) => {
        const body = { error, message: "router said: e2b sbx_secret_handle" };
        const e = await refusal(
            getSealingKeys(
                route(() => json(status, body)),
                grant,
                signal,
            ),
        );
        expect(e.message).toMatch(text);
        expect(e.message).not.toMatch(/e2b|sbx_/);
        expect(e.reason).toBe(error || `http_${status}`);
    });

    it("keeps the Retry-After of a 429", async () => {
        const opts = route(() => json(429, { error: "rate_limited" }, { "retry-after": "7" }));
        const e = await refusal(getSealingKeys(opts, grant, signal));
        expect(e.message).toBe("too many requests for now");
        expect(e.retryAfterSeconds).toBe(7);
    });

    it("reads an unreachable route and an unreadable answer as refusals", async () => {
        const down: RouteOptions = {
            baseUrl: "https://secrets.example",
            timeoutMs: 1000,
            fetch: async () => {
                throw new TypeError("fetch failed");
            },
        };
        expect((await refusal(getSealingKeys(down, grant, signal))).reason).toBe("unreachable");
        const garbled = route(() => new Response("<html>", { status: 200 }));
        expect((await refusal(getSealingKeys(garbled, grant, signal))).reason).toBe("bad_json");
        const wrong = route(() => json(200, { sealingKeys: "no" }));
        expect((await refusal(getSealingKeys(wrong, grant, signal))).reason).toBe("bad_json");
    });
});
