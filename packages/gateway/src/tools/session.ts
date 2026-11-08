// Texts and fields for the spend, stop and summary link of the sandbox answers
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { PlacementState, type Placement } from "../gen/bugnet/router/v1/router_pb.ts";
import { sessionKeepMs, sessionLink, summaryLine, usd, whenText, type Deps } from "./common.ts";

// Under a minute in seconds, under an hour in minutes, otherwise in hours
export function usedLong(s: number): string {
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (s < 3600) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
    const h = Math.floor(m / 60);
    return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

// Zero or negative means the router could not say, so no total shows
export function paidOf(p: Placement | undefined): bigint {
    return p && p.paidMicros > 0n ? p.paidMicros : 0n;
}

// Pay lines for a start, an extension or a redeem, left out when the amount is unknown
export function paidLine(amountMicros: number | undefined, orderId: string, more: boolean): string {
    if (!amountMicros || amountMicros <= 0) return "";
    return (
        `Paid ${usd(amountMicros)} USDC${more ? " more" : ""} for this sandbox ` +
        `(order ${orderId}). Tell the user what it cost.`
    );
}

// Why a sandbox ended, for the ended line only
const causeWords: Record<string, string> = {
    deadline: "it reached its deadline",
    abuse: "it was ended for a terms violation",
    control_lost: "Bugnet lost contact with it",
    provider_failed: "its host failed",
    sandbox_exited: "it stopped from inside, for example by a shutdown or a crash",
    wallet_blocked: "the paying wallet is blocked",
    operator: "a Bugnet operator ended it",
};

// The start line of an x402 order, which splits the total into the allowance and the one-time fee
export function paidX402Line(
    amountMicros: number,
    allowanceMicros: number,
    feeMicros: number,
    orderId: string,
): string {
    const fee = feeMicros > 0 ? ` and ${usd(feeMicros)} a one-time fee` : "";
    return (
        `Paid ${usd(amountMicros)} USDC (order ${orderId}), of which ` +
        `${usd(allowanceMicros)} is the x402 allowance${fee}. Tell the user what it cost.`
    );
}

export interface EndedAnswer {
    lines: string[];
    fields: Record<string, unknown>;
}

// The plain stopped or ended lines and fields, or null when the router sent no ended_at
export function endedAnswer(
    deps: Deps,
    handle: string,
    p: Placement | undefined,
    used: number | undefined,
    reason: string,
    sandboxTime = false,
): EndedAnswer | null {
    if (!p?.endedAt || p.state !== PlacementState.TERMINATED || used === undefined) return null;
    const at = timestampDate(p.endedAt);
    const paid = paidOf(p);
    const total =
        paid > 0n
            ? ` ${sandboxTime ? "Sandbox time cost" : "It cost"} ${usd(paid)} USDC in total.`
            : "";
    const stopped = reason === "" || reason === "stop";
    const lead = stopped
        ? "The sandbox is stopped."
        : Object.hasOwn(causeWords, reason)
          ? `The sandbox has ended because ${causeWords[reason]}.`
          : "The sandbox has ended.";
    const tell = stopped ? "it is stopped" : "it has ended";
    const url = sessionLink(deps, p.sessionUrl, handle);
    return {
        lines: [
            `${lead} It ended at ${whenText(at)} after ${usedLong(used)} of use, and ` +
                `everything in it was deleted.${total} Tell the user ${tell}.`,
            ...(url ? [summaryLine(url, at)] : []),
        ],
        fields: {
            ...(paid > 0n ? { paidUsd: usd(paid) } : {}),
            ...(url
                ? {
                      sessionUrl: url,
                      sessionUntil: new Date(at.getTime() + sessionKeepMs).toISOString(),
                  }
                : {}),
        },
    };
}

// The line a start answer carries so the user knows where the summary will stay
export function startSummary(
    deps: Deps,
    handle: string,
    p: Placement | undefined,
): { line: string; fields: Record<string, unknown> } {
    const live = p?.state === PlacementState.READY || p?.state === PlacementState.PLACING;
    if (!p || !live) return { line: "", fields: {} };
    const url = sessionLink(deps, p.sessionUrl, handle);
    if (!url) return { line: "", fields: {} };
    return {
        line:
            `After this sandbox ends, its summary and logs stay at ${url} for 48 hours. ` +
            "Show this link to the user.",
        fields: { sessionUrl: url },
    };
}
