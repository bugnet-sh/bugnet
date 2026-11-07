import { Code } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { X402ServiceState } from "../gen/bugnet/router/v1/router_pb.ts";
import type {
    RefusedOrder,
    X402Account,
    X402AccountService,
    X402ConfigureRefused,
    X402RefundState,
} from "../payments/port.ts";
import {
    otherPayTo,
    routerError,
    testAccount,
    testChatId,
    testChatLine,
    testChatUrl,
    testNow,
    testPayTo,
    testTerms,
    testTtsId,
    testTtsLine,
    testTtsUrl,
    testX402Index,
    x402Info,
    x402Refusal,
} from "../testing/harness.ts";
import { refusalError } from "../tools/orders.ts";
import { loadIndex } from "./index.ts";
import { parseServiceLine, payToShort, type ServiceLineParts } from "./lines.ts";
import type { PlannedService } from "./pins.ts";
import { probeWords } from "./probe.ts";
import {
    buildView,
    copyBackLine,
    firstUseLine,
    notAllowanceOrder,
    otherSandboxOrder,
    paidRetryUnreachable,
    paymentsRefusal,
    statusEndedLine,
    statusLines,
    stopFilesLine,
    stopMoneyLine,
    totalsUnavailable,
    x402Error,
    x402Fail,
    x402Kinds,
    x402Lines,
    x402Text,
    type RefusalContext,
    type ViewInput,
    type X402View,
    type X402ViewService,
    type X402TextKey,
    type X402TextValues,
} from "./render.ts";
import {
    failureText,
    failureWords,
    routerReasonWords,
    x402RouterError,
    type X402What,
} from "./router.ts";
import { lineLimits } from "./terms.ts";

const terms = testTerms();
const chat: X402AccountService = {
    serviceId: testChatId,
    method: "POST",
    host: "agent402.tools",
    prefix: "/v1/auto/",
    url: testChatUrl,
    paidPath: null,
    maxPriceMicros: 10_000,
    payTo: testPayTo,
    listed: "indexed",
    state: "enabled",
};
const tts: X402AccountService = {
    serviceId: testTtsId,
    method: "POST",
    host: "tts.example.com",
    prefix: "/v1/",
    url: testTtsUrl,
    paidPath: "/v1/speech",
    maxPriceMicros: 20_000,
    payTo: otherPayTo,
    listed: "unlisted",
    state: "enabled",
};
const account: X402Account = {
    state: "open",
    fundedMicros: 1_000_000,
    spentMicros: 730_000,
    heldMicros: 20_000,
    leftMicros: 250_000,
    allowanceRoomMicros: 4_000_000,
    paidCalls: 73,
    pendingCalls: 2,
    spendPerMinuteMicros: 500_000,
    services: [chat],
};
const fresh: X402Account = {
    ...account,
    spentMicros: 0,
    heldMicros: 0,
    leftMicros: 1_000_000,
    paidCalls: 0,
    pendingCalls: 0,
};
const input = (patch: Partial<ViewInput> = {}): ViewInput => ({
    account,
    feeDue: false,
    router: [x402Info(testChatId, X402ServiceState.ACTIVE)],
    refusals: [],
    terms,
    index: testX402Index(),
    ...patch,
});
const chatRow = `- POST agent402.tools/v1/auto/ at most $0.01 a call, pays ${payToShort(testPayTo)} (${testChatId})`;
const ttsRow = `- POST tts.example.com/v1/ at most $0.02 a call, paid only on /v1/speech, pays ${payToShort(otherPayTo)} (${testTtsId})`;
const chatEnv =
    "Env for agent402.tools: OPENAI_BASE_URL=https://agent402.tools/v1/auto OPENAI_API_KEY=x402. They go in bugnet_exec's env on every command that runs this code.";
const editsLine =
    "Code edits in the sandbox are fine, but they only work inside Bugnet: never commit, push or copy them into the user's own files without the user's yes.";
const paidCallLine =
    "A paid call must finish within about 60 s. Bugnet reads the traffic to these hosts to pay for it.";
const refundLine =
    "Unspent money of $0.01 or more goes back to the paying wallet when the sandbox ends.";

function partsOf(line: string): ServiceLineParts {
    const p = parseServiceLine(line, lineLimits(terms));
    if (!p.ok) throw new Error(`test line refused: ${line}`);
    return p.parts;
}

