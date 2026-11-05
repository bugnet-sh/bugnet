import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KeyError, parsePublicKey } from "./sshkey.ts";

/* Keys */

// Made with OpenSSH 10.3 ssh-keygen, ssh-keygen -lf printed the fingerprint
const opensshEd25519 =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPtybGGsm+VyEjrrr3g41O4+iiVBe2YoFLs+PfxiHbnM me@host";
const opensshFingerprint = "SHA256:UOTMgQOqiiMfzLDkpttT80jlnh7DzrYQ+TwhD7RrU6Y";

function str(b: Buffer | string): Buffer {
    const data = Buffer.from(b);
    const n = Buffer.alloc(4);
    n.writeUInt32BE(data.length);
    return Buffer.concat([n, data]);
}

function wire(type: string, ...parts: (Buffer | string)[]): string {
    return Buffer.concat([str(type), ...parts.map(str)]).toString("base64");
}

function ed25519Point(): Buffer {
    const jwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
    return Buffer.from(jwk.x as string, "base64url");
}

function ecdsaLine(bits: 256 | 384 | 521): string {
    const jwk = generateKeyPairSync("ec", { namedCurve: `P-${bits}` }).publicKey.export({
        format: "jwk",
    });
    const q = Buffer.concat([
        Buffer.from([4]),
        Buffer.from(jwk.x as string, "base64url"),
        Buffer.from(jwk.y as string, "base64url"),
    ]);
    const type = `ecdsa-sha2-nistp${bits}`;
    return `${type} ${wire(type, `nistp${bits}`, q)}`;
}

// The parser checks only the modulus length, so any bytes of the right size stand in for one
function modulus(bits: number): Buffer {
    const n = Buffer.alloc(Math.ceil(bits / 8), 0xab);
    n[0] = 1 << ((bits - 1) % 8);
    return (n[0] as number) & 0x80 ? Buffer.concat([Buffer.from([0]), n]) : n;
}

function rsaLine(bits: number, e: Buffer = Buffer.from([1, 0, 1])): string {
    return `ssh-rsa ${wire("ssh-rsa", e, modulus(bits))}`;
}

function refusal(input: string): KeyError {
    try {
        parsePublicKey(input);
    } catch (e) {
        if (e instanceof KeyError) return e;
        throw e;
    }
    throw new Error("the key was accepted");
}

// No refusal may quote the input, so no run of 8 characters from it shows up in the message
function quotes(message: string, input: string): boolean {
    const runs = input.match(/[A-Za-z0-9+/=]{12,}/g) ?? [];
    return runs.some((run) => {
        for (let i = 0; i + 8 <= run.length; i++) {
            if (message.includes(run.slice(i, i + 8))) return true;
        }
        return false;
    });
}

/* Tests */

