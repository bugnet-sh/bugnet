import { timestampDate } from "@bufbuild/protobuf/wkt";
import { z } from "zod";
import type { AddSshKeyResponse } from "../gen/bugnet/router/v1/router_pb.ts";
import { GatewayError, fromRouter } from "../router.ts";
import { KeyError, parsePublicKey } from "../sshkey.ts";
import {
    handleTag,
    ok,
    okBody,
    sandboxFailure,
    underDomain,
    type Deps,
    type Register,
    handleInput,
} from "./common.ts";

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

const notOpenYet =
    "Bugnet has not opened SSH yet, so a retry now or later gets the same answer. " +
    "bugnet_exec and the file tools work as usual";
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

/* Router output */

// Data-plane 9.2 says base32 but its own example has a 9, so any lower-case letter or digit
const aliasShape = /^bn-[a-z0-9]{10}$/;
const hostShape = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const fingerprintShape = /^SHA256:[A-Za-z0-9+/]{43}$/;
const knownHostName = "(?:\\[[a-z0-9.-]+\\]:\\d{1,5}|[a-z0-9.-]+)";
const keyTypes = "ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa|rsa-sha2-(?:256|512)";
const knownHostShape = new RegExp(
    `^${knownHostName}(?:,${knownHostName})* (?:${keyTypes}) [A-Za-z0-9+/]+={0,2}$`,
);

// ssh_config keywords that only connect, never ones like ProxyCommand that run a program
const configKeys = new Set([
    "batchmode",
    "connecttimeout",
    "controlmaster",
    "controlpath",
    "controlpersist",
    "host",
    "hostname",
    "identitiesonly",
    "identityfile",
    "loglevel",
    "port",
    "serveralivecountmax",
    "serveraliveinterval",
    "stricthostkeychecking",
    "user",
    "userknownhostsfile",
]);
const configLine = /^\s*([A-Za-z]+)(?:\s+|\s*=\s*)[A-Za-z0-9._/~$@%:+=-]{1,300}\s*$/;

// The stanza is optional, so one with any other line is left out rather than refused
function safeConfig(config: string): string | null {
    if (!config) return null;
    for (const line of config.split("\n")) {
        if (line.trim() === "") continue;
        const key = configLine.exec(line)?.[1]?.toLowerCase();
        if (!key || !configKeys.has(key)) return null;
    }
    return config;
}

interface Endpoint {
    alias: string;
    host: string;
    port: number;
    knownHosts: string[];
}

// The command goes into the user's shell, so the gateway builds it from parts it has checked
function checkedEndpoint(deps: Deps, res: AddSshKeyResponse): Endpoint | null {
    const ok =
        aliasShape.test(res.alias) &&
        hostShape.test(res.host) &&
        underDomain(deps, res.host) &&
        Number.isInteger(res.port) &&
        res.port >= 1 &&
        res.port <= 65_535 &&
        res.knownHosts.every((l) => knownHostShape.test(l));
    if (!ok) return null;
    return { alias: res.alias, host: res.host, port: res.port, knownHosts: res.knownHosts };
}

export function sshCommand(e: Endpoint, identityFile: string, knownHostsFile: string): string {
    return (
        `ssh -i ${identityFile} -o IdentitiesOnly=yes -o BatchMode=yes ` +
        `-o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHostsFile}` +
        (e.port === 22 ? "" : ` -p ${e.port}`) +
        ` ${e.alias}@${e.host}`
    );
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
                const end = checkedEndpoint(deps, res);
                if (!end) {
                    throw new GatewayError(
                        "internal",
                        `${what}: the sandbox service gave an unusable SSH address`,
                    );
                }
                const fingerprint = fingerprintShape.test(res.fingerprint)
                    ? res.fingerprint
                    : key.fingerprint;
                const expiresAt = res.expiresAt ? timestampDate(res.expiresAt).toISOString() : null;
                const file = args.knownHostsFile ?? defaultKnownHostsFile;
                const identity = args.identityFile ?? `~/.ssh/bugnet_${end.alias}`;
                const command = sshCommand(end, identity, file);
                deps.log.info("ssh key added", { handle: handleTag(args.handle), fingerprint });
                const lines = [
                    `Added key ${fingerprint} for SSH to ${end.alias}` +
                        (expiresAt ? `, valid until ${expiresAt}.` : "."),
                    `The command checks host keys only against ${file}, so the knownHosts ` +
                        "lines go into that file before the first connection.",
                    "The first connection can wait up to a minute while the sandbox sets up SSH, " +
                        'and after a "try again" message a retry works.',
                    `command: ${command}`,
                ];
                const text = [...lines, "knownHosts:", ...end.knownHosts].join("\n");
                return okBody(text, lines.join("\n"), {
                    alias: end.alias,
                    host: end.host,
                    port: end.port,
                    fingerprint,
                    knownHosts: end.knownHosts,
                    knownHostsFile: file,
                    command,
                    config: safeConfig(res.config),
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
                const what = "ssh remove";
                const missing = "no key with that fingerprint";
                return sandboxFailure(deps, args.handle, sshError(e, what), what, missing);
            }
        },
    );
};
