import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
    BootstrapState,
    PlacementState,
    type PackageOption,
    type Placement,
    type X402ServiceInfo,
} from "../gen/bugnet/router/v1/router_pb.ts";
import { extensionsFor } from "./extend.ts";
import { verifyQuote, QuoteError, type QuoteClaims, type QuotedPackage } from "../quote.ts";
import {
    GatewayError,
    errorReason,
    fromRouter,
    reasonCode,
    reasonOf,
    waitMargin,
} from "../router.ts";
import {
    paymentMemo,
    type OrderRequest,
    type OrderResult,
    type PaidOrder,
    type RefusedOrder,
    type X402Account,
    type X402ServicePin,
    type X402Terms,
} from "../payments/port.ts";
import { indexOf } from "../x402/index.ts";
import { serviceLine, toMicros, usdText } from "../x402/lines.ts";
import {
    allowanceDescription,
    checkAddOf,
    newServiceCount,
    orderSetup,
    planLines,
    probeLines,
    servicesAfter,
    spendUnderPrice,
    type PlannedService,
} from "../x402/pins.ts";
import {
    allowanceEndedText,
    buildView,
    paidRetryUnreachable,
    paymentUnconfirmed,
    paymentsRefusal,
    servicesApplyingText,
    startNeedsSecretsText,
    startTotalText,
    x402Fail,
    x402Lines,
    x402Text,
    type X402View,
} from "../x402/render.ts";
import {
    checkServices,
    enableRequestId,
    enableServices,
    hasOwnReason,
    viewChanges,
    x402RouterError,
} from "../x402/router.ts";
import { readTerms } from "../x402/terms.ts";
import {
    approvalMeta,
    Budget,
    type Deps,
    failure,
    handleInput,
    handleTag,
    ok,
    type Register,
    sshAliasPattern,
    timeLeft,
    toolUseId,
    usd,
    waitMs,
    withProgress,
} from "./common.ts";
import {
    abandonedFields,
    claimAsked,
    claimInput,
    allowanceOrderError,
    paidRetry,
    paymentRequiredResult,
    refusalError,
    retryCall,
    type PaidRetry,
} from "./orders.ts";
import { describeSize, limitQuotes, quoted, unavailableWords } from "./quote.ts";
import { fetchAfterStart, sentence, sourceView, unplacedNote, type SourceView } from "./source.ts";

export { describeSize } from "./quote.ts";

export const stateName: Record<PlacementState, string> = {
    [PlacementState.UNSPECIFIED]: "unknown",
    [PlacementState.PLACING]: "starting",
    [PlacementState.READY]: "ready",
    [PlacementState.TERMINATING]: "stopping",
    [PlacementState.TERMINATED]: "ended",
    [PlacementState.FAILED]: "failed",
};

// The codes in Placement.termination_reason, in plain words that never name a provider
const terminationWords: Record<string, string> = {
    stop: "stopped with bugnet_stop",
    deadline: "ended at its deadline",
    abuse: "ended for a terms violation",
    control_lost: "ended because Bugnet lost contact with it",
    provider_failed: "ended by the provider",
    sandbox_exited: "the sandbox stopped from inside, for example by a shutdown or a crash",
    wallet_blocked: "ended because the paying wallet is blocked",
    operator: "ended by a Bugnet operator",
};

export function terminationText(code: string): string {
    return Object.hasOwn(terminationWords, code) ? (terminationWords[code] as string) : "ended";
}

const aliasShape = sshAliasPattern;
// A code such as no_candidate, never free text that could carry a provider's words
const failureCode = /^[a-z0-9_]{1,64}$/i;

function ended(s: PlacementState): boolean {
    return s === PlacementState.TERMINATED || s === PlacementState.FAILED;
}

interface PlacementView {
    state: string;
    packageId: string;
    deadline: string | null;
    timeLeft: string;
    endedAt?: string;
    failureReason?: string;
    refundable?: boolean;
    terminationReason?: string;
    sshAlias?: string;
    source?: SourceView;
    [key: string]: unknown;
}

