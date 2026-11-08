import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { PlacementState } from "../gen/bugnet/router/v1/router_pb.ts";
import { signQuote } from "../quote.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    packageOption,
    placement,
    recordingLog,
    routerError,
    testDeps,
    testHandle,
    testNow,
    testPayments,
    type RouterImpl,
} from "../testing/harness.ts";
import type { Deps } from "./common.ts";

const key = "bnk_" + "A1b2C3d4E5_-".repeat(4).slice(0, 43);
const id = "abcdefghijklmnop";
const url = `https://sessions.bugnet.sh/s/${id}#k=${key}`;
const hash = (s: string) => `#k=${s}`;

async function connect(impl: RouterImpl, log?: Deps["log"]): Promise<Client> {
    const deps = testDeps({
        router: fakeRouter(impl),
        payments: testPayments(),
        ...(log ? { log } : {}),
    });
    return connectTools(deps);
}

const endedAt = timestampFromMs(testNow - 10_000);
const ended = (init = {}) =>
    placement(PlacementState.TERMINATED, {
        readyAt: timestampFromMs(testNow - 90_000 - 10_000),
        endedAt,
        sessionUrl: url,
        ...init,
    });
const until = "2026-11-07 11:59 UTC";
const whenText = "2026-11-05 11:59 UTC";

describe("bugnet_stop", () => {
    it("says plainly that the sandbox is stopped, with the cost and the summary link", async () => {
        const client = await connect({
            stopPlacement: () => ({ placement: ended({ paidMicros: 90_000n }) }),
        });
        const r = await callTool<Record<string, unknown>>(client, "bugnet_stop", {
            handle: testHandle,
        });
        expect(r.structured.message).toBe(
            `The sandbox is stopped. It ended at ${whenText} after 1 min 30 s of use, and everything in it was deleted. It cost $0.09 USDC in total. Tell the user it is stopped.\n` +
                `Summary and logs: ${url} (until ${until}). Show this link to the user.`,
        );
        expect(r.structured).toEqual(
            expect.objectContaining({
                state: "ended",
                usedSeconds: 90,
                paidUsd: "$0.09",
                sessionUrl: url,
                sessionUntil: "2026-11-07T11:59:50.000Z",
            }),
        );
    });

    it("leaves out the total and the link when the router sends none", async () => {
        const client = await connect({
            stopPlacement: () => ({ placement: ended({ sessionUrl: "", paidMicros: 0n }) }),
        });
        const r = await callTool<Record<string, unknown>>(client, "bugnet_stop", {
            handle: testHandle,
        });
        expect(r.structured.message).toBe(
            `The sandbox is stopped. It ended at ${whenText} after 1 min 30 s of use, and everything in it was deleted. Tell the user it is stopped.`,
        );
        expect(r.structured).not.toHaveProperty("sessionUrl");
        expect(r.structured).not.toHaveProperty("paidUsd");
    });

    it("measures use from ready to the end, as in a 4 s run", async () => {
        const client = await connect({
            stopPlacement: () => ({
                placement: ended({
                    readyAt: timestampFromMs(testNow - 10_000 - 3_920),
                    createdAt: timestampFromMs(testNow - 10_000 - 9_000),
                    sessionUrl: "",
                }),
            }),
        });
        const r = await callTool<Record<string, unknown>>(client, "bugnet_stop", {
            handle: testHandle,
        });
        expect(r.text).toContain("after 4 s of use");
        expect(r.structured.usedSeconds).toBe(4);
    });

    it("counts a sandbox that never became ready as 0 s", async () => {
        const client = await connect({
            stopPlacement: () => ({ placement: ended({ readyAt: undefined, sessionUrl: "" }) }),
        });
        const r = await callTool(client, "bugnet_stop", { handle: testHandle });
        expect(r.text).toContain("after 0 s of use");
    });

    it("keeps today's line when the router sends no ended_at", async () => {
        const client = await connect({
            stopPlacement: () => ({
                placement: ended({ endedAt: undefined, sessionUrl: "" }),
            }),
        });
        const r = await callTool(client, "bugnet_stop", { handle: testHandle });
        expect(r.text).toBe("Sandbox ended.");
    });
});

