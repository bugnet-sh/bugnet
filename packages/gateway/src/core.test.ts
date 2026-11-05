import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { ConfigError, checkSettings, parseDuration, parseSettings, readSecrets } from "./config.ts";
import { fromRouter, safeMessage } from "./router.ts";
import { cleanText, looksLikeText, tail } from "./sanitize.ts";
import { secretLooking } from "./tools/jobs.ts";
import { recommend } from "./tools/quote.ts";
import type { QuotedPackage } from "./quote.ts";

describe("sanitize", () => {
    it("strips escape sequences, controls and bidi overrides", () => {
        const raw = "\u001b[31mred\u001b[0m \u001b]0;title\u0007ok\r\nnext\u0000\u202eevil";
        expect(cleanText(raw)).toBe("red ok\nnextevil");
    });

    it("keeps the last bytes on a line boundary", () => {
        const t = tail("line one\nline two\nline three\n", 16);
        expect(t.truncated).toBe(true);
        expect(t.text).toBe("line three\n");
    });

    it("tells text from binary", () => {
        expect(looksLikeText(new TextEncoder().encode("h\u00e9llo"))).toBe(true);
        expect(looksLikeText(new Uint8Array([0x89, 0x50, 0x00, 0xff]))).toBe(false);
    });
});

describe("config", () => {
    it("rejects unknown keys by name", () => {
        expect(() => parseSettings('listen_adr = "x"')).toThrow(/unknown key listen_adr/);
        expect(() => parseSettings("[router]\nurll = 1")).toThrow(/router.urll/);
    });

    it("parses durations and defaults", () => {
        expect(parseDuration("10m")).toBe(600_000);
        const s = parseSettings("");
        expect(s.limits.quote_ttl).toBe(600_000);
        expect(s.router.timeout).toBe(50_000);
    });

    it("keeps dev payments on loopback", () => {
        const s = parseSettings('listen_addr = "0.0.0.0:8787"\n[payments]\nmode = "dev"');
        expect(() => checkSettings(s)).toThrow(ConfigError);
        const ok = parseSettings('[payments]\nmode = "dev"');
        expect(() => checkSettings(ok)).not.toThrow();
    });

    it("needs the secrets each mode uses", () => {
        const s = parseSettings('[payments]\nmode = "dev"');
        const base = {
            BUGNET_INTERNAL_TOKEN: "x".repeat(32),
            BUGNET_QUOTE_KEY: Buffer.alloc(32).toString("base64"),
        };
        expect(() => readSecrets(base, s)).toThrow(/BUGNET_ORDER_PRIVATE_KEY/);
        const env = { ...base, BUGNET_ORDER_PRIVATE_KEY: Buffer.alloc(32).toString("base64") };
        expect(readSecrets(env, s).orderPrivateKey?.length).toBe(32);
    });
});

describe("router errors", () => {
    it("maps codes and never names a provider", () => {
        const e = new ConnectError("saga: e2b refused the boxd thing", Code.FailedPrecondition);
        expect(safeMessage(e)).toBe("provider refused the provider thing");
        expect(fromRouter(new ConnectError("x", Code.NotFound), "exec").kind).toBe("not_found");
        expect(fromRouter(new Error("boom"), "exec").message).toBe("exec failed");
    });
});

describe("exec env", () => {
    it("flags values shaped like tokens", () => {
        expect(secretLooking({ A: "plain", B: "hf_" + "a".repeat(34) })).toBe("B");
        expect(secretLooking({ PATH: "/usr/bin" })).toBeNull();
    });
});

describe("recommend", () => {
    const pkg = (id: string, price: number, minutes: number, mem: number): QuotedPackage => ({
        id,
        priceMicros: price,
        minutes,
        vcpu: 2,
        memoryMib: mem,
        diskGib: 10,
        gpuCount: 0,
    });
    const pkgs = [pkg("s10", 50, 10, 2048), pkg("s30", 120, 30, 2048), pkg("l30", 300, 30, 8192)];

    it("picks the cheapest long enough package for light work", () => {
        expect(recommend(pkgs, "tests", 20)?.pkg.id).toBe("s30");
        expect(recommend(pkgs, "script", undefined)?.pkg.id).toBe("s10");
    });

    it("picks the most memory for inference", () => {
        expect(recommend(pkgs, "inference", undefined)?.pkg.id).toBe("l30");
    });
});
