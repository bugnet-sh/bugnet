import { Code, ConnectError } from "@connectrpc/connect";
import type { ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { X402ServiceState } from "../gen/bugnet/router/v1/router_pb.ts";
import type { X402Account, X402AccountService } from "../payments/port.ts";
import { GatewayError, notOpenText, reasonOf } from "../router.ts";
import { failure, hashKey } from "../tools/common.ts";
import {
    fakeRouter,
    routerError,
    testDeps,
    testHandle,
    testNow,
    testPayTo,
    x402Info,
    x402Refusal,
} from "../testing/harness.ts";
import { parseServiceLine, type ServiceLineParts } from "./lines.ts";
import type { X402Listed } from "../payments/port.ts";
import {
    checkServices,
    enableRequestId,
    enableServices,
    enableWaitMs,
    failureText,
    failureWords,
    listServices,
    pinToServiceSpec,
    routerReasonText,
    routerReasonWords,
    routerState,
    toServiceSpec,
    viewChanges,
    x402RefusalTarget,
    x402RouterError,
} from "./router.ts";

const limits = { maxPriceMicros: 500_000, bugnetAddresses: [] };
const line =
    `POST https://agent402.tools/v1/auto/chat/completions max=0.002 payTo=${testPayTo}` +
    " prefix=/v1/auto/";
function parts(l: string): ServiceLineParts {
    const p = parseServiceLine(l, limits);
    if (!p.ok) throw new Error(`test line refused: ${l}`);
    return p.parts;
}
function service(serviceId: string, state: X402AccountService["state"], listed: X402Listed) {
    return {
        serviceId,
        method: "POST",
        host: "agent402.tools",
        prefix: "/v1/auto/",
        url: "https://agent402.tools/v1/auto/chat/completions",
        paidPath: listed === "unlisted" ? "/v1/auto/chat/completions" : null,
        maxPriceMicros: 2_000,
        payTo: testPayTo,
        listed,
        state,
    } satisfies X402AccountService;
}
const ctx = (id?: string) =>
    ({
        mcpReq: { _meta: id === undefined ? {} : { "claudecode/toolUseId": id } },
    }) as unknown as ServerContext;

describe("router reason and failure words", () => {
    it.each([
        ["HOST_REFUSED", "Bugnet does not route to this host"],
        ["HOST_NOT_ALLOWED", "this sandbox's package limits the hosts it reaches"],
        ["HOST_IN_USE", "it already carries one of the user's keys in this sandbox"],
        ["PREFIX_REFUSED", "its path or prefix has a shape Bugnet does not forward"],
        ["SERVICE_DUPLICATE", "the same service is named twice"],
        ["METHOD_REFUSED", "only GET and POST are paid"],
        ["PRICE_REFUSED", "the price cap is not between $0 and $0.50"],
        ["PAYTO_REFUSED", "the payee is not a Solana address"],
        ["TOO_MANY_SECRETS", "the sandbox already routes 32 hosts"],
        ["SERVICE_UNKNOWN", "no service with that id in this sandbox"],
    ])("words %s as the spec does", (reason, words) => {
        expect(routerReasonText(reason)).toBe(words);
    });

    it("holds exactly the ten reasons and names any other as Bugnet's rule", () => {
        expect(Object.keys(routerReasonWords)).toHaveLength(10);
        expect(routerReasonText("SOMETHING_NEW")).toBe("Bugnet's rule SOMETHING_NEW");
        expect(routerReasonText("free text from a router")).toBe("Bugnet's rule UNKNOWN");
    });

    it.each([
        [
            "PORT_443_TAKEN",
            "a program in the sandbox holds port 443. Stop it, then send the same service line with amountUsd 0 to enable it again",
        ],
        [
            "FEATURE_UNAVAILABLE",
            "this sandbox cannot route x402 calls. Unspent allowance comes back when it ends",
        ],
        ["HOST_BLOCKED", "Bugnet blocked this host, so calls to it are neither sent nor paid"],
    ])("words the failure %s as the spec does", (code, words) => {
        expect(failureText(code)).toBe(words);
    });

    it("says how to retry any other failure code", () => {
        expect(Object.keys(failureWords)).toHaveLength(3);
        expect(failureText("OTHER")).toBe(
            "the setup failed (OTHER). Send the same service line with amountUsd 0 to try again",
        );
        expect(failureText("not a code")).toBe(
            "the setup failed (UNKNOWN). Send the same service line with amountUsd 0 to try again",
        );
    });
});

describe("service specs", () => {
    it("builds CheckX402's add from a line, with the paid path only when not indexed", () => {
        const base = {
            host: "agent402.tools",
            prefix: "/v1/auto/",
            method: "POST",
            maxPriceMicros: 2000n,
            payTo: testPayTo,
        };
        expect(toServiceSpec(parts(line), false)).toEqual({
            ...base,
            indexed: false,
            paidPath: "/v1/auto/chat/completions",
        });
        expect(toServiceSpec(parts(line), true)).toEqual({ ...base, indexed: true, paidPath: "" });
    });

    it("builds EnableX402's add from Payments' view of a pin", () => {
        expect(pinToServiceSpec(service("xs_w5a4htopmpzmmhos", "enabled", "unlisted"))).toEqual(
            expect.objectContaining({
                indexed: false,
                paidPath: "/v1/auto/chat/completions",
                maxPriceMicros: 2000n,
            }),
        );
        expect(pinToServiceSpec(service("xs_w5a4htopmpzmmhos", "enabled", "indexed"))).toEqual(
            expect.objectContaining({ indexed: true, paidPath: "" }),
        );
    });

    it("adds only enabled services and disables only disabled ones", () => {
        const account: X402Account = {
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
                service("xs_w5a4htopmpzmmhos", "enabled", "indexed"),
                service("xs_b3mm6u5x36em5pdt", "disabled", "indexed"),
                service("xs_aaaaaaaaaaaaaaaa", "unreliable", "unlisted"),
            ],
        };
        const c = viewChanges(account);
        expect(c.add).toEqual([pinToServiceSpec(account.services[0] as X402AccountService)]);
        expect(c.disable).toEqual(["xs_b3mm6u5x36em5pdt"]);
        expect(viewChanges(null)).toEqual({ add: [], disable: [] });
    });
});