describe("buildView", () => {
    it("turns the account into USD strings and the router's state", () => {
        expect(buildView(input())).toEqual({
            paidInUsd: "$1.00",
            spentUsd: "$0.73",
            heldUsd: "$0.02",
            leftUsd: "$0.25",
            maxPerSandboxUsd: "$5.00",
            feeDue: false,
            paidCalls: 73,
            pendingCalls: 2,
            refused: {},
            spendPerMinuteUsd: "$0.50",
            services: [
                {
                    serviceId: testChatId,
                    method: "POST",
                    host: "agent402.tools",
                    prefix: "/v1/auto/",
                    paidPath: null,
                    maxPriceUsd: "$0.01",
                    payTo: testPayTo,
                    listed: "indexed",
                    state: "active",
                    serviceLine: testChatLine,
                    envLines: [
                        "OPENAI_BASE_URL=https://agent402.tools/v1/auto",
                        "OPENAI_API_KEY=x402",
                    ],
                },
            ],
        });
    });

    it("lets a Payments disabled or unreliable state win over the router", () => {
        const disabled = buildView(
            input({ account: { ...account, services: [{ ...chat, state: "disabled" }] } }),
        );
        expect(disabled.services[0]?.state).toBe("disabled");
        const unreliable = buildView(
            input({ account: { ...account, services: [{ ...chat, state: "unreliable" }] } }),
        );
        expect(unreliable.services[0]?.state).toBe("unreliable");
    });

    it("reads an enabled service as applying when the router lacks it or gave no answer", () => {
        for (const router of [[], null]) {
            const s = buildView(input({ router })).services[0];
            expect(s?.state).toBe("applying");
            expect(s).not.toHaveProperty("failureReason");
        }
    });

    it("shows a router FAILED row as failed with its failure code", () => {
        const s = buildView(
            input({
                router: [
                    x402Info(testChatId, X402ServiceState.FAILED, {
                        failureReason: "PORT_443_TAKEN",
                    }),
                ],
            }),
        ).services[0];
        expect(s?.state).toBe("failed");
        expect(s?.failureReason).toBe("PORT_443_TAKEN");
    });

    it("marks a service a refused repair left out as failed with the router reason", () => {
        const s = buildView(input({ notEnabled: new Map([[testChatId, "HOST_IN_USE"]]) }))
            .services[0];
        expect(s?.state).toBe("failed");
        expect(s?.failureReason).toBe("HOST_IN_USE");
    });

    it("counts the router's refusals by reason", () => {
        const view = buildView(
            input({
                refusals: [
                    x402Refusal("allowance_spent", 3, testNow),
                    x402Refusal("price_above_max", 1, testNow),
                ],
            }),
        );
        expect(view.refused).toEqual({ allowance_spent: 3, price_above_max: 1 });
    });

    it("renders the refund, with txs only when there are some", () => {
        const closed = (txs: string[]): X402Account => ({
            ...account,
            state: "closed",
            refund: { state: "confirmed", amountMicros: 250_000, keptMicros: 0, txs },
        });
        expect(buildView(input({ account: closed(["5sig"]) })).refund).toEqual({
            state: "confirmed",
            amountUsd: "$0.25",
            keptUsd: "$0.00",
            txs: ["5sig"],
        });
        const none = buildView(input({ account: closed([]) })).refund;
        expect(none).toEqual({ state: "confirmed", amountUsd: "$0.25", keptUsd: "$0.00" });
        expect(none).not.toHaveProperty("txs");
        expect(buildView(input())).not.toHaveProperty("refund");
    });

    it("gives env lines from the index entry or the OpenAI shape, and none otherwise", () => {
        const view = buildView(
            input({
                account: { ...account, services: [chat, tts] },
                router: [
                    x402Info(testChatId, X402ServiceState.ACTIVE),
                    x402Info(testTtsId, X402ServiceState.ACTIVE),
                ],
            }),
        );
        expect(view.services[1]?.envLines).toEqual([]);
        expect(view.services[1]?.serviceLine).toBe(testTtsLine);
        const reviewed = loadIndex({
            v: 1,
            services: [
                {
                    host: "agent402.tools",
                    url: testChatUrl,
                    method: "POST",
                    prefix: "/v1/auto/",
                    payTo: testPayTo,
                    category: "chat",
                    keyNames: [],
                    name: "Agent402 chat",
                    inputFields: [],
                    outputFields: [],
                    envLines: ["AGENT402_URL=https://agent402.tools/v1/auto"],
                    reviewedAt: "2026-11-01",
                },
            ],
        });
        expect(buildView(input({ index: reviewed })).services[0]?.envLines).toEqual([
            "AGENT402_URL=https://agent402.tools/v1/auto",
        ]);
        const empty = loadIndex({ v: 1, services: [] });
        expect(buildView(input({ index: empty })).services[0]?.envLines).toEqual([
            "OPENAI_BASE_URL=https://agent402.tools/v1/auto",
            "OPENAI_API_KEY=x402",
        ]);
    });
});

describe("x402Lines", () => {
    it("renders the S 5.3 success message in order on a first use", () => {
        const view = buildView(input({ account: fresh }));
        expect(x402Lines(view, { firstUse: true, terms })).toEqual([
            `First x402 allowance for this wallet. Show the user, in your next message: "Your x402 limits for this sandbox: a $1.00 allowance (up to $5.00 in all), agent402.tools at most $0.01 a call (up to $0.50), and at most $0.50 spent a minute (up to $5.00). Tell me to change any of these, for example 'add $1', 'allow $0.02 a call', 'let it spend $1 a minute' or 'stop paying agent402.tools'. Bugnet fixes the ceilings and at most 5 services. Changes last for this sandbox only. A new sandbox starts again at $0.50 a minute and the prices you approve."`,
            "x402 for this sandbox: $1.00 paid in, $0.00 spent, $0.00 settling, $1.00 left.",
            "Enabled, paid only on these terms:",
            `${chatRow}: active. Service line: ${testChatLine}`,
            "Spending is capped at $0.50 a minute.",
            chatEnv,
            "New commands get BUGNET_X402=1 and BUGNET_X402_HOSTS=agent402.tools. Restart servers that should call these hosts.",
            editsLine,
            paidCallLine,
            refundLine,
        ]);
        expect(firstUseLine(view, terms)).toBe(x402Lines(view, { firstUse: true, terms })[0]);
    });

    it("leaves out the empty lines when no service is enabled", () => {
        const none = buildView(input({ account: { ...account, services: [] } }));
        expect(x402Lines(none, { firstUse: false, terms })).toEqual([
            "x402 for this sandbox: $1.00 paid in, $0.73 spent, $0.02 settling, $0.25 left.",
            "Spending is capped at $0.50 a minute.",
            refundLine,
        ]);
        const first = x402Lines(none, { firstUse: true, terms })[0];
        expect(first).toContain(
            "for example 'add $1', 'allow $0.02 a call' or 'let it spend $1 a minute'.",
        );
        expect(first).toContain(
            "a $1.00 allowance (up to $5.00 in all), and at most $0.50 spent a minute (up to $5.00).",
        );
    });

    it("words each row state", () => {
        const applying = buildView(
            input({ router: [x402Info(testChatId, X402ServiceState.APPLYING)] }),
        );
        expect(x402Lines(applying, { firstUse: false, terms })).toContain(
            `${chatRow}: applying, usable within a few seconds. Service line: ${testChatLine}`,
        );
        const codes = [
            ...Object.entries(failureWords),
            ["OTHER", failureText("OTHER")] as [string, string],
        ];
        for (const [code, words] of codes) {
            const failed = buildView(
                input({
                    router: [
                        x402Info(testChatId, X402ServiceState.FAILED, { failureReason: code }),
                    ],
                }),
            );
            expect(x402Lines(failed, { firstUse: false, terms })).toContain(
                `${chatRow}: failed, ${words}. Service line: ${testChatLine}`,
            );
        }
    });

    it("names the paid path of an unlisted service and joins the hosts with commas", () => {
        const view = buildView(
            input({
                account: { ...account, services: [chat, tts] },
                router: [
                    x402Info(testChatId, X402ServiceState.ACTIVE),
                    x402Info(testTtsId, X402ServiceState.ACTIVE),
                ],
            }),
        );
        const lines = x402Lines(view, { firstUse: false, terms });
        expect(lines).toContain(`${ttsRow}: active. Service line: ${testTtsLine}`);
        expect(lines).toContain(
            "New commands get BUGNET_X402=1 and BUGNET_X402_HOSTS=agent402.tools,tts.example.com. Restart servers that should call these hosts.",
        );
    });

    it("never lists a disabled or unreliable service, nor a failed one's host", () => {
        for (const state of ["disabled", "unreliable"] as const) {
            const view = buildView(
                input({
                    account: { ...account, services: [chat, { ...tts, state }] },
                    router: [
                        x402Info(testChatId, X402ServiceState.ACTIVE),
                        x402Info(testTtsId, X402ServiceState.ACTIVE),
                    ],
                }),
            );
            const text = x402Lines(view, { firstUse: false, terms }).join("\n");
            expect(text).not.toContain("tts.example.com");
            expect(text).toContain("BUGNET_X402_HOSTS=agent402.tools.");
        }
        const failed = buildView(
            input({
                router: [
                    x402Info(testChatId, X402ServiceState.FAILED, {
                        failureReason: "HOST_BLOCKED",
                    }),
                ],
            }),
        );
        expect(x402Lines(failed, { firstUse: false, terms })).toEqual([
            "x402 for this sandbox: $1.00 paid in, $0.73 spent, $0.02 settling, $0.25 left.",
            "Enabled, paid only on these terms:",
            `${chatRow}: failed, ${failureWords.HOST_BLOCKED}. Service line: ${testChatLine}`,
            "Spending is capped at $0.50 a minute.",
            refundLine,
        ]);
    });

    it("puts the paid-but-not-enabled line in place of the services block", () => {
        expect(
            x402Lines(buildView(input({ account: fresh, router: null })), {
                firstUse: false,
                terms,
                notEnabled: true,
            }),
        ).toEqual([
            "x402 for this sandbox: $1.00 paid in, $0.00 spent, $0.00 settling, $1.00 left.",
            "x402: the allowance is paid ($1.00), but the services were not enabled yet. Call bugnet_status with the handle; it finishes enabling them at no charge.",
            "Spending is capped at $0.50 a minute.",
            refundLine,
        ]);
    });

    it("renders every amount from the terms", () => {
        const t = testTerms({
            refundMinMicros: 20_000,
            maxAllowancePerSandboxMicros: 4_000_000,
            maxServices: 3,
            defaultSpendPerMinuteMicros: 250_000,
        });
        const view = buildView(input({ account: fresh, terms: t }));
        const lines = x402Lines(view, { firstUse: true, terms: t });
        const text = lines.join("\n");
        expect(text).toContain(
            "Unspent money of $0.02 or more goes back to the paying wallet when the sandbox ends.",
        );
        expect(text).toContain("(up to $4.00 in all)");
        expect(text).toContain("at most 3 services");
        expect(text).toContain("starts again at $0.25 a minute");
        expect(view.maxPerSandboxUsd).toBe("$4.00");
    });
});

