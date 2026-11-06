import {
    Code,
    ConnectError,
    createClient,
    type Client,
    type Interceptor,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import type { Config } from "./config.ts";
import { SandboxRouterService } from "./gen/bugnet/router/v1/router_pb.ts";
import { toolCallSignal } from "./request.ts";

export type RouterClient = Client<typeof SandboxRouterService>;

// A long poll's deadline past its wait, which router.timeout alone would cut short
export const waitMargin = 5_000;

// A cancelled tool call cancels the router calls it made, so no tool passes its signal by hand
const followToolCall: Interceptor = (next) => async (req) => {
    const tool = toolCallSignal();
    if (!tool) return next(req);
    // A write sent after the tool call ended would take effect while the tool reports it failed
    if (tool.aborted) throw ConnectError.from(tool.reason, Code.Canceled);
    return next({ ...req, signal: AbortSignal.any([req.signal, tool]) });
};

// Calls without a deadline of their own end at router.timeout, long polls set wait plus a margin
export function createRouterClient(
    config: Pick<Config, "router" | "secrets">,
    interceptors: Interceptor[] = [],
): RouterClient {
    const auth: Interceptor = (next) => (req) => {
        req.header.set("Authorization", `Bearer ${config.secrets.internalToken}`);
        return next(req);
    };
    const transport = createConnectTransport({
        baseUrl: config.router.url,
        httpVersion: "2",
        defaultTimeoutMs: config.router.timeout,
        interceptors: [...interceptors, followToolCall, auth],
    });
    return createClient(SandboxRouterService, transport);
}

export type GatewayErrorKind =
    | "not_found"
    | "expired"
    | "not_ready"
    | "invalid"
    | "rate_limited"
    | "no_capacity"
    | "limit"
    | "denied"
    | "precondition"
    | "revoked"
    | "unsupported"
    | "unavailable"
    | "timeout"
    | "internal";

export class GatewayError extends Error {
    constructor(
        readonly kind: GatewayErrorKind,
        message: string,
        readonly retryAfterMs: number | null = null,
        readonly reason: string | null = null,
    ) {
        super(message);
    }
}

export const retryInfoType = "google.rpc.RetryInfo";
export const errorInfoType = "google.rpc.ErrorInfo";

function detailOf(err: ConnectError, typeName: string): Uint8Array | null {
    for (const d of err.details) {
        if ("type" in d && d.type === typeName && "value" in d) return d.value;
    }
    return null;
}

// Reads one length-delimited field of a message, null when absent or malformed
function field(raw: Uint8Array, fieldNo: number): Uint8Array | null {
    try {
        const r = new BinaryReader(raw);
        while (r.pos < r.len) {
            const [no, type] = r.tag();
            if (no === fieldNo && type === WireType.LengthDelimited) return r.bytes();
            r.skip(type, no);
        }
    } catch {
        return null;
    }
    return null;
}

// Decodes google.rpc.RetryInfo.retry_delay without pulling in the googleapis descriptors
export function retryDelayMs(err: ConnectError): number | null {
    const raw = detailOf(err, retryInfoType);
    const dur = raw && field(raw, 1);
    if (!dur) return null;
    let seconds = 0;
    let nanos = 0;
    try {
        const r = new BinaryReader(dur);
        while (r.pos < r.len) {
            const [no, type] = r.tag();
            if (no === 1 && type === WireType.Varint) seconds = Number(r.int64());
            else if (no === 2 && type === WireType.Varint) nanos = r.int32();
            else r.skip(type, no);
        }
    } catch {
        return null;
    }
    const ms = seconds * 1000 + Math.ceil(nanos / 1e6);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function errorReason(err: ConnectError): string | null {
    const raw = detailOf(err, errorInfoType);
    const reason = raw && field(raw, 1);
    return reason && reason.length > 0 ? new TextDecoder().decode(reason) : null;
}

// The google.rpc.ErrorInfo reason of a router failure, or the one a GatewayError kept from it
export function reasonOf(err: unknown): string | null {
    if (err instanceof GatewayError) return err.reason;
    if (err instanceof ConnectError) return errorReason(err);
    return null;
}

interface Rule {
    code: Code;
    kind: GatewayErrorKind;
    text: string;
}

/* Reasons */

const unknownHandle =
    "no sandbox has this handle. Check it was copied in full, or quote and start a new one";

// The router has not built the feature, which no retry, wait or extension changes
export const notOpenText =
    "Bugnet has not opened this yet, so a retry now or later gets the same answer. The " +
    "other Bugnet tools work as usual";

// Data-plane 11.3 and control-plane 13.1, each honoured only under the code it comes with
const rules: Record<string, Rule> = {
    PORT_REFUSED: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text: "that port cannot be previewed, the app has to listen on another port",
    },
    PATH_REFUSED: { code: Code.InvalidArgument, kind: "invalid", text: "that path is refused" },
    SIZE_REQUIRED: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text: "an upload needs the file's exact size in bytes",
    },
    SIZE_MISMATCH: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text: "the file's size is not the size given",
    },
    IS_DIRECTORY: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text: "the path is a directory, a tar archive of it transfers as one file",
    },
    NOT_REGULAR: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text: "the path is not a regular file",
    },
    KEY_INVALID: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text:
            "the public key is refused. One ssh-ed25519, ecdsa or RSA 3072+ key line " +
            "without options is accepted",
    },
    NAME_RESERVED: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text: "that secret name is reserved, another name works",
    },
    HOST_REFUSED: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text: "a secret cannot be sent to that host",
    },
    HEADER_REFUSED: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text: "a secret cannot go in that header",
    },
    SEALED_TOO_LARGE: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text: "the secret is too large",
    },
    KEY_UNKNOWN: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text: "the sealing key is no longer current, fetch it again",
    },
    SOURCE_INVALID: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text:
            "the source has to be a GitHub URL, a Hugging Face model id or an https URL, " +
            "with no credentials in it",
    },
    SECRET_IN_ARGUMENT: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text:
            "a value shaped like an API token is in the arguments. Tokens never go in source, " +
            "entryCommand, cmd or env, bugnet_secret_link adds them to a sandbox",
    },
    IDEMPOTENCY_KEY_RESERVED: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text: "the request id is reserved for Bugnet's own jobs",
    },
    QUOTE_INVALID: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text: "the quote is not valid, bugnet_quote gives a new one",
    },
    PACKAGE_UNKNOWN: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text: "that package is not on offer, bugnet_quote lists the packages",
    },
    NOT_START_PACKAGE: {
        code: Code.InvalidArgument,
        kind: "invalid",
        text:
            "that package only extends a running sandbox, a start takes a package from " +
            "bugnet_quote",
    },
    HANDLE_UNKNOWN: {
        code: Code.NotFound,
        kind: "not_found",
        text: unknownHandle,
    },
    JOB_UNKNOWN: {
        code: Code.NotFound,
        kind: "not_found",
        text: "this sandbox has no job with that id, bugnet_exec gives the jobId of each command",
    },
    not_found: {
        code: Code.NotFound,
        kind: "not_found",
        text: "no file or directory at that path",
    },
    FILE_NOT_FOUND: {
        code: Code.NotFound,
        kind: "not_found",
        text: "no file or directory at that path",
    },
    PREVIEW_UNKNOWN: { code: Code.NotFound, kind: "not_found", text: "no preview has this id" },
    TOKEN_UNKNOWN: {
        code: Code.NotFound,
        kind: "not_found",
        text: "the link is unknown or has expired, a new one is needed",
    },
    LINK_UNKNOWN: {
        code: Code.NotFound,
        kind: "not_found",
        text: "the secret link is unknown or used, bugnet_secret_link makes a new one",
    },
    GRANT_UNKNOWN: {
        code: Code.NotFound,
        kind: "not_found",
        text: "the grant is unknown or has expired, a new one is needed",
    },
    TOKEN_INVALID: {
        code: Code.PermissionDenied,
        kind: "denied",
        text: "the token is not valid for this sandbox",
    },
    GRANT_INVALID: {
        code: Code.PermissionDenied,
        kind: "denied",
        text: "the grant has expired or is for another sandbox, a new one is needed",
    },
    PUT_GRANT_INVALID: {
        code: Code.PermissionDenied,
        kind: "denied",
        text: "the grant has expired or is for another sandbox, a new one is needed",
    },
    WALLET_BLOCKED: {
        code: Code.PermissionDenied,
        kind: "denied",
        text: "the paying wallet is blocked from Bugnet, so the order was refused",
    },
    PAYER_REQUIRED: {
        code: Code.PermissionDenied,
        kind: "denied",
        text: "the order named no paying wallet, so it was refused",
    },
    NOT_READY: {
        code: Code.FailedPrecondition,
        kind: "not_ready",
        text: "the sandbox is not ready, bugnet_status shows its state",
    },
    EXCEEDS_LIFETIME: {
        code: Code.FailedPrecondition,
        kind: "invalid",
        text: "that would pass the longest time a sandbox can run",
    },
    FEATURE_UNAVAILABLE: {
        code: Code.FailedPrecondition,
        kind: "unsupported",
        text: "not open on this sandbox yet, the other Bugnet tools work as usual",
    },
    PREVIEW_REVOKED: {
        code: Code.FailedPrecondition,
        kind: "revoked",
        text:
            "Bugnet closed the preview on this port for good, so a retry gets the same " +
            "answer. A preview on another port still works",
    },
    TOKEN_USED: {
        code: Code.FailedPrecondition,
        kind: "precondition",
        text: "that one-time link was already used, a new one is needed",
    },
    TOKEN_EXPIRED: {
        code: Code.FailedPrecondition,
        kind: "precondition",
        text: "that link has expired, a new one is needed",
    },
    IN_USE: {
        code: Code.FailedPrecondition,
        kind: "precondition",
        text: "another transfer on this link is still running",
    },
    FILE_CHANGED: {
        code: Code.FailedPrecondition,
        kind: "precondition",
        text: "the file changed during the download, a new link downloads it again",
    },
    LINK_LOCKED: {
        code: Code.FailedPrecondition,
        kind: "precondition",
        text:
            "the secret link locked after too many failed tries, bugnet_secret_link makes " +
            "a new one",
    },
    HOST_NOT_ALLOWED: {
        code: Code.FailedPrecondition,
        kind: "precondition",
        text: "secrets for that host are not allowed",
    },
    NO_SOURCE: {
        code: Code.FailedPrecondition,
        kind: "precondition",
        text: "the quote named no source to fetch",
    },
    SECRET_REQUIRED: {
        code: Code.FailedPrecondition,
        kind: "precondition",
        text:
            "the repo is private or missing. A GitHub token added with bugnet_secret_link " +
            "lets the next call read it",
    },
    TOOL_MISSING: {
        code: Code.FailedPrecondition,
        kind: "precondition",
        text:
            "the sandbox lacks git or tar, which the fetch needs, so the choices left are " +
            "cloning it by hand with bugnet_exec or stopping",
    },
    OVER_CAP: {
        code: Code.OutOfRange,
        kind: "limit",
        text: "the file is over this sandbox's transfer size limit",
    },
    RANGE: {
        code: Code.OutOfRange,
        kind: "invalid",
        text: "the offset is past the end of the file",
    },
    RATE_LIMITED: {
        code: Code.ResourceExhausted,
        kind: "rate_limited",
        text: "too many requests for now",
    },
    BUDGET_SPENT: {
        code: Code.ResourceExhausted,
        kind: "limit",
        text:
            "this sandbox has used its network allowance for previews, transfers and SSH. " +
            "Commands and files still work",
    },
    TOO_MANY_PREVIEWS: {
        code: Code.ResourceExhausted,
        kind: "limit",
        text: "this sandbox has as many previews as it may",
    },
    TOO_MANY_TRANSFERS: {
        code: Code.ResourceExhausted,
        kind: "limit",
        text:
            "this sandbox has as many open transfer links as it may, until one is used or " +
            "expires",
    },
    TOO_MANY_KEYS: {
        code: Code.ResourceExhausted,
        kind: "limit",
        text: "this sandbox holds as many SSH keys as it may",
    },
    TOO_MANY_SECRETS: {
        code: Code.ResourceExhausted,
        kind: "limit",
        text: "this sandbox holds as many secrets as it may",
    },
    TOO_MANY_CONNECTIONS: {
        code: Code.ResourceExhausted,
        kind: "limit",
        text: "too many connections to this sandbox are open",
    },
    NO_SPACE: { code: Code.ResourceExhausted, kind: "limit", text: "the sandbox's disk is full" },
    WALLET_BUSY: {
        code: Code.ResourceExhausted,
        kind: "limit",
        text:
            "the paying wallet already runs as many sandboxes as it may. Stopping one with " +
            "bugnet_stop, or one ending, frees a place. This order is refunded",
    },
    WALLET_RATE_LIMITED: {
        code: Code.ResourceExhausted,
        kind: "rate_limited",
        text: "the paying wallet started too many sandboxes recently. This order is refunded",
    },
    CHECKSUM_MISMATCH: {
        code: Code.DataLoss,
        kind: "invalid",
        text: "the uploaded bytes do not match the sha256 given, so nothing was saved",
    },
    GATE_UNAVAILABLE: {
        code: Code.Unavailable,
        kind: "unavailable",
        text: "the sandbox's web gate did not answer, a retry in a minute may work",
    },
    SSH_PREPARING: {
        code: Code.Unavailable,
        kind: "unavailable",
        text: "SSH is still being set up in the sandbox",
    },
    PROVIDER_UNAVAILABLE: {
        code: Code.Unavailable,
        kind: "unavailable",
        text: "the cloud behind this sandbox is unavailable right now",
    },
};

