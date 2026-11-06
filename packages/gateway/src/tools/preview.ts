import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { z } from "zod";
import { GatewayError, errorReason } from "../router.ts";
import {
    handleTag,
    ok,
    routerLink,
    sandboxFailure,
    timeLeft,
    type Deps,
    type Register,
    handleInput,
} from "./common.ts";

const quoteHint = 'bugnet_quote with needs ["preview"]';

// The shared wording for these two refusals cannot name previews or the quote need they depend on
function previewRefusal(err: unknown): unknown {
    if (!(err instanceof ConnectError)) return err;
    if (err.code === Code.Unimplemented) {
        return new GatewayError(
            "unsupported",
            "preview: Bugnet has not opened web previews yet, so a retry now or later gets the " +
                "same answer. The other Bugnet tools work as usual",
        );
    }
    const reason = errorReason(err);
    if (err.code === Code.FailedPrecondition && reason === "FEATURE_UNAVAILABLE") {
        return new GatewayError(
            "unsupported",
            "preview: web previews are not open on this sandbox, the other Bugnet tools work " +
                `here as usual. A sandbox started from ${quoteHint} has them`,
            null,
            reason,
        );
    }
    return err;
}

// The router's link may leave out the scheme, and every preview is served over https
export function previewLink(deps: Deps, raw: string): URL {
    const url = routerLink(deps, raw, /^\/$/, true);
    if (!url) throw new GatewayError("internal", "preview: the router gave no usable link");
    return url;
}

// Data-plane 4.4, bnp_ and 32 bytes of base64url, the one shape safe inside the curl command
const tokenShape = /^bnp_[A-Za-z0-9_-]{43}$/;

function note(port: number, host: string, token: string, listening: boolean): string {
    const reach =
        "Anyone holding the url or token reaches the app until it expires. A browser may first " +
        `see a Bugnet notice page, curl -H 'Bugnet-Token: ${token}' https://${host}/path ` +
        "skips it. Each preview is one origin, so a frontend reaches an API on another port " +
        "through its dev server's proxy, not a second preview. webpack-dev-server needs " +
        `allowedHosts: 'all', Django needs ${host} in ALLOWED_HOSTS, and Vite works as is.`;
    if (listening) return reach;
    return (
        `Nothing answered on port ${port} yet, so the link shows an error page until a server ` +
        "listens there, for example one started in the background with bugnet_exec " +
        "(nohup npm run dev > dev.log 2>&1 &). Calling bugnet_preview again for port " +
        `${port} then shows listening true. ${reach}`
    );
}

export const registerPreviewTool: Register = (server, deps) => {
    server.registerTool(
        "bugnet_preview",
        {
            title: "Open a web preview of a Bugnet sandbox port",
            description:
                "Makes an HTTPS link to a port in the sandbox, so you or the user can reach a " +
                "web app or API running there. The link holds a bearer token and lasts until the " +
                "sandbox's deadline. Calling it again for the same port returns the same link. " +
                "listening says whether a server answered on the port. Servers bound to " +
                "127.0.0.1 are reachable too. Previews work on sandboxes quoted with needs " +
                '["preview"].',
            inputSchema: z.object({
                handle: handleInput,
                port: z.number().int().min(1).max(65_535).describe("Port the app listens on"),
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (args) => {
            try {
                let res;
                try {
                    res = await deps.router.createPreview({ handle: args.handle, port: args.port });
                } catch (e) {
                    throw previewRefusal(e);
                }
                if (!tokenShape.test(res.token)) {
                    throw new GatewayError("internal", "preview: the router gave no usable token");
                }
                const url = previewLink(deps, res.url);
                const expires = res.expiresAt ? timestampDate(res.expiresAt) : undefined;
                const left = timeLeft(expires, deps.now());
                deps.log.info("preview created", {
                    handle: handleTag(args.handle),
                    port: args.port,
                    previewId: res.previewId,
                    listening: res.listening,
                });
                const until = expires
                    ? `until ${expires.toISOString()}, time left ${left}`
                    : "until the sandbox's deadline";
                const text =
                    `Preview of port ${args.port} is at ${url.href} ${until}. ` +
                    note(args.port, url.host, res.token, res.listening);
                return ok(text, {
                    url: url.href,
                    token: res.token,
                    expiresAt: expires?.toISOString() ?? null,
                    listening: res.listening,
                    previewId: res.previewId,
                    port: args.port,
                });
            } catch (e) {
                return sandboxFailure(deps, args.handle, e, "preview");
            }
        },
    );
};
