// Pinned at build time so no router or route can hand out a key, CONTRIBUTING says how to add one
import type { PinnedKey } from "./seal.ts";

export const pinnedKeys: readonly PinnedKey[] = [
    // Production egress box key, made on the server on 2026-11-09
    { keyId: "k1", publicKey: "izQzPuN7A8R6WyD4-wT2h1lMf7VnvlsJU1gFWapvi1k" },
];
