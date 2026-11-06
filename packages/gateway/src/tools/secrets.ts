import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SecretState, type SecretInfo } from "../gen/bugnet/router/v1/router_pb.ts";
import { GatewayError, fromRouter } from "../router.ts";
import { cleanText } from "../sanitize.ts";
import {
    failure,
    handleTag,
    idempotencyKey,
    ok,
    routerLink,
    sandboxFailure,
    withFreshKey,
    type Deps,
    type Register,
    handleInput,
    iso,
} from "./common.ts";

const nameInput = z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "an environment variable name such as HF_TOKEN");
const hostInput = z
    .string()
    .max(253)
    .regex(
        /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\.?$/,
        "a bare host name such as huggingface.co, without scheme, port or path",
    );

const secretStateName: Record<SecretState, string> = {
    [SecretState.UNSPECIFIED]: "unknown",
    [SecretState.APPLYING]: "applying",
    [SecretState.ACTIVE]: "active",
    [SecretState.FAILED]: "failed",
};

// Codes a failed secret carries, data-plane 10.10 and 10.12.5.4
const failureText: Record<string, string> = {
    PORT_443_TAKEN: "port 443 in the sandbox is taken, and secrets need it",
    SOURCE_UNKNOWN: "this sandbox cannot use secrets, a new sandbox can",
};

// Data-plane 4.4, a bnsl_ token of 16 bytes and six Crockford base32 characters
const linkPath = /^\/l\/bnsl_[A-Za-z0-9_-]{22}$/;
const pairingShape = /^[0-9A-HJKMNP-TV-Z]{6}$/;

// The router refuses hosts not in canonical form instead of rewriting them
export function canonicalHosts(hosts: readonly string[]): string[] {
    const set = new Set(hosts.map((h) => h.trim().toLowerCase().replace(/\.$/, "")));
    return [...set].sort();
}

export interface SecretView {
    name: string;
    hosts: string[];
    headerNames: string[];
    fetchOnly: boolean;
    state: string;
    failureReason?: string;
    updatedAt: string | null;
}

// Router codes only, so free text from anywhere else never reaches the model
function reasonCode(reason: string): string {
    return /^[A-Z0-9_]{1,64}$/.test(reason) ? reason : "UNKNOWN";
}

export function secretView(s: SecretInfo): SecretView {
    const spec = s.spec;
    return {
        name: cleanText(spec?.name ?? ""),
        hosts: (spec?.hosts ?? []).map(cleanText),
        headerNames: (spec?.headerNames ?? []).map(cleanText),
        fetchOnly: spec?.fetchOnly ?? false,
        state: secretStateName[s.state] ?? "unknown",
        ...(s.failureReason ? { failureReason: reasonCode(s.failureReason) } : {}),
        updatedAt: iso(s.updatedAt),
    };
}

function describeSecret(s: SecretView): string {
    const reason = s.failureReason;
    const why = reason ? ` (${[reason, failureText[reason]].filter(Boolean).join(", ")})` : "";
    const headers = s.headerNames.length > 0 ? `, also in headers ${s.headerNames.join(", ")}` : "";
    const fetch = s.fetchOnly ? ", fetch only, the sandbox gets no variable" : "";
    return `- ${s.name}: ${s.state}${why}, hosts ${s.hosts.join(", ") || "none"}${headers}${fetch}`;
}

const secretsNotOpen =
    "Bugnet has not opened secrets yet, so a retry now or later gets the same answer. Work " +
    "that needs a secret goes without it here, and a value never goes in a command, env or file";

// Both a missing secret path and a closed one answer FEATURE_UNAVAILABLE, and the cure is the same
async function secretFailure(
    deps: Deps,
    handle: string,
    err: unknown,
    what: string,
    name?: string,
): Promise<CallToolResult> {
    if (err instanceof GatewayError) return failure(err, what);
    const e = fromRouter(err, what);
    if (e.kind === "unsupported" && e.reason === null) {
        return failure(new GatewayError(e.kind, `${what}: ${secretsNotOpen}`), what);
    }
    if (e.kind === "unsupported" && e.reason === "FEATURE_UNAVAILABLE") {
        return failure(
            new GatewayError(
                "unsupported",
                `${what}: this sandbox cannot hold secrets. A sandbox started from a ` +
                    'bugnet_quote with needs ["secrets"] can, and the other Bugnet tools work ' +
                    "here as usual",
                null,
                e.reason,
            ),
            what,
        );
    }
    const missing =
        name === undefined ? undefined : `no secret named ${name}, bugnet_secrets lists them`;
    return sandboxFailure(deps, handle, e, what, missing);
}

/* Tools */

