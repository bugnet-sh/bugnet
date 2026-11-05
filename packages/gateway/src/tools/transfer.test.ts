import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
    PlacementState,
    TransferDirection,
    type CreateTransferRequest,
} from "../gen/bugnet/router/v1/router_pb.ts";
import type { Log } from "../log.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    placement,
    routerError,
    testConfig,
    testDeps,
    testHandle,
    testNow,
    type RouterImpl,
} from "../testing/harness.ts";
import { downloadName, shellWord, transferDescription } from "./transfer.ts";

const url = "https://transfer.bugnet.sh/bnx_Q2hlY2tUaGVTaGEyNTZPZlRoZUZpbGVQbGVhc2U";
const digest = createHash("sha256").update("hello\n").digest();
const hex = digest.toString("hex");
const expires = timestampFromMs(testNow + 10 * 60_000);
const gib = 1024 ** 3;

interface Upload {
    message: string;
    command: string;
    direction: string;
    path: string;
    url: string;
    expiresAt: string | null;
    size: number;
    maxBytes: number;
    httpErrors: Record<string, string>;
}

interface Download extends Upload {
    resumeCommand: string;
    modifiedAt: string | null;
    sha256: string | null;
}

function recording(): { log: Log; lines: string[] } {
    const lines: string[] = [];
    const write = (level: string) => (msg: string, f?: Record<string, unknown>) => {
        lines.push(JSON.stringify({ level, msg, ...f }));
    };
    return { log: { info: write("info"), warn: write("warn"), error: write("error") }, lines };
}

interface Setup {
    client: Client;
    requests: CreateTransferRequest[];
    lines: string[];
}

// A router whose CreateTransfer records each request and answers with answer, or impl overrides
async function setup(
    answer: (req: CreateTransferRequest) => Record<string, unknown> = (req) => ({
        url,
        expiresAt: expires,
        size: req.direction === TransferDirection.UPLOAD ? req.sizeBytes : 6n,
        maxBytes: BigInt(gib),
        ...(req.direction === TransferDirection.DOWNLOAD
            ? {
                  modifiedAt: timestampFromMs(testNow - 60_000),
                  sha256: req.wantSha256 ? digest : new Uint8Array(),
              }
            : {}),
    }),
    impl: RouterImpl = {},
    toml = "",
): Promise<Setup> {
    const requests: CreateTransferRequest[] = [];
    const { log, lines } = recording();
    const router = fakeRouter({
        createTransfer: (req) => {
            requests.push(req);
            return answer(req);
        },
        ...impl,
    });
    const client = await connectTools(testDeps({ router, log, config: testConfig(toml) }));
    return { client, requests, lines };
}

const upload = { handle: testHandle, direction: "upload", path: "~/data/in.csv" };
const download = { handle: testHandle, direction: "download", path: "/srv/out/result.tar.gz" };