const long = `POST https://agent402.tools/v1/auto/chat/completions max=0.60 payTo=${testPayTo} prefix=/v1/auto/`;

describe("x402Text", () => {
    const rows: [X402TextKey, X402What, X402TextValues, string][] = [
        [
            "switchedOff",
            "start",
            {},
            "start: Bugnet's pay-per-call APIs are switched off right now. Nothing was charged",
        ],
        [
            "paused",
            "x402",
            {},
            "x402: Bugnet paused x402 payments right now. Nothing was charged. Try again later, or add the user's key with bugnet_secret_link",
        ],
        [
            "startUnavailable",
            "x402",
            {},
            "start: an allowance cannot be bought together with a sandbox yet. Start the sandbox without x402, then call bugnet_x402_budget with the handle and the same service line. Nothing was charged",
        ],
        [
            "notCapable",
            "x402",
            {},
            'x402: this sandbox cannot use x402 services. A sandbox started from a quote with needs ["secrets"] can, and the other Bugnet tools work here as usual',
        ],
        [
            "amountTooSmall",
            "x402",
            { terms },
            'x402: amountUsd is at least $0.10, or "0" to re-price, disable or change the minute limit only',
        ],
        [
            "noAllowance",
            "x402",
            { terms },
            "x402: this sandbox has no allowance yet. Pass amountUsd, such as 1.00, with the services",
        ],
        [
            "needsPayment",
            "x402",
            { terms, host: "tts.example.com" },
            "x402: adding tts.example.com, or changing who it pays, needs an allowance payment of at least $0.10, so the user approves it in their wallet. Pass amountUsd, such as 0.50, with the service line, and the total as confirmPriceUsd",
        ],
        [
            "overCeiling",
            "x402",
            { terms, amountMicros: 2_000_000, roomMicros: 1_500_000 },
            "x402: $2.00 would bring this sandbox's allowance to $5.50, past the $5.00 limit for one sandbox. At most $1.50 more can be added",
        ],
        [
            "ceilingReached",
            "x402",
            { terms, roomMicros: 50_000 },
            "x402: this sandbox has reached its $5.00 allowance limit ($0.05 is left, under the $0.10 minimum order). Add the user's key with bugnet_secret_link, or start a new sandbox",
        ],
        [
            "wrongConfirmFee",
            "x402",
            { terms, amountMicros: 1_000_000, totalMicros: 1_003_000 },
            "x402: this charges $1.003: $1.00 of allowance plus a one-time $0.003 fee that covers the refund. Tell the user that total and pass it as confirmPriceUsd",
        ],
        [
            "wrongConfirm",
            "x402",
            { amountMicros: 1_000_000 },
            "x402: this charges $1.00. Tell the user that total and pass it as confirmPriceUsd",
        ],
        [
            "maxAbove",
            "x402",
            { terms, line: long },
            `x402: max= in "${long.slice(0, 80)}" is above $0.50, the most Bugnet pays a call. Lower max= to 0.50 or less, with the user's yes`,
        ],
        [
            "malformed",
            "x402",
            { line: long },
            `x402: "${long.slice(0, 80)}" is not a service line. Copy it from bugnet_x402_find or bugnet_status, and to re-price change only max=`,
        ],
        [
            "unlisted",
            "x402",
            { host: "tts.example.com" },
            "x402: tts.example.com is not reviewed by Bugnet. Enable it only if the user agreed to an unreviewed service, with allowUnlisted true",
        ],
        [
            "livePriceAbove",
            "x402",
            { host: "agent402.tools", liveMicros: 20_000, maxMicros: 10_000 },
            "x402: agent402.tools now asks $0.02 a call, above the approved $0.01. Tell the user the new price, and enable it only if they agree",
        ],
        [
            "payToChanged",
            "x402",
            { host: "agent402.tools", livePayTo: otherPayTo, linePayTo: testPayTo },
            `x402: agent402.tools now pays a different address (${payToShort(otherPayTo)}) than the one the user approved (${payToShort(testPayTo)}). Run bugnet_x402_find again and ask the user before enabling it`,
        ],
        [
            "probeFailed",
            "x402",
            { host: "agent402.tools", words: probeWords.no_402 },
            `x402: agent402.tools did not answer with a price Bugnet can pay (${probeWords.no_402}), so it cannot be enabled`,
        ],
        [
            "pinRefused",
            "x402",
            { host: "agent402.tools", words: probeWords.payee_no_usdc_account },
            `x402: Bugnet cannot pay agent402.tools (${probeWords.payee_no_usdc_account}). Nothing was charged. Pick another service from bugnet_x402_find`,
        ],
        [
            "duplicate",
            "x402",
            { line: long },
            `x402: "${long.slice(0, 80)}" names the same service as another line here. Send each service once`,
        ],
        [
            "tooManyServices",
            "x402",
            { terms },
            "x402: a sandbox takes at most 5 services. Disable one first, bugnet_status lists their ids",
        ],
        ["spendRange", "x402", { terms }, "x402: spendPerMinuteUsd is between $0.01 and $5.00"],
        [
            "spendUnderMax",
            "x402",
            { limitMicros: 10_000, host: "agent402.tools", maxMicros: 20_000 },
            "x402: spendPerMinuteUsd $0.01 is under agent402.tools's $0.02 a call, so no call to it could ever be paid. Raise the limit to at least $0.02, or lower that service's max=, with the user's yes",
        ],
        [
            "poolFull",
            "x402",
            {},
            "x402: Bugnet cannot take more x402 allowances right now. Nothing was charged. Try again later, or add the user's key with bugnet_secret_link",
        ],
        [
            "paidRefused",
            "x402",
            { reason: "allowance_ceiling", refundPending: true, amountMicros: 1_003_000 },
            "x402: the payment of $1.003 would pass Bugnet's x402 limits, so it is refunded in full to the paying wallet within 10 minutes and nothing was enabled",
        ],
        [
            "paidRefused",
            "x402",
            { reason: "allowance_pool_full", refundPending: false, amountMicros: 1_003_000 },
            "x402: the payment of $1.003 would pass Bugnet's x402 limits, so it was refunded and nothing was enabled",
        ],
        [
            "paidRefused",
            "x402",
            { reason: "sandbox_ended", refundPending: true, amountMicros: 1_003_000 },
            "x402: the sandbox ended before the payment of $1.003 was applied, so it is refunded in full to the paying wallet within 10 minutes",
        ],
        [
            "paidRefused",
            "x402",
            { reason: "sandbox_ended", refundPending: false, amountMicros: 1_003_000 },
            "x402: the sandbox ended before the payment of $1.003 was applied, so it was refunded",
        ],
        [
            "paidRefused",
            "x402",
            {
                reason: "order_expired",
                refundPending: true,
                amountMicros: 1_003_000,
                orderId: "ord_x",
            },
            "x402: the payment of $1.003 arrived after order ord_x expired, so it is refunded in full to the paying wallet within 10 minutes and nothing was enabled. A new order needs the user's yes",
        ],
        [
            "paidRefused",
            "start",
            { reason: "allowance_ceiling", refundPending: true, amountMicros: 1_053_000 },
            "start: the payment of $1.053 would pass Bugnet's x402 limits, so it is refunded in full to the paying wallet within 10 minutes and no sandbox was started",
        ],
        [
            "paidRefused",
            "x402",
            { reason: "allowance_ceiling", refundPending: true },
            "x402: the payment would pass Bugnet's x402 limits, so it is refunded in full to the paying wallet within 10 minutes and nothing was enabled",
        ],
        [
            "ended",
            "x402",
            {},
            "x402: this sandbox has ended and everything in it was deleted. Quote and start a new one",
        ],
        [
            "routerRefused",
            "x402",
            { hosts: ["agent402.tools"], words: routerReasonWords.HOST_REFUSED },
            "x402: agent402.tools cannot be enabled (Bugnet does not route to this host). Nothing was charged",
        ],
        [
            "paidNotEnabled",
            "x402",
            { amountMicros: 1_000_000 },
            "x402: the allowance is paid ($1.00), but the services were not enabled yet. Call bugnet_status with the handle; it finishes enabling them at no charge",
        ],
        [
            "unreachable",
            "x402",
            {},
            "x402: Bugnet could not reach its payment service, so nothing was charged. Try again in a minute",
        ],
        [
            "termsMismatch",
            "x402",
            { orderId: "ord_x" },
            "x402: order ord_x was made with other terms. If the user already paid it, call again with only orderId and the claim or payment, and Bugnet answers from that order. Make a new order (no orderId) only if the user has not paid, and only with their yes to the new total",
        ],
        [
            "idempotencyConflict",
            "x402",
            {},
            "x402: Bugnet already applied this call with other settings. bugnet_status shows the current services and limits",
        ],
        [
            "tooManyNew",
            "x402",
            { terms },
            "x402: the wallet cannot show this many new services in one payment, so nothing was charged. Enable at most 5 new services in this call, then add the rest with another bugnet_x402_budget call",
        ],
    ];

    it.each(rows)("%s (%s) renders its row", (key, what, v, text) => {
        expect(x402Text[key](what, v)).toBe(text);
    });

    it("covers every key in the table", () => {
        expect(new Set(rows.map(([k]) => k))).toEqual(new Set(Object.keys(x402Text)));
    });

    it("renders the amounts of other terms", () => {
        const t = testTerms({
            minAllowanceMicros: 200_000,
            maxServices: 3,
            maxPricePerCallMicros: 250_000,
        });
        expect(x402Text.amountTooSmall("x402", { terms: t })).toBe(
            `x402: amountUsd is at least $0.20, or "0" to re-price, disable or change the minute limit only`,
        );
        expect(x402Text.tooManyServices("x402", { terms: t })).toBe(
            "x402: a sandbox takes at most 3 services. Disable one first, bugnet_status lists their ids",
        );
        expect(x402Text.maxAbove("x402", { terms: t, line: "x" })).toBe(
            `x402: max= in "x" is above $0.25, the most Bugnet pays a call. Lower max= to 0.25 or less, with the user's yes`,
        );
    });

    it("matches B7's router error texts for the rows they share", () => {
        // Per-service refusals carry the failing add entry, placement-wide ones ignore it
        const metadata = { service_id: testChatId, host: "agent402.tools" };
        const of = (code: Code, reason: string) =>
            x402RouterError(routerError(code, reason, { metadata }), "x402", [], 5).message;
        expect(of(Code.FailedPrecondition, "X402_DISABLED")).toBe(x402Text.switchedOff("x402", {}));
        expect(of(Code.FailedPrecondition, "FEATURE_UNAVAILABLE")).toBe(
            x402Text.notCapable("x402", {}),
        );
        expect(of(Code.FailedPrecondition, "NOT_READY")).toBe(x402Text.ended("x402", {}));
        expect(of(Code.ResourceExhausted, "TOO_MANY_SERVICES")).toBe(
            x402Text.tooManyServices("x402", { terms }),
        );
        expect(of(Code.InvalidArgument, "HOST_REFUSED")).toBe(
            x402Text.routerRefused("x402", {
                hosts: ["agent402.tools"],
                words: routerReasonWords.HOST_REFUSED,
            }),
        );
    });

    it("gives each row its error kind", () => {
        expect(x402Kinds).toEqual({
            switchedOff: "unsupported",
            startUnavailable: "unsupported",
            notCapable: "unsupported",
            paused: "unavailable",
            poolFull: "unavailable",
            paidNotEnabled: "unavailable",
            unreachable: "unavailable",
            noAllowance: "precondition",
            overCeiling: "limit",
            ceilingReached: "limit",
            tooManyServices: "limit",
            pinRefused: "denied",
            paidRefused: "denied",
            ended: "expired",
            amountTooSmall: "invalid",
            needsPayment: "invalid",
            wrongConfirmFee: "invalid",
            wrongConfirm: "invalid",
            maxAbove: "invalid",
            malformed: "invalid",
            unlisted: "invalid",
            livePriceAbove: "invalid",
            payToChanged: "invalid",
            probeFailed: "invalid",
            duplicate: "invalid",
            spendRange: "invalid",
            spendUnderMax: "invalid",
            routerRefused: "invalid",
            termsMismatch: "invalid",
            idempotencyConflict: "invalid",
            tooManyNew: "invalid",
        });
        expect(Object.keys(x402Kinds)).toHaveLength(31);
        const e = x402Fail("ended", "x402");
        expect([e.kind, e.message, e.retryAfterMs]).toEqual([
            "expired",
            x402Text.ended("x402", {}),
            null,
        ]);
    });

    it("keeps the short totals line exact", () => {
        expect(totalsUnavailable).toBe("x402 totals are unavailable right now.");
    });

    it("tells a paid retry with unreadable terms to call again", () => {
        const byClaim = paidRetryUnreachable("x402", "bugnet_x402_budget", "ord_x", {
            claim: "c".repeat(43),
            handle: true,
        });
        expect(byClaim.message).toBe(
            `x402: order ord_x is paid, but Bugnet could not reach its payment service to apply it. Call bugnet_x402_budget with the handle, orderId "ord_x" and claim "${"c".repeat(43)}" in a minute`,
        );
        expect(byClaim.kind).toBe("unavailable");
        expect(
            paidRetryUnreachable("x402", "bugnet_x402_budget", "ord_x", { payment: true }).message,
        ).toBe(
            `x402: order ord_x is paid, but Bugnet could not reach its payment service to apply it. Call bugnet_x402_budget with orderId "ord_x" and the claim from its payment step in a minute`,
        );
    });

    it("sends a sandbox order back to bugnet_redeem", () => {
        const e = notAllowanceOrder("ord_x");
        expect(e.message).toBe(
            "x402: order ord_x starts a sandbox or adds time to one, not x402 allowance. Call bugnet_redeem with its orderId and claim",
        );
        expect(e.kind).toBe("invalid");
    });

    it("sends an order for another sandbox back to the handle", () => {
        const e = otherSandboxOrder("ord_x");
        expect([e.message, e.kind, e.fields]).toEqual([
            "x402: order ord_x is not for that sandbox, check the handle",
            "invalid",
            { orderId: "ord_x" },
        ]);
    });

    it("says its order when an expired order's answer names none", () => {
        expect(
            x402Text.paidRefused("x402", {
                reason: "order_expired",
                refundPending: true,
                amountMicros: 1_003_000,
            }),
        ).toBe(
            "x402: the payment of $1.003 arrived after its order expired, so it is refunded in full to the paying wallet within 10 minutes and nothing was enabled. A new order needs the user's yes",
        );
        const e = x402Fail("paidRefused", "x402", {
            reason: "order_expired",
            refundPending: false,
            amountMicros: 1_003_000,
        });
        expect(e.message).toContain("arrived after its order expired, so it was refunded");
        expect(e.fields).toBeNull();
    });

    it("carries the orderId on every error whose text names an order", () => {
        const id = { orderId: "ord_x" };
        expect(x402Fail("termsMismatch", "x402", id).fields).toEqual(id);
        const expired = { reason: "order_expired", refundPending: true, amountMicros: 1, ...id };
        expect(x402Fail("paidRefused", "x402", expired).fields).toEqual(id);
        const ended = { reason: "sandbox_ended", refundPending: true, amountMicros: 1, ...id };
        expect(x402Fail("paidRefused", "x402", ended).fields).toBeNull();
        expect(x402Fail("ended", "x402").fields).toBeNull();
        const w = { claim: "c".repeat(43), handle: true };
        expect(paidRetryUnreachable("x402", "bugnet_x402_budget", "ord_x", w).fields).toEqual(id);
        expect(notAllowanceOrder("ord_x").fields).toEqual(id);
        expect(x402Error("x402: x", "denied", 3_000, { orderId: "ord_y" })).toMatchObject({
            kind: "denied",
            retryAfterMs: 3_000,
            fields: { orderId: "ord_y" },
        });
        expect(x402Error("x402: x").fields).toBeNull();
    });
});

