import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { usd } from "../tools/common.ts";

export const solanaNetwork = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const usdcAsset = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const usdTextPattern = /^\$?\d{1,3}(\.\d{1,6})?$/;
export const usdText = z.string().max(12).regex(usdTextPattern, "a dollar amount such as 0.01");

export function toMicros(text: string): number | null {
    if (!usdTextPattern.test(text)) return null;
    const [whole = "0", frac = ""] = text.replace(/^\$/, "").split(".");
    return Number(whole) * 1_000_000 + Number(frac.padEnd(6, "0"));
}

export function lineMax(micros: number): string {
    return usd(micros).slice(1);
}

export const serviceLinePattern =
    /^(GET|POST) (https:\/\/[a-z0-9.-]{1,253}(?:\/[!-~]*)?) max=(\d{1,3}(?:\.\d{1,6})?) payTo=([1-9A-HJ-NP-Za-km-z]{32,44})(?: prefix=(\/[!-~]{0,198}\/))?$/;
export const serviceLine = z
    .string()
    .max(400)
    .regex(
        serviceLinePattern,
        "a service line from bugnet_x402_find or bugnet_status; to re-price, change only max=",
    );

export const serviceIdPattern = /^xs_[a-z2-7]{16}$/;
export const disableId = z.string().regex(serviceIdPattern, "a service id from bugnet_status");

export type X402Method = "GET" | "POST";

export interface ServiceLineParts {
    line: string;
    method: X402Method;
    url: string;
    host: string;
    path: string;
    prefix: string;
    prefixGiven: boolean;
    maxMicros: number;
    payTo: string;
    serviceId: string;
}

export interface LineLimits {
    maxPriceMicros: number;
    bugnetAddresses: readonly string[];
}

export type LineRefusal = "malformed" | "max_above" | "payee";

export type ParsedServiceLine =
    | { ok: true; parts: ServiceLineParts }
    | { ok: false; refusal: LineRefusal; line: string; host: string | null };

const hex2 = /^[0-9a-fA-F]{2}$/;
const refusedBytes = new Set([0x2f, 0x5c, 0x2e, 0x3b, 0x25]);

export function pathRefused(path: string): boolean {
    if (!path.startsWith("/")) return true;
    if (path.split("/").some((s) => s === "." || s === "..")) return true;
    if (path.includes("//") || path.includes(";") || path.includes("\\")) return true;
    for (let i = 0; i < path.length; i++) {
        const c = path.charCodeAt(i);
        if (c < 0x21 || c > 0x7e) return true;
        if (c !== 0x25) continue;
        const h = path.slice(i + 1, i + 3);
        if (!hex2.test(h)) return true;
        const b = parseInt(h, 16);
        if (b < 0x20 || b >= 0x7f || refusedBytes.has(b)) return true;
    }
    return false;
}

export function prefixRefused(prefix: string, path: string): boolean {
    return !(
        /^\/.+\/$/.test(prefix) &&
        prefix.length <= 200 &&
        !pathRefused(prefix) &&
        (path + "/").startsWith(prefix)
    );
}

export function defaultPrefix(path: string): string | null {
    const p = path.slice(0, path.lastIndexOf("/") + 1);
    if (p === "/") return path === "/" ? null : path + "/";
    return p;
}

export function urlParts(url: string): { host: string; path: string } | null {
    if (!url.startsWith("https://") || url.includes("?") || url.includes("#")) return null;
    const rest = url.slice("https://".length);
    const slash = rest.indexOf("/");
    const host = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? "" : rest.slice(slash);
    if (host.includes("@") || host.includes(":") || !/^[a-z0-9.-]+$/.test(host)) return null;
    if (isIP(host) !== 0) return null;
    try {
        if (new URL(url).hostname !== host) return null;
    } catch {
        return null;
    }
    return pathRefused(path) ? null : { host, path };
}

const b32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += b32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if (bits > 0) out += b32[(value << (5 - bits)) & 31];
    return out;
}

export function serviceId(method: X402Method, host: string, prefix: string): string {
    const digest = createHash("sha256").update(`${method}\0${host}\0${prefix}`).digest();
    return `xs_${base32(digest).slice(0, 16)}`;
}

const b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    let out = "";
    while (n > 0n) {
        out = b58[Number(n % 58n)] + out;
        n /= 58n;
    }
    return "1".repeat(zeros) + out;
}

