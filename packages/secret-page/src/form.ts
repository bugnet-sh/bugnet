/**
 * The form's rules, what a link may pre-fill and what the page sends.
 *
 * Only a preset's own hosts are ever pre-filled, so an injected agent cannot slip an attacker's
 * host into the form (data-plane 10.3). Names, hosts and header names are checked here the way
 * the router checks them, so most mistakes show next to their field before anything is sent.
 */
import {
    CanonicalError,
    canonicalHeaderName,
    canonicalHost,
    maxBoxBytes,
    maxValueBytes,
    namePattern,
    presetFor,
    presets,
    sealedBytes,
    valueBytes,
    type SecretSpec,
} from "@bugnet/seal";

export type Field = "name" | "value" | "hosts" | "headers";

export interface Problem {
    field: Field;
    message: string;
}

export interface Draft {
    name: string;
    value: string;
    hosts: string;
    headers: string;
    // The GitHub box, ticked to let code in the sandbox use the token too
    sandboxUse: boolean;
}

export type Checked = { ok: true; spec: SecretSpec } | { ok: false; problems: Problem[] };

export const maxHosts = 10;
export const maxHeaderNames = 8;
// Data-plane 10.9, larger values are stored but most upstreams refuse such headers
export const largeValueBytes = 8 * 1024;

export const knownNames: readonly string[] = presets.flatMap((p) => p.names);

export interface Prefill {
    name: string;
    hosts: string[];
    headerNames: string[];
}

// Hosts the router suggests count only when they are the name's preset, and otherwise the preset
export function prefill(suggested: SecretSpec): Prefill {
    const name = namePattern.test(suggested.name) ? suggested.name : "";
    const preset = presetFor(name);
    if (!preset) return { name, hosts: [], headerNames: [] };
    const kept = preset.hosts.filter((h) => suggested.hosts.includes(h));
    return {
        name,
        hosts: kept.length > 0 ? kept : [...preset.hosts],
        headerNames: [...preset.headerNames],
    };
}

// Data-plane 10.3's reserved names, which the router refuses with NAME_RESERVED
const reservedExact = new Set([
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "AWS_CA_BUNDLE",
    "BASH_ENV",
    "ENV",
]);
const reservedAnyCase = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);
const reservedPrefixes = [
    "LD_",
    "BUGNET_",
    "SSL_",
    "NODE_",
    "GIT_",
    "PIP_",
    "UV_",
    "DENO_",
    "npm_config_",
    "PYTHON",
    "__VITE_",
];

export function reservedName(name: string): boolean {
    return (
        reservedExact.has(name) ||
        reservedAnyCase.has(name.toUpperCase()) ||
        reservedPrefixes.some((p) => name.startsWith(p))
    );
}

// Data-plane 10.3's refused header names, which the router refuses with HEADER_REFUSED
const refusedHeaders = new Set([
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "upgrade",
    "te",
    "trailer",
    "cookie",
    "set-cookie",
    "referer",
    "user-agent",
    "origin",
    "forwarded",
    "via",
]);

export function refusedHeader(name: string): boolean {
    return refusedHeaders.has(name) || name.startsWith("proxy-") || name.startsWith("x-forwarded-");
}

export function splitList(text: string): string[] {
    return text.split(/[\s,]+/).filter((s) => s.length > 0);
}

export interface HostView {
    // As the proxy matches it, in lower-case punycode
    host: string;
    // The known service whose usual host it is, or null for a host the user typed
    service: string | null;
}

export function hostViews(hosts: readonly string[]): HostView[] {
    return hosts.map((host) => ({
        host,
        service: presets.find((p) => p.hosts.includes(host))?.service ?? null,
    }));
}

// Data-plane 10.7, FetchSource uses only a secret whose hosts include api.github.com
export const fetchHost = "api.github.com";

// Such a secret is fetch only unless the user lets the sandbox use it too
export function canFetchSource(hosts: readonly string[]): boolean {
    return hosts.includes(fetchHost);
}