function placementView(p: Placement | undefined, now: number): PlacementView {
    const deadline = p?.deadline ? timestampDate(p.deadline) : undefined;
    const source = sourceView(p?.bootstrap);
    return {
        state: p ? stateName[p.state] : "unknown",
        packageId: p?.packageId ?? "",
        deadline: deadline?.toISOString() ?? null,
        timeLeft: p && ended(p.state) ? "none, the sandbox has ended" : timeLeft(deadline, now),
        ...(p?.endedAt ? { endedAt: timestampDate(p.endedAt).toISOString() } : {}),
        ...(p && failureCode.test(p.failureReason) ? { failureReason: p.failureReason } : {}),
        ...(p?.state === PlacementState.FAILED ? { refundable: p.refundable } : {}),
        ...(p?.terminationReason
            ? { terminationReason: terminationText(p.terminationReason) }
            : {}),
        // Names the key file for bugnet_ssh before the key exists
        ...(p && !ended(p.state) && aliasShape.test(p.sshAlias) ? { sshAlias: p.sshAlias } : {}),
        ...(source ? { source } : {}),
    };
}

// Never past the deadline, since the sweep that ends a sandbox there may run a little late
function usedSeconds(p: Placement | undefined, now: number): number | undefined {
    if (!p?.readyAt) return 0;
    // A router from before ended_at cannot say when it ended, and now would keep growing
    if (!p.endedAt && ended(p.state)) return undefined;
    const end = p.endedAt ? timestampDate(p.endedAt).getTime() : now;
    const deadline = p.deadline ? timestampDate(p.deadline).getTime() : Infinity;
    const ms = Math.min(end, deadline) - timestampDate(p.readyAt).getTime();
    return Math.max(0, Math.round(ms / 1000));
}

function usedText(used: number | undefined): string {
    return used === undefined ? "" : `, used for about ${used} s`;
}

function sshLine(alias: string | undefined): string {
    if (!alias) return "";
    return (
        `SSH alias ${alias}. bugnet_ssh takes the public key of ` +
        `ssh-keygen -t ed25519 -N "" -f ~/.ssh/bugnet_${alias}.`
    );
}

const startInput = z
    .object({
        quoteId: z.string().max(200).describe("quoteId from bugnet_quote or bugnet_assess"),
        packageId: z.string().max(100),
        confirmPriceUsd: z
            .string()
            .max(20)
            .describe(
                "The package price you told the user, such as 0.05, shown in the approval prompt",
            ),
        orderId: z.string().max(200).optional().describe("orderId from an earlier payment step"),
        claim: claimInput.optional().describe("claim from the payment step, sent with its orderId"),
        payment: z
            .unknown()
            .optional()
            .describe("x402 PaymentPayload for this order if your wallet tool produced one"),
        x402: z
            .object({
                allowanceUsd: usdText.describe("Allowance for x402 services, 0.10 to 5.00"),
                services: z.array(serviceLine).max(5).optional(),
                allowUnlisted: z.boolean().optional(),
                spendPerMinuteUsd: usdText.optional(),
            })
            .optional()
            .describe(
                "Only when a missing key is already known and the user agreed to the allowance, each service and the total. confirmPriceUsd then includes the package, the allowance and a one-time $0.003 fee",
            ),
    })
    .refine((a) => a.claim === undefined || a.orderId !== undefined, {
        message: "claim goes with the orderId of its payment step",
        path: ["claim"],
    });

type StartArgs = z.infer<typeof startInput>;
type StartX402Args = NonNullable<StartArgs["x402"]>;

const startTool = "bugnet_start";

// What CreatePlacement and a first look at the sandbox need after the payment
export const placeReserveMs = 12_000;
// EnableX402 before the ready wait and the probes before payment need 5 s more
export const x402PlaceReserveMs = 17_000;
// The repo fetch's own cap, left out when less than this remains
const fetchMs = 5_000;

// After the payment, a failure that does not prove the router recorded nothing leaves it open
function afterPayment(err: GatewayError, orderId: string, retry: string | null): GatewayError {
    const unsure = ["timeout", "unavailable", "internal"].includes(err.kind);
    if (!unsure) return err;
    return new GatewayError(
        err.kind,
        `${err.message}. Order ${orderId} was paid and may still start a sandbox, so tell the ` +
            "user before starting another" +
            // A repeat redeem within the order token's 10 minutes returns the same token
            (retry ? `. Calling ${retry} within 10 minutes returns its handle` : ""),
        err.retryAfterMs,
        err.reason,
    );
}

