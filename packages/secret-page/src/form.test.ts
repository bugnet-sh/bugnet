import { describe, expect, it } from "vitest";
import {
    check,
    hostViews,
    isGitHub,
    knownNames,
    prefill,
    readHosts,
    refusedHeader,
    reservedName,
    splitList,
    valueNotes,
    type Draft,
} from "./form.ts";

const spec = (name: string, hosts: string[] = []) => ({
    name,
    hosts,
    headerNames: [],
    fetchOnly: false,
});

const draft = (d: Partial<Draft> = {}): Draft => ({
    name: "HF_TOKEN",
    value: "hf_abc",
    hosts: "huggingface.co",
    headers: "",
    sandboxUse: false,
    ...d,
});

describe("prefill", () => {
    it("fills a known name with its preset's hosts and headers", () => {
        expect(prefill(spec("HF_TOKEN"))).toEqual({
            name: "HF_TOKEN",
            hosts: ["huggingface.co"],
            headerNames: [],
        });
        expect(prefill(spec("ANTHROPIC_API_KEY"))).toEqual({
            name: "ANTHROPIC_API_KEY",
            hosts: ["api.anthropic.com"],
            headerNames: ["x-api-key"],
        });
    });

    it("keeps suggested hosts only inside the name's preset", () => {
        expect(prefill(spec("GH_TOKEN", ["api.github.com", "evil.example"])).hosts).toEqual([
            "api.github.com",
        ]);
        expect(prefill(spec("HF_TOKEN", ["evil.example"])).hosts).toEqual(["huggingface.co"]);
    });

    it("never fills hosts for a name outside every preset", () => {
        expect(prefill(spec("MY_TOKEN", ["evil.example"]))).toEqual({
            name: "MY_TOKEN",
            hosts: [],
            headerNames: [],
        });
    });

    it("drops a suggested name that is not a variable name", () => {
        expect(prefill(spec("<script>", ["huggingface.co"]))).toEqual({
            name: "",
            hosts: [],
            headerNames: [],
        });
    });

    it("offers every preset name", () => {
        expect(knownNames).toEqual([
            "HF_TOKEN",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "NPM_TOKEN",
        ]);
    });
});

describe("reservedName", () => {
    it("matches data-plane 10.3's list", () => {
        for (const name of [
            "PATH",
            "HOME",
            "SHELL",
            "USER",
            "LD_PRELOAD",
            "BUGNET_X",
            "SSL_CERT_FILE",
            "NODE_OPTIONS",
            "REQUESTS_CA_BUNDLE",
            "CURL_CA_BUNDLE",
            "AWS_CA_BUNDLE",
            "HTTP_PROXY",
            "https_proxy",
            "All_Proxy",
            "no_proxy",
            "GIT_ASKPASS",
            "PIP_INDEX_URL",
            "UV_INDEX",
            "DENO_DIR",
            "npm_config_registry",
            "PYTHONPATH",
            "BASH_ENV",
            "ENV",
            "__VITE_X",
        ]) {
            expect(reservedName(name), name).toBe(true);
        }
    });

    it("leaves ordinary names alone", () => {
        for (const name of ["HF_TOKEN", "path", "MY_PATH", "GITHUB_TOKEN", "ENVIRONMENT", "PY"]) {
            expect(reservedName(name), name).toBe(false);
        }
    });
});

describe("refusedHeader", () => {
    it("matches data-plane 10.3's list", () => {
        for (const h of ["host", "cookie", "proxy-authorization", "x-forwarded-for", "via", "te"]) {
            expect(refusedHeader(h), h).toBe(true);
        }
        expect(refusedHeader("x-api-key")).toBe(false);
    });
});