function sortedUnique(values: string[]): string[] {
    return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface HostsRead {
    hosts: string[];
    problems: string[];
}

export function readHosts(text: string): HostsRead {
    const hosts: string[] = [];
    const problems: string[] = [];
    for (const entry of splitList(text)) {
        try {
            hosts.push(canonicalHost(entry));
        } catch (e) {
            problems.push(e instanceof CanonicalError ? `${e.message}.` : `${entry} is not valid.`);
        }
    }
    return { hosts: sortedUnique(hosts), problems };
}

function readHeaders(text: string): { names: string[]; problems: string[] } {
    const names: string[] = [];
    const problems: string[] = [];
    for (const entry of splitList(text)) {
        let name: string;
        try {
            name = canonicalHeaderName(entry);
        } catch (e) {
            problems.push(e instanceof CanonicalError ? `${e.message}.` : `${entry} is not valid.`);
            continue;
        }
        if (name === "authorization") continue;
        if (refusedHeader(name)) {
            problems.push(`${name} cannot carry a secret.`);
            continue;
        }
        names.push(name);
    }
    return { names: sortedUnique(names), problems };
}

function kib(bytes: number): string {
    return `${Math.ceil(bytes / 1024)} KiB`;
}

export function check(draft: Draft): Checked {
    const problems: Problem[] = [];
    const name = draft.name.trim();
    if (name.length === 0) {
        problems.push({ field: "name", message: "Give the secret a name, such as HF_TOKEN." });
    } else if (!namePattern.test(name)) {
        problems.push({
            field: "name",
            message:
                "Use letters, digits and _ only, up to 64 characters, not starting with a digit.",
        });
    } else if (reservedName(name)) {
        problems.push({
            field: "name",
            message:
                "This name is reserved, because the sandbox's own tools rely on it. Choose " +
                "another, such as MY_API_TOKEN.",
        });
    }

    const bytes = valueBytes(draft.value);
    if (bytes === 0) {
        problems.push({ field: "value", message: "Paste the secret's value." });
    } else if (bytes > maxValueBytes) {
        problems.push({
            field: "value",
            message: `The value is ${kib(bytes)}, and up to ${kib(maxValueBytes)} fit.`,
        });
    }

    const hosts = readHosts(draft.hosts);
    for (const message of hosts.problems) problems.push({ field: "hosts", message });
    if (hosts.problems.length === 0 && hosts.hosts.length === 0) {
        problems.push({
            field: "hosts",
            message: "Add at least one host, such as huggingface.co.",
        });
    } else if (hosts.hosts.length > maxHosts) {
        problems.push({ field: "hosts", message: `Up to ${maxHosts} hosts fit in one secret.` });
    }

    const headers = readHeaders(draft.headers);
    for (const message of headers.problems) problems.push({ field: "headers", message });
    if (headers.names.length > maxHeaderNames) {
        problems.push({
            field: "headers",
            message: `Up to ${maxHeaderNames} extra headers fit in one secret.`,
        });
    }

    if (problems.length > 0) return { ok: false, problems };
    const spec: SecretSpec = {
        name,
        hosts: hosts.hosts,
        headerNames: headers.names,
        fetchOnly: canFetchSource(hosts.hosts) && !draft.sandboxUse,
    };
    if (sealedBytes(spec, draft.value) > maxBoxBytes) {
        const message =
            "This value is too large once sealed, because quotes, backslashes and control " +
            "characters take more room. Up to 64 KiB of plain text fit.";
        return { ok: false, problems: [{ field: "value", message }] };
    }
    return { ok: true, spec };
}

// Things worth a second look that the router would still accept
export function valueNotes(value: string): string[] {
    const notes: string[] = [];
    if (valueBytes(value) > largeValueBytes) {
        notes.push(
            "This value is over 8 KiB. Bugnet stores it, but most services refuse headers that " +
                "large.",
        );
    }
    if (value.length > 0 && value.trim() !== value) {
        notes.push("The value starts or ends with a space, which tokens rarely do.");
    }
    return notes;
}
