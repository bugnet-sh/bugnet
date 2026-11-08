// What the key signer spent today (UTC), shared by every bridge process with no lock: a folder per
// day holds one file per reservation, written whole then linked in place (link fails if it exists),
// and a claim that then finds the day over its cap takes its own file back. Two claims at the cap
// can both back off; none goes over it
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
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
    // ~/.config/bugnet/spend; each UTC day gets a folder under it
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

export class SpendLedger {
    private readonly dir: string;
    private readonly now: () => number;
    private readonly unreadableMicros: number;
    private readonly retries: number;
    // This process's own reservations, the only files settle touches
    private readonly mine = new Map<string, { day: string; micros: number }>();

    constructor(opts: SpendLedgerOptions) {
        this.dir = opts.dir;
        this.now = opts.now ?? Date.now;
        this.unreadableMicros = opts.unreadableMicros ?? paymentCeilingUsd * 1_000_000;
        this.retries = opts.retries ?? 4;
    }

    private day(): string {
        return new Date(this.now()).toISOString().slice(0, 10);
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

    private body(orderId: string, micros: number, state: State): string {
        return JSON.stringify({ orderId, micros, state, at: this.now() });
    }

    // A file that vanished was freed or backed off; one that cannot be read counts in full
    private async count(folder: string, name: string): Promise<number> {
        let text: string;
        try {
            const fh = await open(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const st = await fh.stat();
                if (!st.isFile() || st.size > maxFileBytes) return this.unreadableMicros;
                text = await fh.readFile("utf8");
            } finally {
                await fh.close();
            }
        } catch (e) {
            return isMissing(e) ? 0 : this.unreadableMicros;
        }
        const entry = parse(text, name);
        if (entry === null) return this.unreadableMicros;
        return entry.state === "freed" ? 0 : entry.micros;
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
        // Temp files of a settle in progress are skipped: the file they replace still counts
        for (const name of names) {
            if (fileName.test(name)) sum += await this.count(folder, name);
        }
        return sum;
    }

    // Holds the amount against today's cap before anything is signed. A claim that backed off
    // looks again after a short random wait and tries afresh while the day, without it, still
    // has room: claims made at the same moment see each other and could otherwise all back off
    async claim(orderId: string, micros: number, dailyCapMicros: number): Promise<Reservation> {
        checkOrder(orderId);
        if (!Number.isSafeInteger(micros) || micros < 0 || micros > this.unreadableMicros) {
            throw new RangeError("micros");
        }
        const day = this.day();
        const folder = await this.folder(day);
        for (let attempt = 0; ; attempt++) {
            const result = await this.tryClaim(folder, orderId, micros, dailyCapMicros);
            if (result === "reserved") this.mine.set(orderId, { day, micros });
            if (result !== "over_cap" || attempt === this.retries) return result;
            await wait(2 + Math.random() * 8 * (attempt + 1));
            if ((await this.total(folder)) + micros > dailyCapMicros) return "over_cap";
        }
    }

    // Each try is whole on its own: the file is made first, then every file of the day is summed,
    // so of two tries the later to make its file always sees the other
    private async tryClaim(
        folder: string,
        orderId: string,
        micros: number,
        dailyCapMicros: number,
    ): Promise<Reservation> {
        const file = join(folder, nameOf(orderId));
        // Written whole under a temp name, then linked: a crash leaves at worst an uncounted temp
        // file, never an empty reservation that would hold the ceiling until the next day
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

    // Spent stays counted; a payment that surely moved nothing frees its reservation
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
