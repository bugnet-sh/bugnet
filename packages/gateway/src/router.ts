import {
    Code,
    ConnectError,
    createClient,
    type Client,
    type Interceptor,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { SandboxRouterService } from "./gen/bugnet/router/v1/router_pb.ts";

export type RouterClient = Client<typeof SandboxRouterService>;

export function createRouterClient(baseUrl: string, internalToken: string): RouterClient {
    const auth: Interceptor = (next) => (req) => {
        req.header.set("Authorization", `Bearer ${internalToken}`);
        return next(req);
    };
    const transport = createConnectTransport({
        baseUrl,
        httpVersion: "2",
        interceptors: [auth],
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
    | "denied"
    | "unavailable"
    | "timeout"
    | "internal";

export class GatewayError extends Error {
    constructor(
        readonly kind: GatewayErrorKind,
        message: string,
        readonly retryAfterMs: number | null = null,
    ) {
        super(message);
    }
}

const retryInfoType = "google.rpc.RetryInfo";
const errorInfoType = "google.rpc.ErrorInfo";

function detailOf(err: ConnectError, typeName: string): Uint8Array | null {
    for (const d of err.details) {
        if ("type" in d && d.type === typeName && "value" in d) return d.value;
    }
    return null;
}

// Reads a protobuf varint at offset, the only wire type RetryInfo and ErrorInfo need here
function varint(b: Uint8Array, at: number): [number, number] {
    let n = 0;
    let shift = 0;
    let i = at;
    while (i < b.length) {
        const byte = b[i++] as number;
        n += (byte & 0x7f) * 2 ** shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return [n, i];
}

// Decodes google.rpc.RetryInfo.retry_delay without pulling in the googleapis descriptors
export function retryDelayMs(err: ConnectError): number | null {
    const raw = detailOf(err, retryInfoType);
    if (!raw || raw[0] !== 0x0a) return null;
    const [len, start] = varint(raw, 1);
    const dur = raw.subarray(start, start + len);
    let seconds = 0;
    let nanos = 0;
    for (let i = 0; i < dur.length;) {
        const tag = dur[i++] as number;
        const [v, next] = varint(dur, i);
        i = next;
        if (tag === 0x08) seconds = v;
        else if (tag === 0x10) nanos = v;
        else break;
    }
    return seconds * 1000 + Math.ceil(nanos / 1e6);
}

export function errorReason(err: ConnectError): string | null {
    const raw = detailOf(err, errorInfoType);
    if (!raw || raw[0] !== 0x0a) return null;
    const [len, start] = varint(raw, 1);
    return new TextDecoder().decode(raw.subarray(start, start + len));
}

// Turns a router failure into the error the agent sees, never echoing provider text
export function fromRouter(err: unknown, what: string): GatewayError {
    if (err instanceof GatewayError) return err;
    if (!(err instanceof ConnectError)) {
        return new GatewayError("internal", `${what} failed`);
    }
    switch (err.code) {
        case Code.NotFound:
            return new GatewayError(
                "not_found",
                `${what}: no sandbox has this handle. Check it was copied in full, or quote and ` +
                    "start a new one",
            );
        case Code.FailedPrecondition:
            if (errorReason(err) === "EXCEEDS_LIFETIME") {
                return new GatewayError(
                    "invalid",
                    `${what}: that would pass the longest time a sandbox can run`,
                );
            }
            return new GatewayError("not_ready", `${what}: ${safeMessage(err)}`);
        case Code.InvalidArgument:
            return new GatewayError("invalid", `${what}: ${safeMessage(err)}`);
        case Code.PermissionDenied:
            return new GatewayError("denied", `${what}: the order was refused`);
        case Code.ResourceExhausted: {
            if (errorReason(err) === "RATE_LIMITED") {
                const wait = retryDelayMs(err) ?? 1000;
                return new GatewayError(
                    "rate_limited",
                    `${what}: too many sandbox operations, wait ${Math.ceil(wait / 1000)} s`,
                    wait,
                );
            }
            return new GatewayError("no_capacity", `${what}: ${safeMessage(err)}`);
        }
        case Code.DeadlineExceeded:
            return new GatewayError("timeout", `${what}: timed out`);
        case Code.Unavailable:
            return new GatewayError("unavailable", `${what}: the sandbox service is unavailable`);
        default:
            return new GatewayError("internal", `${what} failed`);
    }
}

const providerNames = /\b(koyeb|boat|e2b|boxd|instabox|daytona)\b/gi;

// Router wording cut to one line, with any provider name scrubbed because callers never learn it
export function safeMessage(err: ConnectError): string {
    const first = err.rawMessage.split("\n")[0] ?? "";
    const text = first
        .replace(/\b(api|saga|jobs|streams|placement): /g, "")
        .replace(providerNames, "provider")
        .slice(0, 200);
    return text || "refused";
}
