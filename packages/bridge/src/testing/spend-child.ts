// One bridge process for the spend ledger race test: each "go <path> <orderId>" line on stdin
// reserves 3 USD against a 5 USD cap and prints the result as one JSON line
import { createInterface } from "node:readline";
import { LedgerError, SpendLedger } from "../spend.ts";

const lines = createInterface({ input: process.stdin });
process.stdout.write("ready\n");
lines.on("line", (line) => {
    const [, path, orderId] = line.split(" ");
    if (path === undefined || orderId === undefined) return;
    new SpendLedger({ path, staleLockMs: 1_000 })
        .reserve(orderId, 3_000_000, 5_000_000)
        .then(
            (granted) => ({ orderId, granted }),
            (e: unknown) => ({ orderId, error: e instanceof LedgerError ? e.code : String(e) }),
        )
        .then((r) => process.stdout.write(`${JSON.stringify(r)}\n`));
});
