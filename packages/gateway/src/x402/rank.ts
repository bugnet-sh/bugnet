/**
 * Scores a search candidate by the S 5.2 step 7 table. Only the index tier is worth more than
 * the quality numbers together, so a seller cannot buy a rank from outside Bugnet's review.
 */
import type { X402SellerStats } from "../payments/port.ts";
import type { Candidate } from "./search.ts";
import type { HostsSeen } from "./index.ts";

export const instructionPhrases: readonly string[] = [
    "you must",
    "always use",
    "ignore",
    "system prompt",
    "assistant",
    "do not tell",
];

export const newHostDays = 14;

const dayMs = 86_400_000;

export function instructionShaped(text: string): boolean {
    const lower = text.toLowerCase();
    return instructionPhrases.some((p) => lower.includes(p));
}

export interface RankContext {
    maxPriceMicros: number;
    now: number;
    sellers: Readonly<Record<string, X402SellerStats>>;
    hostsSeen: HostsSeen;
}

// Null means the seller fails too often to offer at all
export function score(c: Candidate, priceMicros: number, ctx: RankContext): number | null {
    let total = 0;
    if (c.indexEntry !== null) total += 100;
    if (c.payers30d !== null) total += Math.min(30, 10 * Math.log10(1 + c.payers30d));
    if (c.lastSettledAt !== null) {
        const age = ctx.now - Date.parse(c.lastSettledAt);
        if (age <= 7 * dayMs) total += 10;
        else if (age <= 30 * dayMs) total += 5;
    }
    total += 10 * (1 - priceMicros / ctx.maxPriceMicros);
    const record = ctx.sellers[c.host];
    if (record !== undefined && record.paidCalls30d >= 10) {
        const failed = record.failedPaid30d / record.paidCalls30d;
        if (failed > 0.5) return null;
        if (failed > 0.2) total -= 50;
    }
    if (instructionShaped(c.sellerText)) total -= 40;
    const first = ctx.hostsSeen.firstSeen(c.host);
    if (first === null || ctx.now - Date.parse(`${first}T00:00:00Z`) < newHostDays * dayMs) {
        total -= 20;
    }
    return total;
}
