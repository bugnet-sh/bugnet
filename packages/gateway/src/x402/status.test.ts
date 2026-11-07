import { Code } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
    JobState,
    PlacementState,
    X402ServiceState,
    type EnableX402Request,
    type ExecRequest,
    type X402Refusal,
    type X402ServiceInfo,
} from "../gen/bugnet/router/v1/router_pb.ts";
import type { X402AccountAnswer } from "../payments/port.ts";
import {
    fakeRouter,
    recordingLog,
    routerError,
    testAccount,
    testChatId,
    testConfig,
    testDeps,
    testHandle,
    testNow,
    testPayTo,
    testPayments,
    testServiceInfo,
    testX402Index,
    x402Info,
    x402Refusal,
    type RouterImpl,
} from "../testing/harness.ts";
import { Budget, hashKey, handleHash } from "../tools/common.ts";
import { totalsUnavailable } from "./render.ts";
import {
    activeX402Hosts,
    stopFiles,
    stopMoney,
    stopServices,
    untilAborted,
    x402StatusPart,
} from "./status.ts";

interface Setup {
    listed?: X402ServiceInfo[];
    refusals?: X402Refusal[];
    // Throws from ListX402
    listError?: unknown;
    account?: () => Promise<X402AccountAnswer>;
    termsError?: boolean;
    enable?: (req: EnableX402Request) => X402ServiceInfo[];
    exec?: (req: ExecRequest) => { state: JobState; stdout: string };
    toml?: string;
}

function setup(o: Setup = {}) {
    const clock = { now: testNow };
    const counts = { account: 0, list: 0, enable: 0, exec: 0 };
    const seen: { enable?: EnableX402Request; exec?: ExecRequest } = {};
    const rec = recordingLog();
    const impl: RouterImpl = {
        listX402: () => {
            counts.list++;
            if (o.listError !== undefined) throw o.listError;
            return { enabled: true, services: o.listed ?? [], refusals: o.refusals ?? [] };
        },
        enableX402: (req) => {
            counts.enable++;
            seen.enable = req;
            return { services: o.enable ? o.enable(req) : [] };
        },
        exec: (req) => {
            counts.exec++;
            seen.exec = req;
            const r = o.exec?.(req) ?? { state: JobState.EXITED, stdout: "" };
            return { state: r.state, stdoutTail: new TextEncoder().encode(r.stdout) };
        },
    };
    const payments = testPayments(undefined, {
        x402: {
            account: () => {
                counts.account++;
                return o.account
                    ? o.account()
                    : Promise.resolve({ x402: testAccount(), feeDue: false });
            },
            ...(o.termsError ? { terms: () => Promise.reject(new Error("down")) } : {}),
        },
    });
    const deps = testDeps({
        config: testConfig(o.toml ?? "[x402]\nenabled = true"),
        router: fakeRouter(impl),
        payments,
        log: rec.log,
        now: () => clock.now,
        x402Index: testX402Index(),
    });
    return { deps, clock, counts, seen, lines: rec.lines };
}

const running = (deps: ReturnType<typeof setup>["deps"]) => ({
    handle: testHandle,
    state: PlacementState.READY,
    budget: new Budget(deps),
});

