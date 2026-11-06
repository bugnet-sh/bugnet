import { timestampDate } from "@bufbuild/protobuf/wkt";
import { z } from "zod";
import { GatewayError } from "../router.ts";
import { cleanText, looksLikeText, untrustedLabel } from "../sanitize.ts";
import { handlePattern, homePath, ok, okBody, sandboxFailure, type Register } from "./common.ts";

const handleInput = z.string().regex(handlePattern, "a sandbox handle starting with sbx_");
const pathInput = z
    .string()
    .min(1)
    .max(4096)
    .describe("Absolute, or relative to the home folder, as in ~/src/app or src/app");

// About what Claude Code shows inline, a longer read goes to a file the agent cannot open
const inlineReadBytes = 32 * 1024;

const noPath = "no file or directory at that path";
const noFolder = "no folder for that path yet, mkdir -p through bugnet_exec makes it";

export const registerFileTools: Register = (server, deps) => {
    const { read_file_max_bytes: readMax, write_file_max_bytes: writeMax } = deps.config.limits;
    const readDefault = Math.min(readMax, inlineReadBytes);
    const inlineKib = Math.floor(readDefault / 1024);

    server.registerTool(
        "bugnet_list_files",
        {
            title: "List files in a Bugnet sandbox",
            description: "Lists a directory in the sandbox, depth 1 to 5 levels.",
            inputSchema: z.object({
                handle: handleInput,
                path: pathInput.default("."),
                depth: z.number().int().min(1).max(5).default(1),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
            try {
                const res = await deps.router.listFiles({
                    handle: args.handle,
                    path: homePath(args.path),
                    depth: args.depth,
                });
                const entries = res.entries.slice(0, 500).map((e) => ({
                    path: cleanText(e.path),
                    size: Number(e.size),
                    isDir: e.isDir,
                    modifiedAt: e.modifiedAt ? timestampDate(e.modifiedAt).toISOString() : null,
                }));
                const more = res.entries.length - entries.length;
                const lines = entries.map((e) =>
                    e.isDir ? `${e.path}/` : `${e.path}  ${e.size} B`,
                );
                const head =
                    `${res.entries.length} entries under ${args.path}` +
                    (res.truncated ? " (the listing stopped at its limit)" : "");
                const rest =
                    more > 0 ? `...and ${more} more, list a subdirectory to see them.` : "";
                const text = [`${head}:`, ...lines, rest].filter(Boolean).join("\n");
                const summary = [`${head}, in entries.`, rest].filter(Boolean).join("\n");
                return okBody(text, summary, { entries, truncated: res.truncated || more > 0 });
            } catch (e) {
                return sandboxFailure(deps, args.handle, e, "list files", noPath);
            }
        },
    );

    server.registerTool(
        "bugnet_read_file",
        {
            title: "Read a file from a Bugnet sandbox",
            description:
                `Reads a sandbox file from offset, ${inlineKib} KiB by default, which shows ` +
                "inline, and up to 256 KiB with length. Text comes back as text, anything else " +
                "as base64. Use offset to read further.",
            inputSchema: z.object({
                handle: handleInput,
                path: pathInput,
                offset: z.number().int().min(0).default(0),
                length: z.number().int().min(1).max(readMax).default(readDefault),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
            try {
                const res = await deps.router.readFile({
                    handle: args.handle,
                    path: homePath(args.path),
                    offset: BigInt(args.offset),
                    length: args.length,
                });
                const isText = looksLikeText(res.data);
                const body = isText
                    ? cleanText(new TextDecoder().decode(res.data))
                    : Buffer.from(res.data).toString("base64");
                const next = args.offset + res.data.length;
                const head = [
                    `${res.data.length} bytes of ${args.path} from offset ${args.offset}` +
                        (res.eof ? ", end of file." : `, more from offset ${next}.`),
                    isText ? untrustedLabel : "Binary content, base64 encoded:",
                ];
                const text = [...head, body].join("\n");
                const summary = [...head, "The bytes are in content."].join("\n");
                return okBody(text, summary, {
                    encoding: isText ? "utf8" : "base64",
                    content: body,
                    bytes: res.data.length,
                    eof: res.eof,
                    nextOffset: res.eof ? null : next,
                });
            } catch (e) {
                return sandboxFailure(deps, args.handle, e, "read file", noPath);
            }
        },
    );

    server.registerTool(
        "bugnet_write_file",
        {
            title: "Write a file in a Bugnet sandbox",
            description:
                "Creates or replaces a sandbox file with up to 256 KiB of content, utf8 or " +
                "base64. Never write secrets, use bugnet_secret_link.",
            inputSchema: z.object({
                handle: handleInput,
                path: pathInput,
                content: z.string(),
                encoding: z.enum(["utf8", "base64"]).default("utf8"),
                mode: z
                    .string()
                    .regex(/^0?[0-7]{3}$/, "an octal mode such as 644 or 755")
                    .optional(),
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (args) => {
            try {
                const data = Buffer.from(args.content, args.encoding);
                if (data.length > writeMax) {
                    throw new GatewayError("invalid", `content is over ${writeMax} bytes`);
                }
                const res = await deps.router.writeFile({
                    handle: args.handle,
                    path: homePath(args.path),
                    data,
                    mode: args.mode ? Number.parseInt(args.mode, 8) : 0,
                });
                const size = Number(res.size);
                return ok(`Wrote ${size} bytes to ${args.path}.`, { path: args.path, size });
            } catch (e) {
                return sandboxFailure(deps, args.handle, e, "write file", noFolder);
            }
        },
    );
};