async function waitReady(
    deps: Deps,
    handle: string,
    first: Placement | undefined,
    budgetMs: number,
    signal: AbortSignal,
): Promise<Placement | undefined> {
    let p = first;
    const until = deps.now() + budgetMs;
    while (p && p.state === PlacementState.PLACING && deps.now() < until) {
        const wait = Math.min(until - deps.now(), 25_000);
        const res = await deps.router.getPlacement(
            { handle, waitMs: wait, knownState: PlacementState.PLACING },
            { signal, timeoutMs: wait + waitMargin },
        );
        p = res.placement;
    }
    return p;
}

function refusal(packageId: string, o: PackageOption, open?: string[]): GatewayError {
    const why = unavailableWords(o.unavailableReason);
    const others = open && open.length > 0 ? `. The packages open now are ${open.join(", ")}` : "";
    return new GatewayError("invalid", `package ${packageId} is ${why}${others}`);
}

// Routers before PricePackage answer Unimplemented, and Estimate still prices the package for them
async function priceForStart(
    deps: Deps,
    packageId: string,
    claims: QuoteClaims,
    timeoutMs: () => number,
): Promise<PackageOption> {
    const requirements = claims.requirements;
    let option: PackageOption | undefined;
    try {
        const res = await deps.router.pricePackage(
            { packageId, requirements },
            { timeoutMs: timeoutMs() },
        );
        option = res.option;
    } catch (e) {
        if (!(e instanceof ConnectError)) throw e;
        const reason = errorReason(e);
        if (e.code === Code.InvalidArgument && reason === "NOT_START_PACKAGE") {
            throw new GatewayError(
                "invalid",
                `package ${packageId} only extends a running sandbox with bugnet_extend, a start ` +
                    "takes a package bugnet_quote lists",
            );
        }
        if (e.code === Code.InvalidArgument && (reason === null || reason === "PACKAGE_UNKNOWN")) {
            throw new GatewayError(
                "invalid",
                `package ${packageId} is not on offer, bugnet_quote lists the packages`,
            );
        }
        if (e.code !== Code.Unimplemented) throw e;
        const est = await deps.router.estimate({ requirements }, { timeoutMs: timeoutMs() });
        option = est.options.find((o) => o.packageId === packageId);
        if (option && !option.available) {
            const open = est.options.filter((o) => o.available).map((o) => o.packageId);
            throw refusal(packageId, option, open);
        }
    }
    if (!option) {
        throw new GatewayError(
            "invalid",
            `package ${packageId} is not on offer, bugnet_quote lists the packages`,
        );
    }
    if (!option.available) throw refusal(packageId, option);
    return option;
}

// Spec 5.4 step 1, all before the package is priced, so a refusal here charged nothing
async function startTerms(
    deps: Deps,
    claims: QuoteClaims,
    budget: Budget,
    payment: unknown,
): Promise<X402Terms> {
    if (!deps.config.x402.enabled) throw x402Fail("switchedOff", "start");
    limitQuotes(deps, "start");
    const terms = await readTerms(deps, budget.signal(3_000));
    if (terms === null) {
        throw payment !== undefined
            ? paymentUnconfirmed("start", startTool, paymentMemo(payment))
            : x402Fail("unreachable", "start");
    }
    if (!terms.enabled) throw x402Fail("switchedOff", "start");
    if (!terms.startWithX402) throw x402Fail("startUnavailable", "start");
    if (!claims.requirements.secrets) throw new GatewayError("invalid", startNeedsSecretsText);
    return terms;
}

// What a first call with x402 checked and probed before Payments charges anything
interface StartPlan {
    pkg: QuotedPackage;
    terms: X402Terms;
    allowance: number;
    total: number;
    planned: PlannedService[];
    pins: X402ServicePin[];
    spend: number | undefined;
    limit: number;
}

