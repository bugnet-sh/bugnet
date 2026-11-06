// The router parses keys again, this gives an early refusal and stops a pasted private key here
import { createHash, createPublicKey } from "node:crypto";

export const keyTypes = [
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-rsa",
] as const;

export type KeyType = (typeof keyTypes)[number];

export const minRsaBits = 3072;
const maxRsaBits = 16384;

export interface PublicKey {
    type: KeyType;
    bits: number;
    // The type and the base64 body, without the comment
    line: string;
    fingerprint: string;
}

export class KeyError extends Error {
    constructor(
        message: string,
        readonly privateKey = false,
    ) {
        super(message);
    }
}

const curves: Record<string, { name: string; crv: string; size: number }> = {
    "ecdsa-sha2-nistp256": { name: "nistp256", crv: "P-256", size: 32 },
    "ecdsa-sha2-nistp384": { name: "nistp384", crv: "P-384", size: 48 },
    "ecdsa-sha2-nistp521": { name: "nistp521", crv: "P-521", size: 66 },
};

// PEM and PuTTY private keys, and the base64 of an OpenSSH private key's openssh-key-v1 magic
const privateMarks = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
    /PuTTY-User-Key-File-/,
    /b3BlbnNzaC1rZXktdjE/,
];

const privateKeyText =
    "publicKey holds a PRIVATE key, so it was refused and sent nowhere. A private key never " +
    "needs to leave its machine. The public key is the one line of the matching .pub file, and " +
    "ssh-keygen -y -f <key file> prints it";

const acceptedText =
    "ssh-ed25519, ecdsa-sha2-nistp256/384/521 or ssh-rsa of 3072 bits or more is accepted";

export function isKeyType(s: string): s is KeyType {
    return (keyTypes as readonly string[]).includes(s);
}

class Wire {
    private at = 0;

    constructor(private readonly buf: Buffer) {}

    string(): Buffer {
        if (this.at + 4 > this.buf.length) throw new KeyError("the key data is cut short");
        const n = this.buf.readUInt32BE(this.at);
        if (this.at + 4 + n > this.buf.length) throw new KeyError("the key data is cut short");
        const out = this.buf.subarray(this.at + 4, this.at + 4 + n);
        this.at += 4 + n;
        return out;
    }

    end(): void {
        if (this.at !== this.buf.length) throw new KeyError("the key data has extra bytes");
    }
}

function bitLength(b: Buffer): number {
    let i = 0;
    while (i < b.length && b[i] === 0) i++;
    if (i === b.length) return 0;
    return (b.length - i - 1) * 8 + (32 - Math.clz32(b[i] as number));
}

// An SSH mpint is two's complement, so a positive value with the top bit set has a leading zero
function positive(b: Buffer, what: string): Buffer {
    if (b.length === 0 || ((b[0] as number) & 0x80) !== 0) {
        throw new KeyError(`the RSA ${what} is not a positive number`);
    }
    return b;
}

function checkEd25519(w: Wire): number {
    if (w.string().length !== 32) throw new KeyError("the ed25519 key is not 32 bytes");
    w.end();
    return 256;
}

function checkEcdsa(type: string, w: Wire): number {
    const curve = curves[type] as { name: string; crv: string; size: number };
    if (w.string().toString("latin1") !== curve.name) {
        throw new KeyError("the ecdsa key names another curve than its type");
    }
    const q = w.string();
    w.end();
    if (q.length !== 1 + 2 * curve.size || q[0] !== 0x04) {
        throw new KeyError("the ecdsa key's point is malformed");
    }
    const x = q.subarray(1, 1 + curve.size).toString("base64url");
    const y = q.subarray(1 + curve.size).toString("base64url");
    try {
        createPublicKey({ key: { kty: "EC", crv: curve.crv, x, y }, format: "jwk" });
    } catch {
        throw new KeyError("the ecdsa key's point is not on its curve");
    }
    return curve.size === 66 ? 521 : curve.size * 8;
}

function checkRsa(w: Wire): number {
    const e = positive(w.string(), "exponent");
    const n = positive(w.string(), "modulus");
    w.end();
    const eBits = bitLength(e);
    // x/crypto/ssh refuses an exponent over 24 bits, under 3 or even
    if (eBits > 24 || eBits < 2 || ((e[e.length - 1] as number) & 1) === 0) {
        throw new KeyError("the RSA exponent is not accepted");
    }
    const bits = bitLength(n);
    if (bits < minRsaBits) {
        throw new KeyError(
            `the RSA key has ${bits} bits and ${minRsaBits} or more are needed, ` +
                "ssh-keygen -t ed25519 makes a key that is accepted",
        );
    }
    if (bits > maxRsaBits) throw new KeyError(`the RSA key is over ${maxRsaBits} bits`);
    return bits;
}

function typeRefusal(type: string, fields: string[]): KeyError {
    if (fields.length === 1 && (/^[~/.$]/.test(type) || type.endsWith(".pub"))) {
        return new KeyError("publicKey is the text inside the .pub file, not the file's path");
    }
    if (type.includes("-cert-v01@openssh.com")) {
        return new KeyError(`certificates are not accepted, a plain key is. ${acceptedText}`);
    }
    if (type === "ssh-dss") return new KeyError(`DSA keys are not accepted. ${acceptedText}`);
    if (type.startsWith("sk-")) {
        return new KeyError(
            "security key (sk-) keys need the hardware key at every login, so they cannot sign in " +
                `unattended. ${acceptedText}`,
        );
    }
    if (fields.slice(1).some(isKeyType)) {
        return new KeyError(
            "options before the key type are not accepted, the line starts with it",
        );
    }
    return new KeyError(`publicKey is not an OpenSSH public key line. ${acceptedText}`);
}

// Parses one authorized_keys line without options, throwing KeyError with a message to show
export function parsePublicKey(input: string): PublicKey {
    if (privateMarks.some((m) => m.test(input))) throw new KeyError(privateKeyText, true);
    const text = input.trim();
    if (text === "") throw new KeyError("publicKey is empty");
    if (text.includes("BEGIN SSH2 PUBLIC KEY")) {
        throw new KeyError(
            "publicKey is in SSH2 format, ssh-keygen -i -f <file> prints it as an OpenSSH line",
        );
    }
    if (text.startsWith("-----BEGIN")) {
        throw new KeyError(
            "publicKey is a PEM key, ssh-keygen -i -m PKCS8 -f <file> prints it as an OpenSSH " +
                "line",
        );
    }
    if (/[\r\n]/.test(text)) {
        throw new KeyError("publicKey holds more than one line, one key line is accepted");
    }
    const fields = text.split(/[ \t]+/);
    const type = fields[0] as string;
    if (!isKeyType(type)) throw typeRefusal(type, fields);
    const body = fields[1];
    if (body === undefined) throw new KeyError("the key line has no base64 key data");
    const wire = Buffer.from(body, "base64");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || wire.toString("base64") !== body) {
        throw new KeyError("the key data is not valid base64");
    }
    const w = new Wire(wire);
    if (w.string().toString("latin1") !== type) {
        throw new KeyError("the key data is for another key type than the line names");
    }
    const bits =
        type === "ssh-ed25519"
            ? checkEd25519(w)
            : type === "ssh-rsa"
              ? checkRsa(w)
              : checkEcdsa(type, w);
    const digest = createHash("sha256").update(wire).digest("base64").replace(/=+$/, "");
    return { type, bits, line: `${type} ${body}`, fingerprint: `SHA256:${digest}` };
}
