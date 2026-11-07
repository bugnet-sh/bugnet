import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paymentRequired } from "./payment.ts";
import {
    PayCli,
    maxPaymentMicros,
    parsePayBody,
    payArgs,
    payEnv,
    paymentStep,
    payRefusal,
    paidTools,
    payTimeoutMs,
    priceMicros,
    progressEveryMs,
    usdText,
    type PayCliOptions,
} from "./pay.ts";
import { fakePayCommand, recordingLog } from "./testing/harness.ts";

const claim = "Ab3_".repeat(10) + "xY-"; // 43 characters
const orderId = "ord_abcdefghijklmnopqrstuvwxyz";

function stepResult(over: Record<string, unknown> = {}, isError = true): CallToolResult {
    const required = {
        x402Version: 2,
        accepts: [{ scheme: "exact", amount: "50000", payTo: "P", extra: { memo: orderId } }],
    };
    return {
        isError,
        content: [{ type: "text", text: JSON.stringify(required) }],
        structuredContent: {
            ...required,
            message: "pay",
            orderId,
            claim,
            payUrl: `https://pay.bugnet.sh/o/${orderId}`,
            ...over,
        },
    };
}

describe("pay helpers", () => {
    it("starts pay with the origin, mainnet and the largest price as flags", () => {
        expect(payArgs("https://pay.bugnet.sh", 50_000)).toEqual([
            "mcp",
            "--allow-origin",
            "https://pay.bugnet.sh",
            "--allow-network",
            "mainnet",
            "--max-payment",
            "$0.05",
        ]);
        expect(maxPaymentMicros([50_000])).toBe(50_000);
        expect(maxPaymentMicros([50_000, 120_000, 10])).toBe(120_000);
        expect(() => maxPaymentMicros([])).toThrow(RangeError);
    });

    it("waits 300 s for pay and sends a progress note every 5 s (handoff 3540)", () => {
        expect([payTimeoutMs, progressEveryMs]).toEqual([300_000, 5_000]);
    });

    it("gives pay no PAY_ variable and no NO_DNA", () => {
        const env = {
            HOME: "/h",
            PATH: "/bin",
            PAY_SECRET: "s",
            pay_force_elicitation: "1",
            NO_DNA: "1",
            GONE: undefined,
        };
        expect(payEnv(env)).toEqual({ HOME: "/h", PATH: "/bin" });
    });

    it("writes exact dollar amounts", () => {
        expect([50_000, 1_000_000, 5_003_000, 1, 0, 1_234_567].map(usdText)).toEqual([
            "$0.05",
            "$1.00",
            "$5.003",
            "$0.000001",
            "$0.00",
            "$1.234567",
        ]);
    });

    it("reads confirmPriceUsd as exact micros", () => {
        expect(priceMicros("0.05")).toBe(50_000);
        expect(priceMicros("$0.05")).toBe(50_000);
        expect(priceMicros("1")).toBe(1_000_000);
        for (const bad of ["0.0500001", "abc", "", "-1", 0.05, undefined]) {
            expect(priceMicros(bad), String(bad)).toBeNull();
        }
    });

    it("reads a v2 payment step of the paid tools only", () => {
        expect(paymentStep("bugnet_start", stepResult())).toEqual({
            tool: "bugnet_start",
            orderId,
            claim,
            payUrl: `https://pay.bugnet.sh/o/${orderId}`,
            amountMicros: 50_000,
        });
        expect(paymentStep("bugnet_extend", stepResult())?.tool).toBe("bugnet_extend");
        expect(paymentStep("bugnet_redeem", stepResult())).toBeNull();
        expect(paymentStep("bugnet_start", stepResult({}, false))).toBeNull();
        expect(paymentStep("bugnet_start", stepResult({ claim: claim.slice(1) }))).toBeNull();
        expect(paymentStep("bugnet_start", stepResult({ claim: undefined }))).toBeNull();
        expect(paymentStep("bugnet_start", stepResult({ payUrl: "not a url" }))).toBeNull();
        expect(paymentStep("bugnet_start", stepResult({ orderId: "ord/../x" }))).toBeNull();
        expect(
            paymentStep("bugnet_start", stepResult({ accepts: [{ amount: "5e4" }] })),
        ).toBeNull();
    });

    it("reads a bugnet_x402_budget payment step", () => {
        const due = stepResult({
            accepts: [{ scheme: "exact", amount: "5003000", payTo: "P", extra: { memo: orderId } }],
        });
        expect(paymentStep("bugnet_x402_budget", due)).toEqual({
            tool: "bugnet_x402_budget",
            orderId,
            claim,
            payUrl: "https://pay.bugnet.sh/o/" + orderId,
            amountMicros: 5_003_000,
        });
        expect(paymentStep("bugnet_x402_find", stepResult())).toBeNull();
        expect(paidTools).toEqual(["bugnet_start", "bugnet_extend", "bugnet_x402_budget"]);
    });

    it("caps pay at the confirmed price of an allowance, or of a start with one", () => {
        expect(
            payArgs("https://pay.bugnet.sh", maxPaymentMicros([priceMicros("5.003") as number])),
        ).toEqual([
            "mcp",
            "--allow-origin",
            "https://pay.bugnet.sh",
            "--allow-network",
            "mainnet",
            "--max-payment",
            "$5.003",
        ]);
        // A $0.05 package, the $5.00 allowance and the fee
        expect(
            payArgs("https://pay.bugnet.sh", maxPaymentMicros([priceMicros("5.053") as number])).at(
                -1,
            ),
        ).toBe("$5.053");
    });

    it("refuses a link off the origin, off the order's path, naming another memo or above the price", () => {
        const step = paymentStep("bugnet_start", stepResult())!;
        const required = paymentRequired(stepResult())!;
        const origin = "https://pay.bugnet.sh";
        expect(payRefusal(step, origin, 50_000, required)).toBeNull();
        expect(
            payRefusal(
                { ...step, payUrl: `https://pay.evil.example/o/${orderId}` },
                origin,
                50_000,
                required,
            ),
        ).toBe("origin");
        expect(
            payRefusal({ ...step, payUrl: `${origin}/o/ord_other` }, origin, 50_000, required),
        ).toBe("path");
        const otherMemo = { ...required, accepts: [{ amount: "50000", extra: { memo: "ord_x" } }] };
        expect(payRefusal(step, origin, 50_000, otherMemo)).toBe("memo");
        const noMemo = { ...required, accepts: [{ amount: "50000" }] };
        expect(payRefusal(step, origin, 50_000, noMemo)).toBeNull();
        expect(payRefusal(step, origin, 49_999, required)).toBe("price");
        expect(payRefusal(step, origin, null, required)).toBe("price");
    });

    it("finds the answer body in pay's curl text", () => {
        const paid = { paid: true, orderId };
        expect(parsePayBody(JSON.stringify(paid))).toEqual(paid);
        expect(
            parsePayBody(
                `HTTP/1.1 200 OK\ncontent-type: application/json\n\n${JSON.stringify(paid)}`,
            ),
        ).toEqual(paid);
        expect(parsePayBody(JSON.stringify({ status: 200, body: JSON.stringify(paid) }))).toEqual(
            paid,
        );
        expect(
            parsePayBody(JSON.stringify({ status: 402, body: { refused: "order_expired" } })),
        ).toEqual({ refused: "order_expired" });
        expect(parsePayBody("Touch ID was cancelled")).toBeNull();
        expect(parsePayBody("[1,2]")).toBeNull();
    });
});

