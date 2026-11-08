import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    ConfigError,
    defaultConfigPath,
    loadCommand,
    loadSignerSettings,
    parseSettings,
} from "./config.ts";

let dir = "";
const env = () => ({ XDG_CONFIG_HOME: join(dir, "xdg") });
const pin = "Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw";

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bugnet-bridge-config-"));
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("bridge settings", () => {
    it("defaults to Bugnet's public endpoints", () => {
        expect(parseSettings("")).toEqual({
            gateway_url: "https://mcp.bugnet.sh/mcp",
            secrets_url: "https://secrets.bugnet.sh",
            connect_timeout: 5_000,
            call_timeout: 300_000,
            secrets_timeout: 30_000,
            pay_command: "pay",
            pay_origin: "https://pay.bugnet.sh",
        });
    });

    it("matches config/example.toml", async () => {
        const text = await readFile(new URL("../config/example.toml", import.meta.url), "utf8");
        expect(parseSettings(text)).toEqual(parseSettings(""));
    });

    it("takes the pay command and an origin to pay, nothing more than an origin", () => {
        expect(parseSettings('pay_command = ""').pay_command).toBe("");
        expect(parseSettings('pay_origin = "https://pay.bugnet.sh/"').pay_origin).toBe(
            "https://pay.bugnet.sh",
        );
        expect(parseSettings('pay_origin = "http://127.0.0.1:8787"').pay_origin).toBe(
            "http://127.0.0.1:8787",
        );
        for (const bad of [
            "https://pay.bugnet.sh/o",
            "https://pay.bugnet.sh/?a=1",
            "https://pay.bugnet.sh/#x",
        ]) {
            expect(() => parseSettings(`pay_origin = "${bad}"`), bad).toThrow(
                /pay_origin: an origin/,
            );
        }
        expect(() => parseSettings('pay_origin = "http://pay.bugnet.sh"')).toThrow(
            /http on loopback/,
        );
    });

    it("names an unknown key and a bad duration", () => {
        expect(() => parseSettings('gatway_url = "x"')).toThrow("unknown key gatway_url");
        expect(() => parseSettings('call_timeout = "5 minutes"')).toThrow(/call_timeout/);
        expect(() => parseSettings("gateway_url = ")).toThrow(ConfigError);
    });

    it("refuses plain http except on loopback", () => {
        expect(() => parseSettings('secrets_url = "http://secrets.bugnet.sh"')).toThrow(
            /https URL, or http on loopback/,
        );
        expect(parseSettings('gateway_url = "http://127.0.0.1:8787/mcp"').gateway_url).toBe(
            "http://127.0.0.1:8787/mcp",
        );
        expect(parseSettings('gateway_url = "http://[::1]:8787/mcp"').gateway_url).toBe(
            "http://[::1]:8787/mcp",
        );
    });

    it("counts only localhost, ::1 and 127.0.0.0/8 literals as loopback", () => {
        for (const url of [
            "http://localhost:9/mcp",
            "http://127.0.0.1/mcp",
            "http://127.255.0.9/mcp",
            "http://127.1/mcp",
            "http://[::1]/mcp",
        ]) {
            expect(parseSettings(`gateway_url = "${url}"`).gateway_url, url).toBe(url);
        }
        for (const url of [
            "http://127.attacker.example/mcp",
            "http://127.0.0.1.nip.io/mcp",
            "http://127-0-0-1.example/mcp",
            "http://localhost.example/mcp",
            "http://128.0.0.1/mcp",
        ]) {
            expect(() => parseSettings(`secrets_url = "${url}"`), url).toThrow(/http on loopback/);
            expect(
                () => loadCommand(["--gateway", url, "--config", "/dev/null"], env()),
                url,
            ).toThrow(/http on loopback/);
        }
    });
});