describe("bugnet_transfer uploads", () => {
    it("mints a link for the given size, sha256 and mode, keyed by the tool use id", async () => {
        const { client, requests } = await setup();
        const r = await callTool<Upload>(
            client,
            "bugnet_transfer",
            {
                ...upload,
                sizeBytes: 6,
                sha256: hex.toUpperCase(),
                mode: "0755",
                localFile: "in.csv",
            },
            { toolUseId: "toolu_up" },
        );
        expect(r.isError).toBe(false);
        const req = requests[0] as CreateTransferRequest;
        expect(req.handle).toBe(testHandle);
        expect(req.direction).toBe(TransferDirection.UPLOAD);
        expect(req.path).toBe("~/data/in.csv");
        expect(req.sizeBytes).toBe(6n);
        expect(Buffer.from(req.sha256).equals(digest)).toBe(true);
        expect(req.mode).toBe(0o755);
        expect(req.idempotencyKey).toBe("toolu_up");
        expect(req.wantSha256).toBe(false);
        expect(r.structured).toEqual({
            message: [
                "Upload link for ~/data/in.csv, 6 bytes, until 2026-11-05T12:10:00.000Z.",
                "command sends in.csv.",
                "The upload prints {path,size,sha256}, and a sha256 equal to the local file's " +
                    "(shasum -a 256 or sha256sum) confirms the copy.",
                "Uploads are only for files the user named.",
                "The link works for one completed upload. A failed upload can run the same " +
                    "command again before the link expires, and httpErrors explains curl's " +
                    "error codes.",
            ].join("\n"),
            command: `curl -fsS -T in.csv '${url}'`,
            direction: "upload",
            path: "~/data/in.csv",
            url,
            expiresAt: "2026-11-05T12:10:00.000Z",
            size: 6,
            maxBytes: gib,
            httpErrors: expect.objectContaining({
                "410": expect.stringMatching(/a new bugnet_transfer call makes another/),
                "422": "the bytes did not match sha256, so nothing was saved",
            }),
        });
        expect(Object.keys(r.structured)[0]).toBe("message");
    });

    it("hashes the handle, path, size, sha256 and mode into the key otherwise", async () => {
        const { client, requests } = await setup();
        const args = { ...upload, sizeBytes: 6, sha256: hex };
        await callTool(client, "bugnet_transfer", args);
        await callTool(client, "bugnet_transfer", { ...args, mode: "644" });
        await callTool(client, "bugnet_transfer", { ...args, sizeBytes: 7 });
        const parts = [testHandle, "upload", "~/data/in.csv", "6", hex, "0644"];
        const want =
            "k1" + createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
        expect(requests.map((q) => q.idempotencyKey)).toEqual([
            want,
            want,
            expect.not.stringMatching(want),
        ]);
        expect(requests[0]?.mode).toBe(0o644);
    });

    it("accepts an empty file and sends a size of 0 as present", async () => {
        const { client, requests } = await setup();
        const r = await callTool<Upload>(client, "bugnet_transfer", {
            ...upload,
            path: "/tmp/empty",
            sizeBytes: 0,
        });
        expect(r.isError).toBe(false);
        expect(requests[0]?.sizeBytes).toBe(0n);
        expect(requests[0]?.sha256).toHaveLength(0);
        expect(r.structured.size).toBe(0);
    });

    it("leaves <file> in the command when no local file is named", async () => {
        const { client } = await setup();
        const r = await callTool<Upload>(client, "bugnet_transfer", { ...upload, sizeBytes: 6 });
        expect(r.structured.command).toBe(`curl -fsS -T <file> '${url}'`);
        expect(r.structured.message).toMatch(/command has <file> where the local file's path goes/);
    });

    it("refuses an upload without sizeBytes before calling the router", async () => {
        const { client, requests } = await setup();
        const r = await callTool(client, "bugnet_transfer", upload);
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "transfer: an upload needs sizeBytes, the local file's exact size in bytes " +
                "(wc -c < file).",
        );
        expect(requests).toEqual([]);
    });

    it("refuses a relative path, a short sha256 and a mode that is not octal", async () => {
        const { client, requests } = await setup();
        const cases: [Record<string, unknown>, RegExp][] = [
            [{ path: "data/in.csv" }, /path: an absolute path, or ~ or ~\/rest/],
            [{ path: "~root/x" }, /path: an absolute path/],
            [{ path: "/tmp/a\nb" }, /path: a path without control characters/],
            [{ sha256: "abc" }, /sha256: a SHA-256 as 64 hex characters/],
            [{ mode: "0855" }, /mode: an octal mode such as 0644 or 0755/],
            [{ sizeBytes: -1 }, /sizeBytes/],
        ];
        for (const [bad, why] of cases) {
            const r = await callTool(client, "bugnet_transfer", {
                ...upload,
                sizeBytes: 1,
                ...bad,
            });
            expect(r.isError).toBe(true);
            expect(r.text).toMatch(why);
        }
        expect(requests).toEqual([]);
    });
});

