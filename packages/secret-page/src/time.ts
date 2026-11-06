const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
];

export function relative(date: Date, now: Date): string {
    const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
    const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    for (const [unit, size] of units) {
        if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
    }
    return "just now";
}

// The reader's own clock and locale, with the distance from now that makes a stale link obvious
export function shownTime(date: Date | null, now: Date, locale?: string): string {
    if (!date) return "unknown";
    const at = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
    return `${at.format(date)} (${relative(date, now)})`;
}
