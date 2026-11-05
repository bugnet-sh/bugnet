import { describe, expect, it } from "vitest";
import { AnswerError, cleanLabel, parseLink, parseSubmit } from "./link.ts";

// The example of data-plane 8.4, field for field
const example = {
    pairingCode: "K3F9X2",
    sourceLabel: "github.com/acme/app@1a2b3c4",
    sandboxCreatedAt: "2026-11-05T13:55:00Z",
    expiresAt: "2026-11-05T14:05:00Z",
    suggested: { name: "HF_TOKEN", hosts: ["huggingface.co"], headerNames: [], fetchOnly: false },
    sealingKeys: [{ keyId: "k1", publicKey: "a".repeat(43), binding: "B".repeat(52) }],
};

describe("parseLink", () => {
    it("reads the spec's example", () => {
        const link = parseLink(example);
        expect(link).toEqual({
            pairingCode: "K3F9X2",
            sourceLabel: "github.com/acme/app@1a2b3c4",
            sandboxCreatedAt: new Date("2026-11-05T13:55:00Z"),
            expiresAt: new Date("2026-11-05T14:05:00Z"),
            suggested: example.suggested,
            sealingKeys: example.sealingKeys,
        });
    });

    it("gives absent fields their proto defaults, as protojson omits them", () => {
        const link = parseLink({ pairingCode: "K3F9X2" });
        expect(link.sourceLabel).toBe("");
        expect(link.sandboxCreatedAt).toBeNull();
        expect(link.suggested).toEqual({ name: "", hosts: [], headerNames: [], fetchOnly: false });
        expect(link.sealingKeys).toEqual([]);
    });

    it("ignores fields a newer route adds", () => {
        expect(parseLink({ ...example, somethingNew: { a: 1 } }).pairingCode).toBe("K3F9X2");
    });

    it("refuses an answer it cannot trust the shape of", () => {
        for (const bad of [
            null,
            [],
            "K3F9X2",
            {},
            { ...example, pairingCode: "k3f9x2" },
            { ...example, pairingCode: "K3F9X<" },
            { ...example, pairingCode: "ILOU12" },
            { ...example, sourceLabel: 7 },
            { ...example, suggested: "HF_TOKEN" },
            { ...example, suggested: { hosts: "huggingface.co" } },
            { ...example, suggested: { fetchOnly: "no" } },
            { ...example, sealingKeys: {} },
            { ...example, sealingKeys: ["k1"] },
            { ...example, sealingKeys: Array.from({ length: 17 }, () => example.sealingKeys[0]) },
        ]) {
            expect(() => parseLink(bad), JSON.stringify(bad)).toThrow(AnswerError);
        }
    });

    it("treats a timestamp that is not RFC 3339 as unknown", () => {
        expect(
            parseLink({ ...example, sandboxCreatedAt: "yesterday" }).sandboxCreatedAt,
        ).toBeNull();
        expect(parseLink({ ...example, expiresAt: "2026-11-05" }).expiresAt).toBeNull();
        expect(
            parseLink({ ...example, sandboxCreatedAt: "2026-11-05T13:55:00.123+01:00" })
                .sandboxCreatedAt,
        ).toEqual(new Date("2026-11-05T12:55:00.123Z"));
    });
});

describe("cleanLabel", () => {
    it("drops characters that could reorder or hide the label", () => {
        expect(cleanLabel("github.com/acme/‮ppa@1a2b3c4")).toBe("github.com/acme/ppa@1a2b3c4");
        expect(cleanLabel("a​b\u0000c\nd e")).toBe("abcde");
    });

    it("keeps markup as plain characters, since the page sets text only", () => {
        expect(cleanLabel("<b>Bugnet support</b>")).toBe("<b>Bugnet support</b>");
    });

    it("clamps a long label", () => {
        expect(cleanLabel("x".repeat(500))).toBe(`${"x".repeat(200)}...`);
    });
});

describe("parseSubmit", () => {
    it("reads the spec's example", () => {
        const answer = parseSubmit({
            secret: {
                spec: example.suggested,
                state: "ACTIVE",
                updatedAt: "2026-11-05T13:58:02Z",
                failureReason: "",
            },
        });
        expect(answer).toEqual({
            spec: example.suggested,
            state: "ACTIVE",
            updatedAt: new Date("2026-11-05T13:58:02Z"),
            failureReason: "",
        });
    });

    it("keeps only router codes as the failure reason", () => {
        const failed = (failureReason: string) =>
            parseSubmit({ secret: { spec: {}, state: "FAILED", failureReason } }).failureReason;
        expect(failed("SOURCE_UNKNOWN")).toBe("SOURCE_UNKNOWN");
        expect(failed("visit evil.example for help")).toBe("UNKNOWN");
    });

    it("refuses an answer without a known state", () => {
        expect(() => parseSubmit({ secret: { state: "DONE" } })).toThrow(AnswerError);
        expect(() => parseSubmit({})).toThrow(AnswerError);
    });
});
