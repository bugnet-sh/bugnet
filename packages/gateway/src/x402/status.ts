import { Code, ConnectError } from "@connectrpc/connect";
import {
    JobState,
    PlacementState,
    X402ServiceState,
    type X402Refusal,
    type X402ServiceInfo,
} from "../gen/bugnet/router/v1/router_pb.ts";
import type { X402Account } from "../payments/port.ts";
import { reasonCode, reasonOf, type RouterClient } from "../router.ts";
import { TtlCache } from "../assess/cache.ts";
import { cleanText } from "../sanitize.ts";
import { Budget, handleHash, handleTag, hashKey, shellQuoted, type Deps } from "../tools/common.ts";
import { indexOf } from "./index.ts";
import {
    buildView,
    statusEndedLine,
    statusLines,
    stopMoneyLine,
    totalsUnavailable,
    type X402View,
} from "./render.ts";
import {
    enableServices,
    hasOwnReason,
    listServices,
    pinToServiceSpec,
    x402RefusalTarget,
} from "./router.ts";
import { readTerms } from "./terms.ts";

export interface StatusPart {
    lines: string[];
    view: X402View | null;
}

const unavailable: StatusPart = { lines: [totalsUnavailable], view: null };
const nothing: StatusPart = { lines: [], view: null };

// A port that ignores its signal must not hold a tool's answer
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            work.catch(() => {});
            return;
        }
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

// Spec 6.3 gives each per-service reason one Connect code
const perServiceCode: Readonly<Record<string, Code>> = {
    HOST_REFUSED: Code.InvalidArgument,
    PREFIX_REFUSED: Code.InvalidArgument,
    SERVICE_DUPLICATE: Code.InvalidArgument,
    METHOD_REFUSED: Code.InvalidArgument,
    PRICE_REFUSED: Code.InvalidArgument,
    PAYTO_REFUSED: Code.InvalidArgument,
    HOST_NOT_ALLOWED: Code.FailedPrecondition,
    HOST_IN_USE: Code.FailedPrecondition,
};

function perServiceReason(err: unknown): string | null {
    const reason = reasonOf(err);
    if (reason === null || !(err instanceof ConnectError)) return null;
    return Object.hasOwn(perServiceCode, reason) && perServiceCode[reason] === err.code
        ? reason
        : null;
}

const hostPattern = /^[a-z0-9.-]{1,253}$/;

function hostsOf(rows: readonly X402ServiceInfo[]): string[] {
    const hosts = rows.map((r) => r.spec?.host ?? "").filter((h) => hostPattern.test(h));
    return [...new Set(hosts)];
}

const ended = (state: PlacementState) =>
    state === PlacementState.TERMINATED || state === PlacementState.FAILED;

interface Repair {
    rows: X402ServiceInfo[];
    enabling: string[];
    notEnabled: Map<string, string>;
}

async function repair(
    deps: Deps,
    handle: string,
    account: X402Account,
    listed: readonly X402ServiceInfo[],
    budget: Budget,
): Promise<Repair> {
    const out: Repair = { rows: [...listed], enabling: [], notEnabled: new Map() };
    const missing = account.services.filter((s) => {
        if (s.state !== "enabled") return false;
        const row = listed.find((r) => r.serviceId === s.serviceId);
        return row === undefined || row.state === X402ServiceState.DISABLED;
    });
    if (missing.length === 0 || budget.left() < 1_000) return out;
    const ids = missing.map((s) => s.serviceId);
    deps.log.info("x402 repair", { handle: handleTag(handle), services: ids });
    try {
        const signal = budget.signal(3_000);
        const answered = await untilAborted(
            enableServices(
                deps,
                {
                    handle,
                    add: missing.map(pinToServiceSpec),
                    disable: [],
                    requestId: hashKey(["x402-repair", ...ids]),
                    waitActive: false,
                },
                signal,
            ),
            signal,
        );
        out.enabling = [...new Set(missing.map((s) => s.host))];
        for (const row of answered) {
            const at = out.rows.findIndex((r) => r.serviceId === row.serviceId);
            if (at >= 0) out.rows[at] = row;
            else out.rows.push(row);
        }
    } catch (e) {
        const reason = hasOwnReason(e, "NOT_READY") ? null : perServiceReason(e);
        const target = x402RefusalTarget(e).serviceId;
        deps.log.warn("x402 repair refused", {
            handle: handleTag(handle),
            reason: reasonCode(reasonOf(e) ?? ""),
            ...(target !== null ? { serviceId: target } : {}),
        });
        if (reason !== null && target !== null && ids.includes(target)) {
            out.notEnabled.set(target, reason);
        }
    }
    return out;
}

