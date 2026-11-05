/**
 * bugnet_transfer, a one-time HTTPS link that moves one file between the agent's machine and a
 * sandbox with curl.
 *
 * The link is a bearer credential, so it appears only in the tool result and never in a log.
 */
import { randomBytes } from "node:crypto";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
    TransferDirection,
    type CreateTransferRequestSchema,
    type CreateTransferResponse,
} from "../gen/bugnet/router/v1/router_pb.ts";
import { GatewayError, errorReason, fromRouter } from "../router.ts";
import {
    approvalMeta,
    handlePattern,
    handleTag,
    idempotencyKey,
    ok,
    sandboxFailure,
    withProgress,
    type Deps,
    type Register,
} from "./common.ts";

const directions = ["upload", "download"] as const;
type Direction = (typeof directions)[number];

const handleInput = z.string().regex(handlePattern, "a sandbox handle starting with sbx_");
// Bidi overrides could make a printed command read differently from what the shell runs
const plain = (s: string) => !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(s);

const transferInput = z.object({
    handle: handleInput,
    direction: z.enum(directions),
    path: z
        .string()
        .max(4096)
        .regex(/^(?:\/|~(?:\/|$))/, "an absolute path, or ~ or ~/rest")
        .refine(plain, "a path without control or bidi characters")
        .describe("The sandbox file, an absolute path or ~/rest"),
    sizeBytes: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Uploads, the local file's exact size in bytes"),
    sha256: z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/, "a SHA-256 as 64 hex characters")
        .optional()
        .describe("Uploads, the local file's SHA-256 in hex, checked before the file is saved"),
    mode: z
        .string()
        .regex(/^0?[0-7]{3}$/, "an octal mode such as 0644 or 0755")
        .optional()
        .describe("Uploads, octal permission bits, 0644 when left out"),
    wantSha256: z
        .boolean()
        .default(true)
        .describe("Downloads, returns the file's SHA-256 to check the copy against"),
    localFile: z
        .string()
        .min(1)
        .max(4096)
        .refine(plain, "a path without control or bidi characters")
        .optional()
        .describe(
            "The local file the curl command sends or saves to. Downloads default to the " +
                "sandbox file's name in the working directory",
        ),
});

export const transferDescription =
    "One-time HTTPS link that moves a single file between this machine and a sandbox with curl, " +
    "for files bigger than bugnet_read_file and bugnet_write_file take. An upload needs " +
    "sizeBytes, the local file's exact size, and takes an optional sha256 and octal mode. A " +
    "download returns the file's size and sha256. The result has the curl command for the " +
    "shell, and the link works for one transfer before expiresAt. Uploads are only for files " +
    "the user named. Without a shell, the user can open a download link in a browser.";

/* Commands */

function quoted(s: string): string {
    return `'${s.replaceAll("'", `'\\''`)}'`;
}

// Leaves plain words bare and quotes the rest, keeping a leading ~/ unquoted so it still expands
export function shellWord(s: string): string {
    if (s === "-") return "./-";
    if (s.startsWith("~/") && s.length > 2) return `~/${shellWord(s.slice(2))}`;
    return /^[\w.+@%=:,/-]+$/.test(s) ? s : quoted(s);
}

// A download lands in the working directory under the sandbox file's own name
export function downloadName(path: string): string {
    const base = path.replace(/\/+$/, "").split("/").pop() ?? "";
    return ["", "~", ".", ".."].includes(base) ? "download" : base;
}

function bytes(n: number): string {
    const units = ["KiB", "MiB", "GiB", "TiB"];
    if (n < 1024) return `${n} ${n === 1 ? "byte" : "bytes"}`;
    let v = n;
    let i = -1;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    return `${Number(v.toFixed(1))} ${units[i]}`;
}

const gone =
    "the link was used, has expired or its sandbox ended, a new bugnet_transfer call makes another";
const busy = "too many requests, or the sandbox spent its traffic allowance";

// What each HTTP status curl -f reports means on these links
const httpErrors: Record<Direction, Record<string, string>> = {
    upload: {
        "400": "the bytes sent were not sizeBytes long, a new link with the exact size is needed",
        "409": "another upload on this link is still running",
        "410": gone,
        "413": "the file is longer than sizeBytes or over maxBytes",
        "422": "the bytes did not match sha256, so nothing was saved",
        "429": busy,
        "507": "the sandbox's disk is full",
    },
    download: {
        "409": "another download on this link is still running",
        "410": gone,
        "412": "the file changed since the link was made, a new link downloads it again",
        "429": busy,
    },
};

/* Errors */

function overCap(direction: Direction): string {
    return direction === "upload"
        ? "A compressed copy, or parts cut with split -b and joined in the sandbox with cat, fit " +
              "under it"
        : "Compressing it, or cutting it into parts with split -b through bugnet_exec, makes " +
              "files that fit";
}

interface Advice {
    code: Code;
    text: (direction: Direction) => string;
}

// Refusals this tool explains with its own next step, each honoured only under its own code
const advice: Record<string, Advice> = {
    CHECKSUM_MISMATCH: {
        code: Code.DataLoss,
        text: () =>
            "the uploaded bytes did not match the sha256 given, so nothing was saved. A new " +
            "call with the local file's current size and sha256 makes a new link",
    },
    TOKEN_USED: {
        code: Code.FailedPrecondition,
        text: () => "that link was already used, a new bugnet_transfer call makes another",
    },
    TOKEN_EXPIRED: {
        code: Code.FailedPrecondition,
        text: () =>
            "that link expired before the transfer started, a new bugnet_transfer call makes " +
            "another",
    },
    OVER_CAP: {
        code: Code.OutOfRange,
        text: (d) => `the file is over this sandbox's transfer size limit. ${overCap(d)}`,
    },
};

