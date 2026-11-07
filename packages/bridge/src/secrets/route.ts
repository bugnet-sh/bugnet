// The grant rides only in Authorization and no Origin is sent, as the route's bridge calls require
import { z } from "zod";
import { failureCode, type SealedValue, type SealingKey, type SecretSpec } from "@bugnet/seal";

export interface RouteOptions {
    baseUrl: string;
    timeoutMs: number;
    fetch?: typeof fetch;
}

export class RouteError extends Error {
    readonly reason: string;
    readonly retryAfterSeconds: number | null;

    constructor(message: string, reason: string, retryAfterSeconds: number | null = null) {
        super(message);
        this.reason = reason;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

const sealingKeysSchema = z.object({
    sealingKeys: z.array(
        z.object({
            keyId: z.string().max(100),
            publicKey: z.string().max(200),
            binding: z.string().max(200),
        }),
    ),
});

const secretSchema = z.object({
    spec: z.object({
        name: z.string(),
        hosts: z.array(z.string()).default([]),
        headerNames: z.array(z.string()).default([]),
        fetchOnly: z.boolean().default(false),
    }),
    state: z.enum(["APPLYING", "ACTIVE", "FAILED"]),
    updatedAt: z.string().optional(),
    failureReason: z.string().default("").transform(failureCode),
});

const putAnswerSchema = z.object({ secret: secretSchema, replaced: z.boolean().default(false) });

export type PutAnswer = z.infer<typeof putAnswerSchema>;

const errorSchema = z.object({ error: z.string().max(100), message: z.string().optional() });

// The route's lower-case reasons from data-plane 11.3, said the way the gateway says them
const reasons: Record<string, string> = {
    put_grant_invalid: "the put grant expired, a new bugnet_secret_from_env call gets a new one",
    grant_unknown: "the put grant expired, a new bugnet_secret_from_env call gets a new one",
    not_ready: "the sandbox is not ready or has ended, bugnet_status shows its state",
    feature_unavailable: "secrets are not open on this sandbox yet, the other Bugnet tools work",
    name_reserved: "that secret name is reserved, another name works",
    host_refused: "a secret cannot be sent to one of those hosts",
    host_not_allowed: "secrets for one of those hosts are not allowed",
    host_in_use:
        "x402 pays for one of those hosts in this sandbox. Stop paying it with " +
        "bugnet_x402_budget (disable, amountUsd 0), then send the secret again",
    header_refused: "a secret cannot go in one of those headers",
    sealed_too_large: "the secret is too large",
    key_unknown: "the sealing key is no longer current",
    too_many_secrets: "the sandbox holds as many secrets, hosts or headers as it may",
    rate_limited: "too many requests for now",
};

const byStatus: Record<number, string> = {
    400: "the secrets route refused the request",
    401: "the put grant was refused, a new bugnet_secret_from_env call gets a new one",
    404: "the secrets route does not know this sandbox",
    409: "the sandbox cannot take secrets right now",
    429: "too many requests for now",
    503: "the secrets route is unavailable, a retry in a minute may work",
};

function retryAfter(res: Response): number | null {
    const v = res.headers.get("retry-after");
    if (!v || !/^\d{1,6}$/.test(v)) return null;
    return Number(v);
}

async function failure(res: Response): Promise<RouteError> {
    let reason = "";
    try {
        const body = errorSchema.safeParse(JSON.parse(await res.text()));
        if (body.success) reason = body.data.error;
    } catch {
        // A body that is not the route's error JSON still has a status to go by
    }
    const known = Object.hasOwn(reasons, reason) ? reasons[reason] : undefined;
    const text = known ?? byStatus[res.status] ?? `the secrets route answered ${res.status}`;
    const wait = retryAfter(res) ?? (res.status === 429 ? 1 : null);
    return new RouteError(text, reason || `http_${res.status}`, wait);
}

async function call(
    opts: RouteOptions,
    method: "GET" | "PUT",
    path: string,
    grant: string,
    signal: AbortSignal,
    body?: unknown,
): Promise<unknown> {
    const doFetch = opts.fetch ?? fetch;
    const url = new URL(path, opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`);
    let res: Response;
    try {
        res = await doFetch(url, {
            method,
            headers: {
                authorization: `Bearer ${grant}`,
                accept: "application/json",
                ...(body !== undefined ? { "content-type": "application/json" } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs)]),
        });
    } catch {
        throw new RouteError("the secrets route did not answer", "unreachable");
    }
    if (!res.ok) throw await failure(res);
    try {
        return JSON.parse(await res.text());
    } catch {
        throw new RouteError("the secrets route gave an answer the bridge cannot read", "bad_json");
    }
}

function parsed<T>(schema: z.ZodType<T>, doc: unknown): T {
    const r = schema.safeParse(doc);
    if (!r.success) {
        throw new RouteError("the secrets route gave an answer the bridge cannot read", "bad_json");
    }
    return r.data;
}

export async function getSealingKeys(
    opts: RouteOptions,
    grant: string,
    signal: AbortSignal,
): Promise<SealingKey[]> {
    const doc = await call(opts, "GET", "v1/sealing-key", grant, signal);
    return parsed(sealingKeysSchema, doc).sealingKeys;
}

export async function putSecret(
    opts: RouteOptions,
    grant: string,
    spec: SecretSpec,
    value: SealedValue,
    idempotencyKey: string,
    signal: AbortSignal,
): Promise<PutAnswer> {
    const body = {
        spec: {
            name: spec.name,
            hosts: spec.hosts,
            headerNames: spec.headerNames,
            fetchOnly: spec.fetchOnly,
        },
        value: { keyId: value.keyId, box: value.box },
        idempotencyKey,
    };
    const path = `v1/secrets/${encodeURIComponent(spec.name)}`;
    const doc = await call(opts, "PUT", path, grant, signal, body);
    return parsed(putAnswerSchema, doc);
}