describe("PayCli", () => {
    let dir = "";
    let n = 0;
    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), "bugnet-pay-"));
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    const step = paymentStep("bugnet_start", stepResult())!;

    const run = async (env: Record<string, string> = {}, opts: Partial<PayCliOptions> = {}) => {
        const { log, lines } = recordingLog();
        const record = join(dir, `record-${++n}.json`);
        const cli = new PayCli({
            command: await fakePayCommand(dir),
            origin: "https://pay.bugnet.sh",
            env: {
                ...process.env,
                BUGNET_FAKE_PAY_RECORD: record,
                PAY_SECRET: "s",
                NO_DNA: "1",
                ...env,
            },
            log,
            ...opts,
        });
        let notes = 0;
        const outcome = await cli.pay(step, 50_000, () => {
            notes += 1;
        });
        const starts = await readFile(`${record}.starts`, "utf8").then(
            (t) => t.split("\n").filter(Boolean).length,
            () => 0,
        );
        return {
            outcome,
            lines,
            notes,
            starts,
            record: await readFile(record, "utf8").then(JSON.parse, () => null),
        };
    };

    it("starts pay with the flags, no PAY_ variable and no client capability, and reads a payment", async () => {
        const { outcome, lines, record } = await run();
        expect(outcome).toEqual({ kind: "paid" });
        expect(record.argv).toEqual(payArgs("https://pay.bugnet.sh", 50_000));
        expect(record.payEnvKeys).toEqual([]);
        expect(record.capabilities).toEqual({});
        expect(lines.map((l) => JSON.parse(l).msg)).toEqual(["pay started", "pay finished"]);
        expect(lines.join("\n")).not.toContain(step.claim);
    });

    it("uses a tool named pay.curl", async () => {
        expect((await run({ BUGNET_FAKE_PAY_TOOL: "pay.curl" })).outcome).toEqual({ kind: "paid" });
    });

    it("answers unavailable when pay is missing, too old for the flags, or has no curl taking url", async () => {
        const missing = await run({}, { command: join(dir, "no-such-pay") });
        expect([missing.outcome.kind, missing.starts]).toEqual(["unavailable", 0]);
        // Review Focus 3, an old pay is started once and never again without the flags
        const old = await run({ BUGNET_FAKE_PAY_OLD: "1" });
        expect([old.outcome.kind, old.starts]).toEqual(["unavailable", 1]);
        const noCurl = await run({ BUGNET_FAKE_PAY_TOOL: "fetch" });
        expect(noCurl.outcome.kind).toBe("unavailable");
        expect((await run({ BUGNET_FAKE_PAY_ARG: "address" })).outcome.kind).toBe("unavailable");
        // The reason word tells a missing pay from one without a usable curl
        const finished = (lines: string[]) =>
            lines.map((l) => JSON.parse(l)).find((l) => l.msg === "pay finished");
        expect(finished(missing.lines)).toMatchObject({ outcome: "unavailable", reason: "start" });
        expect(finished(noCurl.lines)).toMatchObject({ outcome: "unavailable", reason: "no_curl" });
    });

    it("sends progress notes while pay runs", async () => {
        const r = await run({ BUGNET_FAKE_PAY_DELAY_MS: "250" }, { progressMs: 50 });
        expect(r.outcome).toEqual({ kind: "paid" });
        expect(r.notes).toBeGreaterThanOrEqual(3);
    });

    it("answers declined for a refused body and unknown for anything else", async () => {
        const refused = JSON.stringify({ refused: "order_expired", orderId: step.orderId });
        expect((await run({ BUGNET_FAKE_PAY_ANSWER: refused })).outcome).toEqual({
            kind: "declined",
            reason: "order_expired",
        });
        expect((await run({ BUGNET_FAKE_PAY_ANSWER: "Touch ID was cancelled" })).outcome).toEqual({
            kind: "unknown",
        });
        const other = JSON.stringify({ paid: true, orderId: "ord_other" });
        expect((await run({ BUGNET_FAKE_PAY_ANSWER: other })).outcome).toEqual({ kind: "unknown" });
        // Port 8, the pay link's other answers to a request carrying a payment
        const busy = JSON.stringify({ refused: "too_many_requests" });
        expect((await run({ BUGNET_FAKE_PAY_ANSWER: busy })).outcome).toEqual({
            kind: "declined",
            reason: "too_many_requests",
        });
        const settling = JSON.stringify({ state: "settling", orderId: step.orderId });
        expect((await run({ BUGNET_FAKE_PAY_ANSWER: settling })).outcome).toEqual({
            kind: "unknown",
        });
    });

    it("answers unknown when pay outlives its timeout, since it may have paid", async () => {
        const r = await run({ BUGNET_FAKE_PAY_DELAY_MS: "5000" }, { timeoutMs: 300 });
        expect(r.outcome).toEqual({ kind: "unknown" });
    });
});