export const registerSecretTools: Register = (server, deps) => {
    server.registerTool(
        "bugnet_secret_link",
        {
            title: "Secret entry link for a Bugnet sandbox",
            description:
                "Makes a one-time link, valid 10 minutes, where the user types a secret such as " +
                "an API token for this sandbox. The value goes from the user's browser to Bugnet " +
                "and never passes through the chat or the agent. name suggests the variable, " +
                "such as HF_TOKEN, and hosts the hosts it may be sent to, kept only when they " +
                "are the usual ones for that name. It needs a sandbox started from a quote with " +
                "needs secrets. Code in the sandbox then reads a placeholder from the variable, " +
                "which Bugnet swaps for the value in HTTPS headers to those hosts.",
            inputSchema: z.object({
                handle: handleInput,
                name: nameInput.optional(),
                hosts: z.array(hostInput).max(10).optional(),
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (args, ctx) => {
            try {
                const name = args.name ?? "";
                const hosts = canonicalHosts(args.hosts ?? []);
                const key = idempotencyKey(ctx, [args.handle, name, hosts.join(",")]);
                const res = await withFreshKey(key, (requestId) =>
                    deps.router.createSecretLink({ handle: args.handle, name, hosts, requestId }),
                );
                const link = routerLink(deps, res.url, "secrets", linkPath);
                if (!link || !pairingShape.test(res.pairingCode)) {
                    throw new GatewayError(
                        "internal",
                        "secret link: the router gave no usable link",
                    );
                }
                const url = link.href;
                const expiresAt = iso(res.expiresAt);
                // The URL and the pairing code are bearer values, so neither is logged
                deps.log.info("secret link created", { handle: handleTag(args.handle), name });
                const text = [
                    `Secret entry link for the user, single use, valid ` +
                        (expiresAt ? `until ${expiresAt}` : "for 10 minutes") +
                        `: ${url}`,
                    `Pairing code: ${res.pairingCode}`,
                    "The link and its six-character pairing code are for the user. The page " +
                        "shows the same code and the sandbox's source, and the user checks both " +
                        "before typing a value. The value never passes through this chat or the " +
                        "agent. Fine-grained, short-lived tokens with the least scope are the " +
                        "safest kind. Bugnet's egress proxy decrypts traffic to the hosts a " +
                        "secret is bound to, bodies included, so a secret fits only hosts the " +
                        "user accepts that for.",
                    hosts.length > 0
                        ? "Suggested hosts are filled in only when they are the usual ones for " +
                          "the name, the user types any other host on the page."
                        : "",
                    "bugnet_secrets shows when the secret is active.",
                ]
                    .filter(Boolean)
                    .join("\n");
                return ok(text, { url, pairingCode: res.pairingCode, expiresAt });
            } catch (e) {
                return secretFailure(deps, args.handle, e, "secret link");
            }
        },
    );

    server.registerTool(
        "bugnet_secrets",
        {
            title: "List the secrets in a Bugnet sandbox",
            description:
                "Lists a sandbox's secrets: name, hosts, extra header names, state (applying, " +
                "active, or failed with a reason) and when each changed. Values are never shown. " +
                "An active secret reaches the next bugnet_exec command as the environment " +
                "variable of its name, and processes already running see it after a restart.",
            inputSchema: z.object({ handle: handleInput }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args) => {
            try {
                const res = await deps.router.listSecrets({ handle: args.handle });
                const secrets = res.secrets.map(secretView);
                const text =
                    secrets.length === 0
                        ? "No secrets on this sandbox. bugnet_secret_link adds one."
                        : [
                              `${secrets.length} secret${secrets.length === 1 ? "" : "s"} on ` +
                                  "this sandbox:",
                              ...secrets.map(describeSecret),
                              "In the sandbox a variable holds a placeholder, which Bugnet swaps " +
                                  "for the value in HTTPS headers to the secret's hosts.",
                          ].join("\n");
                return ok(text, { secrets });
            } catch (e) {
                return secretFailure(deps, args.handle, e, "secrets");
            }
        },
    );

    server.registerTool(
        "bugnet_secret_delete",
        {
            title: "Delete a secret from a Bugnet sandbox",
            description:
                "Deletes a secret from a sandbox by name. Bugnet stops sending its value within " +
                "a minute, and new commands no longer get the variable.",
            inputSchema: z.object({ handle: handleInput, name: nameInput }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (args) => {
            try {
                await deps.router.deleteSecret({ handle: args.handle, name: args.name });
                deps.log.info("secret deleted", {
                    handle: handleTag(args.handle),
                    name: args.name,
                });
                return ok(
                    `Deleted secret ${args.name}. Bugnet stops sending its value within a minute.`,
                    { name: args.name, deleted: true },
                );
            } catch (e) {
                return secretFailure(deps, args.handle, e, "delete secret", args.name);
            }
        },
    );

    server.registerTool(
        "bugnet_secret_put_grant",
        {
            title: "Secret put grant for the Bugnet bridge",
            description:
                "Used by the local Bugnet bridge, which seals secret values on the user's " +
                "machine. Returns a put grant, valid 10 minutes, that lets the bridge add " +
                "secrets to this sandbox and nothing else. Agents add secrets with " +
                "bugnet_secret_link instead.",
            inputSchema: z.object({ handle: handleInput }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
        },
        async (args) => {
            try {
                const res = await deps.router.createSecretPutGrant({ handle: args.handle });
                if (!res.putGrant.startsWith("bnsp_")) {
                    throw new GatewayError("internal", "put grant: the router gave no grant");
                }
                const expiresAt = iso(res.expiresAt);
                // The grant is a bearer credential, so only the handle's tag is logged
                deps.log.info("secret put grant issued", { handle: handleTag(args.handle) });
                return ok(
                    "Put grant for the local Bugnet bridge, valid " +
                        (expiresAt ? `until ${expiresAt}` : "for 10 minutes") +
                        ". It lets the bridge add sealed secrets to this sandbox and nothing else.",
                    { putGrant: res.putGrant, expiresAt },
                );
            } catch (e) {
                return secretFailure(deps, args.handle, e, "put grant");
            }
        },
    );
};
