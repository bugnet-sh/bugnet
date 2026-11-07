import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ServerContext } from "@modelcontextprotocol/server";
import {
    X402ServiceState,
    type X402Refusal,
    type X402ServiceInfo,
    type X402ServiceSpecSchema,
} from "../gen/bugnet/router/v1/router_pb.ts";
import type { X402Account, X402AccountService } from "../payments/port.ts";
import {
    errorMetadata,
    fromRouter,
    GatewayError,
    reasonCode,
    reasonOf,
    waitMargin,
    x402OffText,
} from "../router.ts";
import { hashKey, idempotencyKey, type Deps } from "../tools/common.ts";
import { serviceIdPattern, type ServiceLineParts } from "./lines.ts";

export type ServiceSpecInit = MessageInitShape<typeof X402ServiceSpecSchema>;

export function toServiceSpec(line: ServiceLineParts, indexed: boolean): ServiceSpecInit {
    return {
        host: line.host,
        prefix: line.prefix,
        method: line.method,
        maxPriceMicros: BigInt(line.maxMicros),
        payTo: line.payTo,
        indexed,
        paidPath: indexed ? "" : line.path,
    };
}

export function pinToServiceSpec(s: X402AccountService): ServiceSpecInit {
    return {
        host: s.host,
        prefix: s.prefix,
        method: s.method,
        maxPriceMicros: BigInt(s.maxPriceMicros),
        payTo: s.payTo,
        indexed: s.listed === "indexed",
        paidPath: s.paidPath ?? "",
    };
}

export function viewChanges(account: X402Account | null): {
    add: ServiceSpecInit[];
    disable: string[];
} {
    const services = account?.services ?? [];
    return {
        add: services.filter((s) => s.state === "enabled").map(pinToServiceSpec),
        disable: services.filter((s) => s.state === "disabled").map((s) => s.serviceId),
    };
}

const printableId = /^[\x21-\x7e]{1,128}$/;

export function enableRequestId(ctx: ServerContext, parts: readonly string[]): string {
    const key = idempotencyKey(ctx, parts);
    return printableId.test(key) ? key : hashKey(parts);
}

export const routerReasonWords: Readonly<Record<string, string>> = {
    HOST_REFUSED: "Bugnet does not route to this host",
    HOST_NOT_ALLOWED: "this sandbox's package limits the hosts it reaches",
    HOST_IN_USE: "it already carries one of the user's keys in this sandbox",
    PREFIX_REFUSED: "its path or prefix has a shape Bugnet does not forward",
    SERVICE_DUPLICATE: "the same service is named twice",
    METHOD_REFUSED: "only GET and POST are paid",
    PRICE_REFUSED: "the price cap is not between $0 and $0.50",
    PAYTO_REFUSED: "the payee is not a Solana address",
    TOO_MANY_SECRETS: "the sandbox already routes 32 hosts",
    SERVICE_UNKNOWN: "no service with that id in this sandbox",
};

export const failureWords: Readonly<Record<string, string>> = {
    PORT_443_TAKEN:
        "a program in the sandbox holds port 443. Stop it, then send the same service line " +
        "with amountUsd 0 to enable it again",
    FEATURE_UNAVAILABLE:
        "this sandbox cannot route x402 calls. Unspent allowance comes back when it ends",
    HOST_BLOCKED: "Bugnet blocked this host, so calls to it are neither sent nor paid",
};

export function routerReasonText(reason: string): string {
    const c = reasonCode(reason);
    return Object.hasOwn(routerReasonWords, c)
        ? (routerReasonWords[c] as string)
        : `Bugnet's rule ${c}`;
}

export function failureText(failure: string): string {
    const c = reasonCode(failure);
    return Object.hasOwn(failureWords, c)
        ? (failureWords[c] as string)
        : `the setup failed (${c}). Send the same service line with amountUsd 0 to try again`;
}

export type X402What = "x402" | "start";
export type ViewState = "applying" | "active" | "failed" | "disabled";

export function routerState(s: X402ServiceState): ViewState {
    if (s === X402ServiceState.ACTIVE) return "active";
    if (s === X402ServiceState.FAILED) return "failed";
    if (s === X402ServiceState.DISABLED) return "disabled";
    return "applying";
}

