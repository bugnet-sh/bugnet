/**
 * Reads the answers of GET /v1/links/<token> and PUT /v1/links/<token>/secret (data-plane 8.4).
 *
 * Absent fields take their proto defaults and unknown fields are ignored, so a newer route still
 * works. Every string shown on the page is cleaned here, and the page only ever sets it as text.
 */
import { failureCode, type SealingKey, type SecretSpec } from "@bugnet/seal";

export class AnswerError extends Error {}

export interface LinkInfo {
    pairingCode: string;
    // Empty when the router recorded no source
    sourceLabel: string;
    sandboxCreatedAt: Date | null;
    expiresAt: Date | null;
    suggested: SecretSpec;
    sealingKeys: SealingKey[];
}

export type SecretState = "APPLYING" | "ACTIVE" | "FAILED";

export interface SecretAnswer {
    spec: SecretSpec;
    state: SecretState;
    updatedAt: Date | null;
    failureReason: string;
}

const maxLabel = 200;
const maxList = 32;
const maxKeys = 16;

type Doc = Record<string, unknown>;

function isDoc(v: unknown): v is Doc {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function docField(doc: Doc, key: string): Doc {
    const v = doc[key];
    if (v === undefined || v === null) return {};
    if (!isDoc(v)) throw new AnswerError(`${key} is not an object`);
    return v;
}

function text(doc: Doc, key: string, max = 1000): string {
    const v = doc[key];
    if (v === undefined || v === null) return "";
    if (typeof v !== "string" || v.length > max) throw new AnswerError(`${key} is not a string`);
    return v;
}

function flag(doc: Doc, key: string): boolean {
    const v = doc[key];
    if (v === undefined || v === null) return false;
    if (typeof v !== "boolean") throw new AnswerError(`${key} is not a boolean`);
    return v;
}

function texts(doc: Doc, key: string, max = maxList): string[] {
    const v = doc[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > max || !v.every((s) => typeof s === "string")) {
        throw new AnswerError(`${key} is not a list of strings`);
    }
    return v.map((s: string) => s.slice(0, 300));
}

const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function time(doc: Doc, key: string): Date | null {
    const v = text(doc, key, 64);
    if (!v || !rfc3339.test(v)) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

// Control and format characters could reorder or hide what the label claims, so they go
export function cleanLabel(s: string): string {
    const plain = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim();
    return plain.length > maxLabel ? `${plain.slice(0, maxLabel)}...` : plain;
}

function spec(doc: Doc): SecretSpec {
    return {
        name: text(doc, "name", 200),
        hosts: texts(doc, "hosts"),
        headerNames: texts(doc, "headerNames"),
        fetchOnly: flag(doc, "fetchOnly"),
    };
}

export function parseLink(answer: unknown): LinkInfo {
    if (!isDoc(answer)) throw new AnswerError("the answer is not an object");
    // Crockford base32, which has no I, L, O or U
    const pairingCode = text(answer, "pairingCode", 64);
    if (!/^[0-9A-HJKMNP-TV-Z]{4,12}$/.test(pairingCode)) {
        throw new AnswerError("the answer has no pairing code");
    }
    const listed = answer.sealingKeys ?? [];
    if (!Array.isArray(listed) || listed.length > maxKeys) {
        throw new AnswerError("sealingKeys is not a list");
    }
    const sealingKeys = listed.map((k: unknown) => {
        if (!isDoc(k)) throw new AnswerError("a sealing key is not an object");
        return {
            keyId: text(k, "keyId", 100),
            publicKey: text(k, "publicKey", 200),
            binding: text(k, "binding", 200),
        };
    });
    return {
        pairingCode,
        sourceLabel: cleanLabel(text(answer, "sourceLabel", 4000)),
        sandboxCreatedAt: time(answer, "sandboxCreatedAt"),
        expiresAt: time(answer, "expiresAt"),
        suggested: spec(docField(answer, "suggested")),
        sealingKeys,
    };
}

const states: readonly string[] = ["APPLYING", "ACTIVE", "FAILED"];

export function parseSubmit(answer: unknown): SecretAnswer {
    if (!isDoc(answer)) throw new AnswerError("the answer is not an object");
    const secret = docField(answer, "secret");
    const state = text(secret, "state", 32);
    if (!states.includes(state)) throw new AnswerError("the answer has no secret state");
    const reason = text(secret, "failureReason", 200);
    return {
        spec: spec(docField(secret, "spec")),
        state: state as SecretState,
        updatedAt: time(secret, "updatedAt"),
        failureReason: failureCode(reason),
    };
}
