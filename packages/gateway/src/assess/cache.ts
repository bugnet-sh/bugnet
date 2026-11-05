// Map order doubles as recency, so the first key is always the one to evict
export class TtlCache<T> {
    private readonly entries = new Map<string, { value: T; expires: number }>();
    private readonly ttlMs: number;
    private readonly max: number;
    private readonly now: () => number;

    constructor(ttlMs: number, max: number, now: () => number) {
        this.ttlMs = ttlMs;
        this.max = max;
        this.now = now;
    }

    get(key: string): T | undefined {
        const e = this.entries.get(key);
        if (!e) return undefined;
        this.entries.delete(key);
        if (e.expires <= this.now()) return undefined;
        this.entries.set(key, e);
        return e.value;
    }

    set(key: string, value: T): void {
        this.entries.delete(key);
        this.entries.set(key, { value, expires: this.now() + this.ttlMs });
        while (this.entries.size > this.max) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    get size(): number {
        return this.entries.size;
    }
}