describe("paymentsRefusal", () => {
    const planned: PlannedService = {
        parts: partsOf(testChatLine),
        listed: "indexed",
        indexEntry: null,
        held: null,
        change: "new",
    };
    const ctx = (p: Partial<RefusalContext> = {}): RefusalContext => ({
        what: "x402",
        tool: "bugnet_x402_budget",
        terms,
        feeDue: true,
        amountMicros: 1_000_000,
        chargedMicros: 1_003_000,
        orderId: "ord_a",
        planned: [planned],
        account: null,
        retry: {},
        spendPerMinuteMicros: 500_000,
        disable: [],
        ...p,
    });
    const at = (max: string): PlannedService => ({
        ...planned,
        parts: partsOf(testChatLine.replace("max=0.01", `max=${max}`)),
    });
    type Row = [
        string,
        RefusedOrder | X402ConfigureRefused,
        Partial<RefusalContext>,
        X402TextKey,
        X402TextValues,
        X402What?,
    ];
    const refused = (reason: string, extra: Record<string, unknown> = {}) =>
        ({ status: "refused", reason, ...extra }) as unknown as RefusedOrder;
    const rows: Row[] = [
        ["x402_disabled", refused("x402_disabled"), {}, "switchedOff", {}],
        [
            "x402_unavailable charged false",
            refused("x402_unavailable", { charged: false }),
            {},
            "switchedOff",
            {},
        ],
        ["x402_paused charged false", refused("x402_paused", { charged: false }), {}, "paused", {}],
        ["x402_start_unavailable", refused("x402_start_unavailable"), {}, "startUnavailable", {}],
        ["sandbox_not_capable", refused("sandbox_not_capable"), {}, "notCapable", {}],
        ["amount_too_small", refused("amount_too_small"), {}, "amountTooSmall", { terms }],
        ["configure no_account", refused("no_account"), {}, "noAllowance", { terms }],
        [
            "configure needs_payment",
            refused("needs_payment"),
            {},
            "needsPayment",
            { terms, host: "agent402.tools" },
        ],
        [
            "allowance_ceiling with room",
            refused("allowance_ceiling"),
            { account: { ...account, allowanceRoomMicros: 500_000 } },
            "overCeiling",
            { terms, amountMicros: 1_000_000, roomMicros: 500_000 },
        ],
        [
            "allowance_ceiling with no room",
            refused("allowance_ceiling"),
            { account: { ...account, allowanceRoomMicros: 50_000 } },
            "ceilingReached",
            { terms, roomMicros: 50_000 },
        ],
        [
            "allowance_ceiling after payment",
            refused("allowance_ceiling", { refundPending: true }),
            {},
            "paidRefused",
            {
                reason: "allowance_ceiling",
                refundPending: true,
                amountMicros: 1_003_000,
                orderId: "ord_a",
            },
        ],
        [
            "fee_mismatch with the fee sent",
            refused("fee_mismatch"),
            { feeDue: true },
            "wrongConfirm",
            { amountMicros: 1_000_000 },
        ],
        [
            "fee_mismatch with no fee sent",
            refused("fee_mismatch"),
            { feeDue: false },
            "wrongConfirmFee",
            { terms, amountMicros: 1_000_000, totalMicros: 1_003_000 },
        ],
        [
            "price_above_ceiling",
            refused("price_above_ceiling"),
            {},
            "maxAbove",
            { terms, line: testChatLine },
        ],
        [
            "pin_refused",
            refused("pin_refused", {
                serviceId: testChatId,
                pinReason: "service_id_mismatch",
            }),
            {},
            "pinRefused",
            { host: "agent402.tools", words: probeWords.service_id_mismatch },
        ],
        ["too_many_services", refused("too_many_services"), {}, "tooManyServices", { terms }],
        [
            "spend_rate_out_of_range above the range",
            refused("spend_rate_out_of_range"),
            { spendPerMinuteMicros: 6_000_000 },
            "spendRange",
            { terms },
        ],
        [
            "spend_rate_out_of_range below the range and a max",
            refused("spend_rate_out_of_range"),
            { spendPerMinuteMicros: 5_000 },
            "spendRange",
            { terms },
        ],
        [
            "spend_rate_out_of_range under a max",
            refused("spend_rate_out_of_range"),
            { spendPerMinuteMicros: 100_000, planned: [at("0.20")] },
            "spendUnderMax",
            { limitMicros: 100_000, host: "agent402.tools", maxMicros: 200_000 },
        ],
        ["description_too_long", refused("description_too_long"), {}, "tooManyNew", { terms }],
        ["allowance_pool_full", refused("allowance_pool_full"), {}, "poolFull", {}],
        [
            "allowance_pool_full after payment",
            refused("allowance_pool_full", { refundPending: false }),
            {},
            "paidRefused",
            {
                reason: "allowance_pool_full",
                refundPending: false,
                amountMicros: 1_003_000,
                orderId: "ord_a",
            },
        ],
        ["sandbox_ended", refused("sandbox_ended"), {}, "ended", {}],
        ["sandbox_unknown", refused("sandbox_unknown"), {}, "ended", {}],
        [
            "sandbox_ended after payment",
            refused("sandbox_ended", { refundPending: true }),
            {},
            "paidRefused",
            {
                reason: "sandbox_ended",
                refundPending: true,
                amountMicros: 1_003_000,
                orderId: "ord_a",
            },
        ],
        [
            "order_expired after payment",
            refused("order_expired", { orderId: "ord_b", refundPending: true }),
            {},
            "paidRefused",
            {
                reason: "order_expired",
                refundPending: true,
                amountMicros: 1_003_000,
                orderId: "ord_b",
            },
        ],
        ["router_unavailable", refused("router_unavailable"), {}, "unreachable", {}],
        [
            "terms_mismatch",
            refused("terms_mismatch", { orderId: "ord_b" }),
            {},
            "termsMismatch",
            { orderId: "ord_b" },
        ],
        ["idempotency_conflict", refused("idempotency_conflict"), {}, "idempotencyConflict", {}],
        [
            "allowance_ceiling after payment on start",
            refused("allowance_ceiling", { refundPending: true }),
            { what: "start", tool: "bugnet_start", chargedMicros: 1_053_000 },
            "paidRefused",
            {
                reason: "allowance_ceiling",
                refundPending: true,
                amountMicros: 1_053_000,
                orderId: "ord_a",
            },
            "start",
        ],
    ];

    it.each(rows)("%s", (_name, r, patch, key, v, what = "x402") => {
        const e = paymentsRefusal(r, ctx(patch));
        expect(e.message).toBe(x402Text[key](what, v));
        expect(e.kind).toBe(x402Kinds[key]);
    });

    it("ends a refused start after payment with no sandbox started", () => {
        const e = paymentsRefusal(
            refused("allowance_ceiling", { refundPending: true }),
            ctx({ what: "start", tool: "bugnet_start", chargedMicros: 1_053_000 }),
        );
        expect(e.message).toMatch(/and no sandbox was started$/);
    });

    it("says the payment with no amount on a retry by claim, whose call sent no payment", () => {
        const e = paymentsRefusal(
            refused("sandbox_ended", { refundPending: true }),
            ctx({ retry: { claim: "c".repeat(43), handle: true } }),
        );
        expect(e.message).toBe(
            "x402: the sandbox ended before the payment was applied, so it is refunded in full to the paying wallet within 10 minutes",
        );
    });

    it("says the payment with no amount when the call cannot know what was paid", () => {
        const e = paymentsRefusal(
            refused("allowance_ceiling", { refundPending: true }),
            ctx({ chargedMicros: null, retry: { payment: true } }),
        );
        expect(e.message).toBe(
            "x402: the payment would pass Bugnet's x402 limits, so it is refunded in full to the paying wallet within 10 minutes and nothing was enabled",
        );
    });

    it("names the order a refusal names in its fields", () => {
        const e = paymentsRefusal(refused("terms_mismatch", { orderId: "ord_b" }), ctx());
        expect(e.fields).toEqual({ orderId: "ord_b" });
        const expired = paymentsRefusal(
            refused("order_expired", { refundPending: true }),
            ctx({ orderId: null }),
        );
        expect(expired.message).toContain("arrived after its order expired");
        expect(expired.fields).toBeNull();
    });

    it("names the first new service that needs a payment, then any planned one", () => {
        const same: PlannedService = { ...planned, change: "same" };
        const tts: PlannedService = {
            parts: partsOf(testTtsLine),
            listed: "unlisted",
            indexEntry: null,
            held: null,
            change: "repin",
        };
        const host = (p: readonly PlannedService[]) =>
            paymentsRefusal(refused("needs_payment"), ctx({ planned: p })).message;
        expect(host([same, tts])).toBe(
            x402Text.needsPayment("x402", { terms, host: "tts.example.com" }),
        );
        expect(host([same])).toBe(x402Text.needsPayment("x402", { terms, host: "agent402.tools" }));
        expect(host([])).toBe(x402Text.needsPayment("x402", { terms, host: "the service" }));
    });

    it("names the line whose max is above the ceiling", () => {
        const high: PlannedService = {
            ...planned,
            parts: { ...partsOf(testTtsLine), maxMicros: 600_000, line: "POST high" },
        };
        expect(
            paymentsRefusal(refused("price_above_ceiling"), ctx({ planned: [planned, high] }))
                .message,
        ).toBe(x402Text.maxAbove("x402", { terms, line: "POST high" }));
        expect(paymentsRefusal(refused("price_above_ceiling"), ctx({ planned: [] })).message).toBe(
            x402Text.maxAbove("x402", { terms, line: "" }),
        );
    });

    it("finds a refused pin's host on the account when the call did not plan it", () => {
        const e = paymentsRefusal(
            refused("pin_refused", { serviceId: testTtsId, pinReason: "payee_no_usdc_account" }),
            ctx({ account: { ...account, services: [chat, tts] } }),
        );
        expect(e.message).toBe(
            x402Text.pinRefused("x402", {
                host: "tts.example.com",
                words: probeWords.payee_no_usdc_account,
            }),
        );
    });

    it("falls back to Plan A's refusalError for the port v2 reasons", () => {
        for (const r of [
            { status: "refused", orderId: "ord_a", reason: "paid_claim_required" },
            { status: "refused", orderId: "ord_a", reason: "order_expired" },
            { status: "refused", orderId: "ord_a", reason: "claim_mismatch" },
            { status: "refused", reason: "bad_request" },
            { status: "refused", reason: "payer_rate_limited", retryAfterSeconds: 7 },
        ] as RefusedOrder[]) {
            const e = paymentsRefusal(r, ctx());
            const plain = refusalError(r, "x402", "bugnet_x402_budget", {
                sentOrderId: "ord_a",
                handleSent: true,
                paymentSent: false,
            });
            expect([e.message, e.kind, e.retryAfterMs]).toEqual([
                plain.message,
                plain.kind,
                plain.retryAfterMs,
            ]);
        }
    });

    it("names the payment, not the claim, while a paid call that carried a payment settles", () => {
        const settling = {
            status: "refused",
            orderId: "ord_a",
            reason: "settling",
            retryAfterSeconds: 3,
        } as RefusedOrder;
        expect(paymentsRefusal(settling, ctx({ retry: { payment: true } })).message).toBe(
            "x402: the payment for order ord_a is still confirming. Call again with the same orderId and its claim, and do not pay again",
        );
        expect(
            paymentsRefusal(settling, ctx({ retry: { claim: "c".repeat(43), handle: true } }))
                .message,
        ).toContain("the same orderId and claim");
    });
});

