import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, defaultConfigPath, loadCommand, parseSettings } from "./config.ts";

let dir = "";
const env = () => ({ XDG_CONFIG_HOME: join(dir, "xdg") });

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
            connect_timeout: 10_000,
            call_timeout: 300_000,
            secrets_timeout: 30_000,
        });
    });

    it("matches config/example.toml", async () => {
        const text = await readFile(new URL("../config/example.toml", import.meta.url), "utf8");
        expect(parseSettings(text)).toEqual(parseSettings(""));
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