describe("bugnet_status", () => {
    it("says an ended sandbox has ended, with the reason, cost and link", async () => {
        const client = await connect({
            getPlacement: () => ({
                placement: ended({ terminationReason: "deadline", paidMicros: 1_500_000n }),
            }),
        });
        const r = await callTool<Record<string, unknown>>(client, "bugnet_status", {
            handle: testHandle,
        });
        expect(r.structured.message).toBe(
            `The sandbox has ended because it reached its deadline. It ended at ${whenText} after 1 min 30 s of use, and everything in it was deleted. It cost $1.50 USDC in total. Tell the user it has ended.\n` +
                `Summary and logs: ${url} (until ${until}). Show this link to the user.`,
        );
        expect(r.structured).toEqual(
            expect.objectContaining({ usedSeconds: 90, paidUsd: "$1.50", sessionUrl: url }),
        );
    });

    const causes: [string, string][] = [
        ["deadline", " because it reached its deadline"],
        ["abuse", " because it was ended for a terms violation"],
        ["control_lost", " because Bugnet lost contact with it"],
        ["provider_failed", " because its host failed"],
        ["sandbox_exited", " because it stopped from inside, for example by a shutdown or a crash"],
        ["wallet_blocked", " because the paying wallet is blocked"],
        ["operator", " because a Bugnet operator ended it"],
        ["something_new", ""],
    ];
    for (const [reason, cause] of causes) {
        it(`words the cause of reason ${reason}`, async () => {
            const client = await connect({
                getPlacement: () => ({
                    placement: ended({ terminationReason: reason, sessionUrl: "" }),
                }),
            });
            const r = await callTool(client, "bugnet_status", { handle: testHandle });
            expect(r.text).toBe(
                `The sandbox has ended${cause}. It ended at ${whenText} after 1 min 30 s of use, and everything in it was deleted. Tell the user it has ended.`,
            );
        });
    }

    it("uses the stop line for a stopped sandbox", async () => {
        const client = await connect({
            getPlacement: () => ({ placement: ended({ terminationReason: "stop" }) }),
        });
        const r = await callTool(client, "bugnet_status", { handle: testHandle });
        expect(r.text?.split("\n")[0]).toMatch(/^The sandbox is stopped\. It ended at /);
    });

    it("formats hours and whole minutes", async () => {
        const client = await connect({
            getPlacement: () => ({
                placement: ended({
                    readyAt: timestampFromMs(testNow - 10_000 - 3_600_000 - 5 * 60_000),
                    deadline: timestampFromMs(testNow + 60_000),
                    sessionUrl: "",
                }),
            }),
        });
        const r = await callTool(client, "bugnet_status", { handle: testHandle });
        expect(r.text).toContain("after 1 h 5 min of use");
    });

    it("shows what a running sandbox cost so far", async () => {
        const client = await connect({
            getPlacement: () => ({
                placement: placement(PlacementState.READY, { paidMicros: 250_000n }),
            }),
        });
        const r = await callTool<Record<string, unknown>>(client, "bugnet_status", {
            handle: testHandle,
        });
        expect(r.text?.split("\n")).toContain("Paid so far: $0.25 USDC.");
        expect(r.structured.paidUsd).toBe("$0.25");
        expect(r.text).not.toMatch(/Summary and logs/);
    });

    it("leaves out the total of a running sandbox when paid_micros is 0", async () => {
        const client = await connect({
            getPlacement: () => ({ placement: placement(PlacementState.READY) }),
        });
        const r = await callTool<Record<string, unknown>>(client, "bugnet_status", {
            handle: testHandle,
        });
        expect(r.text).not.toMatch(/Paid so far/);
        expect(r.structured).not.toHaveProperty("paidUsd");
    });

    it("keeps the failed text and adds no link to a failed placement", async () => {
        const client = await connect({
            getPlacement: () => ({
                placement: placement(PlacementState.FAILED, {
                    readyAt: undefined,
                    sessionUrl: url,
                }),
            }),
        });
        const r = await callTool<Record<string, unknown>>(client, "bugnet_status", {
            handle: testHandle,
        });
        expect(r.text).toMatch(/^Sandbox failed, package small-10m/);
        expect(r.text).not.toContain("sessions.");
        expect(r.structured).not.toHaveProperty("sessionUrl");
    });
});

