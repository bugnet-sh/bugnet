import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundPayload, sealSecret, toBase64Url, type SealingKey } from "./seal.ts";
import { developmentKey } from "./testing/development-key.ts";

const dir = fileURLToPath(new URL("../interop/", import.meta.url));
const hasGo = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

const binding = "kqrmzv4ztqjwgk4rfwopgmn7q6ygkwqdcx2b3h3bqzqcdquxcz5a";
const key: SealingKey = { keyId: "dev-only-1", publicKey: developmentKey.publicKey, binding };

const specs = [
    { name: "HF_TOKEN", hosts: ["HuggingFace.co"], headerNames: [], fetchOnly: false },
    {
        name: "GITHUB_TOKEN",
        hosts: ["uploads.github.com", "api.github.com", "github.com."],
        headerNames: [],
        fetchOnly: true,
    },
    {
        name: "ANTHROPIC_API_KEY",
        hosts: ["api.anthropic.com"],
        headerNames: ["X-API-Key", "x-api-key"],
        fetchOnly: false,
    },
    { name: "INTL", hosts: ["Bücher.example"], headerNames: [], fetchOnly: false },
];
const values = ["hf_abc", "ghp_" + "x".repeat(36), 'quote " and \\ and   <&>', "é😀\n"];

function openInGo(cases: unknown[]) {
    const input = JSON.stringify({
        publicKey: developmentKey.publicKey,
        privateKey: developmentKey.privateKey,
        cases,
    });
    return spawnSync("go", ["run", "."], {
        cwd: dir,
        input,
        encoding: "utf8",
        env: { ...process.env, GOFLAGS: "-mod=readonly" },
        timeout: 110_000,
    });
}

// Go's box.OpenAnonymous is what the egress proxy opens boxes with
describe.skipIf(!hasGo)("Go box.OpenAnonymous", () => {
    it("opens every box sealed here to the same payload", { timeout: 120_000 }, async () => {
        const cases = [];
        for (const [i, spec] of specs.entries()) {
            const value = values[i] as string;
            const sealed = await sealSecret(spec, value, key);
            const want = JSON.parse(boundPayload(binding, sealed.spec, value)) as unknown;
            cases.push({ box: sealed.value.box, expectOpen: true, expect: want });
        }
        const stranger = { ...key, publicKey: toBase64Url(new Uint8Array(32).fill(9)) };
        const notOurs = await sealSecret(specs[0] as (typeof specs)[0], "x", stranger);
        cases.push({ box: notOurs.value.box, expectOpen: false });
        const run = openInGo(cases);
        expect(run.stderr).toBe("");
        expect(run.stdout).toBe("opened 4 boxes, refused 1\n");
        expect(run.status).toBe(0);
    });

    it("notices a payload that differs from the one sealed", { timeout: 120_000 }, async () => {
        const sealed = await sealSecret(specs[0] as (typeof specs)[0], "hf_abc", key);
        const want = JSON.parse(boundPayload(binding, sealed.spec, "hf_abd")) as unknown;
        const run = openInGo([{ box: sealed.value.box, expectOpen: true, expect: want }]);
        expect(run.stderr).toMatch(/^case 0: payload differs from the one sealed\n/);
        expect(run.status).toBe(1);
    });
});