async function statusPart(
    deps: Deps,
    input: { handle: string; state: PlacementState; budget: Budget },
): Promise<StatusPart> {
    const { handle, state, budget } = input;
    if (budget.left() < 1_000) return unavailable;
    const signal = budget.signal(3_000);
    const [accountR, termsR, listR] = await Promise.allSettled([
        untilAborted(deps.payments.x402Account(handleHash(handle), signal), signal),
        untilAborted(readTerms(deps, signal), signal),
        untilAborted(listServices(deps, handle, signal), signal),
    ]);
    if (accountR.status === "rejected") return unavailable;
    const { x402: account, feeDue } = accountR.value;
    if (account === null || account.services.length === 0) return nothing;
    const terms = termsR.status === "fulfilled" ? termsR.value : null;
    if (terms === null) return unavailable;
    const done = ended(state) || account.state !== "open";
    const list = listR.status === "fulfilled" ? listR.value : null;
    if (list === null && !done) return unavailable;
    const fix =
        !done &&
        list !== null &&
        list.enabled &&
        (state === PlacementState.PLACING || state === PlacementState.READY)
            ? await repair(deps, handle, account, list.services, budget)
            : null;
    const rows = fix?.rows ?? list?.services ?? null;
    const refusals: readonly X402Refusal[] = list?.refusals ?? [];
    const view = buildView({
        account,
        feeDue,
        router: rows,
        refusals,
        terms,
        index: indexOf(deps),
        ...(fix !== null && fix.notEnabled.size > 0 ? { notEnabled: fix.notEnabled } : {}),
    });
    return {
        lines: done
            ? [statusEndedLine(account, terms)]
            : statusLines(view, { enabling: fix?.enabling ?? [] }),
        view,
    };
}

// Payments account and ListX402 at once under budget.signal(3_000), the repair, and the lines
export async function x402StatusPart(
    deps: Deps,
    input: { handle: string; state: PlacementState; budget: Budget },
): Promise<StatusPart> {
    try {
        return await statusPart(deps, input);
    } catch {
        deps.log.warn("x402 status failed", { handle: handleTag(input.handle) });
        return unavailable;
    }
}

// ListX402 before StopPlacement, null when it shows no services and failed when it errs
export async function stopServices(
    deps: Deps,
    handle: string,
): Promise<{ hosts: string[]; failed?: true } | null> {
    try {
        const r = await listServices(deps, handle, AbortSignal.timeout(3_000));
        return r.services.length === 0 ? null : { hosts: hostsOf(r.services) };
    } catch {
        deps.log.warn("x402 stop list failed", { handle: handleTag(handle) });
        return { hosts: [], failed: true };
    }
}

// The grep job under a 3 s cap, at most 5 cleaned paths cut to 120, [] on any failure
export async function stopFiles(
    deps: Deps,
    handle: string,
    hosts: readonly string[],
): Promise<string[]> {
    const words = [...hosts, "x402"].map((h) => `-e ${shellQuoted(h)}`).join(" ");
    try {
        const res = await deps.router.exec(
            {
                handle,
                argv: ["sh", "-c", `grep -rIlF --exclude-dir=.git ${words} "$HOME/src"`],
                cwd: "",
                env: {},
                idempotencyKey: hashKey(["x402-stop-files", handle]),
                waitMs: 2_500,
            },
            { timeoutMs: 3_000 },
        );
        if (res.state !== JobState.EXITED) return [];
        return new TextDecoder()
            .decode(res.stdoutTail)
            .split("\n")
            .map((l) => cleanText(l).trim().slice(0, 120))
            .filter((l) => l !== "")
            .slice(0, 5);
    } catch {
        return [];
    }
}

// After StopPlacement, the money line or totalsUnavailable
export async function stopMoney(deps: Deps, handle: string): Promise<string> {
    const signal = AbortSignal.timeout(3_000);
    try {
        const [answer, terms] = await Promise.all([
            untilAborted(deps.payments.x402Account(handleHash(handle), signal), signal),
            untilAborted(readTerms(deps, signal), signal),
        ]);
        if (terms === null) return totalsUnavailable;
        return answer.x402 === null ? "" : stopMoneyLine(answer.x402, terms);
    } catch {
        deps.log.warn("x402 stop money failed", { handle: handleTag(handle) });
        return totalsUnavailable;
    }
}

const copyBack = new WeakMap<RouterClient, TtlCache<string[]>>();

// Hosts of ACTIVE services, cached 30 s per handle, [] on failure
export async function activeX402Hosts(deps: Deps, handle: string): Promise<string[]> {
    if (!deps.config.x402.enabled) return [];
    let cache = copyBack.get(deps.router);
    if (!cache) {
        cache = new TtlCache<string[]>(30_000, 500, deps.now);
        copyBack.set(deps.router, cache);
    }
    const key = handleHash(handle);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    try {
        const r = await listServices(deps, handle, AbortSignal.timeout(3_000));
        const hosts = hostsOf(r.services.filter((s) => s.state === X402ServiceState.ACTIVE));
        cache.set(key, hosts);
        return hosts;
    } catch {
        return [];
    }
}
