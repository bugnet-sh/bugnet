import { readFileSync } from "node:fs";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it } from "vitest";
import {
    ConfigError,
    checkSettings,
    isLoopback,
    parseDuration,
    parseSettings,
    readSecrets,
} from "./config.ts";
import { fromRouter, safeMessage, setProviderNames } from "./router.ts";
import { cleanText, looksLikeText, tail } from "./sanitize.ts";
import vectors from "./testing/sanitize-vectors.json" with { type: "json" };
import { x402Vector } from "./testing/vectors.ts";
import { secretLooking } from "./tools/jobs.ts";
import { recommend } from "./tools/quote.ts";
import type { QuotedPackage } from "./quote.ts";

describe("sanitize", () => {
    // The vectors are plain JSON so the router's Go sanitiser can run the same cases
    it.each(vectors)("cleans $name", ({ in: raw, out }) => {
        expect(cleanText(raw)).toBe(out);
    });

    it("cleans hostile input in linear time", () => {
        const raw = ("x" + "\u0301".repeat(50) + "\r\u200b\udb40\udc41").repeat(20_000);
        const started = performance.now();
        const clean = cleanText(raw);
        expect(performance.now() - started).toBeLessThan(2_000);
        expect(clean).not.toMatch(/[\u200b\r]/);
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
        expect(s.router.timeout).toBe(20_000);
    });

    it("keeps dev payments on loopback", () => {
        const s = parseSettings('listen_addr = "0.0.0.0:8787"\n[payments]\nmode = "dev"');
        expect(() => checkSettings(s)).toThrow(ConfigError);
        const ok = parseSettings('[payments]\nmode = "dev"');
        expect(() => checkSettings(ok)).not.toThrow();
    });

    it("counts only real loopback literals as loopback", () => {
        for (const url of ["http://localhost:8787", "http://[::1]:8787", "http://127.0.0.2:8787"]) {
            expect(isLoopback(url), url).toBe(true);
        }
        for (const url of ["http://127.attacker.example", "http://127.0.0.1.nip.io:8787"]) {
            expect(isLoopback(url), url).toBe(false);
        }
        const s = parseSettings(
            'public_url = "http://127.0.0.1.nip.io:8787"\n[payments]\nmode = "dev"',
        );
        expect(() => checkSettings(s)).toThrow(ConfigError);
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

    it("keeps dev_require_payment off by default and for dev payments only", () => {
        expect(parseSettings("").payments.dev_require_payment).toBe(false);
        const http = parseSettings(
            '[payments]\nurl = "http://127.0.0.1:8450"\ndev_require_payment = true',
        );
        expect(() => checkSettings(http)).toThrow(
            "payments.dev_require_payment needs payments.mode dev",
        );
        const dev = parseSettings('[payments]\nmode = "dev"\ndev_require_payment = true');
        expect(() => checkSettings(dev)).not.toThrow();
    });

    it("lists every payments setting at its default in config/example.toml", () => {
        const example = readFileSync(
            new URL("../../../config/example.toml", import.meta.url),
            "utf8",
        );
        expect(parseSettings(example, "example.toml").payments).toEqual(parseSettings("").payments);
    });
});

const sixteen = [
    "workers.dev",
    "onrender.com",
    "vercel.app",
    "netlify.app",
    "pages.dev",
    "herokuapp.com",
    "fly.dev",
    "up.railway.app",
    "replit.app",
    "ngrok-free.app",
    "ngrok.io",
    "trycloudflare.com",
    "github.io",
    "glitch.me",
    "deno.dev",
    "web.app",
];
// Dev payments on loopback pass every other checkSettings rule, so only the x402 checks can throw
const devX402 = (lines: string) => parseSettings(`[payments]\nmode = "dev"\n[x402]\n${lines}`);

describe("x402 settings", () => {
    it("defaults every [x402] key as spec 5.1 gives it", () => {
        expect(parseSettings("").x402).toEqual({
            enabled: false,
            cdp_search_url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search",
            payai_resources_url: "https://facilitator.payai.network/discovery/resources",
            hosts_seen_file: "",
            search_timeout: 4_000,
            probe_timeout: 3_000,
            probe_concurrency: 8,
            probe_max_bytes: 65_536,
            search_cache_ttl: 600_000,
            probe_cache_ttl: 120_000,
            payai_refresh: 3_600_000,
            max_results: 5,
            default_max_price_usd: "0.10",
            sandbox_host_domains: [],
            shared_hosting_suffixes: sixteen,
        });
    });
    it("keeps the shared-hosting list equal to the shared vector the router reads", () => {
        expect(parseSettings("").x402.shared_hosting_suffixes).toEqual(
            (x402Vector("shared-hosting-suffixes.json") as { suffixes: string[] }).suffixes,
        );
    });
    it("names an unknown x402 key, an index file among them", () => {
        expect(() => parseSettings("[x402]\nfoo = 1")).toThrow(/unknown key x402\.foo/);
        expect(() => parseSettings('[x402]\nindex_file = "/tmp/x402-index.json"')).toThrow(
            /unknown key x402\.index_file/,
        );
    });
    it.each([
        [
            'shared_hosting_suffixes = ["a.dev", "b.dev", "a.dev"]',
            "x402.shared_hosting_suffixes holds a.dev twice",
        ],
        ['cdp_search_url = "http://search.example/s"', "x402.cdp_search_url must be https"],
        [
            'payai_resources_url = "http://payai.example/r"',
            "x402.payai_resources_url must be https",
        ],
        ['search_timeout = "499ms"', "x402.search_timeout must be 500ms to 10s"],
        ['search_timeout = "11s"', "x402.search_timeout must be 500ms to 10s"],
        ['probe_timeout = "499ms"', "x402.probe_timeout must be 500ms to 10s"],
        ['probe_timeout = "11s"', "x402.probe_timeout must be 500ms to 10s"],
        ['payai_refresh = "59s"', "x402.payai_refresh must be 1m or more"],
        ['default_max_price_usd = "0.000000"', "x402.default_max_price_usd must be above 0"],
    ])("refuses %s", (line, message) => {
        expect(() => checkSettings(devX402(line))).toThrow(new ConfigError(message));
    });
    it("takes the bounds themselves", () => {
        const s = devX402(
            'search_timeout = "500ms"\nprobe_timeout = "10s"\npayai_refresh = "1m"\ndefault_max_price_usd = "0.000001"',
        );
        expect(() => checkSettings(s)).not.toThrow();
        expect(() => checkSettings(devX402(""))).not.toThrow();
    });
    it.each([
        ["probe_concurrency = 0", /x402\.probe_concurrency/],
        ["probe_concurrency = 33", /x402\.probe_concurrency/],
        ["probe_max_bytes = 1023", /x402\.probe_max_bytes/],
        ["max_results = 6", /x402\.max_results/],
        ['default_max_price_usd = "$0.10"', /a dollar amount such as 0\.10/],
        ['shared_hosting_suffixes = ["Workers.dev"]', /a lower-case domain such as workers\.dev/],
    ])("refuses the value %s", (line, message) => {
        expect(() => parseSettings(`[x402]\n${line}`)).toThrow(message);
    });
    it("lists [x402] at its defaults in config/example.toml", () => {
        const example = readFileSync(
            new URL("../../../config/example.toml", import.meta.url),
            "utf8",
        );
        expect(example).toContain("\n[x402]\n");
        expect(parseSettings(example, "example.toml").x402).toEqual(parseSettings("").x402);
    });
});

describe("provider settings", () => {
    it("default to no provider names and no sandbox host domains", () => {
        expect(parseSettings("").router.provider_names).toEqual([]);
        expect(parseSettings("").x402.sandbox_host_domains).toEqual([]);
    });
    it("take lower-case provider names and domains", () => {
        const s = parseSettings(
            '[router]\nprovider_names = ["acmebox", "cloud-vm"]\n' +
                '[x402]\nsandbox_host_domains = ["acmebox.dev"]',
        );
        expect(s.router.provider_names).toEqual(["acmebox", "cloud-vm"]);
        expect(s.x402.sandbox_host_domains).toEqual(["acmebox.dev"]);
    });
    it.each([
        ['[router]\nprovider_names = ["AcmeBox"]', /a lower-case provider name/],
        ['[router]\nprovider_names = ["a"]', /a lower-case provider name/],
        ['[x402]\nsandbox_host_domains = ["AcmeBox.dev"]', /a lower-case domain/],
    ])("refuses %s", (toml, message) => {
        expect(() => parseSettings(toml)).toThrow(message);
    });
    it("lists both in config/example.toml, empty, as the real names stay private", () => {
        const example = readFileSync(
            new URL("../../../config/example.toml", import.meta.url),
            "utf8",
        );
        expect(example).toMatch(/\nprovider_names = \[\]/);
        expect(example).toMatch(/\nsandbox_host_domains = \[\]/);
    });
});

describe("router errors", () => {
    afterEach(() => setProviderNames([]));
    it("maps codes and never names a configured provider", () => {
        setProviderNames(["acmebox", "cloudvm"]);
        const e = new ConnectError(
            "saga: acmebox refused the CloudVM thing",
            Code.FailedPrecondition,
        );
        expect(safeMessage(e)).toBe("provider refused the provider thing");
        expect(fromRouter(new ConnectError("x", Code.NotFound), "exec").kind).toBe("not_found");
        expect(fromRouter(new Error("boom"), "exec").message).toBe("exec failed");
    });
    it("keeps a word whole, so a name inside another word stays", () => {
        setProviderNames(["acme"]);
        expect(safeMessage(new ConnectError("acme said no to acmes", Code.NotFound))).toBe(
            "provider said no to acmes",
        );
    });
    it("passes the text on when no provider is configured", () => {
        setProviderNames([]);
        const e = new ConnectError("saga: acmebox refused", Code.FailedPrecondition);
        expect(safeMessage(e)).toBe("acmebox refused");
    });
});

describe("exec env", () => {
    it("flags values shaped like tokens", () => {
        expect(secretLooking({ A: "plain", B: "hf_" + "a".repeat(34) })).toBe("B");
        expect(secretLooking({ K: "bnk_" + "Ab9-_".repeat(9) })).toBe("K");
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

    it("picks the longest package when none lasts the expected time", () => {
        const short = [pkg("a1", 10, 1, 1024), pkg("a10", 50, 10, 1024)];
        expect(recommend(short, "serve", undefined)).toEqual({
            pkg: short[1],
            why: "it is the longest package, and none lasts 20 min, so extend it when needed",
        });
        expect(recommend(short, "script", 30)?.pkg.id).toBe("a10");
    });

    it("gives the length as the reason when every long enough package has the same memory", () => {
        const same = [pkg("a1", 10, 1, 1024), pkg("a10", 50, 10, 1024)];
        expect(recommend(same, "build", 5)).toEqual({
            pkg: same[1],
            why: "it is the cheapest package that lasts 5 min",
        });
    });
});