describe("hosts", () => {
    it("splits on lines, spaces and commas", () => {
        expect(splitList(" a.example\nb.example, c.example\t\n")).toEqual([
            "a.example",
            "b.example",
            "c.example",
        ]);
    });

    it("reads hosts as the proxy matches them", () => {
        expect(readHosts("HuggingFace.co.\nhuggingface.co\nbücher.example")).toEqual({
            hosts: ["huggingface.co", "xn--bcher-kva.example"],
            problems: [],
        });
    });

    it("names each host it cannot take", () => {
        const read = readHosts("https://huggingface.co\n10.0.0.1\n*.example.com\nok.example");
        expect(read.hosts).toEqual(["ok.example"]);
        expect(read.problems).toHaveLength(3);
        expect(read.problems[0]).toMatch(/^"https:\/\/huggingface.co" is not a bare host name/);
        expect(read.problems[1]).toMatch(/IP address/);
    });

    it("labels preset hosts with their service and the rest as typed", () => {
        expect(hostViews(["api.github.com", "my.example"])).toEqual([
            { host: "api.github.com", service: "GitHub" },
            { host: "my.example", service: null },
        ]);
    });
});

describe("check", () => {
    it("gives the canonical spec the router expects", () => {
        const checked = check(
            draft({
                name: " MY_TOKEN ",
                hosts: "B.example.\na.example\nb.example",
                headers: "X-Api-Key, Authorization, x-api-key",
            }),
        );
        expect(checked).toEqual({
            ok: true,
            spec: {
                name: "MY_TOKEN",
                hosts: ["a.example", "b.example"],
                headerNames: ["x-api-key"],
                fetchOnly: false,
            },
        });
    });

    it("names the problem with each field", () => {
        const checked = check(draft({ name: "1X", value: "", hosts: "", headers: "cookie" }));
        expect(checked.ok).toBe(false);
        if (checked.ok) return;
        expect(checked.problems.map((p) => p.field)).toEqual(["name", "value", "hosts", "headers"]);
    });

    it("refuses reserved names and empty names", () => {
        const reserved = check(draft({ name: "PATH" }));
        expect(!reserved.ok && reserved.problems[0]?.message).toMatch(/reserved/);
        const empty = check(draft({ name: "  " }));
        expect(!empty.ok && empty.problems[0]?.message).toMatch(/Give the secret a name/);
    });

    it("takes a value up to 64 KiB of UTF-8", () => {
        expect(check(draft({ value: "x".repeat(64 * 1024) })).ok).toBe(true);
        const over = check(draft({ value: "é".repeat(32 * 1024 + 1) }));
        expect(!over.ok && over.problems[0]?.message).toBe(
            "The value is 65 KiB, and up to 64 KiB fit.",
        );
    });

    it("holds at most 10 hosts and 8 extra headers", () => {
        const hosts = Array.from({ length: 11 }, (_, i) => `h${i}.example`).join("\n");
        expect(check(draft({ hosts })).ok).toBe(false);
        const headers = Array.from({ length: 9 }, (_, i) => `x-h${i}`).join(",");
        expect(check(draft({ headers })).ok).toBe(false);
    });

    it("makes a GitHub token fetch only unless the box is ticked", () => {
        const gh = draft({ name: "GH_TOKEN", hosts: "api.github.com" });
        expect(check(gh)).toMatchObject({ ok: true, spec: { fetchOnly: true } });
        expect(check({ ...gh, sandboxUse: true })).toMatchObject({
            ok: true,
            spec: { fetchOnly: false },
        });
        expect(check(draft({ sandboxUse: true }))).toMatchObject({
            ok: true,
            spec: { fetchOnly: false },
        });
    });

    it("counts any secret bound to a GitHub host as a GitHub token", () => {
        expect(isGitHub("MY_TOKEN", ["github.com"])).toBe(true);
        expect(isGitHub("GITHUB_TOKEN", [])).toBe(true);
        expect(isGitHub("HF_TOKEN", ["huggingface.co"])).toBe(false);
    });
});

describe("valueNotes", () => {
    it("points out large values and stray spaces", () => {
        expect(valueNotes("hf_abc")).toEqual([]);
        expect(valueNotes(" hf_abc")).toEqual([
            "The value starts or ends with a space, which tokens rarely do.",
        ]);
        expect(valueNotes("x".repeat(8 * 1024 + 1))[0]).toMatch(/over 8 KiB/);
    });
});
