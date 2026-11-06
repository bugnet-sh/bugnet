/**
 * Finds a headless browser that is already installed, without ever downloading one.
 *
 * It tries Playwright's own Chromium first, then a Chrome or Chromium binary in the usual
 * places, or BUGNET_CHROME. BUGNET_PAGE_SMOKE=jsdom skips the search, so the jsdom path can be
 * run on a machine that has a browser.
 */
import { existsSync } from "node:fs";
import type { Browser } from "playwright-core";

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
