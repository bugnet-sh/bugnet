/**
 * The page's two calls to the secrets route, in the JSON of data-plane 8.4.
 *
 * The link token travels only in the path. Requests stay same-origin and carry no credentials,
 * so a preview that filled the bugnet.sh cookie jar adds nothing to them.
 */
import type { Sealed } from "@bugnet/seal";
import { AnswerError, parseLink, parseSubmit, type LinkInfo, type SecretAnswer } from "./link.ts";
import { answerProblem, networkProblem, routeProblem, type PageProblem } from "./errors.ts";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class RouteFailure extends Error {
    readonly problem: PageProblem;

    constructor(problem: PageProblem) {
        super(problem.message);
        this.problem = problem;
    }
}

// Data-plane 4.4, bnsl_ and 16 bytes in base64url without padding
const tokenPattern = /^bnsl_[A-Za-z0-9_-]{22}$/;

export function tokenFromPath(pathname: string): string | null {
    const m = /^\/l\/([^/]+)\/?$/.exec(pathname);
    if (!m) return null;
    let token: string;
    try {
        token = decodeURIComponent(m[1] as string);
    } catch {
        return null;
    }
    return tokenPattern.test(token) ? token : null;
}

const getTimeoutMs = 30_000;
// The router waits up to 15 s for the secret to become active before it answers
const putTimeoutMs = 60_000;

async function call(
    fetchFn: Fetch,
    method: "GET" | "PUT",
    path: string,
    timeoutMs: number,
    body?: unknown,
): Promise<unknown> {
    let res: Response;
    try {
        res = await fetchFn(path, {
            method,
            headers: { accept: "application/json", "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            mode: "same-origin",
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        throw new RouteFailure(networkProblem);
    }
    let text: string;
    try {
        text = await res.text();
    } catch {
        throw new RouteFailure(networkProblem);
    }
    if (!res.ok) {
        throw new RouteFailure(routeProblem(res.status, text, res.headers.get("retry-after")));
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new RouteFailure(answerProblem);
    }
}

function read<T>(parse: (doc: unknown) => T, doc: unknown): T {
    try {
        return parse(doc);
    } catch (e) {
        if (e instanceof AnswerError) throw new RouteFailure(answerProblem);
        throw e;
    }
}

function linkPath(token: string): string {
    return `/v1/links/${encodeURIComponent(token)}`;
}

export async function getLink(fetchFn: Fetch, token: string): Promise<LinkInfo> {
    return read(parseLink, await call(fetchFn, "GET", linkPath(token), getTimeoutMs));
}

// Field for field the body of data-plane 8.4, since the route refuses unknown fields
export function submitBody(sealed: Sealed, submissionId: string): unknown {
    return {
        spec: {
            name: sealed.spec.name,
            hosts: sealed.spec.hosts,
            headerNames: sealed.spec.headerNames,
            fetchOnly: sealed.spec.fetchOnly,
        },
        value: { keyId: sealed.value.keyId, box: sealed.value.box },
        submissionId,
    };
}

export async function submitSecret(
    fetchFn: Fetch,
    token: string,
    sealed: Sealed,
    submissionId: string,
): Promise<SecretAnswer> {
    const body = submitBody(sealed, submissionId);
    const doc = await call(fetchFn, "PUT", `${linkPath(token)}/secret`, putTimeoutMs, body);
    return read(parseSubmit, doc);
}
