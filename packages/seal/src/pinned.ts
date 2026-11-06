// Pinned at build time so no router or route can hand out a key, CONTRIBUTING says how to add one
import type { PinnedKey } from "./seal.ts";

export const pinnedKeys: readonly PinnedKey[] = [];
