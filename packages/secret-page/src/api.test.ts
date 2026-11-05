import { describe, expect, it } from "vitest";
import {
    RouteFailure,
    getLink,
    submitBody,
    submitSecret,
    tokenFromPath,
    type Fetch,
} from "./api.ts";

const token = "bnsl_AAAAAAAAAAAAAAAAAAAAAA";

interface Call {
    input: string;
    init: RequestInit;
}

function fake(status: number, body: string, headers: Record<string, string> = {}) {
    const calls: Call[] = [];
    const fetchFn: Fetch = async (input, init) => {
        calls.push({ input, init });
        return new Response(body, { status, headers });
    };
    return { calls, fetchFn };
}

const sealed = {
    spec: { name: "HF_TOKEN", hosts: ["huggingface.co"], headerNames: [], fetchOnly: false },
    value: { keyId: "k1", box: "Ym94" },
};

describe("tokenFromPath", () => {
    it("reads the token from /l/<token>", () => {
        expect(tokenFromPath(`/l/${token}`)).toBe(token);
        expect(tokenFromPath(`/l/${token}/`)).toBe(token);
    });

    it("refuses anything else", () => {
        for (const path of [
            "/",
            "/l/",
            "/l/bnsl_short",
            `/l/${token}/x`,
            `/x/${token}`,
            "/l/bnsp_AAAAAAAAAAAAAAAAAAAAAA",
            "/l/%E0%A4%A",
            `/l/${token.slice(0, -1)}%2F`,
        ]) {
            expect(tokenFromPath(path), path).toBeNull();
        }
    });
});

describe("getLink", () => {
    it("sends a same-origin JSON GET with no credentials", async () => {
        const { calls, fetchFn } = fake(200, JSON.stringify({ pairingCode: "K3F9X2" }));
        const link = await getLink(fetchFn, token);
        expect(link.pairingCode).toBe("K3F9X2");
        expect(calls).toHaveLength(1);
        const { input, init } = calls[0] as Call;
        expect(input).toBe(`/v1/links/${token}`);
        expect(init).toMatchObject({
            method: "GET",
            headers: { accept: "application/json", "content-type": "application/json" },
            mode: "same-origin",
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            referrerPolicy: "no-referrer",
        });
        expect(init.body).toBeUndefined();
    });

    it("turns a refusal into the page's sentence", async () => {
        const { fetchFn } = fake(404, JSON.stringify({ error: "link_unknown", message: "x" }));
        const err = await getLink(fetchFn, token).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RouteFailure);
        expect((err as RouteFailure).problem).toMatchObject({ code: "link_unknown", final: true });
    });

    it("passes Retry-After on", async () => {
        const { fetchFn } = fake(429, "", { "retry-after": "5" });
        const err = (await getLink(fetchFn, token).catch((e: unknown) => e)) as RouteFailure;
        expect(err.problem.message).toMatch(/Wait 5 seconds first\.$/);
    });

    it("says so when Bugnet does not answer or answers nonsense", async () => {
        const down: Fetch = () => Promise.reject(new TypeError("Failed to fetch"));
        const err = (await getLink(down, token).catch((e: unknown) => e)) as RouteFailure;
        expect(err.problem.code).toBe("network");
        const { fetchFn } = fake(200, "<html>");
        const bad = (await getLink(fetchFn, token).catch((e: unknown) => e)) as RouteFailure;
        expect(bad.problem.code).toBe("bad_answer");
        const shapeless = fake(200, JSON.stringify({ pairingCode: 7 }));
        const odd = (await getLink(shapeless.fetchFn, token).catch(
            (e: unknown) => e,
        )) as RouteFailure;
        expect(odd.problem.code).toBe("bad_answer");
    });
});

describe("submitSecret", () => {
    it("PUTs exactly data-plane 8.4's body", async () => {
        const answer = { secret: { spec: sealed.spec, state: "ACTIVE", failureReason: "" } };
        const { calls, fetchFn } = fake(200, JSON.stringify(answer));
        const got = await submitSecret(fetchFn, token, sealed, "sub-1");
        expect(got.state).toBe("ACTIVE");
        const { input, init } = calls[0] as Call;
        expect(input).toBe(`/v1/links/${token}/secret`);
        expect(init.method).toBe("PUT");
        expect(init.credentials).toBe("omit");
        expect(JSON.parse(init.body as string)).toEqual({
            spec: {
                name: "HF_TOKEN",
                hosts: ["huggingface.co"],
                headerNames: [],
                fetchOnly: false,
            },
            value: { keyId: "k1", box: "Ym94" },
            submissionId: "sub-1",
        });
    });

    it("sends no field the route would refuse as unknown", () => {
        const extra = {
            spec: { ...sealed.spec, extra: 1 },
            value: { ...sealed.value, other: 2 },
        } as unknown as typeof sealed;
        const body = submitBody(extra, "s") as Record<string, Record<string, unknown>>;
        expect(Object.keys(body).sort()).toEqual(["spec", "submissionId", "value"]);
        expect(Object.keys(body.spec as object).sort()).toEqual([
            "fetchOnly",
            "headerNames",
            "hosts",
            "name",
        ]);
        expect(Object.keys(body.value as object).sort()).toEqual(["box", "keyId"]);
    });
});
