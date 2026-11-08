// What the key signer spent today (UTC), shared by every bridge process through one lockfile
import { constants } from "node:fs";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

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
    // A lock older than this belongs to a process that died holding it
    staleLockMs?: number;
    lockWaitMs?: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

    private async withLock<T>(work: () => Promise<T>): Promise<T> {
        const lock = `${this.path}.lock`;
        const started = Date.now();
        for (;;) {
            try {
                const fh = await open(
                    lock,
                    constants.O_WRONLY |
                        constants.O_CREAT |
                        constants.O_EXCL |
                        constants.O_NOFOLLOW,
                    0o600,
                );
                await fh.close();
                break;
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            }
            const st = await stat(lock).catch(() => null);
            if (st !== null && Date.now() - st.mtimeMs > this.staleLockMs) {
                await unlink(lock).catch(() => {});
                continue;
            }
            if (Date.now() - started > this.lockWaitMs) throw new LedgerError("ledger_busy");
            await wait(10 + Math.random() * 20);
        }
        try {
            return await work();
        } finally {
            await unlink(lock).catch(() => {});
        }
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

    private async write(doc: Doc): Promise<void> {
        const tmp = `${this.path}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(doc), { mode: 0o600 });
        await rename(tmp, this.path);
    }

    // Holds the amount against today's cap before anything is signed; false when it would not fit
    async reserve(orderId: string, micros: number, dailyCapMicros: number): Promise<boolean> {
        return this.withLock(async () => {
            const doc = await this.read();
            if (Object.hasOwn(doc.entries, orderId)) return false;
            const used = Object.values(doc.entries).reduce((n, e) => n + e.micros, 0);
            if (used + micros > dailyCapMicros) return false;
            doc.entries[orderId] = { micros, state: "reserved" };
            await this.write(doc);
            return true;
        });
    }

    // Spent stays counted; a payment that surely moved nothing frees its reservation
    async settle(orderId: string, spent: boolean): Promise<void> {
        await this.withLock(async () => {
            const doc = await this.read();
            const e = doc.entries[orderId];
            if (e === undefined) return;
            if (spent) e.state = "spent";
            else delete doc.entries[orderId];
            await this.write(doc);
        });
    }

    async spentToday(): Promise<number> {
        return this.withLock(async () =>
            Object.values((await this.read()).entries).reduce((n, e) => n + e.micros, 0),
        );
    }
}
