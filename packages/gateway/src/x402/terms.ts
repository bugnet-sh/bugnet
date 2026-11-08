import type { X402Terms } from "../payments/port.ts";
import type { Deps } from "../tools/common.ts";
import type { LineLimits } from "./lines.ts";

export const termsMaxAgeMs = 300_000;

type TermsDeps = Pick<Deps, "payments" | "now" | "log">;

interface TermsState {
    copy: { terms: X402Terms; at: number } | null;
    inflight: Promise<X402Terms | null> | null;
}

const states = new WeakMap<object, TermsState>();

function stateOf(deps: TermsDeps): TermsState {
    let s = states.get(deps.payments);
    if (!s) {
        s = { copy: null, inflight: null };
        states.set(deps.payments, s);
    }
    return s;
}

// The shared read has its own time limit, so no caller's signal can fail the others
function fetchTerms(deps: TermsDeps, state: TermsState) {
    if (state.inflight) return state.inflight;
    const read = Promise.resolve()
        .then(() => deps.payments.x402Terms(AbortSignal.timeout(10_000)))
        .then((terms) => {
            state.copy = { terms, at: deps.now() };
            return terms;
        })
        .catch((e: unknown) => {
            state.copy = null;
            deps.log.warn("x402 terms unavailable", { err: String(e) });
            return null;
        })
        .finally(() => {
            state.inflight = null;
        });
    state.inflight = read;
    return read;
}

// A copy younger than termsMaxAgeMs, else one read shared by all callers in flight, null on failure
export function readTerms(deps: TermsDeps, signal: AbortSignal): Promise<X402Terms | null> {
    const state = stateOf(deps);
    if (state.copy && deps.now() - state.copy.at < termsMaxAgeMs) {
        return Promise.resolve(state.copy.terms);
    }
    if (signal.aborted) return Promise.resolve(null);
    const read = fetchTerms(deps, state);
    return new Promise((resolve) => {
        const stop = () => resolve(null);
        signal.addEventListener("abort", stop, { once: true });
        void read.then((terms) => {
            signal.removeEventListener("abort", stop);
            resolve(terms);
        });
    });
}

// Reads at once and every termsMaxAgeMs with an unref'd timer, the returned function stops it
export function pollTerms(deps: TermsDeps): () => void {
    const state = stateOf(deps);
    const tick = () => void fetchTerms(deps, state);
    tick();
    const timer = setInterval(tick, termsMaxAgeMs);
    timer.unref();
    return () => clearInterval(timer);
}

export function lineLimits(t: X402Terms): LineLimits {
    return { maxPriceMicros: t.maxPricePerCallMicros, bugnetAddresses: t.bugnetAddresses };
}
