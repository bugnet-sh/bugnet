import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyError, loadWallet, runKeyCommand, walletPath } from "./keyfile.ts";
import { KeyPayer } from "./keypay.ts";
import { stderrLog } from "./log.ts";
import { SpendLedger } from "./spend.ts";

let home = "";
const cwd = process.cwd();

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "bugnet-keyfile-"));
});

afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});

function freshKey(): Uint8Array {
    const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const bytes = new Uint8Array(64);
    bytes.set(Buffer.from(jwk.d as string, "base64url"));
    bytes.set(Buffer.from(jwk.x as string, "base64url"), 32);
    return bytes;
}

// Every form a leaked key could take in text
function forms(bytes: Uint8Array): string[] {
    return [
        `[${Array.from(bytes).join(",")}]`,
        Array.from(bytes).join(","),
        getBase58Decoder().decode(bytes),
        Buffer.from(bytes).toString("hex"),
        Buffer.from(bytes).toString("base64"),
        Buffer.from(bytes.subarray(0, 32)).toString("hex"),
    ];
}

describe("key new", () => {
    it("creates a 0600 file in a 0700 folder and prints only the address", async () => {
        const out = await runKeyCommand({ kind: "key-new" }, home, cwd);
        expect(out.code).toBe(0);
        const file = walletPath(home);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect((await stat(join(home, ".config", "bugnet"))).mode & 0o777).toBe(0o700);
        const bytes = Uint8Array.from(JSON.parse(await readFile(file, "utf8")) as number[]);
        const signer = await loadWallet(home, cwd);
        expect(out.stdout.split("\n")[0]).toBe(signer.address);
        expect(out.stdout).toMatch(/USDC/);
        for (const f of forms(bytes)) expect(out.stdout + out.stderr).not.toContain(f);
        const again = await runKeyCommand({ kind: "key-new" }, home, cwd);
        expect(again.code).toBe(1);
        expect(again.stderr).toMatch(/wallet_exists/);
    });
});

describe("key import", () => {
    it("moves a base58 key and prints only the address and the delete hint", async () => {
        const bytes = freshKey();
        const from = join(home, ".env");
        await writeFile(from, `OTHER=1\nWALLET=${getBase58Decoder().decode(bytes)}\n`);
        const out = await runKeyCommand(
            { kind: "key-import", from, variable: "WALLET" },
            home,
            cwd,
        );
        expect(out.code).toBe(0);
        expect(out.stdout).toContain(`delete WALLET from ${from} now`);
        expect(out.stderr).toMatch(/may already be exposed.*bugnet-mcp key new/s);
        for (const f of forms(bytes)) expect(out.stdout + out.stderr).not.toContain(f);
        const signer = await loadWallet(home, cwd);
        expect(out.stdout.split("\n")[0]).toBe(signer.address);
    });

    it("never echoes a bad value", async () => {
        const bytes = freshKey();
        const value = getBase58Decoder().decode(bytes.subarray(0, 63)) + "0OIl";
        const from = join(home, ".env");
        await writeFile(from, `WALLET=${value}\n`);
        const out = await runKeyCommand(
            { kind: "key-import", from, variable: "WALLET" },
            home,
            cwd,
        );
        expect(out.code).toBe(1);
        expect(out.stderr).toMatch(/var_format/);
        expect(out.stdout + out.stderr).not.toContain(value.slice(0, 20));
        // A valid key under a name the file lacks, and a JSON array one number short
        await writeFile(from, `WALLET=[${Array.from(bytes.subarray(0, 63)).join(",")}]\n`);
        for (const variable of ["WALLET", "OTHER"]) {
            const bad = await runKeyCommand({ kind: "key-import", from, variable }, home, cwd);
            expect(bad.code).toBe(1);
            for (const f of forms(bytes)) expect(bad.stdout + bad.stderr).not.toContain(f);
            expect(bad.stdout + bad.stderr).not.toContain(
                Array.from(bytes.subarray(0, 8)).join(","),
            );
        }
    });
});

describe("wallet file", () => {
    it("refuses a file readable by others and a folder open to others", async () => {
        await runKeyCommand({ kind: "key-new" }, home, cwd);
        await chmod(walletPath(home), 0o644);
        await expect(loadWallet(home, cwd)).rejects.toThrow(/wallet_mode/);
        await chmod(walletPath(home), 0o600);
        await chmod(join(home, ".config", "bugnet"), 0o755);
        await expect(loadWallet(home, cwd)).rejects.toThrow(/folder_mode/);
    });

    it("leaks no key bytes from a malformed file into errors or the log", async () => {
        const bytes = freshKey();
        const dir = join(home, ".config", "bugnet");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // 65 numbers, so the file is near-valid and a careless parser would quote it
        const text = `[${Array.from(bytes).join(",")},7`;
        await writeFile(walletPath(home), text, { mode: 0o600 });
        let thrown: unknown;
        try {
            await loadWallet(home, cwd);
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(KeyError);
        const err = thrown as Error;
        const errText = `${err.message}\n${err.stack ?? ""}\n${String(err.cause ?? "")}`;
        const lines: string[] = [];
        const payer = new KeyPayer({
            origin: "https://pay.bugnet.sh",
            settings: {
                paySigner: "key",
                maxPaymentMicros: 1_000_000,
                dailyMicros: 5_000_000,
                payTo: ["Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw"],
                feePayer: ["73iCm2eWpXsEqTpYkNHe4VoiR4Eq7nyCLv9wYZzEnFM9"],
                keyPaysAllowances: false,
                allowancePayTo: [],
            },
            signer: () => loadWallet(home, cwd),
            ledger: new SpendLedger({ path: join(dir, "spend.json") }),
            log: stderrLog((l) => lines.push(l)),
        });
        const out = await payer.pay(
            {
                tool: "bugnet_start",
                orderId: "ord_1",
                claim: "c".repeat(43),
                payUrl: "https://pay.bugnet.sh/o/ord_1",
                amountMicros: 1,
            },
            1,
        );
        expect(out).toEqual({ kind: "unavailable", reason: "key_wallet_format" });
        for (const f of [...forms(bytes), text.slice(1, 40)]) {
            expect(errText).not.toContain(f);
            expect(lines.join("")).not.toContain(f);
        }
    });
});
