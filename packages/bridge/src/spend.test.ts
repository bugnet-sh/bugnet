import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpendLedger } from "./spend.ts";

// A write that fails partway, and unlinks that fail as if the process had died there
const faults = vi.hoisted(() => ({ write: false, dead: new Set<string>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
    const fs = await importOriginal<typeof import("node:fs/promises")>();
    const open: typeof fs.open = async (path, flags, mode) => {
        const fh = await fs.open(path, flags, mode);
        if (!faults.write || typeof flags !== "number" || (flags & constants.O_EXCL) === 0) {
            return fh;
        }
        faults.write = false;
        faults.dead.add(String(path));
        const write = fh.writeFile.bind(fh);
        fh.writeFile = async (data) => {
            await write(String(data).slice(0, 10));
            throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        };
        return fh;
    };
    const unlink: typeof fs.unlink = async (path) => {
        if (faults.dead.has(String(path))) throw Object.assign(new Error("dead"), { code: "EIO" });
        return fs.unlink(path);
    };
    return { ...fs, open, unlink, default: { ...fs, open, unlink } };
});

let dir = "";
let spend = "";
const today = () => new Date().toISOString().slice(0, 10);
const hash = (orderId: string) => createHash("sha256").update(orderId).digest("hex");

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bugnet-spend-"));
    spend = join(dir, "spend");
});

afterEach(async () => {
    faults.write = false;
    faults.dead.clear();
    await rm(dir, { recursive: true, force: true });
});

it("lets at most one of two concurrent reservations past the daily cap", async () => {
    // Two ledgers stand for two bridge processes sharing the folder
    const a = new SpendLedger({ dir: spend });
    const b = new SpendLedger({ dir: spend });
    const results = await Promise.all([
        a.reserve("ord_a", 3_000_000, 5_000_000),
        b.reserve("ord_b", 3_000_000, 5_000_000),
    ]);
    const granted = results.filter(Boolean).length;
    expect(granted).toBeLessThanOrEqual(1);
    expect(await a.spentToday()).toBe(granted * 3_000_000);
});

it("tells an order already reserved apart from one over the cap", async () => {
    const ledger = new SpendLedger({ dir: spend });
    expect(await ledger.claim("ord_a", 3_000_000, 5_000_000)).toBe("reserved");
    expect(await ledger.claim("ord_a", 1, 5_000_000)).toBe("already_reserved");
    expect(await ledger.claim("ord_b", 3_000_000, 5_000_000)).toBe("over_cap");
    await ledger.settle("ord_a", true);
    expect(await ledger.claim("ord_a", 1, 5_000_000)).toBe("already_reserved");
    expect(await ledger.reserve("ord_a", 1, 5_000_000)).toBe(false);
    expect(await ledger.spentToday()).toBe(3_000_000);
    // The order over the cap took its file back
    expect(await ledger.claim("ord_b", 2_000_000, 5_000_000)).toBe("reserved");
});

it("tries afresh after backing off while the day still has room, and only then", async () => {
    const ledger = new SpendLedger({ dir: spend });
    const total = vi.spyOn(ledger as unknown as { total(f: string): Promise<number> }, "total");
    // Its first try saw another claim made at the same moment, which then backed off
    total.mockResolvedValueOnce(6_000_000).mockResolvedValueOnce(0);
    expect(await ledger.claim("ord_a", 3_000_000, 5_000_000)).toBe("reserved");
    expect(total).toHaveBeenCalledTimes(3);
    // The other claim stayed, so it looks once and gives up
    total.mockClear().mockResolvedValueOnce(6_000_000).mockResolvedValueOnce(3_000_000);
    expect(await ledger.claim("ord_b", 3_000_000, 5_000_000)).toBe("over_cap");
    expect(total).toHaveBeenCalledTimes(2);
    total.mockRestore();
    expect(await ledger.spentToday()).toBe(3_000_000);
    const once = new SpendLedger({ dir: spend, retries: 0 });
    const first = vi.spyOn(once as unknown as { total(f: string): Promise<number> }, "total");
    first.mockResolvedValueOnce(6_000_000);
    expect(await once.claim("ord_c", 1, 5_000_000)).toBe("over_cap");
    expect(first).toHaveBeenCalledTimes(1);
    first.mockRestore();
    expect(await ledger.spentToday()).toBe(3_000_000);
});

