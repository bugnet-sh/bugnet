// The value is read only after the user confirms, and never enters an argument, result or log
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import {
    inputRequired,
    inputResponse,
    type CallToolResult,
    type ClientCapabilities,
    type InputRequiredResult,
    type ServerContext,
    type Tool,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
    CanonicalError,
    SealError,
    canonicalHeaderNames,
    canonicalHosts,
    chooseKey,
    failureWhy,
    maxBoxBytes,
    namePattern,
    presetFor,
    sealSecret,
    sealedBytes,
    withinPreset,
    type PinnedKey,
    type Sealed,
    type SecretSpec,
} from "@bugnet/seal";
import { handleTag, type Log } from "../log.ts";
import type { RemoteTools } from "../remote.ts";
import { RouteError, getSealingKeys, putSecret, type RouteOptions } from "./route.ts";
import {
    SourceError,
    checkSource,
    readSource,
    type CheckedSource,
    type SourceDeps,
} from "./sources.ts";
import { looksLikeKeyName, looksLikeSolanaKey, walletKeyRefusal } from "./keyguard.ts";

export const secretFromEnvName = "bugnet_secret_from_env";
export const putGrantToolName = "bugnet_secret_put_grant";

// Data-plane 4.4, 40 bytes of placement, expiry and MAC in base64url without padding
const grantPattern = /^bnsp_[A-Za-z0-9_-]{54}$/;
// A refinement, since \p classes in a JSON Schema pattern read differently without the u flag
const isPrintable = (s: string) => /^[^\p{Cc}\p{Cf}]+$/u.test(s);
const confirmTtlMs = 10 * 60_000;

const sourceSchema = z.discriminatedUnion("type", [
    z
        .object({
            type: z.literal("env"),
            variable: z
                .string()
                .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
                .describe("Environment variable of the agent's process, such as HF_TOKEN"),
        })
        .strict(),
    z
        .object({
            type: z.literal("dotenv"),
            path: z
                .string()
                .min(1)
                .max(1024)
                .refine(isPrintable, "printable characters only")
                .describe(".env file in the working folder or the home folder"),
            key: z.string().regex(/^[\w.-]{1,128}$/),
        })
        .strict(),
    z
        .object({
            type: z.literal("keychain"),
            service: z.string().min(1).max(256).refine(isPrintable, "printable characters only"),
            account: z
                .string()
                .min(1)
                .max(256)
                .refine(isPrintable, "printable characters only")
                .optional(),
        })
        .strict(),
]);

const argsSchema = z
    .object({
        handle: z.string().regex(/^sbx_[a-z2-7]{26}$/, "a sandbox handle starting with sbx_"),
        name: z
            .string()
            .regex(namePattern, "letters, digits and _, not starting with a digit")
            .describe("Variable name inside the sandbox, such as HF_TOKEN"),
        source: sourceSchema,
        hosts: z
            .array(z.string().min(1).max(254))
            .min(1)
            .max(10)
            .describe("Hosts the value may be sent to, such as huggingface.co"),
        headerNames: z
            .array(z.string().min(1).max(100))
            .max(8)
            .optional()
            .describe(
                "Headers besides Authorization that carry it, the service's usual ones if left out",
            ),
    })
    .strict();

type Args = z.infer<typeof argsSchema>;

function jsonSchemaOf(schema: z.ZodType): Tool["inputSchema"] {
    const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
    delete json.$schema;
    return json as Tool["inputSchema"];
}

export const secretFromEnvTool: Tool = {
    name: secretFromEnvName,
    title: "Add a secret from this machine to a Bugnet sandbox",
    description:
        "Adds a secret to a sandbox without the value passing through the chat. The bridge reads " +
        "it from an environment variable, a .env file in the working or home folder, or a macOS " +
        "keychain item, asks the user to confirm the name, source and hosts, and seals it for " +
        "Bugnet's egress proxy. In the sandbox the variable holds a placeholder that the proxy " +
        "swaps for the value only on HTTPS requests to those hosts. The proxy decrypts all " +
        "traffic to those hosts, bodies included.",
    inputSchema: jsonSchemaOf(argsSchema),
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
};

export interface SecretToolDeps {
    remote: RemoteTools;
    route: RouteOptions;
    pinned: readonly PinnedKey[];
    sources: SourceDeps;
    log: Log;
    now: () => number;
    // Handles of the sandboxes that bugnet_start results relayed by this bridge process named
    started: ReadonlySet<string>;
    clientCapabilities: (ctx: ServerContext) => ClientCapabilities | undefined;
}

