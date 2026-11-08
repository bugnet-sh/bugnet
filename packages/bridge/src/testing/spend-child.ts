// One bridge process for the spend ledger race tests, driven by lines on stdin
import { createInterface } from "node:readline";
import { LedgerError, SpendLedger } from "../spend.ts";

const answer = (r: unknown) => process.stdout.write(`${JSON.stringify(r)}\n`);
const failure = (e: unknown) => (e instanceof LedgerError ? e.code : String(e));

async function run(dir: string, prefix: string, count: number, micros: number, cap: number) {
    const ledger = new SpendLedger({ dir });
    const results = { reserved: 0, already_reserved: 0, over_cap: 0, errors: 0 };
    for (let i = 0; i < count; i++) {
        try {
            results[await ledger.claim(`${prefix}_${i}`, micros, cap)] += 1;
        } catch {
            results.errors += 1;
        }
    }
    return results;
}

const lines = createInterface({ input: process.stdin });
process.stdout.write("ready\n");
lines.on("line", (line) => {
    const [verb, dir, orderId, ...rest] = line.split(" ");
    if (dir === undefined || orderId === undefined) return;
    const n = rest.map(Number);
    // go <dir> <orderId> [micros] [cap] claims once, 3 USD against 5 USD by default
    if (verb === "go") {
        new SpendLedger({ dir })
            .claim(orderId, n[0] ?? 3_000_000, n[1] ?? 5_000_000)
            .then(
                (result) => ({ orderId, granted: result === "reserved", result }),
                (e: unknown) => ({ orderId, error: failure(e) }),
            )
            .then(answer);
    } else if (verb === "run") {
        // run <dir> <prefix> <count> <micros> <cap> claims count times and tallies the results
        run(dir, orderId, n[0] ?? 1, n[1] ?? 1, n[2] ?? 1).then(answer, (e: unknown) =>
            answer({ error: failure(e) }),
        );
    }
});
