/**
 * Serves the built page with a fake secrets route on port 0 and drives it end to end.
 *
 * With an installed headless browser it runs in Chromium under the route's real headers, CSP
 * included. Without one, or with BUGNET_PAGE_SMOKE=jsdom, it runs the same bundle under jsdom,
 * which enforces no CSP. Either way it opens every PUT body with the development private key.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { boundPayload, pinnedKeys, toBase64Url, type SealingKey } from "@bugnet/seal";
import { developmentKey, developmentPinned, openSealed } from "@bugnet/seal/testing";
import { buildPage } from "../src/build.ts";
import { routeProblem } from "../src/errors.ts";
import { findLauncher, findOtherLaunchers } from "../src/testing/browser.ts";
import { startFakeRoute, type FakeLink, type FakeRoute, type Put } from "../src/testing/route.ts";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const binding = "D6CXU3RKY3CNWOHCPSG7I5LFQQSFQLLBABMQB7JFP5YGLL4OCDMQ";
const devKey: SealingKey = {
    keyId: developmentKey.keyId,
    publicKey: developmentKey.publicKey,
    binding,
};
// Listed first, so the page must skip it for the older key it pins
const unpinnedKey: SealingKey = {
    keyId: "k9",
    publicKey: toBase64Url(new Uint8Array(32).fill(7)),
    binding,
};

let tokenCount = 0;
function token(): string {
    tokenCount += 1;
    return `bnsl_${String(tokenCount).padStart(22, "A")}`;
}

function link(extra: Partial<FakeLink> = {}): FakeLink {
    const now = Date.now();
    return {
        pairingCode: "K3F9X2",
        sourceLabel: "github.com/acme/app@1a2b3c4",
        sandboxCreatedAt: new Date(now - 12 * 60_000).toISOString(),
        expiresAt: new Date(now + 9 * 60_000).toISOString(),
        suggested: { name: "HF_TOKEN", hosts: ["huggingface.co"] },
        sealingKeys: [unpinnedKey, devKey],
        ...extra,
    };
}

async function opened(put: Put | undefined): Promise<unknown> {
    if (!put) throw new Error("the page sent no PUT");
    return JSON.parse(await openSealed(put.body.value.box));
}

function bound(spec: Put["body"]["spec"], value: string): unknown {
    return JSON.parse(boundPayload(binding, spec, value));
}

const launcher = await findLauncher();
const others = await findOtherLaunchers();

let devDir = "";
beforeAll(async () => {
    // The release bundle exactly as pnpm build makes it, and a development one apart from it
    await buildPage({ outdir: dist, pinned: pinnedKeys });
    devDir = await mkdtemp(join(tmpdir(), "bugnet-secret-page-"));
    await buildPage({ outdir: devDir, pinned: developmentPinned, development: true });
}, 60_000);

afterAll(async () => {
    if (devDir) await rm(devDir, { recursive: true, force: true });
});

describe.runIf(launcher !== null)(`in a headless browser (${launcher?.label ?? "none"})`, () => {
    let browser: Browser;
    let route: FakeRoute;
    let releaseRoute: FakeRoute;
    const links: Record<string, FakeLink> = {};
    const contexts: BrowserContext[] = [];

    beforeAll(async () => {
        browser = await (launcher as NonNullable<typeof launcher>).launch();
        route = await startFakeRoute(devDir, links);
        releaseRoute = await startFakeRoute(dist, links);
    }, 60_000);

    afterAll(async () => {
        for (const c of contexts) await c.close();
        await browser?.close();
        await route?.close();
        await releaseRoute?.close();
    });

    async function visible(page: Page, selector: string): Promise<void> {
        await page.locator(selector).waitFor({ state: "visible" });
    }

    async function masking(page: Page): Promise<string> {
        return page.$eval(
            "#value",
            (e) => getComputedStyle(e).getPropertyValue("-webkit-text-security") || "unsupported",
        );
    }

    async function focused(page: Page): Promise<string> {
        return page.evaluate(() => document.activeElement?.id ?? "");
    }

    interface Opened {
        page: Page;
        context: BrowserContext;
        pageErrors: string[];
        violations: () => Promise<string[]>;
        requests: string[];
    }

    async function open(
        path: string,
        on: FakeRoute = route,
        viewport = { width: 1000, height: 900 },
    ): Promise<Opened> {
        const context = await browser.newContext({ viewport });
        contexts.push(context);
        const page = await context.newPage();
        const pageErrors: string[] = [];
        const requests: string[] = [];
        page.on("pageerror", (e) => pageErrors.push(e.message));
        page.on("request", (r) => requests.push(r.url()));
        await page.addInitScript(() => {
            const w = window as unknown as { violations: string[] };
            w.violations = [];
            document.addEventListener("securitypolicyviolation", (e) => {
                w.violations.push(`${e.effectiveDirective} ${e.blockedURI}`);
            });
        });
        await page.goto(`${on.origin}${path}`);
        await page.waitForSelector("#loading", { state: "hidden" });
        const violations = () =>
            page.evaluate(() => (window as unknown as { violations: string[] }).violations);
        return { page, context, pageErrors, violations, requests };
    }

    // The spec's CSP has no wasm-unsafe-eval, so libsodium's WebAssembly attempt is the one refusal
    async function expectOnlyWasmRefused(o: Opened): Promise<void> {
        const violations = await o.violations();
        expect(violations.length).toBeGreaterThan(0);
        expect(violations.every((v) => v.endsWith(" wasm-eval"))).toBe(true);
        expect(o.pageErrors.every((m) => m.includes("WebAssembly"))).toBe(true);
        expect(
            o.requests.every(
                (u) => u.startsWith(route.origin) || u.startsWith(releaseRoute.origin),
            ),
        ).toBe(true);
    }

    it("the release bundle refuses a key it does not pin, before anything is typed", async () => {
        const t = token();
        links[t] = link();
        const o = await open(`/l/${t}`, releaseRoute);
        await visible(o.page, "#problem");
        expect(await o.page.textContent("#problem-text")).toMatch(/^Do not enter a secret here/);
        expect(await o.page.textContent("#problem-code")).toBe("key_not_pinned");
        expect(await o.page.isHidden("#form")).toBe(true);
        expect(await o.page.isHidden("#dev-build")).toBe(true);
        expect(releaseRoute.puts).toHaveLength(0);
        const js = await readFile(join(dist, "assets", "page.js"), "utf8");
        expect(js).not.toContain(developmentKey.publicKey);
        expect(js).not.toContain(developmentKey.privateKey);
    });

    it("seals in the browser, and the PUT opens with the development key", async () => {
        const t = token();
        links[t] = link({
            suggested: { name: "HF_TOKEN", hosts: ["huggingface.co", "evil.example"] },
        });
        const context = await browser.newContext();
        contexts.push(context);
        // A preview can fill the bugnet.sh cookie jar, and the page must still work
        await context.addCookies(
            Array.from({ length: 8 }, (_, i) => ({
                name: `preview${i}`,
                value: "x".repeat(3000),
                domain: "127.0.0.1",
                path: "/",
            })),
        );
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (e) => pageErrors.push(e.message));
        await page.goto(`${route.origin}/l/${t}`);
        await visible(page, "#form");

        expect(await page.textContent("#pairing-code")).toBe("K3F9X2");
        expect(await page.locator("#source").evaluate((e) => e.parentElement?.textContent)).toBe(
            "Source: github.com/acme/app@1a2b3c4",
        );
        expect(await page.textContent("#created")).toMatch(/\(12 minutes ago\)$/);
        expect(await page.textContent("#expires")).toMatch(/\(in [89] minutes\)$/);
        await visible(page, "#dev-build");
        expect(await page.inputValue("#name")).toBe("HF_TOKEN");
        // The router keeps only preset hosts, and the page drops any other one too
        expect(await page.inputValue("#hosts")).toBe("huggingface.co");
        expect(await page.isHidden("#sandbox-use-field")).toBe(true);

        const value = "hf_" + "a1b2c3".repeat(6);
        await page.locator("#value").focus();
        await page.keyboard.type(value);
        await page.keyboard.press("Enter");
        await visible(page, "#done");
        expect(await focused(page)).toBe("#done".slice(1));
        expect(await page.textContent("#done-text")).toMatch(/^It is active\./);
        expect(await page.textContent("#done-hosts")).toBe("huggingface.co");
        expect(await page.inputValue("#value")).toBe("");

        const put = route.puts.find((p) => p.token === t);
        const spec = {
            name: "HF_TOKEN",
            hosts: ["huggingface.co"],
            headerNames: [],
            fetchOnly: false,
        };
        expect(put?.body.spec).toEqual(spec);
        expect(put?.body.value.keyId).toBe(developmentKey.keyId);
        expect(put?.body.submissionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(await opened(put)).toEqual(bound(spec, value));
        expect(put?.headers.origin).toBe(route.origin);
        expect(put?.headers["sec-fetch-site"]).toBe("same-origin");
        expect(put?.headers["content-type"]).toBe("application/json");
        expect(put?.headers.cookie).toBeUndefined();
        // The Referer may name the origin, never the path that holds the link's token
        expect(put?.headers.referer ?? `${route.origin}/`).toBe(`${route.origin}/`);

        const get = route.requests.find((r) => r.method === "GET" && r.path === `/v1/links/${t}`);
        expect(get?.headers["sec-fetch-site"]).toBe("same-origin");
        expect(get?.headers["content-type"]).toBe("application/json");
        expect(get?.headers.cookie).toBeUndefined();
        // Browsers send no Origin on a same-origin GET, so the route must not require one there
        expect(get?.headers.origin).toBeUndefined();

        const cookies = await context.cookies();
        expect(cookies.map((c) => c.name).sort()).toEqual(
            Array.from({ length: 8 }, (_, i) => `preview${i}`),
        );
        expect(pageErrors.every((m) => m.includes("WebAssembly"))).toBe(true);
    });

    it("loads under the route's headers with no refusal but libsodium's WebAssembly", async () => {
        const t = token();
        links[t] = link();
        const o = await open(`/l/${t}`);
        await visible(o.page, "#form");
        const res = await o.page.request.get(`${route.origin}/l/${t}`);
        expect(res.headers()["content-security-policy"]).toBe(
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
                "font-src 'self'; connect-src 'self'; form-action 'none'; " +
                "frame-ancestors 'none'; " +
                "base-uri 'none'",
        );
        expect(res.headers()["set-cookie"]).toBeUndefined();
        await expectOnlyWasmRefused(o);
        expect(await o.page.evaluate(() => document.cookie)).toBe("");
    });

    // A password field that vanishes after a fetch reads as a login the browser offers to save
    it("gives a password manager no password field to save the value from", async () => {
        const t = token();
        links[t] = link();
        const { page } = await open(`/l/${t}`);
        await visible(page, "#form");
        expect(await page.locator("input[type=password]").count()).toBe(0);
        expect(await page.getAttribute("#value", "type")).toBe("text");
        expect(await page.getAttribute("#value", "autocomplete")).toBe("off");
        expect(await page.getAttribute("#value", "data-1p-ignore")).not.toBeNull();
        expect(await page.getAttribute("#value", "data-lpignore")).toBe("true");
        expect(await masking(page)).toBe("disc");
        await page.locator("#value").fill("hf_never_saved");
        await page.locator("#submit").click();
        await visible(page, "#done");
        expect(await page.locator("input[type=password]").count()).toBe(0);
    });

    it("shows the source as text, never as HTML", async () => {
        const t = token();
        const label = '<img src=x onerror="window.pwned=1">Bugnet support: verified‮';
        links[t] = link({ sourceLabel: label });
        const o = await open(`/l/${t}`);
        expect(await o.page.textContent("#source")).toBe(
            '<img src=x onerror="window.pwned=1">Bugnet support: verified',
        );
        expect(await o.page.locator("img").count()).toBe(0);
        expect(await o.page.evaluate(() => "pwned" in window)).toBe(false);
    });

    it("keeps its times current and says when the link has expired", async () => {
        const t = token();
        links[t] = link();
        const context = await browser.newContext();
        contexts.push(context);
        await context.clock.install({ time: Date.now() });
        const page = await context.newPage();
        await page.goto(`${route.origin}/l/${t}`);
        await visible(page, "#form");
        expect(await page.textContent("#expires")).toMatch(/\(in [89] minutes\)$/);
        expect(await page.isHidden("#expired")).toBe(true);
        await page.clock.fastForward(4 * 60_000);
        expect(await page.textContent("#expires")).toMatch(/\(in [45] minutes\)$/);
        expect(await page.textContent("#created")).toMatch(/\(16 minutes ago\)$/);
        expect(await page.isHidden("#expired")).toBe(true);
        await page.clock.fastForward(8 * 60_000);
        expect(await page.textContent("#expires")).toMatch(/\([23] minutes ago\)$/);
        await visible(page, "#expired");
        expect(await page.textContent("#expired")).toMatch(/^\s*This link has expired\./);
    });

    it("says Source: unknown when the router recorded none", async () => {
        const t = token();
        links[t] = link({ sourceLabel: "", sandboxCreatedAt: "" });
        const o = await open(`/l/${t}`);
        expect(await o.page.locator("#source").evaluate((e) => e.parentElement?.textContent)).toBe(
            "Source: unknown",
        );
        expect(await o.page.textContent("#created")).toBe("unknown");
    });

    it("works by keyboard alone, with a visible focus ring, and custom hosts typed", async () => {
        const t = token();
        links[t] = link({ suggested: {} });
        const o = await open(`/l/${t}`);
        const { page } = o;
        const order: string[] = [];
        for (let i = 0; i < 6; i++) {
            await page.keyboard.press("Tab");
            order.push(await page.evaluate(() => document.activeElement?.id ?? ""));
        }
        expect(order).toEqual(["name", "value", "show-value", "hosts", "headers", "submit"]);
        await page.locator("#name").focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        const ring = await page.evaluate(() => {
            const s = getComputedStyle(document.activeElement as Element);
            return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
        });
        expect(ring.style).not.toBe("none");
        expect(ring.width).toBeGreaterThanOrEqual(2);

        expect(await page.inputValue("#hosts")).toBe("");
        await page.keyboard.type("MY_TOKEN");
        await page.keyboard.press("Tab");
        await page.keyboard.type("secret-value");
        await page.keyboard.press("Tab");
        expect(await masking(page)).toBe("disc");
        await page.keyboard.press("Space");
        expect(await masking(page)).toBe("none");
        expect(await page.getAttribute("#show-value", "aria-pressed")).toBe("true");
        // A toggle keeps its name, and only its pressed state says the value shows
        expect(await page.textContent("#show-value")).toMatch(/^\s*Show value\s*$/);
        await page.keyboard.press("Tab");
        await page.keyboard.type("Api.Example.COM.\nbücher.example");
        await page.waitForFunction(() => document.querySelectorAll("#host-items li").length === 2);
        expect(await page.locator("#host-items li").allTextContents()).toEqual([
            "api.example.com, typed by you, so check the spelling",
            "xn--bcher-kva.example, typed by you, so check the spelling",
        ]);
        await page.keyboard.press("Tab");
        await page.keyboard.type("X-Api-Key");
        await page.keyboard.press("Enter");
        await visible(page, "#done");
        expect(await masking(page)).toBe("disc");
        expect(await page.getAttribute("#show-value", "aria-pressed")).toBe("false");

        const put = route.puts.find((p) => p.token === t);
        const spec = {
            name: "MY_TOKEN",
            hosts: ["api.example.com", "xn--bcher-kva.example"],
            headerNames: ["x-api-key"],
            fetchOnly: false,
        };
        expect(put?.body.spec).toEqual(spec);
        expect(await opened(put)).toEqual(bound(spec, "secret-value"));
    });

    it("refills the hosts when a known name is typed, without touching typed hosts", async () => {
        const t = token();
        links[t] = link({ suggested: {} });
        const { page } = await open(`/l/${t}`);
        await page.locator("#name").fill("ANTHROPIC_API_KEY");
        expect(await page.inputValue("#hosts")).toBe("api.anthropic.com");
        expect(await page.inputValue("#headers")).toBe("x-api-key");
        await page.locator("#name").fill("OPENAI_API_KEY");
        expect(await page.inputValue("#hosts")).toBe("api.openai.com");
        expect(await page.inputValue("#headers")).toBe("");
        await page.locator("#hosts").fill("my.example");
        await page.locator("#name").fill("HF_TOKEN");
        expect(await page.inputValue("#hosts")).toBe("my.example");
    });

    it("keeps a GitHub token fetch only unless the box is ticked", async () => {
        const t = token();
        links[t] = link({ suggested: { name: "GH_TOKEN" } });
        const { page } = await open(`/l/${t}`);
        expect((await page.inputValue("#hosts")).split("\n")).toEqual([
            "api.github.com",
            "github.com",
            "uploads.github.com",
        ]);
        await visible(page, "#sandbox-use-field");
        expect(await page.isChecked("#sandbox-use")).toBe(false);
        await page.locator("#value").fill("github_pat_x");
        await page.locator("#submit").click();
        await visible(page, "#done");
        expect(await page.textContent("#done-text")).toMatch(/^Bugnet keeps it for downloading/);
        const put = route.puts.find((p) => p.token === t);
        expect(put?.body.spec.fetchOnly).toBe(true);
        expect(await opened(put)).toMatchObject({ fetchOnly: true, value: "github_pat_x" });
    });

    it("treats a GitHub token without api.github.com like any other secret", async () => {
        const t = token();
        links[t] = link({ suggested: { name: "GH_TOKEN", hosts: ["github.com"] } });
        const { page } = await open(`/l/${t}`);
        expect(await page.inputValue("#hosts")).toBe("github.com");
        expect(await page.isHidden("#sandbox-use-field")).toBe(true);
        await page.locator("#value").fill("github_pat_y");
        await page.locator("#submit").click();
        await visible(page, "#done");
        expect(await page.textContent("#done-text")).toMatch(/^It is active\./);
        const put = route.puts.find((p) => p.token === t);
        expect(put?.body.spec).toMatchObject({ hosts: ["github.com"], fetchOnly: false });
    });

    it("checks fields before sending and names the problem beside each", async () => {
        const t = token();
        links[t] = link({ suggested: {} });
        const { page } = await open(`/l/${t}`);
        await page.locator("#name").fill("PATH");
        await page.locator("#hosts").fill("https://example.com/x");
        await page.locator("#submit").click();
        expect(await focused(page)).toBe("#name".slice(1));
        expect(await page.getAttribute("#name", "aria-invalid")).toBe("true");
        expect(await page.textContent("#name-error")).toMatch(/reserved/);
        expect(await page.textContent("#value-error")).toBe("Paste the secret's value.");
        expect(await page.textContent("#hosts-error")).toMatch(/not a bare host name/);
        expect(route.puts.some((p) => p.token === t)).toBe(false);
    });

    it("shows each refusal plainly, and a final one ends the form", async () => {
        const t = token();
        links[t] = link({
            refusals: [
                { status: 400, error: "host_refused" },
                { status: 429, error: "rate_limited" },
                { status: 409, error: "link_locked" },
            ],
        });
        const { page } = await open(`/l/${t}`);
        await page.locator("#value").fill("hf_value");
        await page.locator("#submit").click();
        await visible(page, "#hosts-error");
        expect(await page.textContent("#hosts-error")).toBe(
            routeProblem(400, '{"error":"host_refused"}', null).message,
        );
        await visible(page, "#form");

        await page.locator("#submit").click();
        await visible(page, "#form-problem");
        expect(await page.textContent("#form-problem-text")).toBe(
            routeProblem(429, '{"error":"rate_limited"}', null).message,
        );
        expect(await page.textContent("#form-problem-code")).toBe("rate_limited");

        await page.locator("#submit").click();
        await visible(page, "#problem");
        expect(await page.textContent("#problem-text")).toMatch(/^This link is locked/);
        expect(await page.textContent("#problem-code")).toBe("link_locked");
        expect(await page.isHidden("#form")).toBe(true);
        expect(await page.isHidden("#check")).toBe(true);
        expect(await page.inputValue("#value")).toBe("");
        // Every try sealed the same secret, and none of the refusals let the server see it
        const tries = route.puts.filter((p) => p.token === t);
        expect(tries).toHaveLength(3);
        expect(new Set(tries.map((p) => p.body.submissionId)).size).toBe(1);
    });

    it("explains an unknown, used or incomplete link", async () => {
        const unknown = await open(`/l/${token()}`);
        expect(await unknown.page.textContent("#problem-code")).toBe("link_unknown");
        expect(await focused(unknown.page)).toBe("#problem".slice(1));
        const incomplete = await open("/l/bnsl_short");
        expect(await incomplete.page.textContent("#problem-code")).toBe("no_token");
    });

    it("reads well on a phone", async () => {
        const t = token();
        links[t] = link();
        const { page } = await open(`/l/${t}`, route, { width: 360, height: 740 });
        const layout = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            pairing: parseFloat(
                getComputedStyle(document.getElementById("pairing-code")!).fontSize,
            ),
            input: parseFloat(getComputedStyle(document.getElementById("value")!).fontSize),
            button: document.getElementById("submit")!.getBoundingClientRect().height,
        }));
        expect(layout.overflow).toBeLessThanOrEqual(0);
        expect(layout.pairing).toBeGreaterThanOrEqual(36);
        // Below 16px, iOS zooms into a field on focus
        expect(layout.input).toBeGreaterThanOrEqual(16);
        expect(layout.button).toBeGreaterThanOrEqual(44);

        // Field errors quote what was typed, and a pasted token has nowhere to break
        await page.locator("#hosts").fill(`ghp_${"Ab1".repeat(30)}`);
        await page.locator("#headers").fill(`X-${"Long".repeat(30)}@`);
        await page.locator("#submit").click();
        await visible(page, "#hosts-error");
        await visible(page, "#headers-error");
        expect(
            await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(0);
    });
});

const jsdomWhy =
    process.env.BUGNET_PAGE_SMOKE === "jsdom"
        ? "BUGNET_PAGE_SMOKE=jsdom"
        : "no headless browser found";

describe.each(others.map((l) => [l.label, l] as const))(
    "in %s, which sends Origin null on a state change under no-referrer",
    (_label, other) => {
        let browser: Browser;
        let route: FakeRoute;
        const links: Record<string, FakeLink> = {};

        beforeAll(async () => {
            browser = await other.launch();
            route = await startFakeRoute(devDir, links);
        }, 60_000);

        afterAll(async () => {
            await browser?.close();
            await route?.close();
        });

        it("sends the PUT with the page's own Origin, and it opens with the dev key", async () => {
            const t = token();
            links[t] = link();
            const page = await browser.newPage();
            await page.goto(`${route.origin}/l/${t}`);
            await page.locator("#form").waitFor({ state: "visible" });
            const value = "hf_" + "d4e5f6".repeat(6);
            await page.locator("#value").fill(value);
            await page.locator("#submit").click();
            const sent = () => route.requests.find((r) => r.method === "PUT" && r.path.includes(t));
            await expect.poll(sent, { timeout: 20_000 }).toBeDefined();
            expect(sent()?.headers.origin).toBe(route.origin);
            await page.locator("#done").waitFor({ state: "visible" });
            const put = route.puts.find((p) => p.token === t);
            expect(put?.headers.referer ?? `${route.origin}/`).toBe(`${route.origin}/`);
            expect(await opened(put)).toEqual(bound(put?.body.spec as Put["body"]["spec"], value));
            await page.close();
        }, 60_000);
    },
);

describe.runIf(launcher === null)(`under jsdom, which enforces no CSP (${jsdomWhy})`, () => {
    let route: FakeRoute;
    const links: Record<string, FakeLink> = {};

    beforeAll(async () => {
        route = await startFakeRoute(devDir, links);
    });

    afterAll(async () => {
        await route?.close();
    });

    async function load(path: string) {
        const { JSDOM } = await import("jsdom");
        const dom = await JSDOM.fromURL(`${route.origin}${path}`, {
            runScripts: "dangerously",
            resources: "usable",
            pretendToBeVisual: true,
            beforeParse(window) {
                const w = window as unknown as Record<string, unknown>;
                w.TextEncoder ??= TextEncoder;
                // jsdom has no fetch, so this one adds what a browser adds to a same-origin call
                w.fetch = async (input: string, init: RequestInit) => {
                    const headers = new Headers(init.headers);
                    headers.set("sec-fetch-site", "same-origin");
                    if (init.method && init.method !== "GET") headers.set("origin", route.origin);
                    const res = await fetch(new URL(input, window.location.href), {
                        method: init.method ?? "GET",
                        headers,
                        ...(init.body ? { body: init.body } : {}),
                        redirect: "error",
                    });
                    return res;
                };
            },
        });
        const doc = dom.window.document;
        await waitFor(() => doc.getElementById("loading")?.hidden === true);
        return dom;
    }

    async function waitFor(ok: () => boolean): Promise<void> {
        for (let i = 0; i < 400; i++) {
            if (ok()) return;
            await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error("the page never got there");
    }

    function type(dom: Awaited<ReturnType<typeof load>>, id: string, text: string): void {
        const el = dom.window.document.getElementById(id) as HTMLInputElement;
        el.value = text;
        el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    }

    it("seals with the page script, and the PUT opens with the development key", async () => {
        const t = token();
        links[t] = link({ suggested: { name: "HF_TOKEN", hosts: ["evil.example"] } });
        const dom = await load(`/l/${t}`);
        const doc = dom.window.document;
        expect(doc.getElementById("pairing-code")?.textContent).toBe("K3F9X2");
        expect(doc.getElementById("source")?.parentElement?.textContent).toBe(
            "Source: github.com/acme/app@1a2b3c4",
        );
        expect((doc.getElementById("hosts") as HTMLTextAreaElement).value).toBe("huggingface.co");
        type(dom, "value", "hf_jsdom_value");
        (doc.getElementById("form") as HTMLFormElement).requestSubmit();
        await waitFor(() => doc.getElementById("done")?.hidden === false);
        const put = route.puts.find((p) => p.token === t);
        const spec = {
            name: "HF_TOKEN",
            hosts: ["huggingface.co"],
            headerNames: [],
            fetchOnly: false,
        };
        expect(put?.body.spec).toEqual(spec);
        expect(await opened(put)).toEqual(bound(spec, "hf_jsdom_value"));
        expect(doc.cookie).toBe("");
        dom.window.close();
    });

    it("shows a refusal plainly", async () => {
        const t = token();
        links[t] = link({ refusals: [{ status: 409, error: "link_locked" }] });
        const dom = await load(`/l/${t}`);
        const doc = dom.window.document;
        type(dom, "value", "hf_value");
        (doc.getElementById("form") as HTMLFormElement).requestSubmit();
        await waitFor(() => doc.getElementById("problem")?.hidden === false);
        expect(doc.getElementById("problem-code")?.textContent).toBe("link_locked");
        expect(doc.getElementById("form")?.hidden).toBe(true);
        dom.window.close();
    });
});