export function base58Decode(text: string): Uint8Array | null {
    let zeros = 0;
    while (zeros < text.length && text[zeros] === "1") zeros++;
    let n = 0n;
    for (const ch of text) {
        const i = b58.indexOf(ch);
        if (i < 0) return null;
        n = n * 58n + BigInt(i);
    }
    const body: number[] = [];
    while (n > 0n) {
        body.unshift(Number(n & 0xffn));
        n >>= 8n;
    }
    return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

export function isCanonicalPubkey(text: string): boolean {
    const bytes = base58Decode(text);
    return bytes !== null && bytes.length === 32 && base58Encode(bytes) === text;
}

export function parseServiceLine(line: string, limits: LineLimits): ParsedServiceLine {
    const m = serviceLinePattern.exec(line);
    if (!m) return { ok: false, refusal: "malformed", line, host: null };
    const [, method, url = "", max = "", payTo = "", given] = m;
    const host = url.slice("https://".length).split("/")[0] ?? "";
    const fail = (refusal: LineRefusal): ParsedServiceLine => ({ ok: false, refusal, line, host });
    const u = urlParts(url);
    if (!u) return fail("malformed");
    const prefix = given ?? defaultPrefix(u.path);
    if (prefix === null || prefixRefused(prefix, u.path)) return fail("malformed");
    const maxMicros = toMicros(max);
    if (maxMicros === null || maxMicros === 0 || !isCanonicalPubkey(payTo)) {
        return fail("malformed");
    }
    if (maxMicros > limits.maxPriceMicros) return fail("max_above");
    if (limits.bugnetAddresses.includes(payTo)) return fail("payee");
    return {
        ok: true,
        parts: {
            line,
            method: method as X402Method,
            url,
            host: u.host,
            path: u.path,
            prefix,
            prefixGiven: given !== undefined,
            maxMicros,
            payTo,
            serviceId: serviceId(method as X402Method, u.host, prefix),
        },
    };
}

export function formatServiceLine(s: {
    method: X402Method;
    url: string;
    maxMicros: number;
    payTo: string;
    prefix: string;
}): string {
    const base = `${s.method} ${s.url} max=${lineMax(s.maxMicros)} payTo=${s.payTo}`;
    const u = urlParts(s.url);
    return u !== null && defaultPrefix(u.path) === s.prefix ? base : `${base} prefix=${s.prefix}`;
}

export function findDuplicate(
    lines: readonly ServiceLineParts[],
    disable: readonly string[],
): ServiceLineParts | null {
    const seen = new Set<string>();
    for (const l of lines) {
        if (seen.has(l.serviceId) || disable.includes(l.serviceId)) return l;
        seen.add(l.serviceId);
    }
    return null;
}

export function underSuffix(host: string, suffixes: readonly string[]): boolean {
    return suffixes.some((s) => host === s || host.endsWith("." + s));
}

const sandboxHostDomains = [
    "e2b.app",
    "e2b.dev",
    "e2b-juliett.dev",
    "boxd.sh",
    "koyeb.app",
    "boat.dev",
    "ascii.dev",
];

export function hostRefused(host: string, linksDomain: string): boolean {
    const labels = host.split(".");
    if (labels.length < 2 || labels.some((l) => l === "" || l.length > 63)) return true;
    if (!/^[a-z0-9.-]+$/.test(host) || isIP(host) !== 0) return true;
    return underSuffix(host, [linksDomain, ...sandboxHostDomains]);
}

export const openAiEndings: readonly string[] = [
    "/chat/completions",
    "/embeddings",
    "/audio/speech",
    "/audio/transcriptions",
    "/images/generations",
    "/models",
];

export function openAiBase(path: string): string | null {
    const ending = openAiEndings.find((e) => path.endsWith(e));
    if (ending === undefined) return null;
    const base = path.slice(0, path.length - ending.length);
    return base === "" ? null : base;
}

export function envLinesFor(url: string, reviewed: readonly string[] | null): string[] {
    if (reviewed !== null) return reviewed.slice(0, 2);
    const u = urlParts(url);
    const base = u ? openAiBase(u.path) : null;
    if (!u || base === null) return [];
    return [`OPENAI_BASE_URL=https://${u.host}${base}`, "OPENAI_API_KEY=x402"];
}

export function lineCut(line: string): string {
    return line.slice(0, 80);
}

export function payToShort(payTo: string): string {
    return `${payTo.slice(0, 4)}...${payTo.slice(-4)}`;
}
