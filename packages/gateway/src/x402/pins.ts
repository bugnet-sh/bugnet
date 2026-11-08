import type {
    X402Account,
    X402AccountService,
    X402Listed,
    X402ServicePin,
    X402Setup,
    X402Terms,
} from "../payments/port.ts";
import { usd, type Deps } from "../tools/common.ts";
import { exactEntry, hostIndexed, indexOf, listedEntry, type IndexEntry } from "./index.ts";
import { findDuplicate, parseServiceLine, underSuffix, type ServiceLineParts } from "./lines.ts";
import { createProber, reasonWords } from "./probe.ts";
import { x402Fail } from "./render.ts";
import { toServiceSpec, type ServiceSpecInit, type X402What } from "./router.ts";
import { lineLimits } from "./terms.ts";

export type LineChange = "new" | "repin" | "reprice" | "reenable" | "same";

export interface PlannedService {
    parts: ServiceLineParts;
    // listedEntry with the line's payTo
    listed: X402Listed;
    // exactEntry, whatever its payTo
    indexEntry: IndexEntry | null;
    // The account's row with this id
    held: X402AccountService | null;
    change: LineChange;
}

export interface LinePlanInput {
    what: X402What;
    lines: readonly string[];
    disable: readonly string[];
    allowUnlisted: boolean;
    account: X402Account | null;
    terms: X402Terms;
}

function changeOf(parts: ServiceLineParts, held: X402AccountService | null): LineChange {
    if (held === null) return "new";
    if (held.payTo !== parts.payTo) return "repin";
    if (held.maxPriceMicros !== parts.maxMicros) return "reprice";
    return held.state === "disabled" ? "reenable" : "same";
}

// Every check runs over all lines before the next, so the first failing rule decides the refusal
export function planLines(deps: Deps, input: LinePlanInput): PlannedService[] {
    const { what, terms } = input;
    const limits = lineLimits(terms);
    const index = indexOf(deps);
    const parsed: ServiceLineParts[] = [];
    for (const line of input.lines) {
        const p = parseServiceLine(line, limits);
        if (p.ok) {
            parsed.push(p.parts);
            continue;
        }
        if (p.refusal === "max_above") throw x402Fail("maxAbove", what, { terms, line });
        if (p.refusal === "payee") {
            const words = reasonWords("payee_refused");
            throw x402Fail("probeFailed", what, { host: p.host ?? "", words });
        }
        throw x402Fail("malformed", what, { line });
    }
    const twice = findDuplicate(parsed, input.disable);
    if (twice !== null) throw x402Fail("duplicate", what, { line: twice.line });
    const planned = parsed.map((parts): PlannedService => {
        const held = input.account?.services.find((s) => s.serviceId === parts.serviceId) ?? null;
        const { method, host, prefix, payTo } = parts;
        return {
            parts,
            listed: listedEntry(index, method, host, prefix, payTo) ? "indexed" : "unlisted",
            indexEntry: exactEntry(index, method, host, prefix),
            held,
            change: changeOf(parts, held),
        };
    });
    for (const p of planned) {
        const heldSamePayee = p.held !== null && p.held.payTo === p.parts.payTo;
        if (p.listed === "unlisted" && !input.allowUnlisted && !heldSamePayee) {
            throw x402Fail("unlisted", what, { host: p.parts.host });
        }
    }
    const suffixes = deps.config.x402.shared_hosting_suffixes;
    for (const { parts } of planned) {
        if (underSuffix(parts.host, suffixes) && !hostIndexed(index, parts.host)) {
            const words = reasonWords("shared_hosting");
            throw x402Fail("probeFailed", what, { host: parts.host, words });
        }
    }
    return planned;
}

function changed(planned: readonly PlannedService[]): PlannedService[] {
    return planned.filter((p) => p.change !== "same");
}

