import { isInputRequiredResult } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import {
    canElicitUrl,
    linkState,
    linkStateOrderId,
    linkTtlMs,
    lostLinkText,
    payLinkRequest,
    paymentStepResult,
    pollForMs,
    readLinkState,
    waitPaid,
} from "./linkpay.ts";
import type { PublicOrderState } from "./orders.ts";
import type { PaymentStep } from "./pay.ts";

const step: PaymentStep = {
    tool: "bugnet_start",
    orderId: "ord_abcdefghijklmnopqrstuvwxyz",
    claim: "Ab3_".repeat(10) + "xY-",
    payUrl: "https://pay.bugnet.sh/o/ord_abcdefghijklmnopqrstuvwxyz",
    amountMicros: 50_000,
};
const signal = new AbortController().signal;

// A clock that moves only when the code under test sleeps, recording each sleep
function fakeClock() {
    let t = 1_000_000;
    const sleeps: number[] = [];
    return {
        sleeps,
        now: () => t,
        sleep: async (ms: number, s?: AbortSignal) => {
            if (s?.aborted) throw s.reason;
            sleeps.push(ms);
            t += ms;
        },
    };
}

it("counts only a declared url mode as able to open links", () => {
    expect(canElicitUrl(undefined)).toBe(false);
    expect(canElicitUrl({})).toBe(false);
    expect(canElicitUrl({ elicitation: {} })).toBe(false);
    expect(canElicitUrl({ elicitation: { form: {} } })).toBe(false);
    expect(canElicitUrl({ elicitation: { url: {} } })).toBe(true);
    expect(canElicitUrl({ elicitation: { form: {}, url: {} } })).toBe(true);
});

it("ties a link state to its order and tool for 10 minutes", () => {
    const state = linkState(step, 1_000_000);
    expect(state).toMatch(/^p1\.1000000\.ord_abcdefghijklmnopqrstuvwxyz\.[0-9a-f]{64}$/);
    expect(readLinkState(state, "bugnet_start", 1_000_000 + linkTtlMs)).toEqual({
        orderId: step.orderId,
    });
    expect(readLinkState(state, "bugnet_start", 1_000_001 + linkTtlMs)).toBeNull();
    expect(readLinkState(state, "bugnet_start", 1_000_000 - 60_001)).toBeNull();
    expect(readLinkState(state, "bugnet_extend", 1_000_000)).toBeNull();
    expect(
        readLinkState(state.replace("ord_abc", "ord_abd"), "bugnet_start", 1_000_000),
    ).toBeNull();
    expect(readLinkState("gateway-state-1", "bugnet_start", 1_000_000)).toBeNull();
    expect(readLinkState(undefined, "bugnet_start", 1_000_000)).toBeNull();
    expect(linkStateOrderId(state.replace(/[0-9a-f]{64}$/, "0".repeat(64)))).toBe(step.orderId);
    expect(linkStateOrderId("gateway-state-1")).toBeNull();
});

it("asks the client to open the pay link with the price", () => {
    const r = payLinkRequest(step, 1_000_000);
    expect(isInputRequiredResult(r)).toBe(true);
    const text = JSON.stringify(r);
    expect(text).toContain(step.payUrl);
    expect(text).toContain(
        "Pay $0.05 USDC for Bugnet order ord_abcdefghijklmnopqrstuvwxyz with " +
            "a Solana wallet in your browser. The agent goes on once it is paid.",
    );
    expect(readLinkState(r.requestState, "bugnet_start", 1_000_000)).toEqual({
        orderId: step.orderId,
    });
});

it("polls every 2.5 s until the order is paid, with a note every 5 s", async () => {
    const clock = fakeClock();
    const states = ["unpaid", "settling", "unpaid", new Error("reset"), "paid"];
    let reads = 0;
    let notes = 0;
    const out = await waitPaid(
        step.orderId,
        {
            status: async () => {
                const s = states[reads++];
                if (s instanceof Error) throw s;
                return s as PublicOrderState;
            },
            sleep: clock.sleep,
            now: clock.now,
        },
        signal,
        () => notes++,
    );
    expect(out).toBe("paid");
    expect(reads).toBe(5);
    expect(clock.sleeps).toEqual([2_500, 2_500, 2_500, 2_500]);
    expect(notes).toBe(3); // at 0, 5_000 and 10_000
});

it.each([
    ["expired", "expired"],
    ["refunded", "closed"],
    ["review", "closed"],
    [null, "unknown_order"],
] as const)("ends on %s with %s", async (state, outcome) => {
    const clock = fakeClock();
    expect(
        await waitPaid(
            "o",
            { status: async () => state, sleep: clock.sleep, now: clock.now },
            signal,
            () => {},
        ),
    ).toBe(outcome);
    expect(clock.sleeps).toEqual([]);
});

it("gives up after 10 minutes", async () => {
    const clock = fakeClock();
    let reads = 0;
    const out = await waitPaid(
        step.orderId,
        {
            status: async () => {
                reads += 1;
                return "unpaid";
            },
            sleep: clock.sleep,
            now: clock.now,
        },
        signal,
        () => {},
    );
    expect(out).toBe("timeout");
    expect(reads).toBe(240);
    expect(clock.now() - 1_000_000).toBe(pollForMs);
});

it("stops when the client gives up", async () => {
    const clock = fakeClock();
    const giveUp = new AbortController();
    let reads = 0;
    const waiting = waitPaid(
        step.orderId,
        {
            status: async () => {
                reads += 1;
                if (reads === 2) giveUp.abort(new DOMException("the client gave up", "AbortError"));
                return "unpaid";
            },
            sleep: clock.sleep,
            now: clock.now,
        },
        giveUp.signal,
        () => {},
    );
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(2);
});

it("rebuilds the payment step as the gateway words it", () => {
    const quoteId = "q2.abc";
    const r = paymentStepResult(step, quoteId);
    const guide =
        "Payment required for order ord_abcdefghijklmnopqrstuvwxyz. Next: pay at " +
        `${step.payUrl} with a Solana wallet holding USDC, then call bugnet_redeem with orderId ` +
        `and claim (orderId "${step.orderId}", claim "${step.claim}", quoteId "q2.abc"). Show the ` +
        "user the link, since they pay in their own browser. Calling bugnet_start again without " +
        "this orderId opens a new order the user would pay again. The x402 maxTimeoutSeconds " +
        "limits a wallet's signed payment, not the user's time to pay.";
    expect(r).toEqual({
        isError: true,
        content: [{ type: "text", text: guide }],
        structuredContent: {
            message: guide,
            orderId: step.orderId,
            payUrl: step.payUrl,
            claim: step.claim,
            quoteId,
        },
    });
    expect(paymentStepResult({ ...step, tool: "bugnet_extend" }).content).toEqual([
        {
            type: "text",
            text: expect.stringContaining(
                `(orderId "${step.orderId}", claim "${step.claim}" and this sandbox's handle)`,
            ),
        },
    ]);
    expect(lostLinkText("bugnet_start")).toBe(
        "This pay link is no longer valid. Call " +
            "bugnet_start again with the orderId and claim from its payment step, since a call " +
            "without them opens a new order the user would pay again.",
    );
});
