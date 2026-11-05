/**
 * The egress proxy's box public keys that the bridge and the entry page seal to.
 *
 * Data-plane 10.2 pins them at build time, so neither the router nor the secrets route can hand
 * out a key of its own. The real key is made once at deploy with
 * `bugnet-egress box-key new --id k1 --out /etc/bugnet/keys` (data-plane 15.5). Its public half
 * goes into the router's `secrets.box_public_keys` and to the gateway team, who add it below with
 * keyId k1 and publicKey in base64url without padding, and ship a new bridge and page bundle.
 * A rotation adds the new key first and keeps the old one until its sandboxes have ended, and
 * ships before the router lists the new key. The development key in src/testing never goes here.
 */
import type { PinnedKey } from "./seal.ts";

export const pinnedKeys: readonly PinnedKey[] = [];