// The add entry a per-service refusal names in its ErrorInfo metadata, each null when absent or odd
export function x402RefusalTarget(err: unknown): {
    serviceId: string | null;
    host: string | null;
} {
    if (!(err instanceof ConnectError)) return { serviceId: null, host: null };
    const m = errorMetadata(err);
    const id = m.service_id;
    const host = m.host;
    return {
        serviceId: id !== undefined && serviceIdPattern.test(id) ? id : null,
        host: host !== undefined && /^[a-z0-9.-]{1,253}$/.test(host) ? host : null,
    };
}

export const routerRows = {
    switchedOff: (what: X402What) => `${what}: ${x402OffText}`,
    notCapable: (what: X402What) =>
        `${what}: this sandbox cannot use x402 services. A sandbox started from a quote with ` +
        'needs ["secrets"] can, and the other Bugnet tools work here as usual',
    ended: (what: X402What) =>
        `${what}: this sandbox has ended and everything in it was deleted. ` +
        "Quote and start a new one",
    tooManyServices: (what: X402What, maxServices: number) =>
        `${what}: a sandbox takes at most ${maxServices} services. Disable one first, ` +
        "bugnet_status lists their ids",
    routerRefused: (what: X402What, hosts: readonly string[], words: string) =>
        hosts.length > 0
            ? `${what}: ${hosts.join(", ")} cannot be enabled (${words}). Nothing was charged`
            : `${what}: Bugnet cannot make this change (${words}). Nothing was charged`,
} as const;

// Spec 6.2 gives each of these reasons one Connect code
const ownCode: Readonly<Record<string, Code>> = {
    X402_DISABLED: Code.FailedPrecondition,
    FEATURE_UNAVAILABLE: Code.FailedPrecondition,
    NOT_READY: Code.FailedPrecondition,
    TOO_MANY_SERVICES: Code.ResourceExhausted,
};

export function x402RouterError(
    err: unknown,
    what: X402What,
    hosts: readonly string[],
    maxServices: number,
): GatewayError {
    if (err instanceof GatewayError) return err;
    const reason = reasonOf(err);
    if (reason === null || reason === "HANDLE_UNKNOWN" || reason === "RATE_LIMITED") {
        return fromRouter(err, what);
    }
    const own = ownCode[reason];
    if (own !== undefined && err instanceof ConnectError && own !== err.code)
        return fromRouter(err, what);
    switch (reason) {
        case "X402_DISABLED":
            return new GatewayError("precondition", routerRows.switchedOff(what), null, reason);
        case "FEATURE_UNAVAILABLE":
            return new GatewayError("unsupported", routerRows.notCapable(what), null, reason);
        case "NOT_READY":
            return new GatewayError("expired", routerRows.ended(what), null, reason);
        case "TOO_MANY_SERVICES":
            return new GatewayError(
                "limit",
                routerRows.tooManyServices(what, maxServices),
                null,
                reason,
            );
    }
    const base = fromRouter(err, what);
    const host = x402RefusalTarget(err).host;
    return new GatewayError(
        base.kind,
        routerRows.routerRefused(what, host ? [host] : hosts, routerReasonText(reason)),
        base.retryAfterMs,
        reason,
    );
}

// The router's secrets.apply_wait plus the long-poll margin
export const enableWaitMs = 15_000 + waitMargin;

export async function checkServices(
    deps: Deps,
    req: { handle: string; add: ServiceSpecInit[]; disable: string[] },
    signal: AbortSignal,
): Promise<void> {
    await deps.router.checkX402(
        { handle: req.handle, add: req.add, disable: req.disable },
        { signal },
    );
}

export async function enableServices(
    deps: Deps,
    req: {
        handle: string;
        add: ServiceSpecInit[];
        disable: string[];
        requestId: string;
        waitActive: boolean;
    },
    signal: AbortSignal,
): Promise<X402ServiceInfo[]> {
    const r = await deps.router.enableX402(
        {
            handle: req.handle,
            add: req.add,
            disable: req.disable,
            requestId: req.requestId,
            waitActive: req.waitActive,
        },
        { signal },
    );
    return r.services;
}

export async function listServices(
    deps: Deps,
    handle: string,
    signal: AbortSignal,
): Promise<{ enabled: boolean; services: X402ServiceInfo[]; refusals: X402Refusal[] }> {
    const r = await deps.router.listX402({ handle }, { signal });
    return { enabled: r.enabled, services: r.services, refusals: r.refusals };
}
