import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBase58Decoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SignerSettings } from "./config.ts";
import { KeyError, keySigner, loadEnvWallet, runKeyCommand, signerFromBytes } from "./keyfile.ts";
import { KeyPayer } from "./keypay.ts";
import { stderrLog } from "./log.ts";
import type { PaymentStep } from "./pay.ts";
import { SpendLedger } from "./spend.ts";

const name = "BUGNET_TEST_WALLET";
const origin = "https://pay.bugnet.sh";

let root = "";
let cwd = "";
let home = "";

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bugnet-walletenv-"));
    cwd = join(root, "project");
    home = join(root, "home");
    await mkdir(cwd);
    await mkdir(join(home, ".config", "bugnet"), { recursive: true, mode: 0o700 });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

function freshKey(): Uint8Array {
    const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const bytes = new Uint8Array(64);
    bytes.set(Buffer.from(jwk.d as string, "base64url"));
    bytes.set(Buffer.from(jwk.x as string, "base64url"), 32);
    return bytes;
}

const base58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes);

async function addressOf(bytes: Uint8Array): Promise<string> {
    return (await signerFromBytes(bytes.slice())).address;
}

// Every form a leaked key could take in text
function forms(bytes: Uint8Array): string[] {
    return [
        `[${Array.from(bytes).join(",")}]`,
        Array.from(bytes).join(","),
        Array.from(bytes.subarray(0, 8)).join(","),
        base58(bytes),
        base58(bytes).slice(0, 20),
        base58(bytes.subarray(0, 32)),
        Buffer.from(bytes).toString("hex"),
        Buffer.from(bytes).toString("base64"),
        Buffer.from(bytes.subarray(0, 32)).toString("hex"),
    ];
}

async function codeOf(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (e) {
        if (e instanceof KeyError) return e.code;
        throw e;
    }
    return "none";
}

const settings: SignerSettings = {
    paySigner: "key",
    maxPaymentMicros: 1_000_000,
    dailyMicros: 5_000_000,
    payTo: ["Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw"],
    feePayer: ["73iCm2eWpXsEqTpYkNHe4VoiR4Eq7nyCLv9wYZzEnFM9"],
    keyPaysAllowances: false,
    allowancePayTo: [],
    keyOrigin: origin,
    walletEnv: name,
};

const step: PaymentStep = {
    tool: "bugnet_start",
    orderId: "ord_1",
    claim: "c".repeat(43),
    payUrl: `${origin}/o/ord_1`,
    amountMicros: 1,
};

