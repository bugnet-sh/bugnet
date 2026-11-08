// Key signer spend per UTC day, one file per reservation, shared by bridge processes with no lock
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paymentCeilingUsd } from "./config.ts";

export class LedgerError extends Error {
    readonly code: "ledger_order" | "ledger_folder" | "ledger_io";

    constructor(code: "ledger_order" | "ledger_folder" | "ledger_io") {
        super(code);
        this.code = code;
    }
}

export interface SpendLedgerOptions {
    // ~/.config/bugnet/spend, with a folder per UTC day under it
    dir: string;
    now?: () => number;
    // What a file that cannot be read counts as, so it must be at least any one payment
    unreadableMicros?: number;
    // Fresh tries after a claim backs off while the day still has room
    retries?: number;
}

export type Reservation = "reserved" | "already_reserved" | "over_cap";

type State = "reserved" | "spent" | "freed";

interface Entry {
    orderId: string;
    micros: number;
    state: State;
    at: number;
}

// The first character is never "_", "-" or "." so names like __proto__ and ../x are refused
const orderIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const fileName = /^[0-9a-f]{64}$/;
const maxFileBytes = 4096;
const dayName = /^\d{4}-\d{2}-\d{2}$/;
const staleTempMs = 10 * 60_000;

const nameOf = (orderId: string) => createHash("sha256").update(orderId).digest("hex");

function checkOrder(orderId: string): void {
    if (typeof orderId !== "string" || !orderIdPattern.test(orderId)) {
        throw new LedgerError("ledger_order");
    }
}

function parse(text: string, name: string): Entry | null {
    let v: unknown;
    try {
        v = JSON.parse(text);
    } catch {
        return null;
    }
    const e = v as Entry;
    if (
        typeof e !== "object" ||
        e === null ||
        typeof e.orderId !== "string" ||
        nameOf(e.orderId) !== name ||
        !Number.isSafeInteger(e.micros) ||
        e.micros < 0 ||
        (e.state !== "reserved" && e.state !== "spent" && e.state !== "freed")
    ) {
        return null;
    }
    return e;
}

// Fails with EEXIST when anything, a symlink included, already has the name
async function create(path: string, text: string): Promise<void> {
    const fh = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
    );
    try {
        await fh.writeFile(text);
        await fh.sync();
    } catch (e) {
        await fh.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw e;
    }
    await fh.close();
}

// Some systems cannot sync a folder
const unsyncable = new Set(["EISDIR", "EINVAL", "EPERM"]);

