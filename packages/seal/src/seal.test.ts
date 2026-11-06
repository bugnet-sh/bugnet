import { describe, expect, it } from "vitest";
import {
    SealError,
    boundPayload,
    chooseKey,
    fromBase64Url,
    maxValueBytes,
    sealSecret,
    toBase64Url,
    type SealingKey,
} from "./seal.ts";
import { pinnedKeys } from "./pinned.ts";
import { developmentKey, developmentPinned, openSealed } from "./testing/development-key.ts";

const binding = "MPWS27XG3CK76UZOFV4I5DOU4WQCYDYKMCFEWBHFDJ7OOR4OI4DQ";
const listed: SealingKey = {
    keyId: developmentKey.keyId,
    publicKey: developmentKey.publicKey,
    binding,
};
const spec = { name: "HF_TOKEN", hosts: ["huggingface.co"], headerNames: [], fetchOnly: false };

describe("base64url", () => {
    it("round-trips without padding", () => {
        for (const n of [0, 1, 2, 3, 31, 32, 33]) {
            const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 250) % 256);
            const text = toBase64Url(bytes);
            expect(text).not.toMatch(/[=+/]/);
            expect(fromBase64Url(text)).toEqual(bytes);
        }
    });

    it("refuses padding, the standard alphabet and impossible lengths", () => {
        expect(() => fromBase64Url("YQ==")).toThrow(SealError);
        expect(() => fromBase64Url("a+b/")).toThrow(SealError);
        expect(() => fromBase64Url("abcde")).toThrow(SealError);
    });
});

describe("chooseKey", () => {
    const other = { keyId: "k0", publicKey: toBase64Url(new Uint8Array(32).fill(1)), binding };

    it("takes the newest listed key that is pinned", () => {
        const pinned = [...developmentPinned, { keyId: "k0", publicKey: other.publicKey }];
        expect(chooseKey([listed, other], pinned)).toBe(listed);
        expect(chooseKey([other, listed], pinned)).toBe(other);
    });

    it("skips a listed key that reuses a pinned id with another public key", () => {
        const swapped = { ...listed, publicKey: other.publicKey };
        expect(() => chooseKey([swapped], developmentPinned)).toThrow(
            /no listed sealing key is one this build pins \(listed dev-only-1\)/,
        );
        expect(chooseKey([swapped, listed], developmentPinned)).toBe(listed);
    });

    it("takes only a binding of 52 upper-case base32 characters, as data-plane 4.4 makes it", () => {
        for (const bad of [
            binding.toLowerCase(),
            binding.slice(0, -1),
            `${binding}A`,
            `${binding.slice(0, -4)}====`,
            `${binding.slice(0, -1)}1`,
            "",
        ]) {
            expect(() => chooseKey([{ ...listed, binding: bad }], developmentPinned), bad).toThrow(
                SealError,
            );
        }
        expect(chooseKey([{ ...listed, binding }], developmentPinned).binding).toBe(binding);
    });

    it("refuses when nothing listed is pinned", () => {
        expect(() => chooseKey([other], developmentPinned)).toThrow(SealError);
        expect(() => chooseKey([], developmentPinned)).toThrow(/listed none/);
    });

    it("never pins the development key in a release", () => {
        expect(pinnedKeys.map((k) => k.publicKey)).not.toContain(developmentKey.publicKey);
        expect(() => chooseKey([listed], pinnedKeys)).toThrow(SealError);
    });
});

describe("sealSecret", () => {
    it("seals the bound payload so the private key opens it", async () => {
        const sealed = await sealSecret(
            { ...spec, hosts: ["HuggingFace.co."], headerNames: ["X-Token"] },
            "hf_secret",
            listed,
        );
        expect(sealed.spec).toEqual({ ...spec, headerNames: ["x-token"] });
        expect(sealed.value.keyId).toBe("dev-only-1");
        expect(fromBase64Url(sealed.value.box).length).toBe(
            48 + boundPayload(binding, sealed.spec, "hf_secret").length,
        );
        const plain = await openSealed(sealed.value.box);
        expect(plain).toBe(
            `{"v":1,"binding":"${binding}","name":"HF_TOKEN","hosts":["huggingface.co"],` +
                `"headers":["x-token"],"fetchOnly":false,"value":"hf_secret"}`,
        );
    });

    it("seals each time with a fresh ephemeral key", async () => {
        const a = await sealSecret(spec, "v", listed);
        const b = await sealSecret(spec, "v", listed);
        expect(a.value.box).not.toBe(b.value.box);
    });

    it("refuses an empty value and one over 64 KiB", async () => {
        await expect(sealSecret(spec, "", listed)).rejects.toThrow(/empty/);
        await expect(sealSecret(spec, "x".repeat(maxValueBytes + 1), listed)).rejects.toThrow(
            /over 64 KiB/,
        );
        await expect(sealSecret(spec, "é".repeat(maxValueBytes / 2 + 1), listed)).rejects.toThrow(
            /over 64 KiB/,
        );
        await expect(sealSecret(spec, "x".repeat(maxValueBytes), listed)).resolves.toBeTruthy();
    });

    it("refuses a value whose escaped payload passes the 70 KiB box limit", async () => {
        const controls = "\u0001".repeat(maxValueBytes / 4);
        await expect(sealSecret(spec, controls, listed)).rejects.toThrow(/sealed secret is over/);
    });
});