describe("command line", () => {
    it("serves the defaults when no settings file exists", () => {
        const c = loadCommand([], env());
        expect(c.kind === "serve" && c.settings.gateway_url).toBe("https://mcp.bugnet.sh/mcp");
        expect(defaultConfigPath(env())).toBe(join(dir, "xdg", "bugnet", "mcp.toml"));
    });

    it("reads --config and lets --gateway win over it", async () => {
        const path = join(dir, "mcp.toml");
        await writeFile(
            path,
            'gateway_url = "https://gw.example/mcp"\nsecrets_url = "https://s.example"\n',
        );
        const fromFile = loadCommand(["--config", path], env());
        expect(fromFile.kind === "serve" && fromFile.settings.gateway_url).toBe(
            "https://gw.example/mcp",
        );
        const flagged = loadCommand(
            ["--config", path, "--gateway", "http://localhost:9/mcp"],
            env(),
        );
        expect(flagged.kind === "serve" && flagged.settings).toMatchObject({
            gateway_url: "http://localhost:9/mcp",
            secrets_url: "https://s.example",
        });
    });

    it("needs a file named with --config to exist, and refuses unknown flags", () => {
        expect(() => loadCommand(["--config", join(dir, "none.toml")], env())).toThrow(/read /);
        expect(() => loadCommand(["--gatewy", "x"], env())).toThrow(ConfigError);
        expect(() => loadCommand(["--gateway", "http://evil.example/mcp"], env())).toThrow(
            /https URL/,
        );
    });

    it("answers --help and --version", () => {
        expect(loadCommand(["--help"], env())).toEqual({ kind: "help" });
        expect(loadCommand(["--version"], env())).toEqual({ kind: "version" });
    });
});

describe("signer settings", () => {
    const fixed = () => join(dir, "home", ".config", "bugnet", "mcp.toml");
    const write = async (text: string, mode = 0o600) => {
        await mkdir(join(dir, "home", ".config", "bugnet"), { recursive: true });
        await writeFile(fixed(), text);
        await chmod(fixed(), mode);
    };

    it("reads the key signer and its pins only from the fixed file, defaulting to pay", async () => {
        expect(loadSignerSettings(join(dir, "nohome")).paySigner).toBe("pay");
        await write('pay_signer = "key"\nmax_payment_usd = 0.5\npay_to = ["' + pin + '"]\n');
        expect(loadSignerSettings(join(dir, "home"))).toEqual({
            paySigner: "key",
            maxPaymentMicros: 500_000,
            dailyMicros: 5_000_000,
            payTo: [pin],
            feePayer: [],
            keyPaysAllowances: false,
            allowancePayTo: [],
        });
        const cmd = loadCommand(["--config", fixed()], { HOME: join(dir, "home") });
        expect(cmd.kind === "serve" && cmd.signer.paySigner).toBe("key");
    });

    it("refuses a group-writable file, a raised ceiling and signer keys in --config", async () => {
        await write('pay_signer = "key"\n', 0o620);
        expect(() => loadSignerSettings(join(dir, "home"))).toThrow(/not writable by group/);
        await write("max_payment_usd = 21\n");
        expect(() => loadSignerSettings(join(dir, "home"))).toThrow(/max_payment_usd/);
        const other = join(dir, "other.toml");
        await writeFile(other, 'pay_signer = "key"\n');
        expect(() => loadCommand(["--config", other], { HOME: join(dir, "home") })).toThrow(
            /pay_signer is read only from/,
        );
    });

    it("reads key_pays_allowances off by default, and refuses an allowance pin that repeats pay_to", async () => {
        await write(
            'pay_signer = "key"\nkey_pays_allowances = true\nallowance_pay_to = ["' + pin + '"]\n',
        );
        expect(loadSignerSettings(join(dir, "home"))).toMatchObject({
            keyPaysAllowances: true,
            allowancePayTo: [pin],
        });
        await write('pay_to = ["' + pin + '"]\nallowance_pay_to = ["' + pin + '"]\n');
        expect(() => loadSignerSettings(join(dir, "home"))).toThrow(/repeat a pay_to/);
        const other = join(dir, "other.toml");
        await writeFile(other, "key_pays_allowances = true\n");
        expect(() => loadCommand(["--config", other], { HOME: join(dir, "home") })).toThrow(
            /key_pays_allowances is read only from/,
        );
    });

    it("refuses the fixed file only from a working folder strictly below HOME that holds it", async () => {
        await write('pay_signer = "key"\n');
        const home = join(dir, "home");
        for (const cwd of ["/", dir, home]) {
            expect(loadSignerSettings(home, cwd).paySigner, cwd).toBe("key");
        }
        for (const cwd of [join(home, ".config"), join(home, ".config", "bugnet")]) {
            expect(() => loadSignerSettings(home, cwd), cwd).toThrow(/inside the working folder/);
        }
    });

    it("checks a file without signer keys for nothing, so a 0664 one still starts", async () => {
        await write('gateway_url = "https://gw.example/mcp"\n', 0o664);
        const home = join(dir, "home");
        const e = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
        const cmd = loadCommand([], e, join(home, ".config", "bugnet"));
        expect(cmd.kind === "serve" && cmd.signer.paySigner).toBe("pay");
        await write('pay_signer = "key"\n', 0o664);
        expect(() => loadCommand([], e, "/")).toThrow(/not writable by group/);
    });
});
