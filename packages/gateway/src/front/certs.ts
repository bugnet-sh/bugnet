import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSecureContext, type SecureContext } from "node:tls";

export const minVersion = "TLSv1.2";

export interface CertPair {
    context: SecureContext;
    names: string[];
    notBefore: Date;
    notAfter: Date;
    sha256: string;
}

export function secureContext(cert: string | Buffer, key: string | Buffer): SecureContext {
    return createSecureContext({ cert, key, minVersion });
}

// Throws when the key does not belong to the certificate, which is the first in the chain
export function loadPair(cert: string | Buffer, key: string | Buffer): CertPair {
    const context = secureContext(cert, key);
    const leaf = new X509Certificate(cert);
    const names = (leaf.subjectAltName ?? "")
        .split(", ")
        .filter((n) => n.startsWith("DNS:"))
        .map((n) => n.slice(4).toLowerCase());
    return {
        context,
        names,
        notBefore: leaf.validFromDate,
        notAfter: leaf.validToDate,
        sha256: leaf.fingerprint256.replaceAll(":", "").toLowerCase(),
    };
}

// The front's certificate from two PEM files, and the TLS-ALPN-01 challenge answers in flight
export class CertStore {
    private pair: CertPair | undefined;
    private readonly challenges = new Map<string, SecureContext>();

    constructor(
        readonly certFile: string,
        readonly keyFile: string,
    ) {}

    get current(): CertPair | undefined {
        return this.pair;
    }

    // A pair that fails to load leaves the one in use in place
    reload(): CertPair {
        const pair = loadPair(readFileSync(this.certFile), readFileSync(this.keyFile));
        this.pair = pair;
        return pair;
    }

    challenge(name: string): SecureContext | undefined {
        return this.challenges.get(name.toLowerCase());
    }

    setChallenge(name: string, context: SecureContext): void {
        this.challenges.set(name.toLowerCase(), context);
    }

    clearChallenge(name: string): void {
        this.challenges.delete(name.toLowerCase());
    }
}
