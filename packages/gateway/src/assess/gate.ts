export type Gate = <T>(work: () => Promise<T>, signal: AbortSignal) => Promise<T | null>;

// Runs at most max jobs at once with a bounded queue, and answers null when the queue is full
export function createGate(max: number, queued: number): Gate {
    let active = 0;
    const waiting: (() => void)[] = [];
    const release = () => {
        const next = waiting.shift();
        if (next) next();
        else active--;
    };
    return async (work, signal) => {
        if (active < max) {
            active++;
        } else {
            if (waiting.length >= queued) return null;
            // A finishing job hands its slot straight to the next waiter, so active never overshoots
            await new Promise<void>((resolve, reject) => {
                const go = () => {
                    signal.removeEventListener("abort", stop);
                    resolve();
                };
                const stop = () => {
                    const i = waiting.indexOf(go);
                    if (i >= 0) waiting.splice(i, 1);
                    reject(signal.reason);
                };
                if (signal.aborted) {
                    reject(signal.reason);
                    return;
                }
                waiting.push(go);
                signal.addEventListener("abort", stop, { once: true });
            });
        }
        try {
            return await work();
        } finally {
            release();
        }
    };
}