// Makes a link or rename in the folder survive a power cut
async function syncFolder(folder: string): Promise<void> {
    let fh;
    try {
        fh = await open(folder, constants.O_RDONLY);
    } catch (e) {
        if (unsyncable.has((e as NodeJS.ErrnoException).code ?? "")) return;
        throw e;
    }
    try {
        await fh.sync();
    } catch (e) {
        if (!unsyncable.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
    } finally {
        await fh.close();
    }
}

// Removes the entries of a folder that pick chooses, never following a symlink
async function sweep(folder: string, pick: (name: string, st: Stats) => boolean): Promise<void> {
    if (!(await lstat(folder)).isDirectory()) return;
    for (const name of await readdir(folder)) {
        const path = join(folder, name);
        const st = await lstat(path).catch(() => null);
        if (st !== null && !st.isDirectory() && pick(name, st)) await unlink(path).catch(() => {});
    }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

export class SpendLedger {
    private readonly dir: string;
    private readonly now: () => number;
    private readonly unreadableMicros: number;
    private readonly retries: number;
    // This process's own reservations, the only files settle touches
    private readonly mine = new Map<string, { day: string; micros: number }>();
    private cleaned = "";

    constructor(opts: SpendLedgerOptions) {
        this.dir = opts.dir;
        this.now = opts.now ?? Date.now;
        this.unreadableMicros = opts.unreadableMicros ?? paymentCeilingUsd * 1_000_000;
        this.retries = opts.retries ?? 4;
    }

    private day(offset = 0): string {
        return new Date(this.now() + offset * 86_400_000).toISOString().slice(0, 10);
    }

    private async folder(day: string): Promise<string> {
        const folder = join(this.dir, day);
        try {
            await mkdir(folder, { recursive: true, mode: 0o700 });
        } catch {
            throw new LedgerError("ledger_folder");
        }
        const st = await lstat(folder).catch(() => {
            throw new LedgerError("ledger_folder");
        });
        const owner = process.getuid?.() ?? st.uid;
        if (!st.isDirectory() || st.uid !== owner || (st.mode & 0o077) !== 0) {
            throw new LedgerError("ledger_folder");
        }
        return folder;
    }

    // Yesterday stays for settles and claims across midnight
    private async cleanup(day: string): Promise<void> {
        const yesterday = this.day(-1);
        for (const entry of await readdir(this.dir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !dayName.test(entry.name) || entry.name >= yesterday) {
                continue;
            }
            const old = join(this.dir, entry.name);
            await sweep(old, () => true).catch(() => {});
            await rmdir(old).catch(() => {});
        }
        const stale = (name: string, st: Stats) =>
            st.isFile() && name.endsWith(".tmp") && st.mtimeMs < this.now() - staleTempMs;
        for (const d of [yesterday, day]) await sweep(join(this.dir, d), stale).catch(() => {});
    }

    private body(orderId: string, micros: number, state: State): string {
        return JSON.stringify({ orderId, micros, state, at: this.now() });
    }

    // Null for a file that vanished, which was freed or backed off
    private async read(folder: string, name: string): Promise<Entry | null | "unreadable"> {
        let text: string;
        try {
            const fh = await open(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const st = await fh.stat();
                if (!st.isFile() || st.size > maxFileBytes) return "unreadable";
                text = await fh.readFile("utf8");
            } finally {
                await fh.close();
            }
        } catch (e) {
            return isMissing(e) ? null : "unreadable";
        }
        return parse(text, name) ?? "unreadable";
    }

    // A file that cannot be read counts in full
    private async count(folder: string, name: string): Promise<number> {
        const entry = await this.read(folder, name);
        if (entry === "unreadable") return this.unreadableMicros;
        return entry === null || entry.state === "freed" ? 0 : entry.micros;
    }

    private async total(folder: string): Promise<number> {
        let names: string[];
        try {
            names = await readdir(folder);
        } catch (e) {
            if (isMissing(e)) return 0;
            throw new LedgerError("ledger_io");
        }
        let sum = 0;
        // A settle's temp file is skipped since the file it replaces still counts
        for (const name of names) {
            if (fileName.test(name)) sum += await this.count(folder, name);
        }
        return sum;
    }

    // Holds the amount before anything is signed, so the day never goes over its cap
    async claim(orderId: string, micros: number, dailyCapMicros: number): Promise<Reservation> {
        checkOrder(orderId);
        if (!Number.isSafeInteger(micros) || micros < 0 || micros > this.unreadableMicros) {
            throw new RangeError("micros");
        }
        const day = this.day();
        const folder = await this.folder(day);
        if (this.cleaned !== day) {
            this.cleaned = day;
            await this.cleanup(day).catch(() => {});
        }
        // An order claimed just before midnight is still held by yesterday's file
        const yesterday = join(this.dir, this.day(-1));
        const before = await this.read(yesterday, nameOf(orderId));
        if (before !== null && (before === "unreadable" || before.state !== "freed")) {
            return "already_reserved";
        }
        for (let attempt = 0; ; attempt++) {
            const result = await this.tryClaim(folder, orderId, micros, dailyCapMicros);
            if (result === "reserved") this.mine.set(orderId, { day, micros });
            if (result !== "over_cap" || attempt === this.retries) return result;
            // Claims at the same moment can all back off, so one retries while the day has room
            await wait(2 + Math.random() * 8 * (attempt + 1));
            if ((await this.total(folder)) + micros > dailyCapMicros) return "over_cap";
        }
    }

    // The file is made before the day is summed, so the later of two tries always sees the other
    private async tryClaim(
        folder: string,
        orderId: string,
        micros: number,
        dailyCapMicros: number,
    ): Promise<Reservation> {
        const file = join(folder, nameOf(orderId));
        // Linked once written whole, so a crash leaves an uncounted temp file, never an empty one
        const tmp = `${file}.${randomUUID()}.tmp`;
        try {
            await create(tmp, this.body(orderId, micros, "reserved"));
            await link(tmp, file);
        } catch (e) {
            await unlink(tmp).catch(() => {});
            if ((e as NodeJS.ErrnoException).code === "EEXIST") return "already_reserved";
            throw new LedgerError("ledger_io");
        }
        await unlink(tmp).catch(() => {});
        let used: number;
        try {
            await syncFolder(folder);
            used = await this.total(folder);
        } catch (e) {
            await unlink(file).catch(() => {});
            throw e instanceof LedgerError ? e : new LedgerError("ledger_io");
        }
        if (used > dailyCapMicros) {
            await unlink(file).catch(() => {});
            return "over_cap";
        }
        return "reserved";
    }

    // True only when this call reserved the amount
    async reserve(orderId: string, micros: number, dailyCapMicros: number): Promise<boolean> {
        return (await this.claim(orderId, micros, dailyCapMicros)) === "reserved";
    }

    // Spent stays counted, and a payment that surely moved nothing frees its reservation
    async settle(orderId: string, spent: boolean): Promise<void> {
        checkOrder(orderId);
        const held = this.mine.get(orderId);
        if (held === undefined) return;
        const folder = join(this.dir, held.day);
        const file = join(folder, nameOf(orderId));
        if (!spent) {
            try {
                await unlink(file);
            } catch (e) {
                if (!isMissing(e)) throw new LedgerError("ledger_io");
            }
            this.mine.delete(orderId);
            return;
        }
        const tmp = `${file}.${randomUUID()}.tmp`;
        try {
            await create(tmp, this.body(orderId, held.micros, "spent"));
            await rename(tmp, file);
            await syncFolder(folder);
        } catch {
            await unlink(tmp).catch(() => {});
            throw new LedgerError("ledger_io");
        }
        this.mine.delete(orderId);
    }

    async spentToday(): Promise<number> {
        return this.total(join(this.dir, this.day()));
    }
}
