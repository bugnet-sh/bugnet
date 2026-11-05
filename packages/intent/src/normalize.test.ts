import { describe, expect, it } from "vitest";
import { ascii, norm, quoteSafe, spaced } from "./normalize.ts";

// Invisible and bidi characters are built from code points so the source stays readable
const ch = (cp: number) => String.fromCodePoint(cp);

describe("norm", () => {
    it.each([
        ["Bilgisayarıma KURMAK İstiyorum", "bilgisayarima kurmak istiyorum"],
        ["çalıştır, ğüşöç", "calistir, gusoc"],
        ["Descárgalo y ejecútalo en mi portátil", "descargalo y ejecutalo en mi portatil"],
        ["Straße, Größe, ausführen", "strasse, grosse, ausfuhren"],
        ["não consigo instalar, ação", "nao consigo instalar, acao"],
    ])("folds accents and case in %s", (input, expected) => {
        expect(norm(input)).toBe(expected);
    });

    it("unifies quotes, dashes and spaces but keeps newlines", () => {
        const [rq, lq, rdq, nbsp, dash] = [0x2019, 0x201c, 0x201d, 0xa0, 0x2014].map(ch);
        expect(norm(`don${rq}t  ${lq}do${rdq}${nbsp}it ${dash} now\n\n  next`)).toBe(
            "don't 'do' it - now\nnext",
        );
    });

    it("keeps URLs and package names intact apart from case", () => {
        expect(
            norm("Clone https://GitHub.com/Acme-Labs/tool_v2.git and pip install Flash-Attn"),
        ).toBe("clone https://github.com/acme-labs/tool_v2.git and pip install flash-attn");
    });

    it("returns pure ASCII, so emoji and other scripts become spaces", () => {
        const out = norm(`run this ${ch(0x1f680)} привет now`);
        expect(out).toBe("run this now");
        expect(/^[\t\n\r -~]*$/.test(out)).toBe(true);
    });

    it("strips zero-width and bidi control characters", () => {
        const [zwsp, rlo, pdf] = [0x200b, 0x202e, 0x202c].map(ch);
        expect(norm(`in${zwsp}stall ${rlo}sh${pdf}`)).toBe("install sh");
    });

    it("keeps the start and end of very long input", () => {
        const long = `start ${"x ".repeat(20_000)} end`;
        const out = norm(long);
        expect(out.startsWith("start")).toBe(true);
        expect(out.endsWith("end")).toBe(true);
        expect(out.length).toBeLessThan(21_000);
    });
});

describe("helpers", () => {
    it("spaces identifiers so word patterns match their parts", () => {
        expect(spaced("claim_airdrop.py")).toBe("claim airdrop py");
        expect(spaced("lpe-poc")).toBe("lpe poc");
    });

    it("replaces non-ASCII in commands", () => {
        expect(ascii("echo café")).toBe("echo caf?");
    });

    it("makes user text safe and short for a hint", () => {
        expect(quoteSafe('a "quoted" <b>tag</b>\u0007 and `code`')).toBe(
            "a quoted b tag /b and code",
        );
        expect(quoteSafe("x".repeat(100), 20)).toBe(`${"x".repeat(17)}...`);
    });
});