// Spec 5.4 steps 2 and 3, every amount and limit first, then the probes and CheckX402 at once
async function planStart(
    deps: Deps,
    x: StartX402Args,
    confirmPriceUsd: string,
    pkg: QuotedPackage,
    terms: X402Terms,
    budget: Budget,
): Promise<StartPlan> {
    // The input check holds it to a dollar amount
    const allowance = toMicros(x.allowanceUsd) as number;
    const total = pkg.priceMicros + terms.sessionFeeMicros + allowance;
    if (toMicros(confirmPriceUsd) !== total) {
        throw new GatewayError(
            "invalid",
            startTotalText(pkg.id, pkg.priceMicros, allowance, terms),
        );
    }
    const planned = planLines(deps, {
        what: "start",
        lines: x.services ?? [],
        disable: [],
        allowUnlisted: x.allowUnlisted === true,
        account: null,
        terms,
    });
    if (allowance < terms.minAllowanceMicros) throw x402Fail("amountTooSmall", "start", { terms });
    if (allowance > terms.maxAllowancePerSandboxMicros) {
        throw x402Fail("overCeiling", "start", {
            terms,
            amountMicros: allowance,
            roomMicros: terms.maxAllowancePerSandboxMicros,
        });
    }
    if (newServiceCount(planned) > terms.maxNewServicesPerOrder) {
        throw x402Fail("tooManyNew", "start", { terms });
    }
    if (servicesAfter(null, planned, []) > terms.maxServices) {
        throw x402Fail("tooManyServices", "start", { terms });
    }
    const spend =
        x.spendPerMinuteUsd === undefined ? undefined : (toMicros(x.spendPerMinuteUsd) as number);
    if (
        spend !== undefined &&
        (spend < terms.minSpendPerMinuteMicros || spend > terms.maxSpendPerMinuteMicros)
    ) {
        throw x402Fail("spendRange", "start", { terms });
    }
    const limit = spend ?? terms.defaultSpendPerMinuteMicros;
    const under = spendUnderPrice(limit, null, planned, []);
    if (under !== null) throw x402Fail("spendUnderMax", "start", { limitMicros: limit, ...under });
    const hosts = [...new Set(planned.map((p) => p.parts.host))];
    const cap = budget.signal(3_000);
    const [pins] = await Promise.all([
        probeLines(deps, planned, terms, "start", cap),
        checkServices(deps, { handle: "", add: checkAddOf(planned), disable: [] }, cap).catch(
            (e: unknown) => {
                throw x402RouterError(e, "start", hosts, terms.maxServices);
            },
        ),
    ]);
    return { pkg, terms, allowance, total, planned, pins, spend, limit };
}

// A first call's refusal, worded with the total and services this call asked for
function startRefusal(
    r: RefusedOrder,
    plan: StartPlan,
    args: StartArgs,
    payment: unknown,
): GatewayError {
    const { pkg, terms } = plan;
    if (r.reason === "fee_mismatch") {
        return new GatewayError(
            "invalid",
            startTotalText(pkg.id, pkg.priceMicros, plan.allowance, terms),
        );
    }
    if (r.reason === "router_unavailable" && payment !== undefined) {
        return paymentUnconfirmed("start", startTool, r.orderId ?? paymentMemo(payment));
    }
    return paymentsRefusal(r, {
        what: "start",
        tool: startTool,
        terms,
        feeDue: true,
        amountMicros: plan.allowance,
        chargedMicros: plan.total,
        orderId: args.orderId ?? null,
        planned: plan.planned,
        account: null,
        retry: { quoteId: args.quoteId, ...(payment !== undefined ? { payment: true } : {}) },
        spendPerMinuteMicros: plan.limit,
        disable: [],
    });
}

// Once money may have moved the answer names the order, chosen by what the call sent
function orderLost(
    e: unknown,
    args: StartArgs,
    retried: PaidRetry | null,
    byClaim: boolean,
    payment: unknown,
): unknown {
    if (byClaim) {
        const w = { claim: args.claim as string };
        return paidRetryUnreachable("start", startTool, args.orderId as string, w);
    }
    if (retried) {
        return paidRetryUnreachable("start", startTool, retried.orderId, { payment: true });
    }
    if (payment !== undefined) {
        // With [x402] off an orderId beside a payment makes a first call for that order
        const id = paymentMemo(payment) ?? args.orderId ?? null;
        return paymentUnconfirmed("start", startTool, id);
    }
    return args.x402 ? x402Fail("unreachable", "start") : e;
}

