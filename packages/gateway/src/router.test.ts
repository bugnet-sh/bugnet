import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { errorInfoType, fromRouter, GatewayError, reasonOf, retryDelayMs } from "./router.ts";
import { fakeRouter, routerError, testHandle } from "./testing/harness.ts";

const providers = /koyeb|boat|e2b|boxd|instabox|daytona/i;

// Every reason the gateway maps, with the code the router sends it under and the kind it becomes
const table: [string, Code, string][] = [
    ["PORT_REFUSED", Code.InvalidArgument, "invalid"],
    ["PATH_REFUSED", Code.InvalidArgument, "invalid"],
    ["SIZE_REQUIRED", Code.InvalidArgument, "invalid"],
    ["SIZE_MISMATCH", Code.InvalidArgument, "invalid"],
    ["IS_DIRECTORY", Code.InvalidArgument, "invalid"],
    ["NOT_REGULAR", Code.InvalidArgument, "invalid"],
    ["KEY_INVALID", Code.InvalidArgument, "invalid"],
    ["NAME_RESERVED", Code.InvalidArgument, "invalid"],
    ["HOST_REFUSED", Code.InvalidArgument, "invalid"],
    ["HEADER_REFUSED", Code.InvalidArgument, "invalid"],
    ["SEALED_TOO_LARGE", Code.InvalidArgument, "invalid"],
    ["KEY_UNKNOWN", Code.InvalidArgument, "invalid"],
    ["SOURCE_INVALID", Code.InvalidArgument, "invalid"],
    ["SECRET_IN_ARGUMENT", Code.InvalidArgument, "invalid"],
    ["IDEMPOTENCY_KEY_RESERVED", Code.InvalidArgument, "invalid"],
    ["QUOTE_INVALID", Code.InvalidArgument, "invalid"],
    ["PACKAGE_UNKNOWN", Code.InvalidArgument, "invalid"],
    ["NOT_START_PACKAGE", Code.InvalidArgument, "invalid"],
    ["HANDLE_UNKNOWN", Code.NotFound, "not_found"],
    ["JOB_UNKNOWN", Code.NotFound, "not_found"],
    ["not_found", Code.NotFound, "not_found"],
    ["FILE_NOT_FOUND", Code.NotFound, "not_found"],
    ["PREVIEW_UNKNOWN", Code.NotFound, "not_found"],
    ["TOKEN_UNKNOWN", Code.NotFound, "not_found"],
    ["LINK_UNKNOWN", Code.NotFound, "not_found"],
    ["GRANT_UNKNOWN", Code.NotFound, "not_found"],
    ["TOKEN_INVALID", Code.PermissionDenied, "denied"],
    ["GRANT_INVALID", Code.PermissionDenied, "denied"],
    ["PUT_GRANT_INVALID", Code.PermissionDenied, "denied"],
    ["WALLET_BLOCKED", Code.PermissionDenied, "denied"],
    ["PAYER_REQUIRED", Code.PermissionDenied, "denied"],
    ["NOT_READY", Code.FailedPrecondition, "not_ready"],
    ["EXCEEDS_LIFETIME", Code.FailedPrecondition, "invalid"],
    ["FEATURE_UNAVAILABLE", Code.FailedPrecondition, "unsupported"],
    ["PREVIEW_REVOKED", Code.FailedPrecondition, "revoked"],
    ["TOKEN_USED", Code.FailedPrecondition, "precondition"],
    ["TOKEN_EXPIRED", Code.FailedPrecondition, "precondition"],
    ["IN_USE", Code.FailedPrecondition, "precondition"],
    ["FILE_CHANGED", Code.FailedPrecondition, "precondition"],
    ["LINK_LOCKED", Code.FailedPrecondition, "precondition"],
    ["HOST_NOT_ALLOWED", Code.FailedPrecondition, "precondition"],
    ["NO_SOURCE", Code.FailedPrecondition, "precondition"],
    ["SECRET_REQUIRED", Code.FailedPrecondition, "precondition"],
    ["TOOL_MISSING", Code.FailedPrecondition, "precondition"],
    ["OVER_CAP", Code.OutOfRange, "limit"],
    ["RANGE", Code.OutOfRange, "invalid"],
    ["RATE_LIMITED", Code.ResourceExhausted, "rate_limited"],
    ["BUDGET_SPENT", Code.ResourceExhausted, "limit"],
    ["TOO_MANY_PREVIEWS", Code.ResourceExhausted, "limit"],
    ["TOO_MANY_TRANSFERS", Code.ResourceExhausted, "limit"],
    ["TOO_MANY_KEYS", Code.ResourceExhausted, "limit"],
    ["TOO_MANY_SECRETS", Code.ResourceExhausted, "limit"],
    ["TOO_MANY_CONNECTIONS", Code.ResourceExhausted, "limit"],
    ["NO_SPACE", Code.ResourceExhausted, "limit"],
    ["WALLET_BUSY", Code.ResourceExhausted, "limit"],
    ["WALLET_RATE_LIMITED", Code.ResourceExhausted, "rate_limited"],
    ["CHECKSUM_MISMATCH", Code.DataLoss, "invalid"],
    ["GATE_UNAVAILABLE", Code.Unavailable, "unavailable"],
    ["SSH_PREPARING", Code.Unavailable, "unavailable"],
    ["PROVIDER_UNAVAILABLE", Code.Unavailable, "unavailable"],
];

