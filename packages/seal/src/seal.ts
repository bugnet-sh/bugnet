import sodium from "libsodium-wrappers";
import { canonicalSpec, type SecretSpec } from "./canonical.ts";

export class SealError extends Error {}

// A key as GET /v1/sealing-key and GET /v1/links/<token> list it, newest first
export interface SealingKey {
    keyId: string;
    // X25519, base64url without padding
    publicKey: string;
    // 52 characters of A-Z2-7
    binding: string;
}

export interface PinnedKey {
    keyId: string;
    publicKey: string;
}

export interface SealedValue {
    keyId: string;
    // crypto_box_seal of the bound payload, base64url without padding
    box: string;
}

export const maxValueBytes = 64 * 1024;
export const maxBoxBytes = 70 * 1024;

const keyBytes = 32;
// Data-plane 4.4, RFC 4648 base32 of a SHA-256, upper case and unpadded
const bindingPattern = /^[A-Z2-7]{52}$/;

export function toBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
    // A length of 1 mod 4 cannot come from any byte string
    if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
        throw new SealError("not base64url without padding");
    }
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function publicKeyOf(text: string): Uint8Array | null {
    try {
        const b = fromBase64Url(text);
        return b.length === keyBytes ? b : null;
    } catch {
        return null;
    }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

// The newest listed key whose id and public key are both pinned, so no server can swap in its own
export function chooseKey(listed: readonly SealingKey[], pinned: readonly PinnedKey[]): SealingKey {
    for (const key of listed) {
        const mine = pinned.find((p) => p.keyId === key.keyId);
        const theirs = publicKeyOf(key.publicKey);
        const ours = mine ? publicKeyOf(mine.publicKey) : null;
        if (!ours || !theirs || !sameBytes(ours, theirs)) continue;
        if (!bindingPattern.test(key.binding)) continue;
        return key;
    }
    const ids = listed.map((k) => k.keyId).join(", ") || "none";
    throw new SealError(
        `no listed sealing key is one this build pins (listed ${ids}). A newer Bugnet bridge may ` +
            "be needed",
    );
}

// Data-plane 10.2, in this field order, which the egress proxy checks against the record
export function boundPayload(binding: string, spec: SecretSpec, value: string): string {
    return JSON.stringify({
        v: 1,
        binding,
        name: spec.name,
        hosts: spec.hosts,
        headers: spec.headerNames,
        fetchOnly: spec.fetchOnly,
        value,
    });
}

export function valueBytes(value: string): number {
    return new TextEncoder().encode(value).length;
}

export interface Sealed {
    // The canonical spec the box binds, which the PUT body must carry unchanged
    spec: SecretSpec;
    value: SealedValue;
}

export async function sealSecret(
    spec: SecretSpec,
    value: string,
    key: SealingKey,
): Promise<Sealed> {
    await sodium.ready;
    const canonical = canonicalSpec(spec);
    if (value.length === 0) throw new SealError("the secret value is empty");
    if (valueBytes(value) > maxValueBytes) {
        throw new SealError(`the secret value is over ${maxValueBytes / 1024} KiB`);
    }
    const publicKey = publicKeyOf(key.publicKey);
    if (!publicKey) throw new SealError("the sealing key is not a 32-byte X25519 public key");
    const payload = boundPayload(key.binding, canonical, value);
    const box = sodium.crypto_box_seal(new TextEncoder().encode(payload), publicKey);
    if (box.length > maxBoxBytes) {
        throw new SealError(`the sealed secret is over ${maxBoxBytes / 1024} KiB`);
    }
    return { spec: canonical, value: { keyId: key.keyId, box: toBase64Url(box) } };
}
