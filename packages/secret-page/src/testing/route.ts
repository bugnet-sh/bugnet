/**
 * A fake secrets route for the page's smoke tests, with the rules of data-plane 8.4.
 *
 * It serves a built bundle with the headers its headers.txt lists, answers the two page calls
 * from links it holds in memory, and records every request so a test can check what the browser
 * sent and open the sealed boxes with the development key.
 */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { canonicalHeaderNames, canonicalHosts, fromBase64Url, maxBoxBytes } from "@bugnet/seal";
import type { SealingKey, SecretSpec } from "@bugnet/seal";
import { headersFile } from "../build.ts";

export interface FakeLink {
    pairingCode: string;
    sourceLabel?: string;
    sandboxCreatedAt?: string;
    expiresAt?: string;
    suggested?: Partial<SecretSpec>;
    sealingKeys: SealingKey[];
    // Refusals the next puts get before one succeeds, as status and lower-case reason
    refusals?: { status: number; error: string }[];
    state?: "APPLYING" | "ACTIVE" | "FAILED";
    failureReason?: string;
}

export interface Recorded {
    method: string;
    path: string;
    headers: IncomingHttpHeaders;
}

export interface Put {
    token: string;
    headers: IncomingHttpHeaders;
    body: {
        spec: SecretSpec;
        value: { keyId: string; box: string };
        submissionId: string;
    };
}

export interface FakeRoute {
    origin: string;
    requests: Recorded[];
    puts: Put[];
    close(): Promise<void>;
}

const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
};

export async function readHeadersFile(pageDir: string): Promise<[string, string][]> {
    const text = await readFile(join(pageDir, headersFile), "utf8");
    return text
        .split("\n")
        .filter((l) => l.trim() !== "" && !l.startsWith("#"))
        .map((l) => {
            const at = l.indexOf(":");
            if (at < 1) throw new Error(`headers file line ${JSON.stringify(l)} has no name`);
            return [l.slice(0, at).trim(), l.slice(at + 1).trim()];
        });
}

const json = (res: ServerResponse, status: number, doc: unknown): void => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(doc));
};

const refuse = (res: ServerResponse, status: number, error: string): void =>
    json(res, status, { error, message: `refused with ${error}` });

function exactKeys(doc: unknown, keys: string[]): doc is Record<string, unknown> {
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return false;
    const got = Object.keys(doc).sort();
    return got.length === keys.length && [...keys].sort().every((k, i) => k === got[i]);
}

function strings(v: unknown): v is string[] {
    return Array.isArray(v) && v.every((s) => typeof s === "string");
}

// Data-plane 8.4's JSON rules, which the real route applies before calling the router
function wellFormed(body: unknown): body is Put["body"] {
    if (!exactKeys(body, ["spec", "value", "submissionId"])) return false;
    const { spec, value, submissionId } = body;
    if (!exactKeys(spec, ["name", "hosts", "headerNames", "fetchOnly"])) return false;
    if (!exactKeys(value, ["keyId", "box"])) return false;
    if (typeof submissionId !== "string" || submissionId.length === 0) return false;
    if (typeof spec.name !== "string" || typeof spec.fetchOnly !== "boolean") return false;
    if (!strings(spec.hosts) || !strings(spec.headerNames)) return false;
    return typeof value.keyId === "string" && typeof value.box === "string";
}

function canonical(spec: SecretSpec): boolean {
    try {
        return (
            JSON.stringify(canonicalHosts(spec.hosts)) === JSON.stringify(spec.hosts) &&
            JSON.stringify(canonicalHeaderNames(spec.headerNames)) ===
                JSON.stringify(spec.headerNames)
        );
    } catch {
        return false;
    }
}

