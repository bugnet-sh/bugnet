import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acmeDomains, checkSettings, ConfigError, hostPort, parseSettings } from "../config.ts";

const example = new URL("../../../../config/example.toml", import.meta.url);

const prod = [
    'public_url = "https://mcp.bugnet.sh"',
    "[payments]",
    'url = "http://127.0.0.1:9000"',
    "[front]",
    'tls_addr = "127.0.0.1:8444"',
];

function check(lines: string[]): void {
    checkSettings(parseSettings(lines.join("\n")));
}

describe("front settings", () => {
    it("lists every default in config/example.toml", () => {
        expect(parseSettings(readFileSync(example, "utf8"))).toEqual(parseSettings(""));
    });

    it("defaults to no TLS front, PROXY headers required and a 30 day renewal", () => {
        const f = parseSettings("").front;
        expect(f.tls_addr).toBe("");
        expect(f.proxy_protocol).toBe(true);
        expect([f.proxy_timeout, f.handshake_timeout]).toEqual([3000, 10_000]);
        expect(f.proxy_max_bytes).toBe(536);
        expect(f.acme_renew_before).toBe(30 * 86_400_000);
        expect(() => parseSettings("[front]\ntls_adr = 'x'")).toThrow(/front.tls_adr/);
        expect(() => parseSettings("[front]\nproxy_max_bytes = 40")).toThrow(/proxy_max_bytes/);
        expect(() => parseSettings("[front]\nacme_directory = 'nope'")).toThrow(/acme_directory/);
    });

    it("splits host and port", () => {
        expect(hostPort("127.0.0.1:8444", "x")).toEqual({ host: "127.0.0.1", port: 8444 });
        expect(hostPort("[::1]:8444", "x")).toEqual({ host: "::1", port: 8444 });
        expect(hostPort(":8444", "x")).toEqual({ host: "", port: 8444 });
        for (const bad of ["8444", "127.0.0.1", "127.0.0.1:99999", "::1:8444", "a b:1"]) {
            expect(() => hostPort(bad, "front.tls_addr")).toThrow(/front.tls_addr/);
        }
    });

    it("needs exactly one certificate source for the TLS front", () => {
        expect(() => check(prod)).toThrow(/either cert_file and key_file or acme_directory/);
        expect(() => check([...prod, 'cert_file = "c.pem"'])).toThrow(/go together/);
        expect(() => check([...prod, 'cert_file = "c"', 'key_file = "k"'])).not.toThrow();
        const acme = [
            ...prod,
            'acme_directory = "https://acme-v02.api.letsencrypt.org/directory"',
            'acme_dir = "/var/lib/bugnet-gateway/acme"',
        ];
        expect(() => check(acme)).toThrow(/acme_accept_terms/);
        expect(() => check([...acme, "acme_accept_terms = true"])).not.toThrow();
        expect(() => check([...acme, "acme_accept_terms = true", 'cert_file = "c"'])).toThrow(
            /go together/,
        );
        const noDir = acme.filter((l) => !l.startsWith("acme_dir"));
        expect(() => check([...noDir, "acme_accept_terms = true"])).toThrow(/acme_dir/);
        expect(() => check([...prod.slice(0, -1), 'cert_file = "c"'])).toThrow(/need tls_addr/);
        expect(() => check([...prod.slice(0, -2), "[front]", 'tls_addr = "x"'])).toThrow(
            /host:port/,
        );
    });

    it("puts the public URL's host on the certificate unless names are set", () => {
        const acme = [
            ...prod,
            'acme_directory = "https://acme-v02.api.letsencrypt.org/directory"',
            'acme_dir = "/tmp/a"',
            "acme_accept_terms = true",
        ];
        expect(acmeDomains(parseSettings(acme.join("\n")))).toEqual(["mcp.bugnet.sh"]);
        const named = [...acme, 'acme_domains = ["mcp.bugnet.sh", "gw.bugnet.sh"]'];
        expect(acmeDomains(parseSettings(named.join("\n")))).toHaveLength(2);
        for (const bad of ["*.bugnet.sh", "127.0.0.1", "MCP.bugnet.sh", "localhost", "a..b.sh"]) {
            expect(() => check([...acme, `acme_domains = ["${bad}"]`])).toThrow(ConfigError);
        }
        const ip = acme.map((l) => l.replace("https://mcp.bugnet.sh", "https://192.0.2.1"));
        expect(() => check(ip)).toThrow(/no DNS name/);
    });

    it("keeps dev payments off any front a proxy relays", () => {
        const dev = ['[payments]\nmode = "dev"', "[front]", 'cert_file = "c"', 'key_file = "k"'];
        expect(() => check([...dev, 'tls_addr = "127.0.0.1:8444"'])).toThrow(/dev/);
        expect(() =>
            check([...dev, 'tls_addr = "0.0.0.0:8444"', "proxy_protocol = false"]),
        ).toThrow(/dev/);
        expect(() =>
            check([...dev, 'tls_addr = "127.0.0.1:8444"', "proxy_protocol = false"]),
        ).not.toThrow();
        expect(() =>
            check([...dev, 'tls_addr = "[::1]:8444"', "proxy_protocol = false"]),
        ).not.toThrow();
    });
});