/* Codes */

// Turns a router failure into the error the agent sees, never echoing provider text
export function fromRouter(err: unknown, what: string): GatewayError {
    if (err instanceof GatewayError) return err;
    if (!(err instanceof ConnectError)) {
        return new GatewayError("internal", `${what} failed`);
    }
    const reason = errorReason(err);
    const rule = reason !== null && Object.hasOwn(rules, reason) ? rules[reason] : undefined;
    const fail = (kind: GatewayErrorKind, text: string) => {
        const wait = retryDelayMs(err) ?? (kind === "rate_limited" ? 1000 : null);
        return new GatewayError(kind, `${what}: ${text}`, wait, reason);
    };
    if (rule && rule.code === err.code) return fail(rule.kind, rule.text);
    switch (err.code) {
        case Code.NotFound:
            // Routers before HANDLE_UNKNOWN sent an unknown handle without a reason
            if (reason === null) return fail("not_found", unknownHandle);
            return fail("not_found", safeMessage(err));
        case Code.FailedPrecondition:
            return fail(reason === null ? "not_ready" : "precondition", safeMessage(err));
        case Code.InvalidArgument:
        case Code.OutOfRange:
            return fail("invalid", safeMessage(err));
        case Code.PermissionDenied:
            return fail("denied", "the order was refused");
        case Code.ResourceExhausted:
            return fail("no_capacity", safeMessage(err));
        case Code.Unimplemented:
            return fail("unsupported", notOpenText);
        case Code.DeadlineExceeded:
            return fail("timeout", "timed out");
        case Code.Unavailable:
            return fail("unavailable", "the sandbox service is unavailable");
        default:
            return new GatewayError("internal", `${what} failed`, null, reason);
    }
}

const providerNames = /\b(koyeb|boat|e2b|boxd|instabox|daytona)\b/gi;

// Router wording cut to one line, with any provider name scrubbed because callers never learn it
export function routerText(text: string): string {
    const first = text.split("\n")[0] ?? "";
    return first
        .replace(/\b(api|saga|jobs|streams|placement): /g, "")
        .replace(providerNames, "provider")
        .slice(0, 200);
}

export function safeMessage(err: ConnectError): string {
    return routerText(err.rawMessage) || "refused";
}