it("starts a new UTC day from nothing and frees a reservation that moved no money", async () => {
    let now = Date.parse("2026-11-08T23:59:00Z");
    const ledger = new SpendLedger({ dir: spend, now: () => now });
    expect(await ledger.reserve("ord_a", 4_000_000, 5_000_000)).toBe(true);
    await ledger.settle("ord_a", true);
    expect(await ledger.reserve("ord_b", 2_000_000, 5_000_000)).toBe(false);
    now = Date.parse("2026-11-09T00:01:00Z");
    expect(await ledger.reserve("ord_b", 2_000_000, 5_000_000)).toBe(true);
    await ledger.settle("ord_b", false);
    expect(await ledger.spentToday()).toBe(0);
    expect((await readdir(spend)).sort()).toEqual(["2026-11-08", "2026-11-09"]);
    expect(await readdir(join(spend, "2026-11-09"))).toEqual([]);
});

it("still sees an order claimed just before midnight once the day has turned", async () => {
    let now = Date.parse("2026-11-08T23:59:59.900Z");
    const a = new SpendLedger({ dir: spend, now: () => now });
    const b = new SpendLedger({ dir: spend, now: () => now });
    expect(await a.claim("ord_a", 1_000_000, 5_000_000)).toBe("reserved");
    expect(await a.claim("ord_b", 1_000_000, 5_000_000)).toBe("reserved");
    expect(await a.claim("ord_c", 1_000_000, 5_000_000)).toBe("reserved");
    now = Date.parse("2026-11-09T00:00:00.100Z");
    expect(await b.claim("ord_a", 1_000_000, 5_000_000)).toBe("already_reserved");
    await a.settle("ord_b", true);
    expect(await b.claim("ord_b", 1_000_000, 5_000_000)).toBe("already_reserved");
    // A payment that moved nothing gave its order back
    await a.settle("ord_c", false);
    expect(await b.claim("ord_c", 1_000_000, 5_000_000)).toBe("reserved");
    // A file left in the freed state holds nothing, one that cannot be read holds its order
    const yesterday = join(spend, "2026-11-08");
    const entry = (orderId: string) =>
        JSON.stringify({ orderId, micros: 1, state: "freed", at: 0 });
    await writeFile(join(yesterday, hash("ord_d")), entry("ord_d"));
    await writeFile(join(yesterday, hash("ord_e")), "");
    expect(await b.claim("ord_d", 1_000_000, 5_000_000)).toBe("reserved");
    expect(await b.claim("ord_e", 1_000_000, 5_000_000)).toBe("already_reserved");
    expect(await b.spentToday()).toBe(2_000_000);
    // Two days on, the order is new again
    now = Date.parse("2026-11-10T00:00:00.100Z");
    expect(await b.claim("ord_a", 1_000_000, 5_000_000)).toBe("reserved");
});

it("drops day folders older than yesterday and stale temp files, once a day", async () => {
    let now = Date.parse("2026-11-08T12:00:00Z");
    const ledger = new SpendLedger({ dir: spend, now: () => now, unreadableMicros: 1_000 });
    const old = new Date(now - 11 * 60_000);
    const put = async (path: string, mtime?: Date) => {
        await writeFile(path, "x");
        if (mtime !== undefined) await utimes(path, mtime, mtime);
    };
    for (const day of ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]) {
        await mkdir(join(spend, day), { recursive: true, mode: 0o700 });
        await put(join(spend, day, hash(`ord_${day}`)));
        await put(join(spend, day, `${hash("ord_old")}.1.tmp`), old);
        await put(join(spend, day, `${hash("ord_new")}.2.tmp`));
    }
    await mkdir(join(spend, "notes"));
    await put(join(spend, "notes", "keep"));
    await mkdir(join(dir, "outside"));
    await put(join(dir, "outside", "keep"));
    await symlink(join(dir, "outside"), join(spend, "2026-11-01"));
    await symlink(join(dir, "outside"), join(spend, "2026-11-07", "link.tmp"));
    expect(await ledger.claim("ord_a", 1, 5_000_000)).toBe("reserved");
    expect((await readdir(spend)).sort()).toEqual([
        "2026-11-01",
        "2026-11-07",
        "2026-11-08",
        "notes",
    ]);
    const kept = (day: string, ...orders: string[]) =>
        [hash(`ord_${day}`), `${hash("ord_new")}.2.tmp`, ...orders].sort();
    expect((await readdir(join(spend, "2026-11-07"))).sort()).toEqual(
        kept("2026-11-07", "link.tmp"),
    );
    expect((await readdir(join(spend, "2026-11-08"))).sort()).toEqual(
        kept("2026-11-08", hash("ord_a")),
    );
    expect(await readdir(join(dir, "outside"))).toEqual(["keep"]);
    expect(await readdir(join(spend, "notes"))).toEqual(["keep"]);
    // Only the first claim of a day looks
    await mkdir(join(spend, "2026-11-04"));
    expect(await ledger.claim("ord_b", 1, 5_000_000)).toBe("reserved");
    expect(await readdir(spend)).toContain("2026-11-04");
    now = Date.parse("2026-11-09T00:00:01Z");
    expect(await ledger.claim("ord_c", 1, 5_000_000)).toBe("reserved");
    expect((await readdir(spend)).sort()).toEqual([
        "2026-11-01",
        "2026-11-08",
        "2026-11-09",
        "notes",
    ]);
});

