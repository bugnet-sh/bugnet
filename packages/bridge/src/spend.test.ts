import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
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

type Locking = {
    withLock<T>(work: (mine: () => Promise<boolean>) => Promise<T>): Promise<T>;
};

// The pid of a process that has exited
function deadPid(): number {
    const r = spawnSync(process.execPath, ["-e", ""]);
    return r.pid as number;
}

const old = () => new Date(Date.now() - 60_000);

it("never takes a live holder's lock, however old", async () => {
    const path = join(dir, "spend.json");
    const lock = `${path}.lock`;
    const a = new SpendLedger({ path, staleLockMs: 10 }) as unknown as Locking;
    const b = new SpendLedger({ path, staleLockMs: 10, lockWaitMs: 300 });
    await a.withLock(async () => {
        const held = await readFile(lock, "utf8");
        await utimes(lock, old(), old());
        await expect(b.reserve("ord_b", 1, 5_000_000)).rejects.toThrow("ledger_busy");
        expect(await readFile(lock, "utf8")).toBe(held);
    });
});

it("takes a lock whose pid is dead at once, and one naming no pid once it is old", async () => {
    const path = join(dir, "spend.json");
    const lock = `${path}.lock`;
    const ledger = new SpendLedger({ path, staleLockMs: 1_000, lockWaitMs: 300 });
    await writeFile(lock, `${deadPid()} ${"f".repeat(36)}`);
    expect(await ledger.reserve("ord_a", 1, 5_000_000)).toBe(true);
    await writeFile(lock, "");
    await expect(ledger.reserve("ord_b", 1, 5_000_000)).rejects.toThrow("ledger_busy");
    await utimes(lock, old(), old());
    expect(await ledger.reserve("ord_b", 1, 5_000_000)).toBe(true);
    await expect(readFile(lock, "utf8")).rejects.toThrow(/ENOENT/);
    expect((await readdir(dir)).sort()).toEqual(["spend.json"]);
});

it("neither writes nor removes a lock that is no longer its own", async () => {
    const path = join(dir, "spend.json");
    const lock = `${path}.lock`;
    const a = new SpendLedger({ path }) as unknown as Locking;
    const ledger = new SpendLedger({ path });
    expect(await ledger.reserve("ord_a", 1, 5_000_000)).toBe(true);
    const before = await readFile(path, "utf8");
    const other = `${process.pid} other`;
    await expect(
        a.withLock(async (mine) => {
            // Another holder's lock now stands where ours was
            await unlink(lock);
            await writeFile(lock, other);
            expect(await mine()).toBe(false);
            throw new Error("stop");
        }),
    ).rejects.toThrow("stop");
    expect(await readFile(lock, "utf8")).toBe(other);
    const write = (
        ledger as unknown as { write(d: unknown, m: () => Promise<boolean>): Promise<void> }
    ).write;
    await expect(write.call(ledger, { day: "x", entries: {} }, async () => false)).rejects.toThrow(
        "ledger_busy",
    );
    expect(await readFile(path, "utf8")).toBe(before);
});

// Six bridge processes race over a lock left by a dead one, each reserving 3 USD of a 5 USD cap
it("grants one of six processes racing over a stale lock, trial after trial", async () => {
    const child = fileURLToPath(new URL("./testing/spend-child.ts", import.meta.url));
    const procs = Array.from({ length: 6 }, () =>
        spawn(process.execPath, ["--import", "tsx", child], {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            stdio: ["pipe", "pipe", "inherit"],
        }),
    );
    const readers = procs.map((p) => createInterface({ input: p.stdout! }));
    const next = (i: number) =>
        new Promise<string>((r) => readers[i]!.once("line", (l: string) => r(l)));
    try {
        await Promise.all(procs.map((_, i) => next(i)));
        const dead = deadPid();
        const trials = 30;
        let grants = 0;
        for (let t = 0; t < trials; t++) {
            const path = join(dir, `t${t}`, "spend.json");
            await mkdir(join(dir, `t${t}`));
            const lock = `${path}.lock`;
            // Alternate a lock naming a dead pid with an old one a crash left empty
            await writeFile(lock, t % 2 === 0 ? `${dead} ${"d".repeat(36)}` : "");
            await utimes(lock, old(), old());
            const answers = procs.map((_, i) => next(i));
            procs.forEach((p, i) => p.stdin!.write(`go ${path} ord_${t}_${i}\n`));
            const results = (await Promise.all(answers)).map(
                (l) => JSON.parse(l) as { orderId: string; granted?: boolean; error?: string },
            );
            const granted = results.filter((r) => r.granted === true);
            expect(granted, `trial ${t}: ${JSON.stringify(results)}`).toHaveLength(1);
            const doc = JSON.parse(await readFile(path, "utf8")) as { entries: object };
            expect(Object.keys(doc.entries)).toEqual([granted[0]!.orderId]);
            grants += granted.length;
        }
        expect(grants).toBe(trials);
    } finally {
        for (const p of procs) p.kill();
    }
}, 120_000);
