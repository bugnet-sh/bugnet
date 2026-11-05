import type { Category, Classification, Signal } from "./types.ts";

// Points at which a classification suggests Bugnet, tuned on the dev split
export const suggestPoints = 4;
const fullPoints = 8;

// Classification.score is points / fullPoints, so suggest is score >= threshold
export const threshold = suggestPoints / fullPoints;

export interface Hit {
    id: string;
    // Null for signals that only strengthen whatever the other signals point to
    category: Category | null;
    weight: number;
    evidence: string;
    subject?: string | undefined;
}

export const none: Classification = {
    suggest: false,
    score: 0,
    category: null,
    signals: [],
    subject: null,
};

// Ties go to the category whose local route is the most harmful
const priority: Category[] = [
    "untrusted_code",
    "risky_experiment",
    "local_ai_model",
    "environment",
    "heavy_compute",
];

export function hit(
    id: string,
    category: Category | null,
    weight: number,
    evidence: string,
    subject?: string,
): Hit {
    return {
        id,
        category,
        weight,
        evidence: evidence.trim().slice(0, 80),
        subject: subject?.slice(0, 120),
    };
}

function leading(hits: Hit[]): Category | null {
    const sums = new Map<Category, number>();
    for (const h of hits) {
        if (h.category && h.weight > 0)
            sums.set(h.category, (sums.get(h.category) ?? 0) + h.weight);
    }
    let best: Category | null = null;
    let bestSum = 0;
    for (const c of priority) {
        const s = sums.get(c) ?? 0;
        if (s > bestSum) {
            best = c;
            bestSum = s;
        }
    }
    return best;
}

// The strongest hit of the leading category, the only one whose subject a hint may name
function leadOf(hits: Hit[], category: Category | null): Hit | undefined {
    let best: Hit | undefined;
    for (const h of hits) {
        if (h.category !== category || h.weight <= 0) continue;
        const tieWithName = best && h.weight === best.weight && !best.subject && h.subject;
        if (!best || h.weight > best.weight || tieWithName) best = h;
    }
    return best;
}

function signals(hits: Hit[], category: Category, lead?: Hit): Signal[] {
    const rest = hits.filter((h) => h !== lead).sort((a, b) => b.weight - a.weight);
    return (lead ? [lead, ...rest] : rest).map((h) => ({
        id: h.id,
        category: h.category ?? category,
        weight: h.weight,
        evidence: h.evidence,
    }));
}

// Points are the weight sum unless the caller settled them, and live hits are those that counted
export function finish(hits: Hit[], points?: number, live: Hit[] = hits): Classification {
    if (hits.length === 0) return none;
    const pool = live.some((h) => h.category && h.weight > 0) ? live : hits;
    const positive = hits.some((h) => h.weight > 0);
    const category = leading(pool) ?? (positive ? "untrusted_code" : null);
    const total = points ?? hits.reduce((s, h) => s + h.weight, 0);
    const score = Math.max(0, Math.min(1, total / fullPoints));
    const lead = leadOf(pool, category);
    return {
        suggest: category !== null && total >= suggestPoints,
        score: Math.round(score * 1000) / 1000,
        category,
        signals: signals(hits, category ?? "untrusted_code", lead),
        subject: lead?.subject ?? null,
    };
}

// Abuse and LAN-only requests never get an offer, and the signal says why
export function refuse(hits: Hit[], policy: Hit): Classification {
    const category = leading(hits);
    const lead = leadOf(hits, category);
    return {
        suggest: false,
        score: 0,
        category,
        signals: signals([policy, ...hits], category ?? "risky_experiment", policy),
        subject: lead?.subject ?? null,
    };
}
