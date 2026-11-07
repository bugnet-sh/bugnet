/**
 * The held-out offer-rate check of spec 11.5.
 *
 * Usage: tsx eval/x402/heldout.ts [--baseline FILE] --rerun FILE
 * Each file holds a results array of run rows. Exits 0 on a pass, 1 on a fail, 2 on bad usage.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ArmRate {
    arm: "mcp" | "plugin";
    offered: number;
    runs: number;
    toldNo: number;
}

export interface RunRow {
    arm: string;
    label: "suggest" | "no";
    toldBeforeRun: boolean;
    told: boolean;
}

export const z95 = 1.96;
export const baselineFile = "eval/x402/heldout-baseline.json";

const arms = ["mcp", "plugin"] as const;
const pct = (p: number) => `${(p * 100).toFixed(1)}%`;
const pts = (p: number) => (p * 100).toFixed(1);

// Pass when each arm's drop from the baseline is within the 95% two-proportion interval
export function offerRateCheck(
    baseline: ArmRate[],
    rerun: ArmRate[],
): { pass: boolean; lines: string[] } {
    let pass = true;
    const lines = baseline.map((b) => {
        const r = rerun.find((x) => x.arm === b.arm);
        if (!r) {
            pass = false;
            return `${b.arm} missing from the rerun, FAIL`;
        }
        const p0 = b.offered / b.runs;
        const p1 = r.offered / r.runs;
        const drop = p0 - p1;
        const allowed = z95 * Math.sqrt((p0 * (1 - p0)) / b.runs + (p1 * (1 - p1)) / r.runs);
        const ok = drop <= allowed && r.toldNo === 0;
        if (!ok) pass = false;
        return `${b.arm} offered ${r.offered}/${r.runs} (${pct(p1)}) against ${b.offered}/${b.runs} (${pct(p0)}): drop ${pts(drop)} points, allowed ${pts(allowed)}, told(no) ${r.toldNo}, ${ok ? "pass" : "FAIL"}`;
    });
    return { pass, lines };
}

// Runs and offered count the arm's suggest rows, toldNo its no rows that were told
export function armRates(results: readonly RunRow[]): ArmRate[] {
    return arms.flatMap((arm) => {
        const rows = results.filter((r) => r.arm === arm);
        if (rows.length === 0) return [];
        const suggest = rows.filter((r) => r.label === "suggest");
        return [
            {
                arm,
                offered: suggest.filter((r) => r.toldBeforeRun).length,
                runs: suggest.length,
                toldNo: rows.filter((r) => r.label === "no" && r.told).length,
            },
        ];
    });
}

// A budget stop must never pass as a result
export function shortArms(baseline: readonly RunRow[], rerun: readonly RunRow[]): string[] {
    const count = (rows: readonly RunRow[], arm: string, label: string) =>
        rows.filter((r) => r.arm === arm && r.label === label).length;
    return arms.flatMap((arm) =>
        (["suggest", "no"] as const).flatMap((label) => {
            const n0 = count(baseline, arm, label);
            const n1 = count(rerun, arm, label);
            return n1 < n0
                ? [`${arm} ran ${n1} of the baseline's ${n0} ${label} prompts, FAIL`]
                : [];
        }),
    );
}

const usage = "usage: heldout.ts [--baseline FILE] --rerun FILE";

function rowsOf(file: string): RunRow[] {
    return (JSON.parse(readFileSync(file, "utf8")) as { results: RunRow[] }).results;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const argv = process.argv.slice(2);
    const opt = (name: string) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const rerunFile = opt("--rerun");
    if (!rerunFile) {
        console.log(usage);
        process.exit(2);
    }
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const base = rowsOf(opt("--baseline") ?? join(root, baselineFile));
    const rerun = rowsOf(rerunFile);
    const short = shortArms(base, rerun);
    const check = offerRateCheck(armRates(base), armRates(rerun));
    for (const line of [...short, ...check.lines]) console.log(line);
    const pass = short.length === 0 && check.pass;
    console.log(
        pass
            ? "held-out rerun: pass"
            : "held-out rerun: FAIL, keep [x402] enabled = false until the wording is fixed and this passes",
    );
    process.exit(pass ? 0 : 1);
}
