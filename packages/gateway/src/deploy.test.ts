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