describe("x402StatusPart", () => {
    it("reads Payments and ListX402 at once and renders the running lines", async () => {
        let listCalled: () => void = () => {};
        const called = new Promise<void>((r) => (listCalled = r));
        const s = setup({
            listed: [testServiceInfo(X402ServiceState.ACTIVE)],
            refusals: [x402Refusal("allowance_spent", 3, testNow)],
            account: async () => {
                await called;
                return { x402: testAccount(), feeDue: false };
            },
        });
        const router = s.deps.router;
        const list = router.listX402.bind(router);
        s.deps.router.listX402 = ((...a: Parameters<typeof list>) => {
            listCalled();
            return list(...a);
        }) as typeof list;
        const part = await x402StatusPart(s.deps, running(s.deps));
        expect(part.lines[0]).toBe(
            "x402: $1.00 paid in, $0.02 spent in 2 paid calls, $0.01 settling, $0.97 left. Refused: 3 allowance_spent.",
        );
        expect(part.view?.services[0]?.state).toBe("active");
        expect(part.view?.refused).toEqual({ allowance_spent: 3 });
    });

    it("shows no lines for a sandbox without an allowance or services", async () => {
        for (const answer of [
            { x402: null, feeDue: true },
            { x402: testAccount({ services: [] }), feeDue: false },
        ]) {
            const s = setup({ account: async () => answer });
            expect(await x402StatusPart(s.deps, running(s.deps))).toEqual({
                lines: [],
                view: null,
            });
        }
    });

    it("shows only the short line when Payments, the terms or ListX402 fail on a running sandbox", async () => {
        const cases: Setup[] = [
            { account: () => Promise.reject(new Error("down")) },
            { termsError: true },
            { listError: routerError(Code.Unavailable) },
        ];
        for (const c of cases) {
            const s = setup({ listed: [testServiceInfo(X402ServiceState.ACTIVE)], ...c });
            expect(await x402StatusPart(s.deps, running(s.deps))).toEqual({
                lines: [totalsUnavailable],
                view: null,
            });
        }
    });

    it("shows the ended line from Payments even when ListX402 fails", async () => {
        const s = setup({
            listError: routerError(Code.FailedPrecondition, "NOT_READY"),
            account: async () => ({
                x402: testAccount({
                    state: "closed",
                    refund: { state: "sent", amountMicros: 980_000, keptMicros: 0, txs: [] },
                }),
                feeDue: false,
            }),
        });
        const part = await x402StatusPart(s.deps, {
            ...running(s.deps),
            state: PlacementState.TERMINATED,
        });
        expect(part.lines).toEqual([
            "x402: $0.02 spent in 2 paid calls. Refund: $0.98 sent to the paying wallet.",
        ]);
        expect(s.counts.enable).toBe(0);
    });

    it("calls nothing with under 1 s of the budget left", async () => {
        const s = setup();
        const input = running(s.deps);
        s.clock.now += 39_500;
        expect(await x402StatusPart(s.deps, input)).toEqual({
            lines: [totalsUnavailable],
            view: null,
        });
        expect(s.counts).toMatchObject({ account: 0, list: 0 });
    });

    it("never waits past the budget for a Payments answer that does not come", async () => {
        const s = setup({ account: () => new Promise<never>(() => {}) });
        const input = running(s.deps);
        s.clock.now += 38_500;
        const t = performance.now();
        expect((await x402StatusPart(s.deps, input)).lines).toEqual([totalsUnavailable]);
        expect(performance.now() - t).toBeLessThan(2_500);
    });

    for (const listed of [[], [testServiceInfo(X402ServiceState.DISABLED)]]) {
        it(`re-enables an enabled service the router ${listed.length ? "holds disabled" : "lacks"}, free and without waiting`, async () => {
            const s = setup({
                listed,
                enable: () => [testServiceInfo(X402ServiceState.APPLYING)],
            });
            const part = await x402StatusPart(s.deps, running(s.deps));
            expect(s.seen.enable).toMatchObject({
                handle: testHandle,
                disable: [],
                requestId: hashKey(["x402-repair", testChatId]),
                waitActive: false,
            });
            expect(s.seen.enable?.add[0]).toMatchObject({
                host: "agent402.tools",
                prefix: "/v1/auto/",
                method: "POST",
                maxPriceMicros: 10_000n,
                payTo: testPayTo,
                indexed: false,
                paidPath: "/v1/auto/chat/completions",
            });
            expect(part.lines.at(-1)).toBe(
                "x402: enabling agent402.tools. New commands see them within seconds.",
            );
            expect(part.lines[1]).toContain(", applying, service line: ");
        });
    }

    it("does not repair a failed service and shows its failure words", async () => {
        const s = setup({ listed: [testServiceInfo(X402ServiceState.FAILED, "PORT_443_TAKEN")] });
        const part = await x402StatusPart(s.deps, running(s.deps));
        expect(s.counts.enable).toBe(0);
        expect(part.lines[1]).toContain("failed, a program in the sandbox holds port 443.");
    });

    it("adds no enabling line when the repair is refused, and shows the router reason words on the service it names", async () => {
        const s = setup({
            listed: [],
            enable: () => {
                throw routerError(Code.InvalidArgument, "HOST_REFUSED", {
                    metadata: { service_id: testChatId, host: "agent402.tools" },
                });
            },
        });
        const part = await x402StatusPart(s.deps, running(s.deps));
        expect(part.lines.join("\n")).not.toContain("enabling");
        expect(part.lines[1]).toContain(
            "failed, Bugnet does not route to this host, service line: ",
        );
        expect(part.view?.services[0]).toMatchObject({
            state: "failed",
            failureReason: "HOST_REFUSED",
        });
    });

    it("leaves the rows as listed when the repair refusal names no service or answers NOT_READY", async () => {
        const errors = [
            routerError(Code.ResourceExhausted, "TOO_MANY_SECRETS"),
            routerError(Code.FailedPrecondition, "NOT_READY"),
            routerError(Code.Unavailable),
            // A reason of 6.3 under metadata that names another service
            routerError(Code.InvalidArgument, "HOST_REFUSED", {
                metadata: { service_id: "xs_b3mm6u5x36em5pdt" },
            }),
        ];
        for (const e of errors) {
            const s = setup({
                listed: [testServiceInfo(X402ServiceState.DISABLED)],
                enable: () => {
                    throw e;
                },
            });
            const part = await x402StatusPart(s.deps, running(s.deps));
            expect(part.lines.join("\n")).not.toMatch(/enabling|failed/);
            expect(part.view?.services[0]?.state).toBe("disabled");
        }
    });

    it("repairs only while the sandbox is placing or ready", async () => {
        const s = setup({ listed: [] });
        await x402StatusPart(s.deps, { ...running(s.deps), state: PlacementState.TERMINATING });
        expect(s.counts.enable).toBe(0);
        const p = setup({ listed: [], enable: () => [testServiceInfo(X402ServiceState.APPLYING)] });
        await x402StatusPart(p.deps, { ...running(p.deps), state: PlacementState.PLACING });
        expect(p.counts.enable).toBe(1);
    });

    it("never logs a payTo or a host the router sent", async () => {
        const ok = setup({
            listed: [],
            enable: () => [testServiceInfo(X402ServiceState.APPLYING)],
        });
        await x402StatusPart(ok.deps, running(ok.deps));
        const bad = setup({
            listed: [],
            enable: () => {
                throw routerError(Code.InvalidArgument, "HOST_REFUSED", {
                    metadata: { service_id: testChatId, host: "agent402.tools" },
                });
            },
        });
        await x402StatusPart(bad.deps, running(bad.deps));
        const all = [...ok.lines, ...bad.lines].join("\n");
        expect(all).toContain("x402 repair");
        expect(all).toContain("x402 repair refused");
        expect(all).not.toContain(testPayTo);
        expect(all).not.toContain("agent402.tools");
        expect(all).not.toContain(testHandle);
    });
});

