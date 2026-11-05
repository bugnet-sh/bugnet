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
