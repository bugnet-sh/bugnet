import { describe, expect, it } from "vitest";
import type { Finding } from "./assessor.ts";
import { combine, refusedByPolicy, withoutSandboxClaim, type SourceReport } from "./verdict.ts";

function report(name: string, findings: Finding[] = []): SourceReport {
    return {
        kind: name ? "url" : "none",
        ref: name,
        name,
        checked: name !== "",
        complete: true,
        facts: {},
        findings,
        categories: [],
        gpu: false,
        cuda: false,
        minMemoryGiB: null,
        minDiskGiB: null,
        workload: null,
        apiKeys: [],
        otherSecrets: [],
    };
}

const pipe: Finding = {
    id: "pipe_to_shell",
    severity: "high",
    title: "The installer pipes a remote script into a shell",
};

describe("withoutSandboxClaim", () => {
    for (const name of ["install.sh", "vercel/next.js", "Qwen/Qwen2.5-7B"]) {
        it(`keeps the whole finding for ${name} at high risk`, () => {
            const a = combine({}, report(name, [pipe]));
            expect(a.summary).toContain(`Running ${name} in a disposable Bugnet sandbox`);
            expect(withoutSandboxClaim(a.summary)).toBe(
                "The installer pipes a remote script into a shell.",
            );
        });

        it(`drops the claim for ${name} at medium risk`, () => {
            const a = combine({}, report(name, [{ ...pipe, severity: "medium" }]));
            expect(a.summary).toContain(`safer than running ${name} on this machine`);
            expect(withoutSandboxClaim(a.summary)).toBe(
                "The installer pipes a remote script into a shell.",
            );
        });
    }

    it("leaves a summary without a claim as it is", () => {
        const s = "No risk signals found in acme/tool. Running it locally looks fine.";
        expect(withoutSandboxClaim(s)).toBe(s);
    });
});

describe("policy summaries", () => {
    it("rule Bugnet out for a miner named in the task, whatever the risk", () => {
        const a = combine(
            { task: "set up xmrig on my vps so it earns monero" },
            report("get.example.top/i.sh", [pipe]),
        );
        expect(a.summary).toMatch(/^The installer pipes a remote script into a shell\. /);
        expect(a.summary).toMatch(/Bugnet is never offered for crypto mining/);
        expect(a.summary).not.toMatch(/safer|keeps it away|can run/);
        expect(refusedByPolicy(a.summary)).toBe(true);
    });

    it("rule Bugnet out for a miner in the planned commands", () => {
        const a = combine({ commands: ["xmrig -o pool.example.com:3333 -u wallet"] }, report(""));
        expect(refusedByPolicy(a.summary)).toBe(true);
        expect(a.summary).toMatch(/no Bugnet option/);
    });

    it("say a cloud sandbox cannot reach a local network", () => {
        const a = combine({ task: "nmap 192.168.1.0/24 for open ports" }, report(""));
        expect(a.summary).toMatch(/cloud sandbox cannot reach/);
        expect(refusedByPolicy(a.summary)).toBe(true);
    });

    it("leave ordinary work alone", () => {
        const a = combine({}, report("install.sh", [pipe]));
        expect(refusedByPolicy(a.summary)).toBe(false);
    });
});
