import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("the gateway's systemd unit", () => {
    it("runs as its own user, named for the deploy check", () => {
        const unit = read("deploy/bugnet-gateway@.service");
        expect(unit).toMatch(/^User=bugnet-gateway$/m);
        expect(unit).toMatch(/^ProtectSystem=strict$/m);
        expect(unit).not.toMatch(/^MemoryDenyWriteExecute=/m);
        expect(read("CONTRIBUTING.md")).toContain('GATEWAY_USERS="bugnet-gateway"');
    });
});

describe("the x402 crawl's systemd units", () => {
    it("crawl once a day as the gateway's user, with its hardening", () => {
        const unit = read("deploy/bugnet-x402-crawl@.service").split("\n");
        for (const line of [
            "Type=oneshot",
            "User=bugnet-gateway",
            "Group=bugnet-gateway",
            "StateDirectory=bugnet-gateway",
            "TimeoutStartSec=30min",
            "ExecStart=/usr/bin/node /opt/bugnet/gateway/%i/packages/gateway/dist/x402-crawl.js -config /etc/bugnet/gateway.toml",
            "CapabilityBoundingSet=",
            "NoNewPrivileges=yes",
            "ProtectSystem=strict",
            "ProtectHome=yes",
            "PrivateTmp=yes",
            "PrivateDevices=yes",
            "ProtectKernelTunables=yes",
            "ProtectKernelModules=yes",
            "ProtectControlGroups=yes",
            "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
            "LockPersonality=yes",
            "LimitCORE=0",
        ])
            expect(unit).toContain(line);
        expect(unit.some((l) => l.startsWith("EnvironmentFile="))).toBe(false);
        const timer = read("deploy/bugnet-x402-crawl@.timer").split("\n");
        for (const line of ["OnCalendar=daily", "RandomizedDelaySec=1h", "Persistent=true"])
            expect(timer).toContain(line);
        expect(read("packages/gateway/package.json")).toContain("--outfile=dist/x402-crawl.js");
        expect(read("CONTRIBUTING.md")).toContain(
            'hosts_seen_file = "/var/lib/bugnet-gateway/hosts-seen.json"',
        );
    });
});
