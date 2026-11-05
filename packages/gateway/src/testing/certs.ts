import * as x509 from "@peculiar/x509";

export interface TestPair {
    cert: string;
    key: string;
}

const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

// A self-signed ECDSA certificate for the names, which a client can trust as its own CA
export async function selfSigned(
    names: string[],
    validity: { notBefore?: Date; notAfter?: Date } = {},
): Promise<TestPair> {
    const keys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
    const now = Date.now();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex"),
        name: `CN=${names[0] ?? "test"}`,
        notBefore: validity.notBefore ?? new Date(now - 60_000),
        notAfter: validity.notAfter ?? new Date(now + 90 * 86_400_000),
        signingAlgorithm: alg,
        keys,
        extensions: [
            new x509.BasicConstraintsExtension(false, undefined, true),
            new x509.SubjectAlternativeNameExtension(
                names.map((value) => ({ type: "dns", value })),
            ),
        ],
    });
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
    return { cert: cert.toString("pem"), key: x509.PemConverter.encode(pkcs8, "PRIVATE KEY") };
}

export interface TestCa {
    cert: string;
    // Signs a certificate for the request's key and names, as a CA finalising an order does
    issue(csrPem: string | Buffer, validity: { notBefore: Date; notAfter: Date }): Promise<string>;
}

export async function testCa(): Promise<TestCa> {
    const keys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
    const ca = await x509.X509CertificateGenerator.createSelfSigned({
        name: "CN=Bugnet test CA",
        notBefore: new Date(Date.now() - 86_400_000),
        notAfter: new Date(Date.now() + 3650 * 86_400_000),
        signingAlgorithm: alg,
        keys,
        extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
    });
    return {
        cert: ca.toString("pem"),
        async issue(csrPem, validity) {
            const csr = new x509.Pkcs10CertificateRequest(csrPem.toString());
            const san = csr.getExtension("2.5.29.17");
            const leaf = await x509.X509CertificateGenerator.create({
                subject: csr.subject,
                issuer: ca.subject,
                publicKey: csr.publicKey,
                signingKey: keys.privateKey,
                signingAlgorithm: alg,
                ...validity,
                extensions: [
                    new x509.BasicConstraintsExtension(false, undefined, true),
                    ...(san ? [san] : []),
                ],
            });
            return `${leaf.toString("pem")}\n${ca.toString("pem")}\n`;
        },
    };
}