describe("wallet_env key", () => {
    it("reads the key from the working folder's .env, as base58 or a JSON array", async () => {
        const a = freshKey();
        await writeFile(join(cwd, ".env"), `OTHER=1\n${name}=${base58(a)}\n`);
        expect((await loadEnvWallet(name, cwd, {})).address).toBe(await addressOf(a));
        const b = freshKey();
        await writeFile(join(cwd, ".env"), `export ${name}="[${Array.from(b).join(", ")}]"\n`);
        expect((await loadEnvWallet(name, cwd, {})).address).toBe(await addressOf(b));
    });

    it("falls back to the bridge's environment, and .env wins over it", async () => {
        const fromEnv = freshKey();
        const fromFile = freshKey();
        const env = { [name]: base58(fromEnv) };
        expect((await loadEnvWallet(name, cwd, env)).address).toBe(await addressOf(fromEnv));
        await writeFile(join(cwd, ".env"), "OTHER=1\n");
        expect((await loadEnvWallet(name, cwd, env)).address).toBe(await addressOf(fromEnv));
        await writeFile(join(cwd, ".env"), `${name}=${base58(fromFile)}\n`);
        expect((await loadEnvWallet(name, cwd, env)).address).toBe(await addressOf(fromFile));
    });

    it("reads the value again for each payment", async () => {
        const env: NodeJS.ProcessEnv = {};
        const signer = keySigner(name, home, () => cwd, env);
        expect(await codeOf(signer())).toBe("wallet_env_missing");
        const a = freshKey();
        await writeFile(join(cwd, ".env"), `${name}=${base58(a)}\n`);
        expect((await signer()).address).toBe(await addressOf(a));
        const b = freshKey();
        await writeFile(join(cwd, ".env"), `${name}=${base58(b)}\n`);
        expect((await signer()).address).toBe(await addressOf(b));
    });

    it("gives fixed codes for a missing or invalid value", async () => {
        expect(await codeOf(loadEnvWallet(name, cwd, {}))).toBe("wallet_env_missing");
        expect(await codeOf(loadEnvWallet(name, cwd, { [name]: "" }))).toBe("wallet_env_missing");
        const key = freshKey();
        const mixed = new Uint8Array(64);
        mixed.set(key.subarray(0, 32));
        mixed.set(freshKey().subarray(32), 32);
        for (const bad of [
            "not-a-key",
            base58(key.subarray(0, 63)),
            `[${Array.from(key.subarray(0, 63)).join(",")}]`,
            base58(mixed),
            Buffer.from(key).toString("hex"),
        ]) {
            await writeFile(join(cwd, ".env"), `${name}=${bad}\n`);
            expect(await codeOf(loadEnvWallet(name, cwd, {})), bad).toBe("wallet_env_invalid");
        }
    });

    it("refuses a symlinked, oversized or non-regular .env, even with the variable set", async () => {
        const key = freshKey();
        const env = { [name]: base58(freshKey()) };
        const target = join(root, "elsewhere.env");
        await writeFile(target, `${name}=${base58(key)}\n`);
        await symlink(target, join(cwd, ".env"));
        expect(await codeOf(loadEnvWallet(name, cwd, env))).toBe("wallet_env_file");
        await rm(join(cwd, ".env"));
        await writeFile(join(cwd, ".env"), `${name}=${base58(key)}\n${"#".repeat(64 * 1024)}\n`);
        expect(await codeOf(loadEnvWallet(name, cwd, env))).toBe("wallet_env_file");
        await rm(join(cwd, ".env"));
        await mkdir(join(cwd, ".env"));
        expect(await codeOf(loadEnvWallet(name, cwd, env))).toBe("wallet_env_file");
        await rm(join(cwd, ".env"), { recursive: true });
        execFileSync("mkfifo", [join(cwd, ".env")]);
        expect(await codeOf(loadEnvWallet(name, cwd, env))).toBe("wallet_env_file");
    });

    it("never reads the wallet file when wallet_env is set", async () => {
        expect((await runKeyCommand({ kind: "key-new" }, home, root)).code).toBe(0);
        const fromWallet = (await keySigner(null, home, () => root, {})()).address;
        const env = { [name]: base58(freshKey()) };
        const fromEnv = (await keySigner(name, home, () => root, env)()).address;
        expect(fromEnv).not.toBe(fromWallet);
        // Without the variable it signs nothing rather than fall back to the wallet file
        expect(await codeOf(keySigner(name, home, () => root, {})())).toBe("wallet_env_missing");
        // A wallet file the loader would refuse is never opened
        await chmod(join(home, ".config", "bugnet", "wallet.json"), 0o644);
        expect((await keySigner(name, home, () => root, env)()).address).toBe(fromEnv);
    });

    it("signs nothing unless ~/.config/bugnet, home of the spend ledger, passes the folder check", async () => {
        const env = { [name]: base58(freshKey()) };
        const folder = join(home, ".config", "bugnet");
        expect(await codeOf(keySigner(name, undefined, () => cwd, env)())).toBe("no_home");
        expect(await codeOf(keySigner(name, "relative", () => cwd, env)())).toBe("no_home");
        await chmod(folder, 0o755);
        expect(await codeOf(keySigner(name, home, () => cwd, env)())).toBe("folder_mode");
        await rm(folder, { recursive: true });
        expect(await codeOf(keySigner(name, home, () => cwd, env)())).toBe("folder_mode");
        await mkdir(join(root, "elsewhere"), { mode: 0o700 });
        await symlink(join(root, "elsewhere"), folder);
        expect(await codeOf(keySigner(name, home, () => cwd, env)())).toBe("folder_mode");
        await rm(folder);
        await mkdir(folder, { mode: 0o700 });
        const below = join(home, ".config");
        expect(await codeOf(keySigner(name, home, () => below, env)())).toBe("inside_cwd");
        expect(await codeOf(keySigner(name, home, () => cwd, env)())).toBe("none");
    });

    it("signs nothing and leaks nothing when the value is missing or invalid", async () => {
        const key = freshKey();
        // One number short, so a careless parser would quote the rest
        const nearly = `[${Array.from(key.subarray(0, 63)).join(",")}]`;
        const cases: [string | null, string][] = [
            [null, "key_wallet_env_missing"],
            [nearly, "key_wallet_env_invalid"],
            [base58(key).slice(0, 80) + "0OIl", "key_wallet_env_invalid"],
        ];
        for (const [i, [value, reason]] of cases.entries()) {
            await writeFile(join(cwd, ".env"), value === null ? "OTHER=1\n" : `${name}=${value}\n`);
            const lines: string[] = [];
            let fetched = 0;
            const payer = new KeyPayer({
                origin,
                settings,
                signer: keySigner(name, home, () => cwd, {}),
                ledger: new SpendLedger({ dir: join(root, `spend-${i}`) }),
                log: stderrLog((l) => lines.push(l)),
                fetch: (async () => {
                    fetched++;
                    return Response.json({});
                }) as typeof fetch,
            });
            const out = await payer.pay(step, 1);
            expect(out).toEqual({ kind: "unavailable", reason });
            expect(fetched).toBe(0);
            let errText = "";
            try {
                await loadEnvWallet(name, cwd, {});
            } catch (e) {
                const err = e as Error;
                errText = `${err.message}\n${err.stack ?? ""}\n${String(err.cause ?? "")}`;
            }
            const text = lines.join("") + JSON.stringify(out) + errText;
            expect(lines.some((l) => JSON.parse(l).reason === reason)).toBe(true);
            for (const f of [...forms(key), ...(value ? [value.slice(0, 30)] : [])]) {
                expect(text).not.toContain(f);
            }
        }
    });

    it("keeps the key out of the log and the outcome on a paid order", async () => {
        const key = freshKey();
        await writeFile(join(cwd, ".env"), `${name}=${base58(key)}\n`);
        const lines: string[] = [];
        const payer = new KeyPayer({
            origin,
            settings,
            signer: keySigner(name, home, () => cwd, {}),
            ledger: new SpendLedger({ dir: join(root, "spend") }),
            log: stderrLog((l) => lines.push(l)),
            fetch: (async () => Response.json({ paid: true })) as typeof fetch,
        });
        const out = await payer.pay(step, 1);
        expect(out).toEqual({ kind: "paid" });
        const text = lines.join("") + JSON.stringify(out);
        for (const f of forms(key)) expect(text).not.toContain(f);
    });
});
