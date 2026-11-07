import { describe, expect, it } from "vitest";
import {
    checkUrl,
    createSafeFetcher,
    FetchRefused,
    guardedLookup,
    isPublicAddress,
    tooManyRedirects,
    userAgent,
    type RawFetch,
    type Resolve,
} from "./fetch.ts";

function resolver(map: Record<string, string[]>): Resolve {
    return (hostname, _opts, cb) => {
        const ips = map[hostname];
        if (!ips) {
            cb(
                Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
                    code: "ENOTFOUND",
                }),
                [],
            );
            return;
        }
        cb(
            null,
            ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
        );
    };
}

const signal = () => AbortSignal.timeout(5000);

describe("isPublicAddress", () => {
    it.each([
        "127.0.0.1",
        "127.8.9.10",
        "169.254.169.254",
        "10.1.2.3",
        "172.16.5.4",
        "172.31.255.255",
        "192.168.1.1",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "239.255.255.250",
        "255.255.255.255",
        "198.18.0.1",
        "192.0.2.10",
        "::",
        "::1",
        "fe80::1",
        "fc00::1",
        "fd12:3456::1",
        "ff02::1",
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
        "::ffff:169.254.169.254",
        "::ffff:a9fe:a9fe",
        "64:ff9b::a9fe:a9fe",
        "2001:db8::1",
        "2002:7f00:1::1",
        "[::1]",
        "fe80::1%en0",
        "not an ip",
    ])("refuses %s", (ip) => {
        expect(isPublicAddress(ip)).toBe(false);
    });

    it.each([
        "8.8.8.8",
        "140.82.112.3",
        "1.1.1.1",
        "2606:4700::1111",
        "2a00:1450::1",
        "::ffff:8.8.8.8",
    ])("allows %s", (ip) => {
        expect(isPublicAddress(ip)).toBe(true);
    });
});

describe("guardedLookup", () => {
    const lookup = guardedLookup(
        resolver({
            "loopback.test": ["127.0.0.1"],
            "metadata.test": ["169.254.169.254"],
            "mixed.test": ["8.8.8.8", "10.0.0.1"],
            "public.test": ["8.8.8.8"],
        }),
    );

    function run(host: string, all: boolean) {
        return new Promise<{ err: Error | null; address: unknown; family?: number | undefined }>(
            (resolve) =>
                lookup(host, { all }, (err, address, family) => resolve({ err, address, family })),
        );
    }

    it("refuses names that resolve to loopback, metadata or a mixed answer", async () => {
        for (const host of ["loopback.test", "metadata.test", "mixed.test"]) {
            const r = await run(host, true);
            expect(r.err).toBeInstanceOf(FetchRefused);
        }
    });

    it("answers in both lookup shapes for public names", async () => {
        expect((await run("public.test", false)).address).toBe("8.8.8.8");
        expect((await run("public.test", true)).address).toEqual([
            { address: "8.8.8.8", family: 4 },
        ]);
    });

    it("passes resolver errors through", async () => {
        expect((await run("missing.test", true)).err?.message).toMatch(/ENOTFOUND/);
    });
});

describe("checkUrl", () => {
    it.each([
        ["http://example.com/x", /only https/],
        ["https://127.0.0.1/x", /non-public/],
        ["https://[::1]/x", /non-public/],
        ["https://169.254.169.254/latest/meta-data", /non-public/],
        ["https://2130706433/", /non-public/],
        [`https://${["user:pw", "example.com"].join("@")}/`, /credentials/],
        ["https://example.com:8443/", /default https port/],
        ["not a url", /valid URL/],
    ])("refuses %s", (url, why) => {
        expect(() => checkUrl(url)).toThrow(why);
    });

    it("allows a public https URL and drops the fragment", () => {
        expect(checkUrl("https://example.com/a#b").href).toBe("https://example.com/a");
    });
});