export async function startFakeRoute(
    pageDir: string,
    links: Record<string, FakeLink>,
): Promise<FakeRoute> {
    const headers = await readHeadersFile(pageDir);
    const requests: Recorded[] = [];
    const puts: Put[] = [];
    const used = new Map<string, { submissionId: string; answer: unknown }>();
    let origin = "";

    async function serveFile(res: ServerResponse, file: string): Promise<void> {
        let bytes: Buffer;
        try {
            bytes = await readFile(file);
        } catch {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("not found");
            return;
        }
        res.writeHead(200, {
            ...Object.fromEntries(headers),
            "content-type": types[extname(file)] ?? "application/octet-stream",
        });
        res.end(bytes);
    }

    // Page calls must come from the page itself, and a same-site preview counts as cross-site
    function pageCall(h: IncomingHttpHeaders, stateChange: boolean): boolean {
        if (h["content-type"] !== "application/json") return false;
        const site = h["sec-fetch-site"];
        if (site !== undefined && site !== "same-origin") return false;
        if (h.origin !== undefined && h.origin !== origin) return false;
        return !stateChange || h.origin === origin;
    }

    async function readBody(req: import("node:http").IncomingMessage): Promise<string | null> {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > 128 * 1024) return null;
            chunks.push(chunk as Buffer);
        }
        return Buffer.concat(chunks).toString("utf8");
    }

    // Large like the real route, so a full cookie jar never breaks the page
    const server = createServer({ maxHeaderSize: 1024 * 1024 }, (req, res) => {
        void (async () => {
            const url = new URL(req.url ?? "/", origin);
            const path = url.pathname;
            requests.push({ method: req.method ?? "", path, headers: req.headers });

            if (req.method === "GET" && path.startsWith("/l/")) {
                return serveFile(res, join(pageDir, "index.html"));
            }
            if (req.method === "GET" && path.startsWith("/assets/")) {
                const file = normalize(join(pageDir, path));
                if (!file.startsWith(join(pageDir, "assets") + sep))
                    return refuse(res, 404, "none");
                return serveFile(res, file);
            }

            const linkMatch = /^\/v1\/links\/([^/]+)(\/secret)?$/.exec(path);
            if (!linkMatch) return refuse(res, 404, "not_found");
            const token = decodeURIComponent(linkMatch[1] as string);
            const link = Object.hasOwn(links, token) ? links[token] : undefined;

            if (req.method === "GET" && !linkMatch[2]) {
                if (!pageCall(req.headers, false)) return refuse(res, 403, "origin_refused");
                if (!link || used.has(token)) return refuse(res, 404, "link_unknown");
                return json(res, 200, {
                    pairingCode: link.pairingCode,
                    ...(link.sourceLabel ? { sourceLabel: link.sourceLabel } : {}),
                    ...(link.sandboxCreatedAt ? { sandboxCreatedAt: link.sandboxCreatedAt } : {}),
                    ...(link.expiresAt ? { expiresAt: link.expiresAt } : {}),
                    ...(link.suggested ? { suggested: link.suggested } : {}),
                    sealingKeys: link.sealingKeys,
                });
            }

            if (req.method === "PUT" && linkMatch[2]) {
                if (!pageCall(req.headers, true)) return refuse(res, 403, "origin_refused");
                const text = await readBody(req);
                if (text === null) return refuse(res, 413, "too_large");
                let body: unknown;
                try {
                    body = JSON.parse(text);
                } catch {
                    return refuse(res, 400, "bad_json");
                }
                if (!wellFormed(body) || !canonical(body.spec)) {
                    return refuse(res, 400, "invalid_argument");
                }
                const earlier = used.get(token);
                if (earlier) {
                    if (earlier.submissionId === body.submissionId) {
                        return json(res, 200, earlier.answer);
                    }
                    return refuse(res, 404, "link_unknown");
                }
                if (!link) return refuse(res, 404, "link_unknown");
                if (!link.sealingKeys.some((k) => k.keyId === body.value.keyId)) {
                    return refuse(res, 400, "key_unknown");
                }
                if (fromBase64Url(body.value.box).length > maxBoxBytes) {
                    return refuse(res, 400, "sealed_too_large");
                }
                puts.push({ token, headers: req.headers, body });
                const refusal = link.refusals?.shift();
                if (refusal) return refuse(res, refusal.status, refusal.error);
                const answer = {
                    secret: {
                        spec: body.spec,
                        state: link.state ?? "ACTIVE",
                        updatedAt: new Date().toISOString(),
                        failureReason: link.failureReason ?? "",
                    },
                };
                used.set(token, { submissionId: body.submissionId, answer });
                return json(res, 200, answer);
            }
            return refuse(res, 404, "not_found");
        })().catch(() => {
            if (!res.headersSent) refuse(res, 500, "internal");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    origin = `http://127.0.0.1:${address.port}`;

    return {
        origin,
        requests,
        puts,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