it("refuses an orderId that is not a plain name", async () => {
    const ledger = new SpendLedger({ dir: spend });
    const bad = ["__proto__", "../x", "", "a".repeat(65), "a/b", ".x", "-x", "ord a", "ord\n"];
    for (const orderId of bad) {
        await expect(ledger.claim(orderId, 1, 5_000_000), orderId).rejects.toThrow("ledger_order");
        await expect(ledger.settle(orderId, true), orderId).rejects.toThrow("ledger_order");
    }
    expect(await ledger.claim("a".repeat(64), 1, 5_000_000)).toBe("reserved");
    expect(await ledger.claim("ord_A-1", 1, 5_000_000)).toBe("reserved");
    expect(await ledger.spentToday()).toBe(2);
    expect(await readdir(dir)).toEqual(["spend"]);
});

it("keeps one 0600 file per reservation in a 0700 folder per day, and no lock", async () => {
    // A spend.json from before is neither read nor removed
    await writeFile(join(dir, "spend.json"), '{"day":"x","entries":{}}');
    const ledger = new SpendLedger({ dir: spend, now: () => Date.parse("2026-11-08T12:00:00Z") });
    expect(await ledger.claim("ord_a", 50_000, 5_000_000)).toBe("reserved");
    const folder = join(spend, "2026-11-08");
    const file = join(folder, hash("ord_a"));
    expect((await stat(spend)).mode & 0o777).toBe(0o700);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        orderId: "ord_a",
        micros: 50_000,
        state: "reserved",
        at: Date.parse("2026-11-08T12:00:00Z"),
    });
    await ledger.settle("ord_a", true);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ state: "spent" });
    expect(await readdir(folder)).toEqual([hash("ord_a")]);
    expect(await ledger.claim("ord_b", 1, 5_000_000)).toBe("reserved");
    await ledger.settle("ord_b", false);
    expect(await readdir(folder)).toEqual([hash("ord_a")]);
    expect((await readdir(dir)).sort()).toEqual(["spend", "spend.json"]);
});

it("settles only its own reservations", async () => {
    const a = new SpendLedger({ dir: spend });
    const b = new SpendLedger({ dir: spend });
    expect(await a.claim("ord_a", 1_000_000, 5_000_000)).toBe("reserved");
    await b.settle("ord_a", false);
    await b.settle("ord_a", true);
    const file = join(spend, today(), hash("ord_a"));
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ state: "reserved" });
    expect(await b.spentToday()).toBe(1_000_000);
});