describe("repair limits", () => {
    it("makes no repair call when ListX402 answers enabled false", async () => {
        const s = setup({ listed: [] });
        const list = s.deps.router.listX402.bind(s.deps.router);
        s.deps.router.listX402 = (async (...a: Parameters<typeof list>) => ({
            ...(await list(...a)),
            enabled: false,
        })) as typeof list;
        const part = await x402StatusPart(s.deps, running(s.deps));
        expect(s.counts.enable).toBe(0);
        expect(part.lines.join("\n")).not.toContain("enabling");
        expect(part.view?.services[0]?.state).toBe("applying");
    });

    it("leaves the rows as listed when a per-service reason comes under the wrong code", async () => {
        const s = setup({
            listed: [testServiceInfo(X402ServiceState.DISABLED)],
            enable: () => {
                throw routerError(Code.Unavailable, "HOST_REFUSED", {
                    metadata: { service_id: testChatId },
                });
            },
        });
        const part = await x402StatusPart(s.deps, running(s.deps));
        expect(part.view?.services[0]?.state).toBe("disabled");
        expect(part.lines.join("\n")).not.toMatch(/enabling|failed/);
    });
});

describe("untilAborted", () => {
    it("rejects with the signal's reason when the work does not settle", async () => {
        const c = new AbortController();
        const p = untilAborted(new Promise<never>(() => {}), c.signal);
        c.abort(new Error("late"));
        await expect(p).rejects.toThrow("late");
        await expect(untilAborted(Promise.resolve(1), new AbortController().signal)).resolves.toBe(
            1,
        );
    });
});

