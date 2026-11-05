import sodium from "libsodium-wrappers";
import { fromBase64Url } from "../seal.ts";

// DEVELOPMENT ONLY. Its private half is public in this repository, so no release ever pins it
export const developmentKey = {
    keyId: "dev-only-1",
    publicKey: "HkNoRqZ05lLKNrHIhWwtPwRVZQiPfGAfNYVVc5el-ik",
    privateKey: "-XE1ppQ-hxG30ajhY-JUZuh4pL4AldwjsYzMaWwWkj0",
} as const;

export const developmentPinned = [
    { keyId: developmentKey.keyId, publicKey: developmentKey.publicKey },
] as const;

// Opens a box as the egress proxy does, for fake secrets routes in tests
export async function openSealed(
    box: string,
    key: { publicKey: string; privateKey: string } = developmentKey,
): Promise<string> {
    await sodium.ready;
    const plain = sodium.crypto_box_seal_open(
        fromBase64Url(box),
        fromBase64Url(key.publicKey),
        fromBase64Url(key.privateKey),
    );
    return new TextDecoder().decode(plain);
}
