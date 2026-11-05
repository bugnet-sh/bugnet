import { timestampDate } from "@bufbuild/protobuf/wkt";
import { z } from "zod";
import { GatewayError } from "../router.ts";
import { cleanText, looksLikeText, untrustedLabel } from "../sanitize.ts";
import { failure, handlePattern, ok, type Register } from "./common.ts";

const handleInput = z.string().regex(handlePattern, "a sandbox handle starting with sbx_");
const pathInput = z.string().min(1).max(4096);

export const registerFileTools: Register = (server, deps) => {
    const { read_file_max_bytes: readMax, write_file_max_bytes: writeMax } = deps.config.limits;

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
                    path: args.path,
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
                const text = [
                    `${res.entries.length} entries under ${args.path}${res.truncated ? " (the listing stopped at its limit)" : ""}:`,
                    ...lines,
                    more > 0 ? `...and ${more} more, list a subdirectory to see them.` : "",
                ]
                    .filter(Boolean)
                    .join("\n");
                return ok(text, { entries, truncated: res.truncated || more > 0 });
            } catch (e) {
                return failure(e, "list files");
            }
        },
    );

    server.registerTool(
        "bugnet_read_file",
        {
            title: "Read a file from a Bugnet sandbox",
            description:
                "Reads up to 256 KiB of a sandbox file from offset. Text comes back as text, " +
                "anything else as base64. Use offset to read further.",
            inputSchema: z.object({
                handle: handleInput,
                path: pathInput,
                offset: z.number().int().min(0).default(0),
                length: z.number().int().min(1).max(readMax).default(readMax),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
            try {
                const res = await deps.router.readFile({
                    handle: args.handle,
                    path: args.path,
                    offset: BigInt(args.offset),
                    length: args.length,
                });
                const isText = looksLikeText(res.data);
                const body = isText
                    ? cleanText(new TextDecoder().decode(res.data))
                    : Buffer.from(res.data).toString("base64");
                const next = args.offset + res.data.length;
                const text = [
                    `${res.data.length} bytes of ${args.path} from offset ${args.offset}` +
                        (res.eof ? ", end of file." : `, more from offset ${next}.`),
                    isText ? untrustedLabel : "Binary content, base64 encoded:",
                    body,
                ].join("\n");
                return ok(text, {
                    encoding: isText ? "utf8" : "base64",
                    content: body,
                    bytes: res.data.length,
                    eof: res.eof,
                    nextOffset: res.eof ? null : next,
                });
            } catch (e) {
                return failure(e, "read file");
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
                    path: args.path,
                    data,
                    mode: args.mode ? Number.parseInt(args.mode, 8) : 0,
                });
                const size = Number(res.size);
                return ok(`Wrote ${size} bytes to ${args.path}.`, { path: args.path, size });
            } catch (e) {
                return failure(e, "write file");
            }
        },
    );
};
