import { describe, expect, it } from "vitest";
import { createGate } from "./gate.ts";

describe("createGate", () => {
    it("queues past the limit, refuses past the queue and drops a waiter that aborts", async () => {
        const gate = createGate(1, 1);
        let finish = () => {};
        const first = gate(
            () => new Promise<string>((resolve) => (finish = () => resolve("first"))),
            AbortSignal.timeout(5000),
        );
        const stop = new AbortController();
        const queued = gate(async () => "queued", stop.signal);
        expect(await gate(async () => "refused", AbortSignal.timeout(5000))).toBeNull();
        stop.abort(new Error("gave up"));
        await expect(queued).rejects.toThrow("gave up");
        const next = gate(async () => "next", AbortSignal.timeout(5000));
        finish();
        expect(await first).toBe("first");
        expect(await next).toBe("next");
        expect(await gate(async () => "free", AbortSignal.timeout(5000))).toBe("free");
    });
});