// Spec 5.3 names no amount for a paid retry, whose confirmPriceUsd is never checked
function paidStartRefusal(r: RefusedOrder, orderId: string): GatewayError | null {
    if (r.refundPending !== undefined) {
        return x402Fail("paidRefused", "start", {
            reason: r.reason,
            refundPending: r.refundPending,
            orderId: r.orderId ?? orderId,
        });
    }
    if (r.charged === false) {
        return x402Fail(r.reason === "x402_paused" ? "paused" : "switchedOff", "start");
    }
    return null;
}

interface StartEnable {
    // Null when EnableX402 failed or was skipped
    infos: X402ServiceInfo[] | null;
    terms: X402Terms | null;
    // NOT_READY under its own code, so the new sandbox already ended
    ended: boolean;
}

// Spec 5.4 step 6, a sandbox ready inside CreatePlacement would overrun a wait for the services
async function enableAtStart(
    deps: Deps,
    ctx: ServerContext,
    orderId: string,
    account: X402Account,
    handle: string,
    budget: Budget,
): Promise<StartEnable> {
    if (budget.left() < 1_000) return { infos: null, terms: null, ended: false };
    let ended = false;
    const [infos, terms] = await Promise.all([
        enableServices(
            deps,
            {
                handle,
                ...viewChanges(account),
                requestId: enableRequestId(ctx, ["x402-start", orderId]),
                waitActive: false,
            },
            budget.signal(5_000),
        ).catch((e: unknown) => {
            deps.log.warn("x402 enable failed", {
                handle: handleTag(handle),
                orderId,
                reason: reasonCode(reasonOf(e) ?? ""),
            });
            ended = hasOwnReason(e, "NOT_READY");
            return null;
        }),
        readTerms(deps, budget.signal(3_000)),
    ]);
    return { infos, terms, ended };
}

// The lines of spec 5.3 for a paid start, or the line that says how it ends without them
function startX402Part(
    deps: Deps,
    order: PaidOrder,
    account: X402Account,
    e: StartEnable,
    failed: boolean,
): { lines: string[]; view: X402View | null } {
    const amountMicros = order.allowanceMicros ?? 0;
    // Spec 7.10 closes the account on a failed placement just as on an ended one
    if (e.ended || failed) return { lines: [`${allowanceEndedText(amountMicros)}.`], view: null };
    if (e.terms === null) {
        // Only a failed or skipped EnableX402 leaves the services for bugnet_status to finish
        const line =
            e.infos !== null
                ? servicesApplyingText
                : x402Text.paidNotEnabled("x402", { amountMicros });
        return { lines: [`${line}.`], view: null };
    }
    const view = buildView({
        account,
        feeDue: false,
        router: e.infos,
        refusals: [],
        terms: e.terms,
        index: indexOf(deps),
    });
    const lines = x402Lines(view, {
        firstUse: order.firstUse === true,
        terms: e.terms,
        notEnabled: e.infos === null,
    });
    return { lines, view };
}

export interface StartPaidOptions {
    retry: string | null;
}

