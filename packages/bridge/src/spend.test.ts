import { mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SpendLedger } from "./spend.ts";

let dir = "";

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bugnet-spend-"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

it("lets only one of two concurrent reservations past the daily cap", async () => {
    const path = join(dir, "spend.json");
    // Two ledgers stand for two bridge processes sharing the file
    const a = new SpendLedger({ path });
    const b = new SpendLedger({ path });
    const results = await Promise.all([
        a.reserve("ord_a", 3_000_000, 5_000_000),
        b.reserve("ord_b", 3_000_000, 5_000_000),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await a.spentToday()).toBe(3_000_000);
});

it("starts a new UTC day from nothing and frees a reservation that moved no money", async () => {
    let now = Date.parse("2026-11-08T23:59:00Z");
    const ledger = new SpendLedger({ path: join(dir, "spend.json"), now: () => now });
    expect(await ledger.reserve("ord_a", 4_000_000, 5_000_000)).toBe(true);
    await ledger.settle("ord_a", true);
    expect(await ledger.reserve("ord_b", 2_000_000, 5_000_000)).toBe(false);
    now = Date.parse("2026-11-09T00:01:00Z");
    expect(await ledger.reserve("ord_b", 2_000_000, 5_000_000)).toBe(true);
    await ledger.settle("ord_b", false);
    expect(await ledger.spentToday()).toBe(0);
});

type Locking = { withLock<T>(work: () => Promise<T>): Promise<T> };

it("keeps a lock a waiter took over when it was stale, past the old holder's finally", async () => {
    const path = join(dir, "spend.json");
    const lock = `${path}.lock`;
    const a = new SpendLedger({ path, staleLockMs: 1_000 }) as unknown as Locking;
    const b = new SpendLedger({ path, staleLockMs: 1_000 }) as unknown as Locking;
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let bHolds = () => {};
    const bIn = new Promise<void>((r) => (bHolds = r));
    let bLock = "";
    let bDone: Promise<void> = Promise.resolve();
    await a.withLock(async () => {
        const old = new Date(Date.now() - 60_000);
        await utimes(lock, old, old);
        bDone = b.withLock(async () => {
            bLock = await readFile(lock, "utf8");
            bHolds();
            await gate;
        });
        await bIn;
    });
    expect(await readFile(lock, "utf8")).toBe(bLock);
    release();
    await bDone;
    await expect(readFile(lock, "utf8")).rejects.toThrow(/ENOENT/);
});