export async function probeLines(
    deps: Deps,
    planned: readonly PlannedService[],
    terms: X402Terms,
    what: X402What,
    signal: AbortSignal,
): Promise<X402ServicePin[]> {
    const prober = createProber(deps);
    const probed = changed(planned);
    const probes = await Promise.all(
        probed.map((p) =>
            prober.probe(
                { method: p.parts.method, url: p.parts.url, indexMatch: p.indexEntry !== null },
                terms,
                signal,
            ),
        ),
    );
    return probed.map((p, i): X402ServicePin => {
        const probe = probes[i];
        const { parts } = p;
        const host = parts.host;
        if (probe === undefined) throw new Error("a probe answer is missing");
        if (!probe.ok) {
            throw x402Fail("probeFailed", what, { host, words: reasonWords(probe.failure) });
        }
        const livePayTo = probe.pinnedFrom === "probe" ? probe.payTo : p.indexEntry?.payTo;
        if (livePayTo !== parts.payTo) {
            throw x402Fail("payToChanged", what, {
                host,
                livePayTo: livePayTo ?? "",
                linePayTo: parts.payTo,
            });
        }
        if (probe.pinnedFrom === "probe" && probe.priceMicros > parts.maxMicros) {
            throw x402Fail("livePriceAbove", what, {
                host,
                liveMicros: probe.priceMicros,
                maxMicros: parts.maxMicros,
            });
        }
        return {
            serviceId: parts.serviceId,
            method: parts.method,
            host,
            prefix: parts.prefix,
            url: parts.url,
            maxPriceMicros: parts.maxMicros,
            payTo: parts.payTo,
            listed: p.listed,
            pinnedFrom: probe.pinnedFrom,
            probe: { at: probe.at, status: probe.status, accepted: probe.accepted },
        };
    });
}

export function checkAddOf(planned: readonly PlannedService[]): ServiceSpecInit[] {
    return changed(planned).map((p) => toServiceSpec(p.parts, p.listed === "indexed"));
}

export function newServiceCount(planned: readonly PlannedService[]): number {
    return planned.filter((p) => p.change === "new" || p.change === "repin").length;
}

// Founder decision F10, a minute limit under the top max left enabled never pays that service
export function spendUnderPrice(
    limitMicros: number,
    account: X402Account | null,
    planned: readonly PlannedService[],
    disable: readonly string[],
): { host: string; maxMicros: number } | null {
    const plannedIds = new Set(planned.map((p) => p.parts.serviceId));
    const candidates = [
        ...planned.map((p) => ({
            id: p.parts.serviceId,
            host: p.parts.host,
            max: p.parts.maxMicros,
        })),
        ...(account?.services ?? [])
            .filter((s) => s.state === "enabled" && !plannedIds.has(s.serviceId))
            .map((s) => ({ id: s.serviceId, host: s.host, max: s.maxPriceMicros })),
    ].filter((c) => !disable.includes(c.id));
    let top: (typeof candidates)[number] | null = null;
    for (const c of candidates) if (top === null || c.max > top.max) top = c;
    return top !== null && limitMicros < top.max ? { host: top.host, maxMicros: top.max } : null;
}

export function orderSetup(
    pins: readonly X402ServicePin[],
    disable: readonly string[],
    spendPerMinuteMicros: number | undefined,
): X402Setup {
    return {
        ...(pins.length > 0 ? { services: [...pins] } : {}),
        ...(disable.length > 0 ? { disable: [...disable] } : {}),
        ...(spendPerMinuteMicros !== undefined ? { spendPerMinuteMicros } : {}),
    };
}

// Services not disabled once the call applies, the count Payments holds against maxServices
export function servicesAfter(
    account: X402Account | null,
    planned: readonly PlannedService[],
    disable: readonly string[],
): number {
    const ids = new Set(
        (account?.services ?? []).filter((s) => s.state !== "disabled").map((s) => s.serviceId),
    );
    for (const p of planned) ids.add(p.parts.serviceId);
    for (const id of disable) ids.delete(id);
    return ids.size;
}

// Payments writes the wallet's text with every service, so ours stays within its 200 characters
export function allowanceDescription(amountMicros: number, feeMicros: number): string {
    const fee = feeMicros > 0 ? ` + ${usd(feeMicros)} fee` : "";
    return `x402 ${usd(amountMicros)}${fee}`;
}