// Starts the sandbox a paid order pays for, and waits for it to come up
export async function startPaid(
    deps: Deps,
    ctx: ServerContext,
    claims: QuoteClaims,
    order: PaidOrder,
    budget: Budget,
    opts: StartPaidOptions,
): Promise<CallToolResult> {
    let created;
    try {
        created = await deps.router.createPlacement(
            {
                orderToken: order.orderToken,
                requirements: claims.requirements,
                estimateId: claims.estimateId ?? "",
            },
            { timeoutMs: Math.max(budget.left(), placeReserveMs) },
        );
    } catch (e) {
        const err = fromRouter(e, "start");
        // Only these codes mean the router recorded nothing, so Payments refunds it
        const outright =
            e instanceof ConnectError &&
            (e.code === Code.PermissionDenied || e.code === Code.InvalidArgument);
        if (outright) {
            await deps.payments
                .abandon(order.orderId, err.kind, budget.lastSignal(10_000))
                .catch((x) => deps.log.error("abandon failed", { err: String(x) }));
            throw new GatewayError(
                err.kind,
                err.message,
                err.retryAfterMs,
                err.reason,
                abandonedFields(order.orderId),
            );
        }
        throw afterPayment(err, order.orderId, opts.retry);
    }
    const handle = created.handle;
    const account = order.x402;
    const enabled = account
        ? await enableAtStart(deps, ctx, order.orderId, account, handle, budget)
        : null;
    const keep = claims.github ? fetchMs + 1_000 : 0;
    const waitBudget = Math.min(25_000, budget.left() - keep);
    // Past the deadline or on a lost wait the handle still goes back as starting
    const p = await withProgress(ctx, "starting the sandbox", (signal) => {
        const cut = AbortSignal.timeout(Math.max(1, waitBudget + 3_000));
        const both = AbortSignal.any([signal, cut]);
        return waitReady(deps, handle, created.placement, waitBudget, both);
    }).catch(() => {
        deps.log.warn("wait for ready failed", { handle: handleTag(handle) });
        return created.placement;
    });
    deps.log.info("placement started", {
        handle: handleTag(handle),
        state: p ? stateName[p.state] : "unknown",
    });
    const ready = p?.state === PlacementState.READY;
    const view = placementView(p, deps.now());
    if (ready && claims.github && budget.left() >= fetchMs) {
        view.source = await fetchAfterStart(deps, handle, fetchMs);
    } else if (claims.githubUnplaced) {
        view.source = { state: "not_fetched", note: unplacedNote };
    }
    const meta =
        order.paymentResponse !== undefined
            ? { "x402/payment-response": order.paymentResponse }
            : undefined;
    const failed = p?.state === PlacementState.FAILED;
    const x402 = account && enabled ? startX402Part(deps, order, account, enabled, failed) : null;
    const text = [
        `Sandbox ${view.state}. handle: ${handle}`,
        ready ? `Time left: ${view.timeLeft} (deadline ${view.deadline}).` : "",
        p?.state === PlacementState.PLACING
            ? "Still starting, call bugnet_status with the handle and waitSeconds 25."
            : "",
        p?.state === PlacementState.FAILED
            ? `It failed to start${p.refundable ? ", the payment will be refunded" : ""}.`
            : "",
        view.source ? sentence(view.source.note) : "",
        sshLine(view.sshAlias),
        ...(x402?.lines ?? []),
        "Keep the handle, it is the only key to this sandbox. Commands run as root " +
            "or as a user with passwordless sudo: use $HOME, prefix system changes with sudo.",
        p?.state === PlacementState.FAILED
            ? ""
            : "When the work is done and its results are read, call bugnet_stop with " +
              "the handle, so the sandbox does not keep running until its deadline.",
    ]
        .filter(Boolean)
        .join("\n");
    return ok(
        text,
        { handle, orderId: order.orderId, ...view, ...(x402?.view ? { x402: x402.view } : {}) },
        meta,
    );
}

