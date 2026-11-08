// What the key signer spent today (UTC), shared by every bridge process through one lockfile
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, readFile, rename, unlink, writeFile } from "node:fs/promises";

export class LedgerError extends Error {
    readonly code: "ledger_busy" | "ledger_corrupt";

    constructor(code: "ledger_busy" | "ledger_corrupt") {
        super(code);
        this.code = code;
    }
}

interface Entry {
    micros: number;
    state: "reserved" | "spent";
}

interface Doc {
    day: string;
    entries: Record<string, Entry>;
}

export interface SpendLedgerOptions {
    path: string;
    now?: () => number;
    // A lock this old whose holder's pid cannot be read is taken as left by a crash
    staleLockMs?: number;
    lockWaitMs?: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readLock(lock: string): Promise<string | null> {
    return readFile(lock, "utf8").catch(() => null);
}

interface LockFile {
    text: string;
    dev: number;
    ino: number;
    mtimeMs: number;
}

// Content and inode from one open file, so both describe the same lock
async function inspect(path: string): Promise<LockFile | null> {
    let fh;
    try {
        fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
        return null;
    }
    try {
        const st = await fh.stat();
        const text = await fh.readFile("utf8");
        return { text, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
    } finally {
        await fh.close();
    }
}

const sameFile = (a: LockFile, b: { dev: number; ino: number }) =>
    a.dev === b.dev && a.ino === b.ino;

// ESRCH is the only proof of death; EPERM means a live process of another user
function holder(text: string): "alive" | "dead" | "unknown" {
    const m = /^(\d{1,10}) /.exec(text);
    const pid = m ? Number(m[1]) : 0;
    if (pid <= 0) return "unknown";
    try {
        process.kill(pid, 0);
        return "alive";
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "alive";
    }
}

function isEntry(v: unknown): v is Entry {
    const e = v as Entry;
    return (
        typeof e === "object" &&
        e !== null &&
        Number.isSafeInteger(e.micros) &&
        e.micros >= 0 &&
        (e.state === "reserved" || e.state === "spent")
    );
}

export class SpendLedger {
    private readonly path: string;
    private readonly now: () => number;
    private readonly staleLockMs: number;
    private readonly lockWaitMs: number;

    constructor(opts: SpendLedgerOptions) {
        this.path = opts.path;
        this.now = opts.now ?? Date.now;
        this.staleLockMs = opts.staleLockMs ?? 30_000;
        this.lockWaitMs = opts.lockWaitMs ?? 10_000;
    }

    private day(): string {
        return new Date(this.now()).toISOString().slice(0, 10);
    }

    // The lock is only ever made through O_EXCL and holds its owner's pid and a random nonce, so
    // a holder only removes its own. work gets a check that the lock is still ours, to run before
    // it writes
    private async withLock<T>(work: (mine: () => Promise<boolean>) => Promise<T>): Promise<T> {
        const lock = `${this.path}.lock`;
        const nonce = `${process.pid} ${randomUUID()}`;
        const started = Date.now();
        for (;;) {
            if (await this.tryCreate(lock, nonce)) break;
            await this.clearStale(lock, nonce);
            if (await this.tryCreate(lock, nonce)) break;
            if (Date.now() - started > this.lockWaitMs) throw new LedgerError("ledger_busy");
            await wait(10 + Math.random() * 20);
        }
        try {
            return await work(async () => (await readLock(lock)) === nonce);
        } finally {
            if ((await readLock(lock)) === nonce) await unlink(lock).catch(() => {});
        }
    }

    private async tryCreate(lock: string, nonce: string): Promise<boolean> {
        let fh;
        try {
            fh = await open(
                lock,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                0o600,
            );
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            return false;
        }
        try {
            await fh.writeFile(nonce);
        } finally {
            await fh.close();
        }
        return true;
    }

    // Stale: its pid is dead, or it is older than staleLockMs and names no pid
    private isStale(l: LockFile): boolean {
        const who = holder(l.text);
        return who === "dead" || (who === "unknown" && Date.now() - l.mtimeMs > this.staleLockMs);
    }

    // Only the holder of the breaker lock clears a stale lock, so between its look and its move
    // nothing else can put a new lock in that place: a live holder never removes a lock not its
    // own. The stale file is moved whole to a tombstone of our own and checked to be the one
    // judged stale; anything else that moved is linked back. The caller then takes the lock
    // through O_EXCL like any waiter
    private async clearStale(lock: string, nonce: string): Promise<void> {
        const seen = await inspect(lock);
        if (seen === null || !this.isStale(seen)) return;
        const breaker = `${lock}.break`;
        if (!(await this.tryCreate(breaker, nonce))) {
            const held = await inspect(breaker);
            if (held !== null && this.isStale(held)) await this.bury(breaker, held);
            return;
        }
        try {
            const now = await inspect(lock);
            if (now !== null && sameFile(now, seen) && this.isStale(now)) {
                await this.bury(lock, now);
            }
        } finally {
            if ((await readLock(breaker)) === nonce) await unlink(breaker).catch(() => {});
        }
    }

    private async bury(path: string, seen: LockFile): Promise<void> {
        const tomb = `${path}.dead.${randomUUID()}`;
        try {
            await rename(path, tomb);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
            throw e;
        }
        const moved = await inspect(tomb);
        if (moved === null || !sameFile(moved, seen) || moved.text !== seen.text) {
            await link(tomb, path).catch(() => {});
        }
        await unlink(tomb).catch(() => {});
    }

    private async read(): Promise<Doc> {
        let text: string;
        try {
            text = await readFile(this.path, "utf8");
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                return { day: this.day(), entries: {} };
            }
            throw e;
        }
        let doc: unknown;
        try {
            doc = JSON.parse(text);
        } catch {
            throw new LedgerError("ledger_corrupt");
        }
        const d = doc as Doc;
        if (
            typeof d !== "object" ||
            d === null ||
            typeof d.day !== "string" ||
            typeof d.entries !== "object" ||
            d.entries === null ||
            !Object.values(d.entries).every(isEntry)
        ) {
            throw new LedgerError("ledger_corrupt");
        }
        // A new UTC day starts from nothing
        return d.day === this.day() ? d : { day: this.day(), entries: {} };
    }

    // Written only while the lock is still ours, so a lost lock never overwrites another's work
    private async write(doc: Doc, mine: () => Promise<boolean>): Promise<void> {
        if (!(await mine())) throw new LedgerError("ledger_busy");
        const tmp = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify(doc), { mode: 0o600 });
        await rename(tmp, this.path);
    }

    // Holds the amount against today's cap before anything is signed; false when it would not fit
    async reserve(orderId: string, micros: number, dailyCapMicros: number): Promise<boolean> {
        return this.withLock(async (mine) => {
            const doc = await this.read();
            if (Object.hasOwn(doc.entries, orderId)) return false;
            const used = Object.values(doc.entries).reduce((n, e) => n + e.micros, 0);
            if (used + micros > dailyCapMicros) return false;
            doc.entries[orderId] = { micros, state: "reserved" };
            await this.write(doc, mine);
            return true;
        });
    }

    // Spent stays counted; a payment that surely moved nothing frees its reservation
    async settle(orderId: string, spent: boolean): Promise<void> {
        await this.withLock(async (mine) => {
            const doc = await this.read();
            const e = doc.entries[orderId];
            if (e === undefined) return;
            if (spent) e.state = "spent";
            else delete doc.entries[orderId];
            await this.write(doc, mine);
        });
    }

    async spentToday(): Promise<number> {
        return this.withLock(async () =>
            Object.values((await this.read()).entries).reduce((n, e) => n + e.micros, 0),
        );
    }
}