function explain(err: unknown, direction: Direction, inlineKib: number): unknown {
    if (!(err instanceof ConnectError)) return err;
    const reason = errorReason(err);
    const known = reason !== null && Object.hasOwn(advice, reason) ? advice[reason] : undefined;
    const e = fromRouter(err, "transfer");
    if (known && known.code === err.code) {
        return new GatewayError(
            e.kind,
            `transfer: ${known.text(direction)}`,
            e.retryAfterMs,
            reason,
        );
    }
    if (e.kind === "unsupported") {
        const inline =
            "bugnet_read_file and bugnet_write_file move up to " + `${inlineKib} KiB per call`;
        return new GatewayError(e.kind, `${e.message}. ${inline}`, e.retryAfterMs, reason);
    }
    return err;
}

type TransferRequest = MessageInitShape<typeof CreateTransferRequestSchema>;

function spent(e: unknown): boolean {
    if (!(e instanceof ConnectError) || e.code !== Code.FailedPrecondition) return false;
    const reason = errorReason(e);
    return reason === "TOKEN_USED" || reason === "TOKEN_EXPIRED";
}

// A repeated key names a link that is already spent, so one retry under a new key makes a live one
async function createTransfer(
    deps: Deps,
    req: TransferRequest,
    signal: AbortSignal,
): Promise<CreateTransferResponse> {
    try {
        return await deps.router.createTransfer(req, { signal });
    } catch (e) {
        if (!spent(e)) throw e;
        const fresh = `k1${randomBytes(16).toString("hex")}`;
        return deps.router.createTransfer({ ...req, idempotencyKey: fresh }, { signal });
    }
}

/* Results */

type Args = z.infer<typeof transferInput>;

function iso(t: Timestamp | undefined): string | null {
    return t ? timestampDate(t).toISOString() : null;
}

function transferRequest(args: Args, ctx: ServerContext): TransferRequest {
    const { handle, path } = args;
    if (args.direction === "download") {
        return {
            handle,
            direction: TransferDirection.DOWNLOAD,
            path,
            wantSha256: args.wantSha256,
            idempotencyKey: idempotencyKey(ctx, [handle, "download", path, "", "", ""]),
        };
    }
    if (args.sizeBytes === undefined) {
        throw new GatewayError(
            "invalid",
            "transfer: an upload needs sizeBytes, the local file's exact size in bytes " +
                "(wc -c < file)",
        );
    }
    const size = String(args.sizeBytes);
    const sha256 = args.sha256?.toLowerCase() ?? "";
    const mode = (args.mode ?? "644").replace(/^0?/, "0");
    return {
        handle,
        direction: TransferDirection.UPLOAD,
        path,
        sizeBytes: BigInt(args.sizeBytes),
        mode: Number.parseInt(mode, 8),
        sha256: Buffer.from(sha256, "hex"),
        idempotencyKey: idempotencyKey(ctx, [handle, "upload", path, size, sha256, mode]),
    };
}