describe("createSafeFetcher", () => {
    it("refuses a hostname that resolves to 127.0.0.1 or 169.254.169.254 through the real agent", async () => {
        const fetch = createSafeFetcher({
            timeoutMs: 3000,
            resolve: resolver({ "evil.test": ["127.0.0.1"], "meta.test": ["169.254.169.254"] }),
        });
        await expect(
            fetch("https://evil.test/", { signal: signal(), maxBytes: 1024 }),
        ).rejects.toBeInstanceOf(FetchRefused);
        await expect(
            fetch("https://meta.test/", { signal: signal(), maxBytes: 1024 }),
        ).rejects.toThrow(/non-public address/);
    });

    it("caps the body while it streams and stops reading", async () => {
        let pulled = 0;
        let cancelled = false;
        const raw: RawFetch = async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    pull(controller) {
                        pulled += 1;
                        if (pulled > 1000) controller.close();
                        else controller.enqueue(new Uint8Array(1024).fill(65));
                    },
                    cancel() {
                        cancelled = true;
                    },
                }),
            );
        const fetch = createSafeFetcher({ timeoutMs: 3000, rawFetch: raw });
        const r = await fetch("https://example.com/big", { signal: signal(), maxBytes: 3000 });
        expect(r.body.length).toBe(3000);
        expect(r.truncated).toBe(true);
        expect(cancelled).toBe(true);
        expect(pulled).toBeLessThan(10);
        pulled = 0;
        const all = await fetch("https://example.com/big", {
            signal: signal(),
            maxBytes: 2 * 1024 * 1024,
        });
        expect(all.truncated).toBe(false);
        expect(all.body.length).toBe(1024 * 1000);
    });

    it("follows up to three redirects, re-checks each target and keeps tokens on the first origin", async () => {
        const seen: { url: string; auth: string | undefined; ua: string | undefined }[] = [];
        const hops: Record<string, string> = {
            "https://api.example.com/a": "/b",
            "https://api.example.com/b": "https://cdn.example.net/c",
        };
        const raw: RawFetch = async (url, init) => {
            seen.push({ url, auth: init.headers.authorization, ua: init.headers["user-agent"] });
            const next = hops[url];
            if (next) return new Response(null, { status: 302, headers: { location: next } });
            return new Response("done", { status: 200, headers: { "x-test": "1" } });
        };
        const fetch = createSafeFetcher({ timeoutMs: 3000, rawFetch: raw });
        const r = await fetch("https://api.example.com/a", {
            signal: signal(),
            maxBytes: 1024,
            originHeaders: { authorization: "Bearer t" },
        });
        expect(r.status).toBe(200);
        expect(r.url).toBe("https://cdn.example.net/c");
        expect(r.headers["x-test"]).toBe("1");
        expect(new TextDecoder().decode(r.body)).toBe("done");
        expect(seen.map((s) => s.auth)).toEqual(["Bearer t", "Bearer t", undefined]);
        expect(seen.every((s) => s.ua === userAgent)).toBe(true);
    });

    it("refuses a redirect to an internal address or plain http", async () => {
        for (const location of ["https://169.254.169.254/latest", "http://example.com/x"]) {
            const raw: RawFetch = async () =>
                new Response(null, { status: 301, headers: { location } });
            const fetch = createSafeFetcher({ timeoutMs: 3000, rawFetch: raw });
            await expect(
                fetch("https://example.com/", { signal: signal(), maxBytes: 1024 }),
            ).rejects.toBeInstanceOf(FetchRefused);
        }
    });

    it("gives up after three redirects", async () => {
        let n = 0;
        const raw: RawFetch = async () =>
            new Response(null, { status: 302, headers: { location: `/r${++n}` } });
        const fetch = createSafeFetcher({ timeoutMs: 3000, rawFetch: raw });
        await expect(
            fetch("https://example.com/", { signal: signal(), maxBytes: 1024 }),
        ).rejects.toThrow(/too many redirects/);
        expect(n).toBe(4);
    });

    it("sends method and body on the first request and a GET without a body after a redirect", async () => {
        const seen: { url: string; method: string; body: string | undefined }[] = [];
        const raw: RawFetch = async (url, init) => {
            seen.push({ url, method: init.method, body: init.body });
            if (url === "https://api.example.com/a") {
                return new Response(null, { status: 307, headers: { location: "/b" } });
            }
            return new Response("done", { status: 200 });
        };
        const fetch = createSafeFetcher({ timeoutMs: 3000, rawFetch: raw });
        await fetch("https://api.example.com/a", {
            signal: signal(),
            maxBytes: 1024,
            method: "POST",
            body: "{}",
        });
        expect(seen).toEqual([
            { url: "https://api.example.com/a", method: "POST", body: "{}" },
            { url: "https://api.example.com/b", method: "GET", body: undefined },
        ]);
    });

    it("sends GET without a body when no method is given", async () => {
        const seen: { url: string; method: string; body: string | undefined }[] = [];
        const raw: RawFetch = async (url, init) => {
            seen.push({ url, method: init.method, body: init.body });
            return new Response("ok", { status: 200 });
        };
        const fetch = createSafeFetcher({ timeoutMs: 3000, rawFetch: raw });
        await fetch("https://example.com/x", { signal: signal(), maxBytes: 1024 });
        expect(seen).toEqual([{ url: "https://example.com/x", method: "GET", body: undefined }]);
    });

    it("refuses the first redirect when maxRedirects is 0", async () => {
        let n = 0;
        const raw: RawFetch = async () => {
            n += 1;
            return new Response(null, { status: 302, headers: { location: "/r" } });
        };
        const fetch = createSafeFetcher({ timeoutMs: 3000, rawFetch: raw });
        expect(tooManyRedirects).toBe("too many redirects");
        const p = fetch("https://example.com/", {
            signal: signal(),
            maxBytes: 1024,
            maxRedirects: 0,
        });
        await expect(p).rejects.toBeInstanceOf(FetchRefused);
        await expect(p).rejects.toThrow(tooManyRedirects);
        expect(n).toBe(1);
    });
});