describe("parsePublicKey", () => {
    it("accepts an OpenSSH ed25519 line with the fingerprint ssh-keygen prints", () => {
        const k = parsePublicKey(opensshEd25519);
        expect(k).toEqual({
            type: "ssh-ed25519",
            bits: 256,
            line: opensshEd25519.replace(/ me@host$/, ""),
            fingerprint: opensshFingerprint,
        });
    });

    it("drops the comment and tolerates tabs, a trailing newline and CRLF", () => {
        const body = opensshEd25519.split(" ")[1] as string;
        for (const input of [
            `ssh-ed25519\t${body}\tme@host two words\n`,
            `  ssh-ed25519 ${body}\r\n`,
        ]) {
            expect(parsePublicKey(input).line).toBe(`ssh-ed25519 ${body}`);
        }
    });

    it("accepts ecdsa keys on each NIST curve", () => {
        for (const bits of [256, 384, 521] as const) {
            const k = parsePublicKey(`${ecdsaLine(bits)} me@host`);
            expect(k.type).toBe(`ecdsa-sha2-nistp${bits}`);
            expect(k.bits).toBe(bits);
            expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
        }
    });

    it("accepts RSA from 3072 bits and refuses anything shorter", () => {
        expect(parsePublicKey(rsaLine(3072)).bits).toBe(3072);
        expect(parsePublicKey(rsaLine(4096)).bits).toBe(4096);
        expect(refusal(rsaLine(3071)).message).toBe(
            "the RSA key has 3071 bits and 3072 or more are needed, ssh-keygen -t ed25519 makes " +
                "a key that is accepted",
        );
        expect(refusal(rsaLine(2048)).message).toMatch(/has 2048 bits/);
        expect(refusal(rsaLine(16392)).message).toBe("the RSA key is over 16384 bits");
    });

    it("refuses an RSA exponent x/crypto/ssh refuses", () => {
        for (const e of [
            Buffer.from([1]),
            Buffer.from([2]),
            Buffer.from([1, 0, 0]),
            Buffer.alloc(4, 1),
        ]) {
            expect(refusal(rsaLine(3072, e)).message).toBe("the RSA exponent is not accepted");
        }
        expect(refusal(rsaLine(3072, Buffer.from([0x81]))).message).toBe(
            "the RSA exponent is not a positive number",
        );
    });

    it("refuses private keys loudly and never quotes them", () => {
        const pkcs8 = generateKeyPairSync("ed25519").privateKey.export({
            type: "pkcs8",
            format: "pem",
        }) as string;
        const body = Buffer.concat([Buffer.from("openssh-key-v1\0"), randomBytes(200)])
            .toString("base64")
            .replace(/.{70}/g, "$&\n");
        // Spelt in parts so secret scanners do not flag this file
        const openssh = `-----BEGIN OPENSSH ${"PRIVATE"} KEY-----\n${body}\n-----END OPENSSH ${"PRIVATE"} KEY-----\n`;
        const putty = `PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n${randomBytes(48).toString("base64")}\n`;
        for (const input of [pkcs8, openssh, body, body.replace(/\n/g, ""), putty]) {
            const e = refusal(input);
            expect(e.privateKey).toBe(true);
            expect(e.message).toMatch(/^publicKey holds a PRIVATE key, so it was refused/);
            expect(quotes(e.message, input)).toBe(false);
        }
    });

    it("refuses what an authorized_keys line may not hold, saying why", () => {
        const body = opensshEd25519.split(" ")[1] as string;
        const certBody = wire("ssh-ed25519-cert-v01@openssh.com", randomBytes(32));
        const cases: [string, RegExp][] = [
            ["", /^publicKey is empty$/],
            [`ssh-ed25519-cert-v01@openssh.com ${certBody} me@host`, /^certificates are not/],
            [`ssh-dss ${wire("ssh-dss", randomBytes(20))}`, /^DSA keys are not accepted/],
            [
                `sk-ssh-ed25519@openssh.com ${body}`,
                /^security key \(sk-\) keys need the hardware key/,
            ],
            [`command="echo hi" ${opensshEd25519}`, /^options before the key type/],
            [`restrict,pty ${opensshEd25519}`, /^options before the key type/],
            ["~/.ssh/bugnet_bn-k3f9x2q7ma.pub", /not the file's path$/],
            [`${opensshEd25519}\n${opensshEd25519}`, /more than one line/],
            [
                `---- BEGIN SSH2 PUBLIC KEY ----\n${body}\n---- END SSH2 PUBLIC KEY ----`,
                /SSH2 format, ssh-keygen -i -f/,
            ],
            [
                `-----BEGIN PUBLIC KEY-----\n${randomBytes(44).toString("base64")}\n-----END PUBLIC KEY-----`,
                /PEM key, ssh-keygen -i -m PKCS8/,
            ],
            [body, /^publicKey is not an OpenSSH public key line/],
            ["ssh-ed25519", /no base64 key data/],
            [`ssh-ed25519 ${body.slice(0, -1)}`, /not valid base64/],
            [`ssh-ed25519 ${body.replace("A", "-")}`, /not valid base64/],
            [`ssh-ed25519 ${rsaLine(3072).split(" ")[1]}`, /for another key type/],
            [`ssh-ed25519 ${wire("ssh-ed25519", randomBytes(31))}`, /not 32 bytes/],
            [`ssh-ed25519 ${wire("ssh-ed25519", ed25519Point(), "x")}`, /extra bytes/],
            [`ssh-ed25519 ${str("ssh-ed25519").toString("base64")}`, /cut short/],
        ];
        for (const [input, want] of cases) {
            const e = refusal(input);
            expect(e.message, input).toMatch(want);
            expect(e.privateKey).toBe(false);
            expect(quotes(e.message, input), input).toBe(false);
        }
    });

    it("checks an ecdsa key's curve and point", () => {
        const good = ecdsaLine(256).split(" ")[1] as string;
        const raw = Buffer.from(good, "base64");
        const q = raw.subarray(raw.length - 65);
        const type = "ecdsa-sha2-nistp256";
        const offCurve = Buffer.from(q);
        offCurve[64] = (offCurve[64] as number) ^ 1;
        const compressed = Buffer.concat([Buffer.from([2]), q.subarray(1, 33)]);
        expect(refusal(`${type} ${wire(type, "nistp384", q)}`).message).toMatch(/another curve/);
        expect(refusal(`${type} ${wire(type, "nistp256", offCurve)}`).message).toMatch(
            /not on its curve/,
        );
        expect(refusal(`${type} ${wire(type, "nistp256", compressed)}`).message).toMatch(
            /point is malformed/,
        );
    });
});