describe("router error details", () => {
    it("decodes ErrorInfo and RetryInfo bytes as the Go router writes them", () => {
        const err = new ConnectError("x", Code.ResourceExhausted);
        const reason = new TextEncoder().encode("RATE_LIMITED");
        const domain = new TextEncoder().encode("bugnet.router");
        err.details.push({
            type: errorInfoType,
            value: new Uint8Array([0x0a, reason.length, ...reason, 0x12, domain.length, ...domain]),
        });
        // retry_delay of 1.5 s, seconds 1 and nanos 500000000
        err.details.push({
            type: "google.rpc.RetryInfo",
            value: new Uint8Array([0x0a, 0x08, 0x08, 0x01, 0x10, 0x80, 0xca, 0xb5, 0xee, 0x01]),
        });
        expect(reasonOf(err)).toBe("RATE_LIMITED");
        expect(retryDelayMs(err)).toBe(1500);
    });

    it("reads a reason after the domain and ignores malformed bytes", () => {
        const err = new ConnectError("x", Code.NotFound);
        const domain = new TextEncoder().encode("bugnet.router");
        err.details.push({
            type: errorInfoType,
            value: new Uint8Array([0x12, domain.length, ...domain, 0x0a, 0x02, 0x41, 0x42]),
        });
        expect(reasonOf(err)).toBe("AB");
        const bad = new ConnectError("x", Code.NotFound);
        bad.details.push({ type: errorInfoType, value: new Uint8Array([0x0a, 0x7f, 0x41]) });
        bad.details.push({ type: "google.rpc.RetryInfo", value: new Uint8Array([0x0a, 0x09]) });
        expect(reasonOf(bad)).toBeNull();
        expect(retryDelayMs(bad)).toBeNull();
    });

    it("round-trips the harness's details through a Connect transport", async () => {
        const router = fakeRouter({
            exec() {
                throw routerError(Code.ResourceExhausted, "RATE_LIMITED", { retryAfterMs: 2250 });
            },
        });
        const err = await router.exec({ handle: testHandle }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConnectError);
        expect(reasonOf(err)).toBe("RATE_LIMITED");
        expect(retryDelayMs(err as ConnectError)).toBe(2250);
        const g = fromRouter(err, "exec");
        expect(g.kind).toBe("rate_limited");
        expect(g.retryAfterMs).toBe(2250);
        expect(reasonOf(g)).toBe("RATE_LIMITED");
    });

    it("answers Unimplemented for every method the fake leaves out", async () => {
        const err = await fakeRouter({})
            .createPreview({ handle: testHandle, port: 3000 })
            .catch((e: unknown) => e);
        expect((err as ConnectError).code).toBe(Code.Unimplemented);
        expect(fromRouter(err, "preview").kind).toBe("unsupported");
    });
});

