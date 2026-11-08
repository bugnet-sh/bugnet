// What the key signer spent today (UTC), shared by every bridge process through one lockfile
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";

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
    // A lock is held for milliseconds, so one this old is taken as left by a crash whatever its pid
    staleLockMs?: number;
    lockWaitMs?: number;
}

// The lock moved away before a write, so nothing was written and the work may run again
class LostLock extends LedgerError {
    constructor() {
        super("ledger_busy");
    }
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

const maxPid = 2 ** 31 - 1;

// ESRCH is the only proof of death and EPERM the only proof of life (another user's process);
// any other answer or a pid out of range leaves the lock to the age rule
function holder(text: string): "alive" | "dead" | "unknown" {
    const m = /^(\d{1,10}) /.exec(text);
    const pid = m ? Number(m[1]) : 0;
    if (pid < 1 || pid > maxPid) return "unknown";
    try {
        process.kill(pid, 0);
        return "alive";
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return code === "ESRCH" ? "dead" : code === "EPERM" ? "alive" : "unknown";
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
    // a holder only removes its own. work gets a check that the lock is still ours, which write
    // runs just before its rename; a lock lost before that runs the work again under a new one
    private async withLock<T>(work: (mine: () => Promise<boolean>) => Promise<T>): Promise<T> {
        const lock = `${this.path}.lock`;
        const started = Date.now();
        for (;;) {
            const nonce = `${process.pid} ${randomUUID()}`;
            await this.acquire(lock, nonce, started);
            try {
                return await work(async () => (await readLock(lock)) === nonce);
            } catch (e) {
                if (!(e instanceof LostLock)) throw e;
                if (Date.now() - started > this.lockWaitMs) throw new LedgerError("ledger_busy");
            } finally {
                if ((await readLock(lock)) === nonce) await unlink(lock).catch(() => {});
            }
        }
    }

    private async acquire(lock: string, nonce: string, started: number): Promise<void> {
        for (;;) {
            if (await this.tryCreate(lock, nonce)) return;
            if ((await this.clearStale(lock)) && (await this.tryCreate(lock, nonce))) return;
            if (Date.now() - started > this.lockWaitMs) throw new LedgerError("ledger_busy");
            await wait(10 + Math.random() * 20);
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

    // Stale: older than staleLockMs, or younger with a pid that is surely dead
    private isStale(l: LockFile): boolean {
        if (Math.abs(Date.now() - l.mtimeMs) > this.staleLockMs) return true;
        return holder(l.text) === "dead";
    }

    // The stale lock is moved whole to a tombstone of our own, then removed. True when the
    // tombstone is the file judged stale. Otherwise a fresh lock was moved: it is never put back,
    // its holder's check before writing fails and it runs again, and we wait before taking the
    // lock so a write already past that check lands first
    private async clearStale(lock: string): Promise<boolean> {
        const seen = await inspect(lock);
        if (seen === null || !this.isStale(seen)) return false;
        const tomb = `${lock}.dead.${randomUUID()}`;
        try {
            await rename(lock, tomb);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw e;
        }
        const moved = await inspect(tomb);
        await unlink(tomb).catch(() => {});
        return (
            moved !== null &&
            moved.dev === seen.dev &&
            moved.ino === seen.ino &&
            moved.text === seen.text
        );
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

    // Renamed into place only while the lock is still ours, so a lost lock never overwrites
    // another's work; the check runs after the temp file is written to keep that gap short
    private async write(doc: Doc, mine: () => Promise<boolean>): Promise<void> {
        const tmp = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify(doc), { mode: 0o600 });
        if (!(await mine())) {
            await unlink(tmp).catch(() => {});
            throw new LostLock();
        }
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