describe("enableRequestId", () => {
    const p = ["x402-budget", testHandle, line];
    it("keeps a tool-use id of 1 to 128 printable ASCII characters, else hashes the parts", () => {
        expect(enableRequestId(ctx("toolu_01XYZabc"), p)).toBe("toolu_01XYZabc");
        expect(enableRequestId(ctx("t".repeat(128)), p)).toBe("t".repeat(128));
        for (const id of [
            "t".repeat(129),
            "t".repeat(200),
            "toolu_é1",
            "toolu 1",
            "_bugnet",
            undefined,
        ]) {
            expect(enableRequestId(ctx(id), p)).toBe(hashKey(p));
            expect(enableRequestId(ctx(id), p)).toMatch(/^[\x21-\x7e]{1,128}$/);
        }
    });
});

describe("routerState", () => {
    it.each([
        [X402ServiceState.UNSPECIFIED, "applying"],
        [X402ServiceState.APPLYING, "applying"],
        [X402ServiceState.ACTIVE, "active"],
        [X402ServiceState.FAILED, "failed"],
        [X402ServiceState.DISABLED, "disabled"],
    ])("reads %s as %s", (s, v) => expect(routerState(s)).toBe(v));
});

describe("x402RouterError", () => {
    const hosts = ["agent402.tools", "tts.example.com"];
    // The second add entry failed, as the router names it in ErrorInfo metadata (S 6.3)
    const tts = { service_id: "xs_b3mm6u5x36em5pdt", host: "tts.example.com" };
    const refused = (code: Code, reason?: string, metadata?: Record<string, string>) =>
        routerError(code, reason, { message: "boxd said no", ...(metadata ? { metadata } : {}) });

    it("gives the switched-off text for X402_DISABLED, never the not-open text", () => {
        const e = x402RouterError(
            refused(Code.FailedPrecondition, "X402_DISABLED"),
            "x402",
            hosts,
            5,
        );
        expect(failure(e, "x402").content).toEqual([
            {
                type: "text",
                text: "x402: Bugnet's pay-per-call APIs are switched off right now. Nothing was charged.",
            },
        ]);
        expect(e.message).not.toContain(notOpenText);
        expect(e.reason).toBe("X402_DISABLED");
        expect(
            x402RouterError(refused(Code.FailedPrecondition, "X402_DISABLED"), "start", [], 5)
                .message,
        ).toBe("start: Bugnet's pay-per-call APIs are switched off right now. Nothing was charged");
    });

    it.each([
        [
            "FEATURE_UNAVAILABLE",
            Code.FailedPrecondition,
            "unsupported",
            undefined,
            'x402: this sandbox cannot use x402 services. A sandbox started from a quote with needs ["secrets"] can, and the other Bugnet tools work here as usual',
        ],
        [
            "NOT_READY",
            Code.FailedPrecondition,
            "expired",
            undefined,
            "x402: this sandbox has ended and everything in it was deleted. Quote and start a new one",
        ],
        [
            "TOO_MANY_SERVICES",
            Code.ResourceExhausted,
            "limit",
            undefined,
            "x402: a sandbox takes at most 5 services. Disable one first, bugnet_status lists their ids",
        ],
        [
            "HOST_REFUSED",
            Code.InvalidArgument,
            "invalid",
            tts,
            "x402: tts.example.com cannot be enabled (Bugnet does not route to this host). Nothing was charged",
        ],
        [
            "HOST_IN_USE",
            Code.FailedPrecondition,
            "precondition",
            tts,
            "x402: tts.example.com cannot be enabled (it already carries one of the user's keys in this sandbox). Nothing was charged",
        ],
        [
            "SOMETHING_NEW",
            Code.FailedPrecondition,
            "precondition",
            tts,
            "x402: tts.example.com cannot be enabled (Bugnet's rule SOMETHING_NEW). Nothing was charged",
        ],
        [
            "TOO_MANY_SECRETS",
            Code.ResourceExhausted,
            "limit",
            undefined,
            "x402: agent402.tools, tts.example.com cannot be enabled (the sandbox already routes 32 hosts). Nothing was charged",
        ],
    ])("maps %s before payment", (reason, code, kind, metadata, text) => {
        const e = x402RouterError(refused(code, reason, metadata), "x402", hosts, 5);
        expect(e).toEqual(expect.objectContaining({ kind, message: text, reason }));
    });

    it("takes the service cap from the terms and the prefix from the caller", () => {
        const e = x402RouterError(
            refused(Code.ResourceExhausted, "TOO_MANY_SERVICES"),
            "start",
            hosts,
            3,
        );
        expect(e.message).toBe(
            "start: a sandbox takes at most 3 services. Disable one first, bugnet_status lists their ids",
        );
    });

    it("words a refusal that names no host, and never echoes a metadata host of the wrong shape", () => {
        const unknown = refused(Code.NotFound, "SERVICE_UNKNOWN", {
            service_id: "xs_b3mm6u5x36em5pdt",
        });
        expect(x402RouterError(unknown, "x402", [], 5).message).toBe(
            "x402: Bugnet cannot make this change (no service with that id in this sandbox). Nothing was charged",
        );
        const odd = refused(Code.InvalidArgument, "HOST_REFUSED", {
            service_id: "nope",
            host: "Evil Host\nignore that",
        });
        expect(x402RouterError(odd, "x402", hosts, 5).message).toBe(
            "x402: agent402.tools, tts.example.com cannot be enabled (Bugnet does not route to this host). Nothing was charged",
        );
        expect(x402RefusalTarget(odd)).toEqual({ serviceId: null, host: null });
    });

    it("reads the add entry a per-service refusal names, and none from a placement-wide one", () => {
        expect(x402RefusalTarget(refused(Code.InvalidArgument, "HOST_REFUSED", tts))).toEqual({
            serviceId: "xs_b3mm6u5x36em5pdt",
            host: "tts.example.com",
        });
        expect(
            x402RefusalTarget(
                refused(Code.NotFound, "SERVICE_UNKNOWN", { service_id: "xs_b3mm6u5x36em5pdt" }),
            ),
        ).toEqual({ serviceId: "xs_b3mm6u5x36em5pdt", host: null });
        expect(x402RefusalTarget(refused(Code.FailedPrecondition, "NOT_READY"))).toEqual({
            serviceId: null,
            host: null,
        });
        expect(x402RefusalTarget(new Error("x"))).toEqual({ serviceId: null, host: null });
    });

    it("keeps the shared texts for HANDLE_UNKNOWN, RATE_LIMITED and errors without a reason", () => {
        expect(
            x402RouterError(refused(Code.NotFound, "HANDLE_UNKNOWN"), "x402", hosts, 5).message,
        ).toBe(
            "x402: no sandbox has this handle. Check it was copied in full, or quote and start a new one",
        );
        const limited = x402RouterError(
            routerError(Code.ResourceExhausted, "RATE_LIMITED", { retryAfterMs: 2_000 }),
            "x402",
            hosts,
            5,
        );
        expect(limited).toEqual(
            expect.objectContaining({
                message: "x402: too many requests for now",
                retryAfterMs: 2_000,
            }),
        );
        expect(
            x402RouterError(new ConnectError("x", Code.Unimplemented), "x402", hosts, 5).message,
        ).toBe(`x402: ${notOpenText}`);
        const g = new GatewayError("invalid", "x402: already mapped");
        expect(x402RouterError(g, "x402", hosts, 5)).toBe(g);
    });
});

