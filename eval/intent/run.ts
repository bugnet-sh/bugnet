/**
 * Offline judge for the hook classifier.
 *
 * Scores packages/intent on the labelled items in this directory. Borderline items are reported
 * apart and never count toward precision or recall. Per-item misses are printed for the dev split
 * only, so the test split stays held out while the rules are tuned.
 *
 * Usage: tsx eval/intent/run.ts [--split dev|test] [--json out.json]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    classifyCommand,
    classifyPrompt,
    type SessionContext,
} from "../../packages/intent/src/index.ts";

interface Item {
    id: string;
    kind: "prompt" | "command";
    text: string;
    context: string;
    os: "macos" | "linux" | "windows";
    label: "suggest" | "no";
    borderline: boolean;
    category: string;
    why: string;
}

interface Counts {
    tp: number;
    fp: number;
    fn: number;
    tn: number;
}

const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const split = args[args.indexOf("--split") + 1] === "test" ? "test" : "dev";
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;

// The hook knows which directories this session cloned, and nothing else about the context
export function contextOf(item: Item): SessionContext {
    const cloned = /\b(git clone|cloned|cloning|just clone)/i.test(item.context);
    return { os: item.os, clonedThisSession: cloned };
}

function load(): Item[] {
    return readdirSync(dir)
        .filter((f) => f.endsWith(`.${split}.jsonl`))
        .sort()
        .flatMap((f) =>
            readFileSync(join(dir, f), "utf8")
                .split("\n")
                .filter((l) => l.trim())
                .map((l) => JSON.parse(l) as Item),
        );
}

function empty(): Counts {
    return { tp: 0, fp: 0, fn: 0, tn: 0 };
}

function add(c: Counts, label: Item["label"], suggested: boolean): void {
    const key = label === "suggest" ? (suggested ? "tp" : "fn") : suggested ? "fp" : "tn";
    c[key] += 1;
}

function rates(c: Counts) {
    const precision = c.tp + c.fp === 0 ? 1 : c.tp / (c.tp + c.fp);
    const recall = c.tp + c.fn === 0 ? 1 : c.tp / (c.tp + c.fn);
    const fpr = c.fp + c.tn === 0 ? 0 : c.fp / (c.fp + c.tn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { ...c, precision, recall, fpr, f1 };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const items = load();
const overall = empty();
const byKind: Record<string, Counts> = {};
const byLens: Record<string, Counts> = {};
const borderline = empty();
const misses: { item: Item; suggested: boolean; score: number; signals: string }[] = [];
const started = performance.now();

for (const item of items) {
    const ctx = contextOf(item);
    const c =
        item.kind === "prompt" ? classifyPrompt(item.text, ctx) : classifyCommand(item.text, ctx);
    if (item.borderline) {
        add(borderline, item.label, c.suggest);
        continue;
    }
    const lens = item.id.replace(/-(dev|test)-\d+$/, "");
    add(overall, item.label, c.suggest);
    add((byKind[item.kind] ??= empty()), item.label, c.suggest);
    add((byLens[lens] ??= empty()), item.label, c.suggest);
    if (c.suggest !== (item.label === "suggest")) {
        misses.push({
            item,
            suggested: c.suggest,
            score: c.score,
            signals: c.signals.map((s) => `${s.id}:${s.weight}`).join(" "),
        });
    }
}

const perItemMs = (performance.now() - started) / Math.max(items.length, 1);
const summary = {
    split,
    items: items.length,
    perItemMs,
    overall: rates(overall),
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, rates(v)])),
    byLens: Object.fromEntries(Object.entries(byLens).map(([k, v]) => [k, rates(v)])),
    borderline: rates(borderline),
};

const line = (name: string, r: ReturnType<typeof rates>) =>
    `${name.padEnd(16)} precision ${pct(r.precision).padStart(6)}  recall ${pct(r.recall).padStart(6)}  ` +
    `false-offer ${pct(r.fpr).padStart(6)}  f1 ${r.f1.toFixed(3)}  (tp ${r.tp} fp ${r.fp} fn ${r.fn} tn ${r.tn})`;

console.log(`split ${split}: ${items.length} items, ${perItemMs.toFixed(3)} ms per item`);
console.log(line("overall", summary.overall));
for (const [k, v] of Object.entries(summary.byKind)) console.log(line(`kind ${k}`, v));
for (const [k, v] of Object.entries(summary.byLens)) console.log(line(`lens ${k}`, v));
console.log(line("borderline", summary.borderline));

if (split === "dev") {
    for (const m of misses) {
        const kind = m.suggested ? "FALSE OFFER" : "MISSED";
        const text = m.item.text.replace(/\s+/g, " ").slice(0, 140);
        console.log(
            `\n${kind} ${m.item.id} [${m.item.category}] score ${m.score.toFixed(2)} ${m.signals}`,
        );
        console.log(`  ${m.item.kind}: ${text}`);
        if (m.item.context) console.log(`  context: ${m.item.context.slice(0, 140)}`);
    }
}

if (jsonOut) writeFileSync(jsonOut, JSON.stringify(summary, null, 4));
