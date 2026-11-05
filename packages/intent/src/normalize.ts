// Longer inputs keep their start and end, where requests and error lines usually sit
const headChars = 16_000;
const tailChars = 4_000;

const letterFolds: Record<string, string> = {
    ı: "i",
    ß: "ss",
    ø: "o",
    æ: "ae",
    œ: "oe",
    ł: "l",
    đ: "d",
    þ: "th",
};

export function clip(s: string): string {
    if (s.length <= headChars + tailChars) return s;
    return `${s.slice(0, headChars)}\n${s.slice(-tailChars)}`;
}

// Newlines survive because prompts are split into clauses on them, and the result is pure ASCII
export function norm(s: string): string {
    const c = clip(s);
    if (/^[\t\n\r -~]*$/.test(c)) return collapse(c.toLowerCase());
    return collapse(
        c
            .toLowerCase()
            .normalize("NFKD")
            .replace(/\p{M}+/gu, "")
            .replace(/[ıßøæœłđþ]/g, (ch) => letterFolds[ch] ?? ch)
            .replace(/[\p{Cf}]/gu, "")
            .replace(/[\p{Pi}\p{Pf}]/gu, "'")
            .replace(/\p{Pd}/gu, "-")
            .replace(/[^\t\n\r -~]+/g, " "),
    );
}

function collapse(s: string): string {
    return s
        .replace(/[^\S\n]+/g, " ")
        .replace(/ ?\n[\s]*/g, "\n")
        .trim();
}

// Patterns are ASCII, and a string that never held another character keeps V8's one-byte form
export function ascii(s: string): string {
    return s.replace(/[^\t\n\r -~]/g, "?");
}

// Identifiers such as claim_airdrop.py or lpe-poc split into words, so word patterns match them
export function spaced(s: string): string {
    return s.replace(/[_./:@=+\\-]+/g, " ");
}

// A subject in the case the user typed it, found case-insensitively in the original text
export function asTyped(subject: string, source: string): string {
    const pattern = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ +/g, "\\s+");
    return new RegExp(pattern, "i").exec(source)?.[0] ?? subject;
}

// Text from the user that goes into a hint, without quotes, markup or control characters
export function quoteSafe(s: string, max = 60): string {
    const flat = s
        .replace(/\\/g, "/")
        .replace(/[\p{Cc}\p{Cf}"`<>]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}
