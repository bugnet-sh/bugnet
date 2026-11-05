import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
    PlacementState,
    type CreateSecretPutGrantRequest,
} from "../gen/bugnet/router/v1/router_pb.ts";
import type { Log } from "../log.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    placement,
    routerError,
    testDeps,
    testHandle,
    testNow,
    type RouterImpl,
} from "../testing/harness.ts";
import { putGrantToolName } from "./secret-grant.ts";

const grant = "bnsp_" + "A".repeat(54);

function recordingLog(lines: string[]): Log {
    const write = (msg: string, fields?: Record<string, unknown>) =>
        lines.push(JSON.stringify({ msg, ...fields }));
    return { info: write, warn: write, error: write };
}

async function connect(impl: RouterImpl, lines: string[] = []): Promise<Client> {
    return connectTools(testDeps({ router: fakeRouter(impl), log: recordingLog(lines) }));
}

const call = (client: Client, handle = testHandle) =>
    callTool<{ putGrant: string; expiresAt: string | null }>(client, putGrantToolName, { handle });

describe("bugnet_secret_put_grant", () => {
    it("returns the router's grant and logs only a handle tag", async () => {
        const seen: CreateSecretPutGrantRequest[] = [];
        const lines: string[] = [];
        const client = await connect(
            {
                createSecretPutGrant(req) {
                    seen.push(req);
                    return { putGrant: grant, expiresAt: timestampFromMs(testNow + 600_000) };
                },
            },
            lines,
        );
        const r = await call(client);
        expect(r.isError).toBe(false);
        expect(r.structured).toEqual({
            message: "Put grant ready, valid until 2026-11-05T12:10:00.000Z.",
            putGrant: grant,
            expiresAt: "2026-11-05T12:10:00.000Z",
        });
        expect(seen.map((s) => s.handle)).toEqual([testHandle]);
        expect(lines.join("\n")).not.toContain(testHandle);
        expect(lines.join("\n")).not.toContain(grant);
        expect(lines.join("\n")).toMatch(/"handle":"h:[0-9a-f]{12}"/);
    });

    it("is not read-only and needs no approval prompt", async () => {
        const client = await connect({});
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === putGrantToolName);
        expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
        expect(tool?._meta?.["anthropic/requiresUserInteraction"]).toBeUndefined();
        expect(tool?.description?.length).toBeLessThan(600);
    });

    it("says the feature is not open yet while the router answers Unimplemented", async () => {
        const r = await call(await connect({}));
        expect(r.isError).toBe(true);
        expect(r.text).toBe("secret grant: not open yet, the other Bugnet tools work as usual.");
    });

    it("says secrets are not open on this sandbox on FEATURE_UNAVAILABLE", async () => {
        const client = await connect({
            createSecretPutGrant() {
                throw routerError(Code.FailedPrecondition, "FEATURE_UNAVAILABLE");
            },
        });
        const r = await call(client);
        expect(r.text).toBe(
            "secret grant: not open on this sandbox yet, the other Bugnet tools work as usual.",
        );
    });

    it("reports NOT_READY on an ended sandbox as expired", async () => {
        const client = await connect({
            createSecretPutGrant() {
                throw routerError(Code.FailedPrecondition, "NOT_READY");
            },
            getPlacement: () => ({ placement: placement(PlacementState.TERMINATED) }),
        });
        const r = await call(client);
        expect(r.text).toMatch(/^secret grant: this sandbox has ended and everything in it/);
    });

    it("passes on the RetryInfo delay of RATE_LIMITED", async () => {
        const client = await connect({
            createSecretPutGrant() {
                throw routerError(Code.ResourceExhausted, "RATE_LIMITED", { retryAfterMs: 3500 });
            },
        });
        const r = await call(client);
        expect(r.text).toBe("secret grant: too many requests for now. Retry after 4 s.");
    });

    it("passes on an InvalidArgument refusal without provider names", async () => {
        const client = await connect({
            createSecretPutGrant() {
                throw routerError(Code.InvalidArgument, undefined, {
                    message: "api: e2b refused the handle",
                });
            },
        });
        const r = await call(client);
        expect(r.text).toBe("secret grant: provider refused the handle.");
    });

    it("refuses a malformed handle before calling the router", async () => {
        let called = false;
        const client = await connect({
            createSecretPutGrant() {
                called = true;
                return { putGrant: grant };
            },
        });
        const r = await call(client, "sbx_short");
        expect(r.isError).toBe(true);
        expect(called).toBe(false);
    });

    it("treats an answer without a grant as a failure", async () => {
        const client = await connect({ createSecretPutGrant: () => ({ putGrant: "" }) });
        const r = await call(client);
        expect(r.text).toBe("secret grant: the router gave no grant.");
    });
});
