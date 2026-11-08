import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SpendLedger } from "./spend.ts";

let dir = "";
let spend = "";
const today = () => new Date().toISOString().slice(0, 10);
const hash = (orderId: string) => createHash("sha256").update(orderId).digest("hex");

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bugnet-spend-"));
    spend = join(dir, "spend");
});

afterEach(async () => {
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
