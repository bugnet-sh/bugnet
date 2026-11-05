import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { GatewayError, fromRouter } from "../router.ts";
import { KeyError, parsePublicKey } from "../sshkey.ts";
import {
    failure,
    handlePattern,
    handleTag,
    ok,
    sandboxFailure,
    type Deps,
    type Register,
} from "./common.ts";

const handleInput = z.string().regex(handlePattern, "a sandbox handle starting with sbx_");

// The router's own rule for the paths it echoes into the command, data-plane 9.2
const fileInput = z
    .string()
    .regex(
        /^(~|\$TMPDIR)?[A-Za-z0-9._/-]{1,200}$/,
        "a path of letters, digits and ._/- that may start with ~ or $TMPDIR",
    );

const fingerprintInput = z
    .string()
    .regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/, "the SHA256:... fingerprint bugnet_ssh returned")
    .transform((s) => s.replace(/=$/, ""));

export const defaultKnownHostsFile = "~/.ssh/bugnet_known_hosts";

const notOpenYet = "SSH is not open yet, bugnet_exec and the file tools work as usual";
const notOnSandbox =
    "SSH is not open on this sandbox yet, bugnet_exec and the file tools work as usual";

// Router refusals worded for SSH, NOT_READY left for sandboxFailure to tell ended from starting
function sshError(err: unknown, what: string): GatewayError {
    const e = fromRouter(err, what);
    if (e.kind === "unsupported") {
        const text = e.reason === "FEATURE_UNAVAILABLE" ? notOnSandbox : notOpenYet;
        return new GatewayError(e.kind, `${what}: ${text}`, null, e.reason);
    }
    if (e.reason === "TOO_MANY_KEYS") {
        return new GatewayError(
            e.kind,
            `${e.message}, bugnet_ssh_remove takes one off by its fingerprint`,
            e.retryAfterMs,
            e.reason,
        );
    }
    return e;
}

// A bare NotFound on a sandbox that exists can only mean the fingerprint is unknown
async function removeFailure(deps: Deps, handle: string, err: unknown): Promise<CallToolResult> {
    const what = "ssh remove";
    const e = sshError(err, what);
    if (e.kind === "not_found" && e.reason === null) {
        try {
            await deps.router.getPlacement({ handle });
        } catch {
            return failure(e, what);
        }
        return failure(
            new GatewayError("not_found", `${what}: this sandbox has no key with that fingerprint`),
            what,
        );
    }
    return sandboxFailure(deps, handle, e, what);
}

function knownHostsFileOf(command: string, given: string | undefined): string {
    const named = /UserKnownHostsFile=(\S+)/.exec(command)?.[1]?.replace(/^["']|["']$/g, "");
    return named || given || defaultKnownHostsFile;
}

export const registerSshTools: Register = (server, deps) => {
    server.registerTool(
        "bugnet_ssh",
        {
            title: "SSH into a Bugnet sandbox",
            description:
                "Authorizes a public key for SSH into a ready sandbox and returns the ssh " +
                "command, the knownHosts lines it checks and an ssh_config stanza. The key " +
                "comes from ssh-keygen -t ed25519 -N '' -f ~/.ssh/bugnet_<alias>, where <alias> " +
                "is the sshAlias bugnet_start and bugnet_status show, and publicKey is the line " +
                "of its .pub file, never the private key. Codex, whose sandbox cannot write " +
                "~/.ssh, makes the key at $TMPDIR/bugnet/<alias> and passes identityFile " +
                '"$TMPDIR/bugnet/<alias>" and knownHostsFile "$TMPDIR/bugnet/known_hosts". ' +
                "The same key again is safe.",
            inputSchema: z.object({
                handle: handleInput,
                publicKey: z
                    .string()
                    .max(65_536)
                    .describe("The one line of the .pub file, such as ssh-ed25519 AAAA... me@host"),
                identityFile: fileInput
                    .optional()
                    .describe("Private key path for the command, ~/.ssh/bugnet_<alias> if unset"),
                knownHostsFile: fileInput
                    .optional()
                    .describe(
                        `known_hosts path for the command, ${defaultKnownHostsFile} if unset`,
                    ),
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (args) => {
            const what = "ssh";
            try {
                let key;
                try {
                    key = parsePublicKey(args.publicKey);
                } catch (e) {
                    if (!(e instanceof KeyError)) throw e;
                    if (e.privateKey) {
                        deps.log.warn("private key refused", { handle: handleTag(args.handle) });
                    }
                    throw new GatewayError("invalid", `${what}: ${e.message}`);
                }
                const res = await deps.router.addSshKey({
                    handle: args.handle,
                    publicKey: key.line,
                    identityFile: args.identityFile ?? "",
                    knownHostsFile: args.knownHostsFile ?? "",
                });
                if (res.knownHosts.length === 0) {
                    throw new GatewayError(
                        "unavailable",
                        `${what}: the sandbox service sent no host key, a retry in a minute may work`,
                    );
                }
                const fingerprint = res.fingerprint || key.fingerprint;
                const expiresAt = res.expiresAt ? timestampDate(res.expiresAt).toISOString() : null;
                const file = knownHostsFileOf(res.command, args.knownHostsFile);
                deps.log.info("ssh key added", { handle: handleTag(args.handle), fingerprint });
                const text = [
                    `Added key ${fingerprint} for SSH to ${res.alias}` +
                        (expiresAt ? `, valid until ${expiresAt}.` : "."),
                    `The command checks host keys only against ${file}, so the knownHosts ` +
                        "lines go into that file before the first connection.",
                    "The first connection can wait up to a minute while the sandbox sets up SSH, " +
                        'and after a "try again" message a retry works.',
                    `command: ${res.command}`,
                ].join("\n");
                return ok(text, {
                    alias: res.alias,
                    host: res.host,
                    port: res.port,
                    fingerprint,
                    knownHosts: res.knownHosts,
                    knownHostsFile: file,
                    command: res.command,
                    config: res.config || null,
                    expiresAt,
                });
            } catch (e) {
                return sandboxFailure(deps, args.handle, sshError(e, what), what);
            }
        },
    );

    server.registerTool(
        "bugnet_ssh_remove",
        {
            title: "Remove an SSH key from a Bugnet sandbox",
            description:
                "Takes an SSH key off a sandbox by the fingerprint bugnet_ssh returned. The " +
                "key's open SSH connections close, and other keys keep working.",
            inputSchema: z.object({ handle: handleInput, fingerprint: fingerprintInput }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (args) => {
            try {
                await deps.router.removeSshKey({
                    handle: args.handle,
                    fingerprint: args.fingerprint,
                });
                deps.log.info("ssh key removed", {
                    handle: handleTag(args.handle),
                    fingerprint: args.fingerprint,
                });
                return ok(
                    `Removed key ${args.fingerprint}. Its open SSH connections close, and other ` +
                        "keys keep working.",
                    { fingerprint: args.fingerprint, removed: true },
                );
            } catch (e) {
                return removeFailure(deps, args.handle, e);
            }
        },
    );
};