describe("the ended refusal", () => {
    const refuse = (p: ReturnType<typeof ended>): RouterImpl => ({
        exec() {
            throw routerError(Code.FailedPrecondition, "NOT_READY");
        },
        getPlacement: () => ({ placement: p }),
    });

    it("appends the summary link to its wording", async () => {
        const client = await connect(refuse(ended()));
        const r = await callTool<Record<string, unknown>>(client, "bugnet_exec", {
            handle: testHandle,
            cmd: "true",
        });
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "exec: this sandbox has ended and everything in it was deleted. Quote and start a " +
                `new one. Summary and logs: ${url} (until ${until}). Show this link to the user.`,
        );
        expect(r.structured.sessionUrl).toBe(url);
    });

    it("adds nothing without a link", async () => {
        const client = await connect(refuse(ended({ sessionUrl: "" })));
        const r = await callTool(client, "bugnet_exec", { handle: testHandle, cmd: "true" });
        expect(r.text).toBe(
            "exec: this sandbox has ended and everything in it was deleted. Quote and start a new one.",
        );
    });
});

describe("the link shape check", () => {
    const bad = [
        ["another host", `https://evil.example/s/${id}#k=${key}`],
        ["a sibling host", `https://sessions.bugnet.sh.evil.example/s/${id}#k=${key}`],
        ["a deeper host", `https://a.sessions.bugnet.sh/s/${id}#k=${key}`],
        ["http", `http://sessions.bugnet.sh/s/${id}#k=${key}`],
        ["no scheme", `sessions.bugnet.sh/s/${id}#k=${key}`],
        ["a short id", `https://sessions.bugnet.sh/s/abcdefghijklmno#k=${key}`],
        ["a long id", `https://sessions.bugnet.sh/s/abcdefghijklmnopq#k=${key}`],
        ["an upper-case id", `https://sessions.bugnet.sh/s/ABCDEFGHIJKLMNOP#k=${key}`],
        ["a digit 1 in the id", `https://sessions.bugnet.sh/s/abcdefghijklmno1#k=${key}`],
        ["another path", `https://sessions.bugnet.sh/x/${id}#k=${key}`],
        ["a trailing path", `https://sessions.bugnet.sh/s/${id}/more#k=${key}`],
        ["a query", `https://sessions.bugnet.sh/s/${id}?a=1#k=${key}`],
        ["user info", `https://user:pw@sessions.bugnet.sh/s/${id}#k=${key}`],
        ["a port", `https://sessions.bugnet.sh:8443/s/${id}#k=${key}`],
        ["no fragment", `https://sessions.bugnet.sh/s/${id}`],
        ["a short key", `https://sessions.bugnet.sh/s/${id}${hash("bnk_" + "A".repeat(42))}`],
        ["a long key", `https://sessions.bugnet.sh/s/${id}${hash("bnk_" + "A".repeat(44))}`],
        ["no bnk_ prefix", `https://sessions.bugnet.sh/s/${id}${hash("xyz_" + "A".repeat(43))}`],
        [
            "a bad key character",
            `https://sessions.bugnet.sh/s/${id}${hash("bnk_" + "+".repeat(43))}`,
        ],
        ["an extra fragment part", `https://sessions.bugnet.sh/s/${id}#k=${key}&x=1`],
        ["a text with spaces", `see ${url}`],
        ["an upper-case host", `https://SESSIONS.BUGNET.SH/s/${id}#k=${key}`],
        ["an upper-case scheme", `HTTPS://sessions.bugnet.sh/s/${id}#k=${key}`],
        ["an empty query", `https://sessions.bugnet.sh/s/${id}?#k=${key}`],
        ["an empty user part", `https://@sessions.bugnet.sh/s/${id}#k=${key}`],
        ["an empty user and password", `https://:@sessions.bugnet.sh/s/${id}#k=${key}`],
        ["the default port", `https://sessions.bugnet.sh:443/s/${id}#k=${key}`],
        ["an empty port", `https://sessions.bugnet.sh:/s/${id}#k=${key}`],
        ["dot segments", `https://sessions.bugnet.sh/x/../s/${id}#k=${key}`],
        ["encoded dot segments", `https://sessions.bugnet.sh/x/%2e%2e/s/${id}#k=${key}`],
        ["backslashes", `https://sessions.bugnet.sh\\s\\${id}#k=${key}`],
        ["a triple slash", `https:///sessions.bugnet.sh/s/${id}#k=${key}`],
        ["a tab in the id", `https://sessions.bugnet.sh/s/abcdefgh\tijklmnop#k=${key}`],
        ["a CR in the id", `https://sessions.bugnet.sh/s/abcd\refghijklmnop#k=${key}`],
        [
            "a newline in the key",
            `https://sessions.bugnet.sh/s/${id}#k=bnk_${"A".repeat(20)}\n${"A".repeat(23)}`,
        ],
        ["a trailing space", `${url} `],
        ["a trailing newline", `${url}\n`],
        ["a leading space", ` ${url}`],
        ["an IDN host", `https://\u017fessions.bugnet.sh/s/${id}#k=${key}`],
        ["a full-width host", `https://\uff53essions.bugnet.sh/s/${id}#k=${key}`],
        ["a percent-encoded host", `https://sessions%2Ebugnet.sh/s/${id}#k=${key}`],
        ["a trailing dot host", `https://sessions.bugnet.sh./s/${id}#k=${key}`],
        ["a trailing slash", `https://sessions.bugnet.sh/s/${id}/#k=${key}`],
        ["an encoded fragment", `https://sessions.bugnet.sh/s/${id}#k%3D${key}`],
        ["a percent-encoded id", `https://sessions.bugnet.sh/s/%61bcdefghijklmnop#k=${key}`],
        ["a second fragment", `https://sessions.bugnet.sh/s/${id}#k=${key}#x`],
    ] as const;

    for (const [name, raw] of bad) {
        it(`drops a link with ${name} and logs only the handle tag`, async () => {
            const { log, lines } = recordingLog();
            const client = await connect(
                { stopPlacement: () => ({ placement: ended({ sessionUrl: raw }) }) },
                log,
            );
            const r = await callTool<Record<string, unknown>>(client, "bugnet_stop", {
                handle: testHandle,
            });
            expect(r.text).not.toContain("Summary and logs");
            expect(r.structured).not.toHaveProperty("sessionUrl");
            const logged = lines.join("\n");
            expect(logged).toMatch(/contract fault/);
            expect(logged).not.toContain(id);
            expect(logged).not.toContain(key);
        });
    }
});

