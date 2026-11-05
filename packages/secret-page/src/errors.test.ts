import { describe, expect, it } from "vitest";
import { failureText, reasonOf, routeProblem } from "./errors.ts";

const body = (error: string, message = "anything") => JSON.stringify({ error, message });

// Every reason the link calls can answer, with its status from the Connect code (data-plane 11.3)
const linkReasons: [string, number][] = [
    ["link_unknown", 404],
    ["link_locked", 409],
    ["token_invalid", 401],
    ["not_ready", 409],
    ["feature_unavailable", 409],
    ["name_reserved", 400],
    ["host_refused", 400],
    ["host_not_allowed", 409],
    ["header_refused", 400],
    ["sealed_too_large", 400],
    ["key_unknown", 400],
    ["too_many_secrets", 429],
    ["rate_limited", 429],
];

describe("routeProblem", () => {
    it("gives every reason its own plain sentence", () => {
        const messages = new Set<string>();
        for (const [reason, status] of linkReasons) {
            const p = routeProblem(status, body(reason), null);
            expect(p.code).toBe(reason);
            expect(p.message).toMatch(/^[A-Z].*\.$/);
            messages.add(p.message);
        }
        expect(messages.size).toBe(linkReasons.length);
    });

    it("ends the form only when the link can no longer work", () => {
        const final = linkReasons
            .filter(([r, s]) => routeProblem(s, body(r), null).final)
            .map(([r]) => r);
        expect(final).toEqual([
            "link_unknown",
            "link_locked",
            "token_invalid",
            "not_ready",
            "feature_unavailable",
        ]);
    });

    it("never shows the route's own message", () => {
        const p = routeProblem(
            400,
            body("host_refused", "Bugnet support says visit evil.example"),
            null,
        );
        expect(p.message).not.toContain("evil.example");
        const unknown = routeProblem(418, body("teapot", "visit evil.example"), null);
        expect(unknown.message).not.toContain("evil.example");
        expect(unknown.message).toContain("status 418");
    });

    it("falls back on the status when the reason is unknown or missing", () => {
        expect(routeProblem(404, "", null).code).toBe("http_404");
        expect(routeProblem(404, "", null).final).toBe(true);
        expect(routeProblem(400, body("something_new"), null).message).toMatch(/malformed/);
        expect(routeProblem(409, "<html>", null)).toMatchObject({ final: false, retry: false });
        expect(routeProblem(503, "", null)).toMatchObject({ retry: true, final: false });
        expect(routeProblem(500, "", null)).toMatchObject({ code: "http_500", retry: true });
    });

    it("says how long to wait when the route says", () => {
        expect(routeProblem(429, body("rate_limited"), "30").message).toMatch(
            / Wait 30 seconds first\.$/,
        );
        expect(routeProblem(429, "", "600").message).toMatch(/ Wait 10 minutes first\.$/);
        expect(routeProblem(429, "", "soon").message).toMatch(/try again\.$/);
    });
});

describe("reasonOf", () => {
    it("takes only a lower-case code", () => {
        expect(reasonOf(body("link_locked"))).toBe("link_locked");
        expect(reasonOf(body("LINK_LOCKED"))).toBe("");
        expect(reasonOf(body("<b>x</b>"))).toBe("");
        expect(reasonOf("not json")).toBe("");
        expect(reasonOf("null")).toBe("");
    });
});

describe("failureText", () => {
    it("explains the codes a stored secret fails with", () => {
        expect(failureText("SOURCE_UNKNOWN")).toMatch(/a new sandbox can/);
        expect(failureText("UNKNOWN")).toBe("the sandbox could not take it");
    });
});