class Refusal extends Error {
    readonly retryAfterSeconds: number | null;

    constructor(message: string, retryAfterSeconds: number | null = null) {
        super(message);
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

function failure(message: string, retryAfterSeconds: number | null = null): CallToolResult {
    const retry = retryAfterSeconds !== null ? ` Retry after ${retryAfterSeconds} s.` : "";
    return { content: [{ type: "text", text: `secret: ${message}.${retry}` }], isError: true };
}

// zod's messages name the field and the rule, never the value that broke it
function argsProblem(err: z.ZodError): string {
    const first = err.issues[0];
    if (!first) return "the arguments are not valid";
    if (first.code === "unrecognized_keys") {
        return (
            `unknown argument ${first.keys.join(", ")}. The value is never an argument, the ` +
            "source names where the bridge reads it"
        );
    }
    const at = first.path.join(".") || "arguments";
    return `${at} is not valid, ${first.message}`;
}

// Only the SDK's own rule, an empty elicitation capability means form mode
function canElicit(caps: ClientCapabilities | undefined): boolean {
    const e = caps?.elicitation as { form?: unknown; url?: unknown } | undefined;
    return e !== undefined && (e.form !== undefined || e.url === undefined);
}

const confirmKey = randomBytes(32);

// Ties an accepted prompt to exactly the name, source and hosts it showed, for 10 minutes
function confirmState(shown: string, issuedAt: number): string {
    const mac = createHmac("sha256", confirmKey).update(`${issuedAt}\0${shown}`).digest("hex");
    return `c1.${issuedAt}.${mac}`;
}

function stateConfirms(state: unknown, shown: string, now: number): boolean {
    if (typeof state !== "string") return false;
    const m = /^c1\.(\d{1,15})\.([0-9a-f]{64})$/.exec(state);
    if (!m) return false;
    const issuedAt = Number(m[1]);
    if (now - issuedAt > confirmTtlMs || issuedAt - now > 60_000) return false;
    const want = Buffer.from(confirmState(shown, issuedAt));
    const got = Buffer.from(state);
    return want.length === got.length && timingSafeEqual(want, got);
}

function plain(s: string): string {
    return s.replace(/[\p{Cc}\p{Cf}]/gu, "?");
}

// The handle's end lets the user match the sandbox with the chat's, against an injected handle
function prompt(handle: string, spec: SecretSpec, checked: CheckedSource, known: boolean): string {
    const preset = presetFor(spec.name);
    const headers = ["Authorization", ...spec.headerNames].join(", ");
    const unknown = known ? "" : ", which this bridge did not start, so check it is yours";
    const lines = [
        "Add a secret to your Bugnet sandbox?",
        "",
        `Sandbox: handle ending ${handle.slice(-6)}${unknown}`,
        `Name: ${spec.name}`,
        `Read from: ${plain(checked.label)}`,
        `Sent only to: ${spec.hosts.join(", ")}`,
        `In headers: ${headers}`,
        "",
        "Bugnet's egress proxy puts the value into requests to these hosts, and it decrypts all " +
            "traffic to them, bodies included. Accept only if that is fine for these hosts.",
    ];
    if (!withinPreset(spec.name, spec.hosts, spec.headerNames)) {
        lines.push(
            "",
            preset
                ? `These are not the usual hosts of ${spec.name}, which are ` +
                      `${preset.hosts.join(", ")}.`
                : `${spec.name} is not a known service's secret, so check each host.`,
        );
    }
    return lines.join("\n");
}

function unconfirmed(rule: string): string {
    return (
        `this client cannot ask the user to confirm, so the bridge ${rule}. ` +
        "bugnet_secret_link gives the user a page to add it instead"
    );
}

// A preset's own names, so GH_TOKEN may come from GITHUB_TOKEN but never from an unrelated key
function ownSource(spec: SecretSpec, checked: CheckedSource): boolean {
    const names = presetFor(spec.name)?.names ?? [];
    const source = checked.source;
    switch (source.type) {
        case "env":
            return names.includes(source.variable);
        case "dotenv":
            return names.includes(source.key) && basename(source.path).startsWith(".env");
        case "keychain":
            return false;
    }
}

// Without a human in the loop the bridge decides alone, so it takes only what is plainly the user's
function unconfirmedRefusal(
    args: Args,
    spec: SecretSpec,
    checked: CheckedSource,
    deps: SecretToolDeps,
): string | null {
    const preset = presetFor(spec.name);
    if (!withinPreset(spec.name, spec.hosts, spec.headerNames)) {
        return unconfirmed(
            preset
                ? `sends ${spec.name} only to ${preset.hosts.join(", ")}`
                : "sends only known secrets to their usual hosts, such as HF_TOKEN to " +
                      "huggingface.co",
        );
    }
    if (checked.source.type === "keychain") return unconfirmed("reads no keychain item");
    if (!ownSource(spec, checked)) {
        return unconfirmed(
            `reads ${spec.name} only from the environment variable or .env key of that name`,
        );
    }
    if (!deps.started.has(args.handle)) {
        return unconfirmed(
            "adds secrets only to sandboxes it started itself, and it did not start that one",
        );
    }
    return null;
}

function idempotencyKey(ctx: ServerContext): string {
    const id = ctx.mcpReq._meta?.["claudecode/toolUseId"];
    if (typeof id === "string" && id.length > 0 && id.length <= 200 && !id.startsWith("_")) {
        return id;
    }
    return randomUUID();
}

async function putGrant(remote: RemoteTools, handle: string, signal: AbortSignal) {
    let res;
    try {
        res = await remote.callTool({ name: putGrantToolName, arguments: { handle } }, { signal });
    } catch {
        throw new Refusal("Bugnet's gateway did not answer, a retry may work");
    }
    if (!("content" in res) || res.isError) {
        const blocks = ("content" in res ? res.content : []) as { type: string; text?: string }[];
        const text = blocks
            .map((b) => b.text ?? "")
            .join(" ")
            .replace(/^put grant: /, "")
            .replace(/\.$/, "");
        throw new Refusal(text || "the gateway gave no put grant");
    }
    const grant = (res.structuredContent as { putGrant?: unknown } | undefined)?.putGrant;
    if (typeof grant !== "string" || !grantPattern.test(grant)) {
        throw new Refusal("the gateway gave no put grant");
    }
    return grant;
}

// Data-plane 10.3, a later secret change applies the whole set again
const failureNext: Record<string, string> = {
    PORT_443_TAKEN:
        "Stop what listens on port 443 in the sandbox, then call bugnet_secret_from_env again " +
        "to set it up",
    SOURCE_UNKNOWN: "Start a new sandbox to use secrets",
};

function failedText(name: string, reason: string): string {
    const code = reason || "UNKNOWN";
    const why = failureWhy(code) ?? "the sandbox could not take it";
    const next = Object.hasOwn(failureNext, code)
        ? failureNext[code]
        : "bugnet_secrets shows its state, and a new sandbox may be needed for secrets";
    return `${name} is stored but not active in the sandbox, because ${why} (${code}). ${next}`;
}

function routeRefusal(e: RouteError): Refusal {
    return new Refusal(e.message, e.retryAfterSeconds);
}

// A lost answer is retried once with the same request, which the router's idempotency key absorbs
async function once<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (e) {
        if (!(e instanceof RouteError) || e.reason !== "unreachable" || signal.aborted) throw e;
        return work();
    }
}

async function store(
    deps: SecretToolDeps,
    spec: SecretSpec,
    value: string,
    grant: string,
    key: string,
    signal: AbortSignal,
) {
    const sealFresh = async () => {
        const listed = await once(signal, () => getSealingKeys(deps.route, grant, signal));
        return sealSecret(spec, value, chooseKey(listed, deps.pinned));
    };
    const put = (sealed: Sealed, k: string) =>
        once(signal, () => putSecret(deps.route, grant, sealed.spec, sealed.value, k, signal));
    try {
        return await put(await sealFresh(), key);
    } catch (e) {
        if (!(e instanceof RouteError) || e.reason !== "key_unknown") throw e;
    }
    // The router keys puts by this value, so a box sealed to a newer key needs a fresh one
    return put(await sealFresh(), `${key}.1`);
}

export async function secretFromEnv(
    rawArgs: unknown,
    ctx: ServerContext,
    deps: SecretToolDeps,
): Promise<CallToolResult | InputRequiredResult> {
    const parsed = argsSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) return failure(argsProblem(parsed.error));
    const args: Args = parsed.data;
    let spec: SecretSpec;
    let checked: CheckedSource;
    try {
        const headerNames = args.headerNames ?? [...(presetFor(args.name)?.headerNames ?? [])];
        spec = {
            name: args.name,
            hosts: canonicalHosts(args.hosts),
            headerNames: canonicalHeaderNames(headerNames),
            fetchOnly: false,
        };
        checked = await checkSource(args.source, deps.sources);
    } catch (e) {
        if (e instanceof CanonicalError || e instanceof SourceError) return failure(e.message);
        throw e;
    }
    const sourceName =
        args.source.type === "env"
            ? args.source.variable
            : args.source.type === "dotenv"
              ? args.source.key
              : "";
    if (looksLikeKeyName(spec.name) || looksLikeKeyName(sourceName)) {
        deps.log.warn("secret refused", { handle: handleTag(args.handle), reason: "wallet_key" });
        return failure(walletKeyRefusal);
    }
    const shown = JSON.stringify([args.handle, spec, checked.label]);
    if (canElicit(deps.clientCapabilities(ctx))) {
        const answer = inputResponse(ctx.mcpReq.inputResponses, "confirm");
        if (answer.kind === "elicit" && answer.action !== "accept") {
            deps.log.info("secret declined", { handle: handleTag(args.handle), name: spec.name });
            return failure("the user did not confirm, so nothing was read or sent");
        }
        const confirmed =
            answer.kind === "elicit" && stateConfirms(ctx.mcpReq.requestState(), shown, deps.now());
        if (!confirmed) {
            return inputRequired({
                inputRequests: {
                    confirm: inputRequired.elicit({
                        message: prompt(args.handle, spec, checked, deps.started.has(args.handle)),
                        requestedSchema: { type: "object", properties: {} },
                    }),
                },
                requestState: confirmState(shown, deps.now()),
            });
        }
    } else {
        const refusal = unconfirmedRefusal(args, spec, checked, deps);
        if (refusal) return failure(refusal);
    }
    const signal = ctx.mcpReq.signal;
    try {
        const value = await readSource(checked, deps.sources, signal);
        if (looksLikeSolanaKey(value, [spec.name, sourceName])) {
            deps.log.warn("secret refused", {
                handle: handleTag(args.handle),
                reason: "wallet_key",
            });
            return failure(walletKeyRefusal);
        }
        if (sealedBytes(spec, value) > maxBoxBytes) {
            throw new Refusal(
                `${spec.name} is too large once sealed, because quotes, backslashes and ` +
                    "control characters take more room. Up to 64 KiB of plain text fit",
            );
        }
        const grant = await putGrant(deps.remote, args.handle, signal);
        const answer = await store(deps, spec, value, grant, idempotencyKey(ctx), signal);
        const s = answer.secret;
        deps.log.info("secret stored", {
            handle: handleTag(args.handle),
            name: spec.name,
            hosts: spec.hosts,
            state: s.state,
        });
        const text =
            s.state === "FAILED"
                ? failedText(spec.name, s.failureReason)
                : `${spec.name} is stored for ${spec.hosts.join(", ")}, state ${s.state}. In ` +
                  `the sandbox $${spec.name} holds a placeholder that Bugnet's egress proxy ` +
                  "swaps for the value only on HTTPS requests to those hosts. The proxy " +
                  "decrypts all traffic to them, bodies included";
        return {
            content: [{ type: "text", text: `${text}.` }],
            structuredContent: {
                message: `${text}.`,
                name: spec.name,
                hosts: spec.hosts,
                headerNames: spec.headerNames,
                state: s.state,
                replaced: answer.replaced,
                ...(s.failureReason ? { failureReason: s.failureReason } : {}),
            },
            ...(s.state === "FAILED" ? { isError: true } : {}),
        };
    } catch (e) {
        if (signal.aborted) throw e;
        const refusal =
            e instanceof Refusal
                ? e
                : e instanceof RouteError
                  ? routeRefusal(e)
                  : e instanceof SourceError || e instanceof SealError
                    ? new Refusal(e.message)
                    : null;
        if (!refusal) {
            deps.log.error("secret failed", { handle: handleTag(args.handle), name: spec.name });
            return failure("the bridge failed to store the secret");
        }
        deps.log.warn("secret refused", {
            handle: handleTag(args.handle),
            name: spec.name,
            reason: e instanceof RouteError ? e.reason : refusal.constructor.name,
        });
        return failure(refusal.message, refusal.retryAfterSeconds);
    }
}