describe("bugnet_start", () => {
    const startQuote = (deps: Deps) =>
        signQuote(deps.config.secrets.quoteKey, {
            requirements: { ssh: false, preview: false, gpu: false, secrets: false },
            github: false,
            estimateId: null,
            expiresAt: testNow + 5 * 60_000,
        });

    async function start(
        state: PlacementState,
        init = {},
        log?: Deps["log"],
    ): Promise<Awaited<ReturnType<typeof callTool<Record<string, unknown>>>>> {
        // The wait for ready ends on the clock, so each look moves it on
        const clock = { now: testNow };
        const deps = testDeps({
            router: fakeRouter({
                estimate: () => ({ options: [packageOption("small-10m", 50_000n)] }),
                createPlacement: () => ({
                    handle: testHandle,
                    placement: placement(PlacementState.PLACING, init),
                }),
                getPlacement: () => {
                    clock.now += 30_000;
                    return { placement: placement(state, init) };
                },
            }),
            payments: testPayments(),
            now: () => clock.now,
            ...(log ? { log } : {}),
        });
        const client = await connectTools(deps);
        return callTool<Record<string, unknown>>(
            client,
            "bugnet_start",
            { quoteId: startQuote(deps), packageId: "small-10m", confirmPriceUsd: "0.05" },
            { toolUseId: "toolu_start" },
        );
    }

    it("says what was paid and where the summary will stay, when ready", async () => {
        const r = await start(PlacementState.READY, { sessionUrl: url });
        const lines = (r.structured.message as string).split("\n");
        expect(lines).toContain(
            "Paid $0.05 USDC for this sandbox (order toolu_start). Tell the user what it cost.",
        );
        expect(lines).toContain(
            `After this sandbox ends, its summary and logs stay at ${url} for 48 hours. Show this link to the user.`,
        );
        expect(r.structured.sessionUrl).toBe(url);
    });

    it("says both while the sandbox is still starting", async () => {
        const r = await start(PlacementState.PLACING, { sessionUrl: url });
        expect(r.text).toContain("Paid $0.05 USDC for this sandbox");
        expect(r.text).toContain("stay at " + url);
    });

    it("says what was paid but shows no link for a failed start", async () => {
        const r = await start(PlacementState.FAILED, { sessionUrl: url, refundable: true });
        expect(r.text).toContain("Paid $0.05 USDC for this sandbox");
        expect(r.text).not.toContain("sessions.");
        expect(r.structured).not.toHaveProperty("sessionUrl");
    });

    it("shows no link line for a start that comes back ended", async () => {
        const r = await start(PlacementState.TERMINATED, { sessionUrl: url });
        expect(r.text).not.toContain("After this sandbox ends");
        expect(r.structured).not.toHaveProperty("sessionUrl");
    });

    it("leaves out the link line when the router sends none", async () => {
        const r = await start(PlacementState.READY);
        expect(r.text).not.toContain("summary and logs");
        expect(r.structured).not.toHaveProperty("sessionUrl");
    });
});

