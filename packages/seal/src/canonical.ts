// The router and the egress proxy compare these forms exactly, so the page and the bridge share them

export class CanonicalError extends Error {}

export interface SecretSpec {
    name: string;
    hosts: string[];
    headerNames: string[];
    fetchOnly: boolean;
}

export const namePattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const maxHostLength = 253;
const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
// Anything that would make the URL parser read a scheme, credentials, port, path or query
const notBareHost = /[\s/\\:@?#%[\]*,;"'<>^`{|}\p{Cc}]/u;
const token = /^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/;

function shown(s: string): string {
    return JSON.stringify(s.length > 80 ? `${s.slice(0, 80)}...` : s);
}

// The WHATWG URL parser applies UTS 46, so it lower-cases and punycodes like the browser does
function toAscii(host: string): string {
    try {
        return new URL(`http://${host}/`).hostname;
    } catch {
        throw new CanonicalError(`${shown(host)} is not a valid host name`);
    }
}

export function canonicalHost(input: string): string {
    if (input.length === 0 || input.length > maxHostLength + 1) {
        throw new CanonicalError(`${shown(input)} is not a valid host name`);
    }
    if (notBareHost.test(input)) {
        throw new CanonicalError(
            `${shown(input)} is not a bare host name. Give it without scheme, port, path or ` +
                "wildcard, as in huggingface.co",
        );
    }
    let host = toAscii(input.toLowerCase());
    if (host.endsWith(".")) host = host.slice(0, -1);
    const labels = host.split(".");
    if (host.length > maxHostLength || labels.length < 2 || !labels.every((l) => label.test(l))) {
        throw new CanonicalError(`${shown(input)} is not a valid host name`);
    }
    if (/^[0-9]+$/.test(labels[labels.length - 1] as string)) {
        throw new CanonicalError(`${shown(input)} is an IP address, secrets go to host names only`);
    }
    return host;
}

function sortedUnique(values: string[]): string[] {
    return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function canonicalHosts(hosts: readonly string[]): string[] {
    return sortedUnique(hosts.map(canonicalHost));
}

export function canonicalHeaderName(input: string): string {
    const name = input.toLowerCase();
    if (!token.test(name)) {
        throw new CanonicalError(`${shown(input)} is not a valid header name`);
    }
    return name;
}

export function canonicalHeaderNames(names: readonly string[]): string[] {
    return sortedUnique(names.map(canonicalHeaderName));
}

export function canonicalSpec(spec: SecretSpec): SecretSpec {
    if (!namePattern.test(spec.name)) {
        throw new CanonicalError(
            `${shown(spec.name)} is not a valid secret name, which is letters, digits and _ ` +
                "and does not start with a digit",
        );
    }
    const hosts = canonicalHosts(spec.hosts);
    if (hosts.length === 0) throw new CanonicalError("a secret needs at least one host");
    return {
        name: spec.name,
        hosts,
        headerNames: canonicalHeaderNames(spec.headerNames),
        fetchOnly: spec.fetchOnly,
    };
}
