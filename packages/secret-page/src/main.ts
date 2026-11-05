import { developmentBuild, pinnedKeys } from "./keys.ts";
import { startPage } from "./page.ts";

startPage({
    document,
    fetch: (input, init) => window.fetch(input, init),
    pathname: window.location.pathname,
    now: () => new Date(),
    randomId: () => crypto.randomUUID(),
    pinned: pinnedKeys,
    development: developmentBuild,
}).catch(() => {
    const loading = document.getElementById("loading");
    if (loading) loading.textContent = "This page failed to start. Reload it to try again.";
});