describe("stop parts", () => {
    const two = [
        testServiceInfo(X402ServiceState.ACTIVE),
        x402Info("xs_b3mm6u5x36em5pdt", X402ServiceState.ACTIVE, {
            spec: {
                host: "agent402.tools",
                prefix: "/v1/other/",
                method: "GET",
                maxPriceMicros: 10_000n,
                payTo: testPayTo,
                indexed: false,
                paidPath: "",
            },
        }),
    ];

    it("lists the hosts ListX402 shows once each, null when it shows none and failed when it fails", async () => {
        expect(await stopServices(setup({ listed: two }).deps, testHandle)).toEqual({
            hosts: ["agent402.tools"],
        });
        expect(
            await stopServices(
                setup({ listError: routerError(Code.Unavailable) }).deps,
                testHandle,
            ),
        ).toEqual({ hosts: [], failed: true });
        expect(await stopServices(setup({ listed: [] }).deps, testHandle)).toBeNull();
    });

    it("runs the grep job with a fixed key and keeps 5 cleaned paths of at most 120 characters", async () => {
        const stdout = [
            "/root/src/a\u001b[31m.py",
            `/root/src/${"b".repeat(200)}`,
            "/root/src/c",
            "",
            "/root/src/d",
            "/root/src/e",
            "/root/src/f",
            "/root/src/g",
        ].join("\n");
        const s = setup({ exec: () => ({ state: JobState.EXITED, stdout }) });
        const paths = await stopFiles(s.deps, testHandle, ["agent402.tools", "api.example.com"]);
        expect(s.seen.exec).toMatchObject({
            handle: testHandle,
            cwd: "",
            env: {},
            waitMs: 2_500,
            idempotencyKey: hashKey(["x402-stop-files", testHandle]),
            argv: [
                "sh",
                "-c",
                `grep -rIlF --exclude-dir=.git -e 'agent402.tools' -e 'api.example.com' -e 'x402' "$HOME/src"`,
            ],
        });
        expect(paths).toHaveLength(5);
        expect(paths[0]).toBe("/root/src/a.py");
        expect(paths[1]).toHaveLength(120);
        expect(paths[2]).toBe("/root/src/c");
    });

    it("gives no paths for a job still running or an exec that fails", async () => {
        const slow = setup({ exec: () => ({ state: JobState.RUNNING, stdout: "/root/src/a\n" }) });
        expect(await stopFiles(slow.deps, testHandle, ["agent402.tools"])).toEqual([]);
        const bad = setup({
            exec: () => {
                throw routerError(Code.Unavailable);
            },
        });
        expect(await stopFiles(bad.deps, testHandle, ["agent402.tools"])).toEqual([]);
    });

    it("reads the money after the stop, or says the totals are unavailable", async () => {
        expect(await stopMoney(setup().deps, testHandle)).toBe(
            "x402: $0.02 spent in 2 paid calls. About $0.98 goes back to the paying wallet, usually within 10 minutes.",
        );
        expect(
            await stopMoney(
                setup({ account: () => Promise.reject(new Error("down")) }).deps,
                testHandle,
            ),
        ).toBe(totalsUnavailable);
        expect(await stopMoney(setup({ termsError: true }).deps, testHandle)).toBe(
            totalsUnavailable,
        );
        expect(
            await stopMoney(
                setup({ account: async () => ({ x402: null, feeDue: true }) }).deps,
                testHandle,
            ),
        ).toBe("");
    });

    it("returns nothing, not the unavailable line, when no allowance exists and the terms fail", async () => {
        const s = setup({
            termsError: true,
            account: async () => ({ x402: null, feeDue: true }),
        });
        expect(await stopMoney(s.deps, testHandle)).toBe("");
    });

    it("never logs the account hash or the handle", async () => {
        const s = setup({ listError: routerError(Code.Unavailable), termsError: true });
        await stopServices(s.deps, testHandle);
        await stopMoney(s.deps, testHandle);
        const all = s.lines.join("\n");
        expect(all).toContain("x402 stop");
        expect(all).not.toContain(handleHash(testHandle));
        expect(all).not.toContain(testHandle);
    });
});

describe("activeX402Hosts", () => {
    const rows = () => [
        testServiceInfo(X402ServiceState.ACTIVE),
        x402Info("xs_b3mm6u5x36em5pdt", X402ServiceState.APPLYING, {
            spec: {
                host: "api.example.com",
                prefix: "/v1/",
                method: "GET",
                maxPriceMicros: 10_000n,
                payTo: testPayTo,
                indexed: false,
                paidPath: "",
            },
        }),
    ];

    it("names only active hosts and asks the router once in 30 s per handle", async () => {
        const s = setup({ listed: rows() });
        expect(await activeX402Hosts(s.deps, testHandle)).toEqual(["agent402.tools"]);
        s.clock.now += 29_000;
        await activeX402Hosts(s.deps, testHandle);
        expect(s.counts.list).toBe(1);
        s.clock.now += 2_000;
        await activeX402Hosts(s.deps, testHandle);
        expect(s.counts.list).toBe(2);
    });

    it("answers [] without a call when x402 is off, and [] uncached when ListX402 fails", async () => {
        const off = setup({ listed: rows(), toml: "" });
        expect(await activeX402Hosts(off.deps, testHandle)).toEqual([]);
        expect(off.counts.list).toBe(0);
        const bad = setup({ listError: routerError(Code.Unavailable) });
        expect(await activeX402Hosts(bad.deps, testHandle)).toEqual([]);
        expect(await activeX402Hosts(bad.deps, testHandle)).toEqual([]);
        expect(bad.counts.list).toBe(2);
    });
});