describe("logs", () => {
    it("never carry the link, its key or its id", async () => {
        const { log, lines } = recordingLog();
        const deps = testDeps({
            router: fakeRouter({
                estimate: () => ({ options: [packageOption("small-10m", 50_000n)] }),
                createPlacement: () => ({
                    handle: testHandle,
                    placement: placement(PlacementState.PLACING, { sessionUrl: url }),
                }),
                getPlacement: () => ({
                    placement: ended({ terminationReason: "deadline", paidMicros: 1n }),
                }),
                stopPlacement: () => ({ placement: ended() }),
                exec() {
                    throw routerError(Code.FailedPrecondition, "NOT_READY");
                },
            }),
            payments: testPayments(),
            log,
        });
        const client = await connectTools(deps);
        const q = signQuote(deps.config.secrets.quoteKey, {
            requirements: { ssh: false, preview: false, gpu: false, secrets: false },
            github: false,
            estimateId: null,
            expiresAt: testNow + 5 * 60_000,
        });
        await callTool(client, "bugnet_start", {
            quoteId: q,
            packageId: "small-10m",
            confirmPriceUsd: "0.05",
        });
        await callTool(client, "bugnet_status", { handle: testHandle });
        await callTool(client, "bugnet_stop", { handle: testHandle });
        await callTool(client, "bugnet_exec", { handle: testHandle, cmd: "true" });
        const logged = lines.join("\n");
        expect(logged.length).toBeGreaterThan(0);
        expect(logged).not.toContain(url);
        expect(logged).not.toContain(key);
        expect(logged).not.toContain(id);
        expect(logged).not.toContain("sessions.bugnet.sh");
    });
});
