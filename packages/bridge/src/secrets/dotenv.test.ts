import { describe, expect, it } from "vitest";
import { parseDotenv } from "./dotenv.ts";

describe("parseDotenv", () => {
    it("reads plain, exported, quoted and commented lines as dotenv does", () => {
        const env = parseDotenv(
            [
                "# a comment",
                "PLAIN=abc",
                "export EXPORTED = def ",
                "SINGLE='g h # not a comment'",
                'DOUBLE="line1\\nline2"',
                "BACKTICK=`x'y\"z`",
                "TRAILING=value # comment",
                "EMPTY=",
                "COLON: yes",
                "",
                "not a line",
            ].join("\r\n"),
        );
        expect(Object.fromEntries(env)).toEqual({
            PLAIN: "abc",
            EXPORTED: "def",
            SINGLE: "g h # not a comment",
            DOUBLE: "line1\nline2",
            BACKTICK: "x'y\"z",
            TRAILING: "value",
            EMPTY: "",
            COLON: "yes",
        });
    });

    it("keeps a quoted value across lines and lets a later line win", () => {
        const env = parseDotenv('KEY="-----BEGIN-----\nbody\n-----END-----"\nA=1\nA=2\n');
        expect(env.get("KEY")).toBe("-----BEGIN-----\nbody\n-----END-----");
        expect(env.get("A")).toBe("2");
    });

    it("leaves escapes alone in single quotes", () => {
        expect(parseDotenv("K='a\\nb'").get("K")).toBe("a\\nb");
    });
});
