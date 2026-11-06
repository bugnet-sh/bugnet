/**
 * Finds a headless browser that is already installed, without ever downloading one.
 *
 * It tries Playwright's own Chromium first, then a Chrome or Chromium binary in the usual
 * places, or BUGNET_CHROME. BUGNET_PAGE_SMOKE=jsdom skips the search, so the jsdom path can be
 * run on a machine that has a browser.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserType } from "playwright-core";

export interface Launcher {
    label: string;
    launch(): Promise<Browser>;
}

const systemChromes = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
];

export async function findLauncher(): Promise<Launcher | null> {
    if (process.env.BUGNET_PAGE_SMOKE === "jsdom") return null;
    let chromium: typeof import("playwright-core").chromium;
    try {
        ({ chromium } = await import("playwright-core"));
    } catch {
        return null;
    }
    try {
        const browser = await chromium.launch({ headless: true });
        await browser.close();
        return { label: "Playwright Chromium", launch: () => chromium.launch({ headless: true }) };
    } catch {
        // Playwright's browsers are not installed, so a system Chrome may still be
    }
    const env = process.env.BUGNET_CHROME;
    for (const path of env ? [env, ...systemChromes] : systemChromes) {
        if (!existsSync(path)) continue;
        try {
            const browser = await chromium.launch({ headless: true, executablePath: path });
            await browser.close();
            return {
                label: path,
                launch: () => chromium.launch({ headless: true, executablePath: path }),
            };
        } catch {
            continue;
        }
    }
    return null;
}

// A build cached by another Playwright release still runs, so a revision mismatch need not skip
function cachedBuilds(kind: "firefox" | "webkit"): string[] {
    const cache =
        process.platform === "darwin"
            ? join(homedir(), "Library", "Caches", "ms-playwright")
            : join(homedir(), ".cache", "ms-playwright");
    let dirs: string[];
    try {
        dirs = readdirSync(cache).filter((d) => d.startsWith(`${kind}-`));
    } catch {
        return [];
    }
    const inside =
        kind === "webkit"
            ? ["pw_run.sh"]
            : ["firefox/Nightly.app/Contents/MacOS/firefox", "firefox/firefox"];
    return dirs
        .sort()
        .reverse()
        .flatMap((d) => inside.map((f) => join(cache, d, f)));
}

async function launcherOf(kind: "firefox" | "webkit", type: BrowserType): Promise<Launcher | null> {
    try {
        const browser = await type.launch({ headless: true });
        await browser.close();
        return { label: `Playwright ${kind}`, launch: () => type.launch({ headless: true }) };
    } catch {
        // This playwright-core's own build is not installed, an older one may be
    }
    const env = process.env[kind === "firefox" ? "BUGNET_FIREFOX" : "BUGNET_WEBKIT"];
    for (const path of [...(env ? [env] : []), ...cachedBuilds(kind)]) {
        if (!existsSync(path)) continue;
        try {
            const browser = await type.launch({ headless: true, executablePath: path });
            await browser.close();
            return {
                label: `${kind} ${path}`,
                launch: () => type.launch({ headless: true, executablePath: path }),
            };
        } catch {
            continue;
        }
    }
    return null;
}

// Firefox and WebKit follow the Fetch rules on a state change's Origin that Chromium does not
export async function findOtherLaunchers(): Promise<Launcher[]> {
    if (process.env.BUGNET_PAGE_SMOKE === "jsdom") return [];
    let pw: typeof import("playwright-core");
    try {
        pw = await import("playwright-core");
    } catch {
        return [];
    }
    const found = [await launcherOf("firefox", pw.firefox), await launcherOf("webkit", pw.webkit)];
    return found.filter((l): l is Launcher => l !== null);
}