export const registerSandboxTools: Register = (server, deps) => {
    server.registerTool(
        "bugnet_start",
        {
            title: "Start a paid Bugnet sandbox",
            description:
                "Starts a cloud sandbox from a quote and charges the package price in USDC. " +
                "Only call it after the user agreed to the price. Returns the sandbox handle, " +
                "the only key to the sandbox, or a payment step to complete first. When the " +
                "quote named a GitHub repo, the result says where the repo is or how to get it. " +
                "With x402, the price the user approves includes the allowance and a one-time " +
                "$0.003 fee, and services listed there are enabled as soon as the sandbox is " +
                "ready.",
            inputSchema: startInput,
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: true,
            },
            _meta: approvalMeta(deps),
        },
        async (args, ctx) => {
            try {
                const payment = ctx.mcpReq._meta?.["x402/payment"] ?? args.payment;
                const retried = paidRetry(args, payment, deps.config.x402.enabled);
                const key = toolUseId(ctx);
                let claims: QuoteClaims;
                try {
                    claims = verifyQuote(deps.config.secrets.quoteKey, args.quoteId, deps.now(), {
                        allowExpired: retried !== null,
                    });
                } catch (e) {
                    if (!(e instanceof QuoteError)) throw e;
                    const keep = args.orderId
                        ? `. Keep orderId "${args.orderId}" ` +
                          (args.claim ? `and claim "${args.claim}" ` : "") +
                          "on the next bugnet_start, so the order is not paid twice"
                        : "";
                    throw new GatewayError("invalid", e.message + keep);
                }
                const budget = new Budget(deps);
                const reserve = args.x402 ? x402PlaceReserveMs : placeReserveMs;
                let request: OrderRequest;
                let plan: StartPlan | null = null;
                if (retried) {
                    // The order holds its own terms, so the price is not asked again
                    request = {
                        ...retried,
                        ...(key ? { idempotencyKey: key } : {}),
                    };
                } else {
                    const terms = args.x402
                        ? await startTerms(deps, claims, budget, payment)
                        : null;
                    const pkg = quoted(
                        await priceForStart(deps, args.packageId, claims, () =>
                            budget.ms(15_000, reserve),
                        ),
                    );
                    if (args.x402 && terms) {
                        plan = await planStart(
                            deps,
                            args.x402,
                            args.confirmPriceUsd,
                            pkg,
                            terms,
                            budget,
                        );
                    } else {
                        const priced = Number.parseFloat(args.confirmPriceUsd.replace(/^\$/, ""));
                        if (
                            !Number.isFinite(priced) ||
                            Math.abs(priced * 1e6 - pkg.priceMicros) > 0.5
                        ) {
                            throw new GatewayError(
                                "invalid",
                                `${args.packageId} costs ${usd(pkg.priceMicros)}, tell the user ` +
                                    "that price and pass it as confirmPriceUsd",
                            );
                        }
                    }
                    if (budget.left() < reserve + 5_000) {
                        throw new GatewayError(
                            "timeout",
                            "start: Bugnet answered slowly, so nothing was charged. Calling " +
                                "bugnet_start again starts it",
                        );
                    }
                    const named = [`Bugnet sandbox ${describeSize(pkg)}`, `${pkg.minutes} min`];
                    if (plan) {
                        const fee = plan.terms.sessionFeeMicros;
                        named.push(allowanceDescription(plan.allowance, fee, plan.pins));
                    }
                    // A claim never goes with a payment, which Payments settles before the claim
                    request = {
                        kind: "start",
                        packageId: pkg.id,
                        amountMicros: plan ? plan.total : pkg.priceMicros,
                        description: named.join(", "),
                        ...(plan
                            ? {
                                  allowanceMicros: plan.allowance,
                                  feeMicros: plan.terms.sessionFeeMicros,
                                  x402: orderSetup(plan.pins, [], plan.spend),
                              }
                            : {}),
                        ...(args.orderId ? { orderId: args.orderId } : {}),
                        ...(payment !== undefined ? { payment } : {}),
                        ...(key ? { idempotencyKey: key } : {}),
                    };
                }
                let byClaim = retried?.claim !== undefined;
                const ask = async (req: OrderRequest): Promise<OrderResult> => {
                    try {
                        return await deps.payments.order(req, budget.signal(30_000, reserve));
                    } catch (e) {
                        throw orderLost(e, args, retried, byClaim, payment);
                    }
                };
                let order = await ask(request);
                if (claimAsked(order, args, payment)) {
                    // Asking with the claim alone moves no money
                    byClaim = true;
                    order = await ask({
                        orderId: args.orderId,
                        claim: args.claim,
                        ...(key ? { idempotencyKey: key } : {}),
                    });
                }
                if (order.status === "payment_required") {
                    return paymentRequiredResult(order, {
                        tool: "bugnet_start",
                        ...(args.orderId ? { sentOrderId: args.orderId } : {}),
                        ...(args.claim ? { sentClaim: args.claim } : {}),
                        quoteId: args.quoteId,
                    });
                }
                if (order.status === "refused") {
                    if (plan) throw startRefusal(order, plan, args, payment);
                    const paid = retried ? paidStartRefusal(order, retried.orderId) : null;
                    if (paid) throw paid;
                    throw refusalError(order, "start", "bugnet_start", {
                        ...(args.orderId ? { sentOrderId: args.orderId } : {}),
                        paymentSent: payment !== undefined,
                    });
                }
                if (order.kind === "allowance") {
                    throw allowanceOrderError(
                        order,
                        "start",
                        byClaim
                            ? { claim: args.claim as string, handle: true }
                            : payment !== undefined
                              ? { payment: true }
                              : {},
                    );
                }
                if (order.kind !== "start") {
                    const next = retryCall(
                        "bugnet_extend",
                        order.orderId,
                        byClaim ? { claim: args.claim, handle: true } : { payment: true },
                    );
                    throw new GatewayError(
                        "invalid",
                        `start: order ${order.orderId} adds time to a sandbox, call ${next}`,
                        null,
                        null,
                        { orderId: order.orderId },
                    );
                }
                const retry = byClaim
                    ? retryCall("bugnet_start", order.orderId, { claim: args.claim })
                    : payment !== undefined
                      ? retryCall("bugnet_start", order.orderId, { payment: true })
                      : null;
                return await startPaid(deps, ctx, claims, order, budget, { retry });
            } catch (e) {
                return failure(e, "start");
            }
        },
    );

    server.registerTool(
        "bugnet_status",
        {
            title: "Bugnet sandbox status",
            description:
                "State, deadline, time left and extension prices of a sandbox, why it ended, " +
                "its SSH alias and where its repo is. Everything is deleted at the deadline, " +
                "so download results first, or extend with bugnet_extend once the user agrees. " +
                "waitSeconds waits for the state to change, for example while it is starting. " +
                "When a start left the repo's fetch pending, it starts that fetch.",
            inputSchema: z.object({
                handle: handleInput,
                waitSeconds: z.number().int().min(0).max(45).optional(),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, ctx) => {
            try {
                let p = (await deps.router.getPlacement({ handle: args.handle })).placement;
                const wait = waitMs(deps, args.waitSeconds ?? 0);
                if (p && wait > 0 && !ended(p.state)) {
                    const known = p.state;
                    p = await withProgress(ctx, "waiting for the sandbox", async (signal) => {
                        const res = await deps.router.getPlacement(
                            { handle: args.handle, waitMs: wait, knownState: known },
                            { signal, timeoutMs: wait + waitMargin },
                        );
                        return res.placement;
                    });
                }
                const used = usedSeconds(p, deps.now());
                const view = {
                    ...placementView(p, deps.now()),
                    ...(used !== undefined ? { usedSeconds: used } : {}),
                };
                const ready = p?.state === PlacementState.READY;
                // A start that saw the sandbox still starting left the fetch to this look
                if (ready && p?.bootstrap?.state === BootstrapState.PENDING) {
                    view.source = await fetchAfterStart(deps, args.handle, fetchMs);
                }
                const extensions = ready ? await extensionsFor(deps, args.handle) : [];
                const offer = extensions.filter((x) => x.available);
                const text = [
                    `Sandbox ${view.state}, package ${view.packageId}, time left ${view.timeLeft}` +
                        (view.deadline ? ` (deadline ${view.deadline})` : "") +
                        (view.failureReason ? `, reason ${view.failureReason}` : "") +
                        (p?.readyAt ? usedText(used) : "") +
                        ".",
                    view.terminationReason ? sentence(view.terminationReason) : "",
                    view.source && !(p && ended(p.state)) ? sentence(view.source.note) : "",
                    ready ? sshLine(view.sshAlias) : "",
                    offer.length > 0
                        ? "Extend with bugnet_extend: " +
                          offer
                              .map((x) => `${x.packageId} +${x.minutes} min ${x.priceUsd}`)
                              .join(", ")
                        : "",
                ]
                    .filter(Boolean)
                    .join("\n");
                return ok(text, { ...view, extensions });
            } catch (e) {
                return failure(e, "status");
            }
        },
    );

    server.registerTool(
        "bugnet_stop",
        {
            title: "Stop a Bugnet sandbox",
            description:
                "Destroys the sandbox and everything in it. Download what you need first. " +
                "Unused paid time is not refunded.",
            inputSchema: z.object({ handle: handleInput }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (args) => {
            try {
                const res = await deps.router.stopPlacement({ handle: args.handle });
                const p = res.placement;
                const used = usedSeconds(p, deps.now());
                const view = {
                    ...placementView(p, deps.now()),
                    ...(used !== undefined ? { usedSeconds: used } : {}),
                };
                return ok(`Sandbox ${view.state}${usedText(used)}.`, view);
            } catch (e) {
                return failure(e, "stop");
            }
        },
    );
};