describe("fromRouter", () => {
    it.each(table)("maps %s under its code", (reason, code, kind) => {
        const e = fromRouter(routerError(code, reason, { message: "boxd said e2b no" }), "op");
        expect(e.kind).toBe(kind);
        expect(e.reason).toBe(reason);
        expect(e.message).toMatch(/^op: \S/);
        expect(e.message).not.toMatch(providers);
        expect(e.message).not.toMatch(/said/);
    });

    it("ignores a reason sent under another code", () => {
        const e = fromRouter(routerError(Code.FailedPrecondition, "WALLET_BLOCKED"), "start");
        expect(e.kind).toBe("precondition");
        const n = fromRouter(routerError(Code.Internal, "NOT_READY"), "exec");
        expect(n.kind).toBe("internal");
        expect(n.message).toBe("exec failed");
    });

    it("keeps the handle wording for a bare NotFound only", () => {
        expect(fromRouter(routerError(Code.NotFound), "exec").message).toMatch(
            /no sandbox has this handle/,
        );
        const other = fromRouter(routerError(Code.NotFound, "SOMETHING_NEW"), "exec");
        expect(other.kind).toBe("not_found");
        expect(other.message).not.toMatch(/handle/);
    });

    it("keeps a bare FailedPrecondition as not ready, an unknown reason as a precondition", () => {
        expect(fromRouter(routerError(Code.FailedPrecondition), "exec").kind).toBe("not_ready");
        const e = fromRouter(routerError(Code.FailedPrecondition, "SOMETHING_NEW"), "exec");
        expect(e.kind).toBe("precondition");
    });

    it("says an unimplemented feature is not open yet", () => {
        const e = fromRouter(new ConnectError("x", Code.Unimplemented), "preview");
        expect(e.kind).toBe("unsupported");
        expect(e.message).toBe(
            "preview: Bugnet has not opened this yet, so a retry now or later, or a new sandbox " +
                "from any quote, gets the same answer. The other Bugnet tools work as usual",
        );
        const f = fromRouter(routerError(Code.FailedPrecondition, "FEATURE_UNAVAILABLE"), "ssh");
        expect(f.message).toMatch(/^ssh: not open on this sandbox yet/);
    });

    it("says a revoked preview is closed for good", () => {
        const e = fromRouter(routerError(Code.FailedPrecondition, "PREVIEW_REVOKED"), "preview");
        expect(e.kind).toBe("revoked");
        expect(e.retryAfterMs).toBeNull();
        expect(e.message).toMatch(/for good/);
        expect(e.message).toMatch(/another port/);
    });

    it("waits the RetryInfo delay on rate limits, one second when none is given", () => {
        const wallet = routerError(Code.ResourceExhausted, "WALLET_RATE_LIMITED", {
            retryAfterMs: 30_000,
        });
        expect(fromRouter(wallet, "start").retryAfterMs).toBe(30_000);
        expect(fromRouter(routerError(Code.ResourceExhausted, "RATE_LIMITED"), "exec")).toEqual(
            expect.objectContaining({ kind: "rate_limited", retryAfterMs: 1000 }),
        );
        const busy = fromRouter(routerError(Code.ResourceExhausted, "WALLET_BUSY"), "start");
        expect(busy.retryAfterMs).toBeNull();
        expect(busy.message).toMatch(/bugnet_stop/);
    });

    it("tells the model where secrets go", () => {
        const e = fromRouter(routerError(Code.InvalidArgument, "SECRET_IN_ARGUMENT"), "quote");
        expect(e.message).toMatch(/bugnet_secret_link/);
    });

    it("passes a GatewayError through and gives no reason for other errors", () => {
        const g = new GatewayError("invalid", "x");
        expect(fromRouter(g, "op")).toBe(g);
        expect(reasonOf(g)).toBeNull();
        expect(reasonOf(new Error("boom"))).toBeNull();
        expect(fromRouter(new Error("e2b exploded"), "op").message).toBe("op failed");
    });
});