describe("bugnet_transfer downloads", () => {
    it("asks for the sha256 and returns it in hex with commands to save and resume", async () => {
        const { client, requests } = await setup();
        const r = await callTool<Download>(client, "bugnet_transfer", download, {
            toolUseId: "toolu_down",
        });
        expect(r.isError).toBe(false);
        const req = requests[0] as CreateTransferRequest;
        expect(req.direction).toBe(TransferDirection.DOWNLOAD);
        expect(req.wantSha256).toBe(true);
        expect(req.sizeBytes).toBeUndefined();
        expect(req.mode).toBe(0);
        expect(req.sha256).toHaveLength(0);
        expect(req.idempotencyKey).toBe("toolu_down");
        expect(r.structured).toEqual({
            message: [
                "Download link for /srv/out/result.tar.gz, 6 bytes, modified " +
                    "2026-11-05T11:59:00.000Z, until 2026-11-05T12:10:00.000Z.",
                "command saves it as result.tar.gz in the working directory, and a name no " +
                    "local file has yet keeps the user's files intact. curl -J is left out " +
                    "because it takes the name from the server.",
                "A sha256 of the saved file (shasum -a 256 or sha256sum) equal to sha256 " +
                    "confirms the copy.",
                "The link works for one completed download. resumeCommand continues a cut " +
                    "download before the link expires, and httpErrors explains curl's error " +
                    "codes.",
            ].join("\n"),
            command: `curl -fSo result.tar.gz '${url}'`,
            resumeCommand: `curl -fSo result.tar.gz -C - '${url}'`,
            direction: "download",
            path: "/srv/out/result.tar.gz",
            url,
            expiresAt: "2026-11-05T12:10:00.000Z",
            size: 6,
            maxBytes: gib,
            modifiedAt: "2026-11-05T11:59:00.000Z",
            sha256: hex,
            httpErrors: expect.objectContaining({
                "412": "the file changed since the link was made, a new link downloads it again",
            }),
        });
        expect(r.structured.command).not.toMatch(/-J|-O/);
    });

    it("hashes only handle, direction and path into a download's key", async () => {
        const { client, requests } = await setup();
        await callTool(client, "bugnet_transfer", { ...download, sizeBytes: 9, mode: "700" });
        const parts = [testHandle, "download", "/srv/out/result.tar.gz", "", "", ""];
        const want =
            "k1" + createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
        expect(requests[0]?.idempotencyKey).toBe(want);
        expect(requests[0]?.sizeBytes).toBeUndefined();
        expect(requests[0]?.mode).toBe(0);
    });

    it("skips the sha256 when wantSha256 is false", async () => {
        const { client, requests } = await setup();
        const r = await callTool<Download>(client, "bugnet_transfer", {
            ...download,
            wantSha256: false,
        });
        expect(requests[0]?.wantSha256).toBe(false);
        expect(r.structured.sha256).toBeNull();
        expect(r.structured.message).not.toMatch(/equal to sha256/);
    });

    it("saves to a named local file, quoting it for the shell", async () => {
        const { client } = await setup();
        const r = await callTool<Download>(client, "bugnet_transfer", {
            ...download,
            localFile: "~/Downloads/it's done.tgz",
        });
        expect(r.structured.command).toBe(`curl -fSo ~/'Downloads/it'\\''s done.tgz' '${url}'`);
    });

    it("needs a ready sandbox file, so a directory gets the tar advice", async () => {
        const { client } = await setup(() => {
            throw routerError(Code.InvalidArgument, "IS_DIRECTORY");
        });
        const r = await callTool(client, "bugnet_transfer", { ...download, path: "~/out" });
        expect(r.text).toBe(
            "transfer: the path is a directory, a tar archive of it transfers as one file.",
        );
    });
});

describe("bugnet_transfer shell words", () => {
    it("leaves plain names bare and quotes the rest", () => {
        expect(shellWord("result.tar.gz")).toBe("result.tar.gz");
        expect(shellWord("./out/a-b_c+1.txt")).toBe("./out/a-b_c+1.txt");
        expect(shellWord("my file.txt")).toBe("'my file.txt'");
        expect(shellWord("$(rm -rf ~)")).toBe("'$(rm -rf ~)'");
        expect(shellWord("a'b")).toBe(`'a'\\''b'`);
        expect(shellWord("~/x y")).toBe("~/'x y'");
        expect(shellWord("-")).toBe("./-");
    });

    it("names a download after the sandbox file", () => {
        expect(downloadName("/srv/out/result.tar.gz")).toBe("result.tar.gz");
        expect(downloadName("~/logs/")).toBe("logs");
        expect(downloadName("~")).toBe("download");
        expect(downloadName("/")).toBe("download");
        expect(downloadName("/a/..")).toBe("download");
    });
});