function linkOf(args: Args, res: CreateTransferResponse) {
    return {
        direction: args.direction,
        path: args.path,
        url: res.url,
        expiresAt: iso(res.expiresAt),
        size: Number(res.size),
        maxBytes: Number(res.maxBytes),
    };
}

type Link = ReturnType<typeof linkOf>;

const until = (link: Link) => (link.expiresAt ? `, until ${link.expiresAt}` : "");

function uploadResult(args: Args, link: Link): CallToolResult {
    const named = args.localFile !== undefined;
    const file = named ? shellWord(args.localFile as string) : "<file>";
    const text = [
        `Upload link for ${link.path}, ${bytes(link.size)}${until(link)}.`,
        named ? `command sends ${file}.` : "command has <file> where the local file's path goes.",
        "The upload prints {path,size,sha256}, and a sha256 equal to the local file's " +
            "(shasum -a 256 or sha256sum) confirms the copy.",
        "Uploads are only for files the user named.",
        "The link works for one completed upload. A failed upload can run the same command " +
            "again before the link expires, and httpErrors explains curl's error codes.",
    ].join("\n");
    return ok(text, {
        command: `curl -fsS -T ${file} ${quoted(link.url)}`,
        ...link,
        httpErrors: httpErrors.upload,
    });
}

function downloadResult(args: Args, link: Link, res: CreateTransferResponse): CallToolResult {
    const file = shellWord(args.localFile ?? downloadName(args.path));
    const url = quoted(link.url);
    const modifiedAt = iso(res.modifiedAt);
    const sha256 = res.sha256.length === 32 ? Buffer.from(res.sha256).toString("hex") : null;
    const modified = modifiedAt ? `, modified ${modifiedAt}` : "";
    const text = [
        `Download link for ${link.path}, ${bytes(link.size)}${modified}${until(link)}.`,
        `command saves it as ${file} in the working directory, and a name no local file has ` +
            "yet keeps the user's files intact. curl -J is left out because it takes the name " +
            "from the server.",
        sha256
            ? "A sha256 of the saved file (shasum -a 256 or sha256sum) equal to sha256 " +
              "confirms the copy."
            : "",
        "The link works for one completed download. resumeCommand continues a cut download " +
            "before the link expires, and httpErrors explains curl's error codes.",
    ]
        .filter(Boolean)
        .join("\n");
    return ok(text, {
        command: `curl -fSo ${file} ${url}`,
        resumeCommand: `curl -fSo ${file} -C - ${url}`,
        ...link,
        modifiedAt,
        sha256,
        httpErrors: httpErrors.download,
    });
}

/* Tool */

export const registerTransferTool: Register = (server, deps) => {
    const { read_file_max_bytes, write_file_max_bytes } = deps.config.limits;
    const inlineKib = Math.floor(Math.min(read_file_max_bytes, write_file_max_bytes) / 1024);

    server.registerTool(
        "bugnet_transfer",
        {
            title: "Move a file to or from a Bugnet sandbox",
            description: transferDescription,
            inputSchema: transferInput,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            _meta: deps.config.tools.confirm_transfers ? approvalMeta(deps) : undefined,
        },
        async (args, ctx) => {
            try {
                const req = transferRequest(args, ctx);
                // The router hashes a large download at mint, so progress keeps the call alive
                const res = await withProgress(ctx, "making the transfer link", () =>
                    createTransfer(deps, req, ctx.mcpReq.signal),
                );
                if (!res.url) {
                    throw new GatewayError(
                        "internal",
                        "transfer: the sandbox service gave no link",
                    );
                }
                const link = linkOf(args, res);
                if (link.maxBytes > 0 && link.size > link.maxBytes) {
                    throw new GatewayError(
                        "limit",
                        `transfer: the file is ${bytes(link.size)}, over this sandbox's transfer ` +
                            `size limit of ${bytes(link.maxBytes)}. ${overCap(args.direction)}`,
                    );
                }
                deps.log.info("transfer link made", {
                    handle: handleTag(args.handle),
                    direction: args.direction,
                });
                return args.direction === "upload"
                    ? uploadResult(args, link)
                    : downloadResult(args, link, res);
            } catch (e) {
                const err = explain(e, args.direction, inlineKib);
                return sandboxFailure(deps, args.handle, err, "transfer");
            }
        },
    );
};