describe("status and stop lines", () => {
    const post = `POST ${testChatUrl} max=0.01 payTo=${testPayTo}`;
    const get = `GET ${testChatUrl} max=0.01 payTo=${testPayTo}`;
    const env = ["OPENAI_BASE_URL=https://agent402.tools/v1/auto", "OPENAI_API_KEY=x402"];
    const service: X402ViewService = {
        serviceId: testChatId,
        method: "POST",
        host: "agent402.tools",
        prefix: "/v1/auto/",
        paidPath: "/v1/auto/chat/completions",
        maxPriceUsd: "$0.01",
        payTo: testPayTo,
        listed: "unlisted",
        state: "active",
        serviceLine: post,
        envLines: env,
    };
    const view: X402View = {
        paidInUsd: "$1.00",
        spentUsd: "$0.02",
        heldUsd: "$0.01",
        leftUsd: "$0.97",
        maxPerSandboxUsd: "$5.00",
        feeDue: false,
        paidCalls: 2,
        pendingCalls: 1,
        refused: { price_above_max: 1, allowance_spent: 3 },
        spendPerMinuteUsd: "$0.50",
        services: [service],
    };
    const terms = testTerms();

    it("renders the running totals, the services with the minute limit, and the env lines", () => {
        expect(statusLines(view, { enabling: [] })).toEqual([
            "x402: $1.00 paid in, $0.02 spent in 2 paid calls, $0.01 settling, $0.97 left. Refused: 3 allowance_spent, 1 price_above_max.",
            `Services: POST agent402.tools/v1/auto/ at most $0.01 a call (${testChatId}), active, service line: ${post}. At most $0.50 a minute.`,
            "Env for agent402.tools: OPENAI_BASE_URL=https://agent402.tools/v1/auto OPENAI_API_KEY=x402. They go in bugnet_exec's env on every command that runs this code.",
        ]);
    });

    it("leaves out Refused when nothing was refused and ends with the enabling line", () => {
        const lines = statusLines(
            { ...view, refused: {} },
            { enabling: ["agent402.tools", "api.example.com"] },
        );
        expect(lines[0]).toBe(
            "x402: $1.00 paid in, $0.02 spent in 2 paid calls, $0.01 settling, $0.97 left.",
        );
        expect(lines.at(-1)).toBe(
            "x402: enabling agent402.tools, api.example.com. New commands see them within seconds.",
        );
    });

    it("shows failure words for a failed row, router reason words for a refused repair, and no env line for either", () => {
        const lines = statusLines(
            {
                ...view,
                services: [
                    { ...service, state: "failed", failureReason: "PORT_443_TAKEN" },
                    {
                        ...service,
                        serviceId: "xs_b3mm6u5x36em5pdt",
                        method: "GET",
                        serviceLine: get,
                        state: "failed",
                        failureReason: "HOST_REFUSED",
                    },
                ],
            },
            { enabling: [] },
        );
        expect(lines[1]).toBe(
            `Services: POST agent402.tools/v1/auto/ at most $0.01 a call (${testChatId}), failed, a program in the sandbox holds port 443. Stop it, then send the same service line with amountUsd 0 to enable it again, service line: ${post}; ` +
                `GET agent402.tools/v1/auto/ at most $0.01 a call (xs_b3mm6u5x36em5pdt), failed, Bugnet does not route to this host, service line: ${get}. At most $0.50 a minute.`,
        );
        expect(lines).toHaveLength(2);
    });

    it("gives the ended line for each refund state", () => {
        const s = "x402: $0.02 spent in 2 paid calls.";
        const refund = (state: X402RefundState, amountMicros = 980_000, keptMicros = 0) =>
            testAccount({ state: "closed", refund: { state, amountMicros, keptMicros, txs: [] } });
        expect(statusEndedLine(refund("waiting", 0), terms)).toBe(
            `${s} About $0.98 goes back to the paying wallet, usually within 10 minutes of the end.`,
        );
        expect(statusEndedLine(testAccount({ state: "closing" }), terms)).toBe(
            `${s} About $0.98 goes back to the paying wallet, usually within 10 minutes of the end.`,
        );
        expect(
            statusEndedLine(
                testAccount({ state: "closing", leftMicros: 4_000, heldMicros: 0 }),
                terms,
            ),
        ).toBe(`${s} About $0.004 is under the $0.01 refund minimum and stays with Bugnet.`);
        expect(statusEndedLine(refund("pending"), terms)).toBe(
            `${s} Refund: $0.98 pending, usually within 10 minutes of the end to the paying wallet.`,
        );
        expect(statusEndedLine(refund("sent"), terms)).toBe(
            `${s} Refund: $0.98 sent to the paying wallet.`,
        );
        expect(statusEndedLine(refund("confirmed"), terms)).toBe(
            `${s} Refund: $0.98 confirmed to the paying wallet.`,
        );
        expect(statusEndedLine(refund("confirmed", 0, 0), terms)).toBe(
            `${s} Nothing was left to refund.`,
        );
        expect(statusEndedLine(refund("manual"), terms)).toBe(
            `${s} Refund: $0.98 is delayed and Bugnet is sending it by hand.`,
        );
        expect(statusEndedLine(refund("kept", 0, 5_000), terms)).toBe(
            `${s} $0.005 was under the $0.01 refund minimum and stayed with Bugnet.`,
        );
    });

    it("chooses the stop line by the terms' refund minimum", () => {
        expect(stopMoneyLine(testAccount(), terms)).toBe(
            "x402: $0.02 spent in 2 paid calls. About $0.98 goes back to the paying wallet, usually within 10 minutes.",
        );
        expect(stopMoneyLine(testAccount({ leftMicros: 4_000, heldMicros: 0 }), terms)).toBe(
            "x402: $0.02 spent in 2 paid calls. About $0.004 is under the $0.01 refund minimum and stays with Bugnet.",
        );
        expect(
            stopMoneyLine(
                testAccount({ leftMicros: 15_000, heldMicros: 0 }),
                testTerms({ refundMinMicros: 20_000 }),
            ),
        ).toMatch(/is under the \$0\.02 refund minimum/);
    });

    it("names the stop files and the hosts of the copy-back reminder", () => {
        expect(stopFilesLine(["/root/src/app/main.py", "/root/src/app/.env"])).toBe(
            "Files that call x402 services: /root/src/app/main.py, /root/src/app/.env. They work only inside Bugnet, so ask the user before copying them into their own files.",
        );
        expect(copyBackLine(["agent402.tools", "api.example.com"])).toBe(
            "Bugnet: this sandbox has code pointed at agent402.tools, api.example.com, which works only inside Bugnet. Ask the user before copying those edits into their own files.",
        );
    });
});