describe("bugnet_transfer errors", () => {
    it("says transfers are not open yet while the router answers Unimplemented", async () => {
        const client = await connectTools(testDeps());
        const r = await callTool(client, "bugnet_transfer", download);
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "transfer: not open yet, the other Bugnet tools work as usual. bugnet_read_file " +
                "and bugnet_write_file move up to 256 KiB per call.",
        );
    });

    it("points at the inline file tools when the sandbox has no transfers", async () => {
        const { client } = await setup(() => {
            throw routerError(Code.FailedPrecondition, "FEATURE_UNAVAILABLE");
        });
        const r = await callTool(client, "bugnet_transfer", download);
        expect(r.text).toBe(
            "transfer: not open on this sandbox yet, the other Bugnet tools work as usual. " +
                "bugnet_read_file and bugnet_write_file move up to 256 KiB per call.",
        );
    });

    it("reports NOT_READY on an ended sandbox as expired", async () => {
        const { client } = await setup(
            () => {
                throw routerError(Code.FailedPrecondition, "NOT_READY");
            },
            { getPlacement: () => ({ placement: placement(PlacementState.TERMINATED) }) },
        );
        const r = await callTool(client, "bugnet_transfer", { ...upload, sizeBytes: 1 });
        expect(r.text).toBe(
            "transfer: this sandbox has ended and everything in it was deleted. Quote and " +
                "start a new one.",
        );
    });

    it("reports a rate limit with its RetryInfo delay", async () => {
        const { client } = await setup(() => {
            throw routerError(Code.ResourceExhausted, "RATE_LIMITED", { retryAfterMs: 2500 });
        });
        const r = await callTool(client, "bugnet_transfer", download);
        expect(r.text).toBe("transfer: too many requests for now. Retry after 3 s.");
    });

    it("passes the router's reason for a refused argument", async () => {
        const { client } = await setup((req) => {
            if (req.path.startsWith("/proc"))
                throw routerError(Code.InvalidArgument, "PATH_REFUSED");
            throw routerError(Code.InvalidArgument, undefined, { message: "api: path too deep" });
        });
        const refused = await callTool(client, "bugnet_transfer", { ...download, path: "/proc/1" });
        expect(refused.text).toBe("transfer: that path is refused.");
        const bare = await callTool(client, "bugnet_transfer", download);
        expect(bare.text).toBe("transfer: path too deep.");
    });

    it("keeps the general wording for a known reason under another code", async () => {
        const { client } = await setup(() => {
            throw routerError(Code.InvalidArgument, "CHECKSUM_MISMATCH", { message: "bad sum" });
        });
        const r = await callTool(client, "bugnet_transfer", { ...upload, sizeBytes: 6 });
        expect(r.text).toBe("transfer: bad sum.");
    });

    it("explains a checksum mismatch", async () => {
        const { client } = await setup(() => {
            throw routerError(Code.DataLoss, "CHECKSUM_MISMATCH");
        });
        const r = await callTool(client, "bugnet_transfer", {
            ...upload,
            sizeBytes: 6,
            sha256: hex,
        });
        expect(r.text).toBe(
            "transfer: the uploaded bytes did not match the sha256 given, so nothing was saved. " +
                "A new call with the local file's current size and sha256 makes a new link.",
        );
    });

    it("makes a new link under a new key when the keyed one is spent", async () => {
        for (const reason of ["TOKEN_USED", "TOKEN_EXPIRED"]) {
            const { client, requests } = await setup((req) => {
                if (req.idempotencyKey === "toolu_again") {
                    throw routerError(Code.FailedPrecondition, reason);
                }
                return { url, expiresAt: expires, size: 6n, maxBytes: BigInt(gib) };
            });
            const r = await callTool<Download>(client, "bugnet_transfer", download, {
                toolUseId: "toolu_again",
            });
            expect(r.isError).toBe(false);
            expect(r.structured.url).toBe(url);
            expect(requests).toHaveLength(2);
            expect(requests[1]?.idempotencyKey).toMatch(/^k1[0-9a-f]{32}$/);
            expect(requests[1]?.path).toBe(download.path);
        }
    });

    it("explains a spent link when the new one is refused too", async () => {
        const used = await setup(() => {
            throw routerError(Code.FailedPrecondition, "TOKEN_USED");
        });
        const r = await callTool(used.client, "bugnet_transfer", download);
        expect(r.text).toBe(
            "transfer: that link was already used, a new bugnet_transfer call makes another.",
        );
        expect(used.requests).toHaveLength(2);
        const expired = await setup(() => {
            throw routerError(Code.FailedPrecondition, "TOKEN_EXPIRED");
        });
        const e = await callTool(expired.client, "bugnet_transfer", download);
        expect(e.text).toBe(
            "transfer: that link expired before the transfer started, a new bugnet_transfer " +
                "call makes another.",
        );
    });

    it("advises compressing or splitting a file over the size limit", async () => {
        const { client } = await setup(() => {
            throw routerError(Code.OutOfRange, "OVER_CAP");
        });
        const up = await callTool(client, "bugnet_transfer", { ...upload, sizeBytes: 3 * gib });
        expect(up.text).toBe(
            "transfer: the file is over this sandbox's transfer size limit. A compressed copy, " +
                "or parts cut with split -b and joined in the sandbox with cat, fit under it.",
        );
        const down = await callTool(client, "bugnet_transfer", download);
        expect(down.text).toBe(
            "transfer: the file is over this sandbox's transfer size limit. Compressing it, or " +
                "cutting it into parts with split -b through bugnet_exec, makes files that fit.",
        );
    });

    it("withholds a link whose size is over maxBytes", async () => {
        const { client } = await setup(() => ({
            url,
            expiresAt: expires,
            size: BigInt(3 * gib),
            maxBytes: BigInt(gib),
        }));
        const r = await callTool(client, "bugnet_transfer", download);
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "transfer: the file is 3 GiB, over this sandbox's transfer size limit of 1 GiB. " +
                "Compressing it, or cutting it into parts with split -b through bugnet_exec, " +
                "makes files that fit.",
        );
        expect(r.text).not.toContain("bnx_");
    });

    it("never writes the link or the handle to the log", async () => {
        const { client, lines } = await setup();
        await callTool(client, "bugnet_transfer", download);
        await callTool(client, "bugnet_transfer", { ...upload, sizeBytes: 6 });
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0] as string)).toEqual({
            level: "info",
            msg: "transfer link made",
            handle: expect.stringMatching(/^h:[0-9a-f]{12}$/),
            direction: "download",
        });
        for (const line of lines) {
            expect(line).not.toContain("bnx_");
            expect(line).not.toContain(testHandle);
        }
    });
});