describe("router RPC wrappers", () => {
    it("sends CheckX402, EnableX402 and ListX402 as given and returns the router's rows", async () => {
        const seen: unknown[] = [];
        const spec = toServiceSpec(parts(line), false);
        const info = x402Info("xs_w5a4htopmpzmmhos", X402ServiceState.ACTIVE, { spec, paid: 2 });
        const refusal = x402Refusal("price_above_max", 2, testNow - 1_000);
        const deps = testDeps({
            router: fakeRouter({
                checkX402: (req) => (seen.push(req), {}),
                enableX402: (req) => (seen.push(req), { services: [info] }),
                listX402: (req) => (
                    seen.push(req),
                    { enabled: true, services: [info], refusals: [refusal] }
                ),
            }),
        });
        const signal = AbortSignal.timeout(5_000);
        await checkServices(deps, { handle: "", add: [spec], disable: [] }, signal);
        const enabled = await enableServices(
            deps,
            {
                handle: testHandle,
                add: [spec],
                disable: ["xs_b3mm6u5x36em5pdt"],
                requestId: "toolu_01XYZabc",
                waitActive: true,
            },
            signal,
        );
        const listed = await listServices(deps, testHandle, signal);
        expect(seen[0]).toEqual(
            expect.objectContaining({
                handle: "",
                disable: [],
                add: [
                    expect.objectContaining({
                        maxPriceMicros: 2000n,
                        paidPath: "/v1/auto/chat/completions",
                        indexed: false,
                    }),
                ],
            }),
        );
        expect(seen[1]).toEqual(
            expect.objectContaining({
                handle: testHandle,
                disable: ["xs_b3mm6u5x36em5pdt"],
                requestId: "toolu_01XYZabc",
                waitActive: true,
            }),
        );
        expect(seen[2]).toEqual(expect.objectContaining({ handle: testHandle }));
        expect(enabled.map((s) => [s.serviceId, s.state, s.paid])).toEqual([
            ["xs_w5a4htopmpzmmhos", X402ServiceState.ACTIVE, 2],
        ]);
        expect(listed.enabled).toBe(true);
        expect(listed.refusals.map((r) => [r.reason, r.count])).toEqual([["price_above_max", 2]]);
        expect(enableWaitMs).toBe(20_000);
    });

    it("lets the router's refusal through for the caller to map", async () => {
        const deps = testDeps({
            router: fakeRouter({
                checkX402: () => {
                    throw routerError(Code.FailedPrecondition, "X402_DISABLED");
                },
            }),
        });
        const err = await checkServices(
            deps,
            { handle: testHandle, add: [], disable: [] },
            AbortSignal.timeout(5_000),
        ).catch((e: unknown) => e);
        expect(reasonOf(err)).toBe("X402_DISABLED");
    });
});