it("counts a file it cannot read at the per-payment ceiling, and skips other names", async () => {
    const ledger = new SpendLedger({ dir: spend, unreadableMicros: 1_000 });
    expect(await ledger.claim("ord_a", 10, 5_000_000)).toBe("reserved");
    const folder = join(spend, today());
    const entry = (orderId: string, state: string) =>
        JSON.stringify({ orderId, micros: 7, state, at: 0 });
    // A claim cut off before its write, garbage, a name its content does not hash to, a symlink
    await writeFile(join(folder, hash("ord_empty")), "");
    await writeFile(join(folder, hash("ord_junk")), '{"orderId":');
    await writeFile(join(folder, hash("ord_other")), entry("ord_x", "spent"));
    await symlink(join(dir, "nowhere"), join(folder, hash("ord_link")));
    expect(await ledger.spentToday()).toBe(10 + 4 * 1_000);
    await mkdir(join(folder, hash("ord_dir")));
    expect(await ledger.spentToday()).toBe(10 + 5 * 1_000);
    // A freed entry, a settle's temp file and other names count nothing
    await writeFile(join(folder, hash("ord_freed")), entry("ord_freed", "freed"));
    await writeFile(join(folder, `${hash("ord_a")}.tmp`), "");
    await writeFile(join(folder, "notes"), "");
    await writeFile(join(folder, hash("ord_spent")), entry("ord_spent", "spent"));
    expect(await ledger.spentToday()).toBe(10 + 5 * 1_000 + 7);
    expect(await ledger.claim("ord_b", 1, 5_000)).toBe("over_cap");
    await expect(ledger.claim("ord_c", 1_001, 1_000_000)).rejects.toThrow(RangeError);
});

it("leaves no reservation behind when its write fails partway", async () => {
    const ledger = new SpendLedger({ dir: spend, unreadableMicros: 1_000 });
    faults.write = true;
    await expect(ledger.claim("ord_a", 10, 5_000_000)).rejects.toThrow("ledger_io");
    expect(faults.dead.size).toBe(1);
    const names = await readdir(join(spend, today()));
    expect(names.filter((n) => /^[0-9a-f]{64}$/.test(n))).toEqual([]);
    expect(await ledger.spentToday()).toBe(0);
    expect(await ledger.claim("ord_a", 10, 5_000_000)).toBe("reserved");
    expect(await ledger.spentToday()).toBe(10);
});

it("counts a file over the size limit at the per-payment ceiling", async () => {
    const ledger = new SpendLedger({ dir: spend, unreadableMicros: 1_000 });
    expect(await ledger.claim("ord_a", 10, 5_000_000)).toBe("reserved");
    const body = JSON.stringify({ orderId: "ord_big", micros: 7, state: "spent", at: 0 });
    const folder = join(spend, today());
    await writeFile(join(folder, hash("ord_big")), body.padEnd(4096, " "));
    expect(await ledger.spentToday()).toBe(10 + 7);
    await writeFile(join(folder, hash("ord_big")), body.padEnd(4097, " "));
    expect(await ledger.spentToday()).toBe(10 + 1_000);
});

it("refuses a day folder that is a symlink or open to others", async () => {
    const day = "2026-11-08";
    const ledger = new SpendLedger({ dir: spend, now: () => Date.parse(`${day}T12:00:00Z`) });
    await mkdir(join(dir, "elsewhere"), { mode: 0o700 });
    await mkdir(spend, { mode: 0o700 });
    await symlink(join(dir, "elsewhere"), join(spend, day));
    await expect(ledger.claim("ord_a", 1, 5_000_000)).rejects.toThrow("ledger_folder");
    await rm(join(spend, day));
    await mkdir(join(spend, day), { mode: 0o755 });
    await expect(ledger.claim("ord_a", 1, 5_000_000)).rejects.toThrow("ledger_folder");
    expect(await readdir(join(dir, "elsewhere"))).toEqual([]);
});

// Six bridge processes each reserve 3 USD of a 5 USD cap at the same moment
it("grants at most one of six processes racing for the cap, trial after trial", async () => {
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
        for (let t = 0; t < 30; t++) {
            const root = join(dir, `t${t}`);
            const answers = procs.map((_, i) => next(i));
            procs.forEach((p, i) => p.stdin!.write(`go ${root} ord_${t}_${i}\n`));
            const results = (await Promise.all(answers)).map(
                (l) => JSON.parse(l) as { orderId: string; granted?: boolean; error?: string },
            );
            expect(results.filter((r) => r.error !== undefined)).toEqual([]);
            const granted = results.filter((r) => r.granted === true).map((r) => r.orderId);
            expect(granted.length, `trial ${t}: ${JSON.stringify(results)}`).toBeLessThan(2);
            expect(await readdir(join(root, today()))).toEqual(granted.map(hash));
        }
    } finally {
        for (const p of procs) p.kill();
    }
}, 120_000);