describe("bugnet_transfer listing", () => {
    async function listed(toml: string) {
        const client = await connectTools(testDeps({ config: testConfig(toml) }));
        const { tools } = await client.listTools();
        return tools.find((t) => t.name === "bugnet_transfer");
    }

    it("asks for a person's approval by default", async () => {
        const t = await listed("");
        expect(t?._meta?.["anthropic/requiresUserInteraction"]).toBe(true);
        expect(t?.annotations).toEqual({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        });
    });

    it("drops the approval when either setting turns it off", async () => {
        const off = "[tools]\nconfirm_transfers = false\n";
        expect((await listed(off))?._meta?.["anthropic/requiresUserInteraction"]).toBeUndefined();
        const unattended = "[tools]\nrequire_user_approval = false\nconfirm_transfers = true\n";
        expect(
            (await listed(unattended))?._meta?.["anthropic/requiresUserInteraction"],
        ).toBeUndefined();
    });

    it("keeps a short, factual description that names no provider", () => {
        expect(transferDescription.length).toBeLessThan(600);
        expect(transferDescription).not.toMatch(/koyeb|boat|e2b|boxd|instabox|daytona/i);
        expect(transferDescription).not.toMatch(/\b(must|never|always|do not|don't)\b/i);
    });

    it("lists confirm_transfers in the example settings at its default", () => {
        const example = readFileSync(
            new URL("../../../../config/example.toml", import.meta.url),
            "utf8",
        );
        expect(example).toMatch(/^confirm_transfers = true\s+#/m);
        expect(testConfig().tools.confirm_transfers).toBe(true);
    });
});
