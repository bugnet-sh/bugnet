/**
 * Plain sentences for every way the secrets route can refuse (data-plane 8.4 and 11.3).
 *
 * The route's own message is never shown. Only the lower-case reason and the status choose a
 * fixed sentence, so a compromised server cannot put words of its own on a page whose job is to
 * warn.
 */

export interface PageProblem {
    // The route's reason, or a page code such as network, shown small for support
    code: string;
    message: string;
    // The link can no longer be used, so the form goes away
    final: boolean;
    // Trying the same thing again may work
    retry: boolean;
}

const newLink = "Ask your agent for a new link.";

interface Known {
    message: string;
    final?: boolean;
    retry?: boolean;
}

const reasons: Record<string, Known> = {
    link_unknown: {
        message:
            "This link is unknown, already used or expired. Each link works once, for 10 " +
            `minutes. ${newLink}`,
        final: true,
    },
    link_locked: {
        message: `This link is locked after too many refused tries. ${newLink}`,
        final: true,
    },
    token_invalid: {
        message: `This link is incomplete or no longer valid. ${newLink}`,
        final: true,
    },
    not_ready: {
        message:
            "The sandbox is not ready, or it has ended and everything in it was deleted. Ask " +
            "your agent to check it.",
        final: true,
    },
    feature_unavailable: {
        message:
            "This sandbox cannot hold secrets. Your agent can start one that can, and nothing " +
            "was sent.",
        final: true,
    },
    name_reserved: {
        message:
            "That name is reserved, because the sandbox's own tools rely on it. Choose another " +
            "name.",
    },
    host_refused: {
        message:
            "Bugnet does not send secrets to one of these hosts. Public suffixes, shared " +
            "hosting domains, Bugnet's own names and the domains of the platforms that run " +
            "sandboxes are refused.",
    },
    host_not_allowed: {
        message:
            "One of these hosts is not allowed for this sandbox right now. The usual hosts of " +
            "known services, such as huggingface.co for HF_TOKEN, still work.",
    },
    header_refused: {
        message:
            "One of these header names cannot carry a secret. The value always goes in " +
            "Authorization, so most services need no extra header.",
    },
    sealed_too_large: { message: "The secret is too large. Values up to 64 KiB fit." },
    key_unknown: {
        message:
            "Bugnet's sealing key changed while this page was open. Reload the page and type " +
            "the secret again.",
    },
    too_many_secrets: {
        message:
            "This sandbox holds as many secrets as it may, which is 20 secrets, 10 hosts each, " +
            "32 hosts in all and 8 extra headers each. Ask your agent to delete one first.",
    },
    rate_limited: { message: "Too many tries for now. Wait a minute and try again.", retry: true },
};

const byStatus: Record<number, Known> = {
    400: {
        message:
            "Bugnet refused the request as malformed. Reload the page and try again, and if it " +
            `keeps failing, ${newLink.toLowerCase()}`,
    },
    401: reasons.token_invalid as Known,
    403: {
        message: "Bugnet refused a request from this page. Open the link again from the chat.",
        final: true,
    },
    404: reasons.link_unknown as Known,
    409: { message: "The sandbox cannot take secrets right now. Ask your agent to check it." },
    413: { message: "The request is too large. Values up to 64 KiB fit." },
    429: reasons.rate_limited as Known,
    503: { message: "Bugnet is busy or restarting. Try again in a minute.", retry: true },
};

function seconds(retryAfter: string | null): number | null {
    if (!retryAfter || !/^\d{1,5}$/.test(retryAfter)) return null;
    return Number(retryAfter);
}

function waitNote(s: number | null): string {
    if (s === null || s === 0) return "";
    return s < 120 ? ` Wait ${s} seconds first.` : ` Wait ${Math.ceil(s / 60)} minutes first.`;
}

export function reasonOf(body: string): string {
    try {
        const doc: unknown = JSON.parse(body);
        if (typeof doc === "object" && doc !== null && "error" in doc) {
            const error = (doc as { error: unknown }).error;
            if (typeof error === "string" && /^[a-z0-9_]{1,64}$/.test(error)) return error;
        }
    } catch {
        // A body that is not the route's error JSON still has a status to go by
    }
    return "";
}

export function routeProblem(status: number, body: string, retryAfter: string | null): PageProblem {
    const reason = reasonOf(body);
    const known =
        (Object.hasOwn(reasons, reason) ? reasons[reason] : undefined) ?? byStatus[status];
    const code = reason || `http_${status}`;
    if (!known) {
        return {
            code,
            message: `Something went wrong at Bugnet (status ${status}). Try again in a minute.`,
            final: false,
            retry: true,
        };
    }
    const retry = known.retry === true;
    return {
        code,
        message: known.message + (retry ? waitNote(seconds(retryAfter)) : ""),
        final: known.final === true,
        retry,
    };
}

export const networkProblem: PageProblem = {
    code: "network",
    message:
        "Bugnet did not answer. Check your connection and try again. Trying again is safe, " +
        "because Bugnet stores a secret from this page at most once.",
    final: false,
    retry: true,
};

export const answerProblem: PageProblem = {
    code: "bad_answer",
    message: "Bugnet gave an answer this page cannot read. Reload the page and try again.",
    final: false,
    retry: true,
};

export const noTokenProblem: PageProblem = {
    code: "no_token",
    message:
        "This link is incomplete. Copy the whole link from the chat, or ask your agent for a " +
        "new link.",
    final: true,
    retry: false,
};

// The page refuses before anything is typed, since it would have nothing safe to seal to
export const keyProblem: PageProblem = {
    code: "key_not_pinned",
    message:
        "Do not enter a secret here. This page seals secrets only to keys built into it, and " +
        "Bugnet offered none of them. Reload in a few minutes, and if this stays, tell your " +
        "agent that the secret page refused Bugnet's sealing key.",
    final: true,
    retry: false,
};

export const sealProblem: PageProblem = {
    code: "seal_failed",
    message:
        "This browser could not seal the secret, so nothing was sent. Reload the page and try " +
        "again.",
    final: false,
    retry: false,
};

export const pageProblem: PageProblem = {
    code: "page_error",
    message: "Something went wrong on this page. Reload it and try again.",
    final: false,
    retry: false,
};

// Codes a stored secret can fail with, data-plane 10.10 and 10.12.5.4
const failures: Record<string, string> = {
    PORT_443_TAKEN: "port 443 in the sandbox is taken, and secrets need it",
    SOURCE_UNKNOWN: "this sandbox cannot use secrets, and a new sandbox can",
};

export function failureText(reason: string): string {
    return failures[reason] ?? "the sandbox could not take it";
}
