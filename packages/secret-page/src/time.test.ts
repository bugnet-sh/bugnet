import { describe, expect, it } from "vitest";
import { relative, shownTime } from "./time.ts";

const now = new Date("2026-11-05T14:00:00Z");
const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);

describe("relative", () => {
    it("rounds toward now in the largest whole unit", () => {
        expect(relative(at(-5), now)).toBe("just now");
        expect(relative(at(-12 * 60 - 30), now)).toBe("12 minutes ago");
        expect(relative(at(9 * 60), now)).toBe("in 9 minutes");
        expect(relative(at(-3 * 3600), now)).toBe("3 hours ago");
        expect(relative(at(-86_400), now)).toBe("yesterday");
    });
});

describe("shownTime", () => {
    it("gives the local time and the distance from now", () => {
        expect(shownTime(at(-60), now, "en-GB")).toMatch(
            /^\d{1,2} Nov 2026, \d\d:\d\d \(1 minute ago\)$/,
        );
        expect(shownTime(null, now)).toBe("unknown");
    });
});
