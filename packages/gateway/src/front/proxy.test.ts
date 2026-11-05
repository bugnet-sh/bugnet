import { randomBytes } from "node:crypto";
import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
    ipv6,
    parseProxyHeader,
    ProxyHeaderError,
    proxySignature,
    readProxyHeader,
    type ProxyHeader,
} from "./proxy.ts";

// Vectors laid out field by field from section 2.2 of HAProxy's doc/proxy-protocol.txt
const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");
const sig = "0d0a0d0a 000d0a51 5549540a";

// The endpoints of the spec's TCP4 example line, PROXY TCP4 192.168.0.1 192.168.0.11 56324 443
const tcp4 = hex(`${sig} 21 11 000c  c0a80001 c0a8000b  dc04 01bb`);
const tcp6 = hex(
    `${sig} 21 21 0024
     20010db8 00000000 00000000 00000001
     20010db8 00000000 00000000 00000002
     dc04 01bb`,
);
const tcp6Max = hex(`${sig} 21 21 0024 ${"ff".repeat(32)} ffff ffff`);
const local = hex(`${sig} 20 00 0000`);
const localWithBlock = hex(`${sig} 20 11 000c  7f000001 7f000001  1f90 20fb`);
// PP2_TYPE_NOOP with three bytes, then PP2_TYPE_AUTHORITY with mcp.bugnet.sh
const tcp4Tlvs = hex(
    `${sig} 21 11 0022  c0a80001 c0a8000b  dc04 01bb
     04 0003 000000
     02 000d ${Buffer.from("mcp.bugnet.sh").toString("hex")}`,
);

const spec4: ProxyHeader = {
    command: "proxy",
    family: "ipv4",
    source: { address: "192.168.0.1", port: 56324 },
    destination: { address: "192.168.0.11", port: 443 },
};

const max = 536;

describe("PROXY v2 header", () => {
    it("matches the spec's signature and fixed header size", () => {
        expect(proxySignature).toEqual(hex(sig));
        expect(tcp4.length).toBe(16 + 12);
        expect(tcp6.length).toBe(16 + 36);
    });

    it("reads TCP over IPv4", () => {
        expect(parseProxyHeader(tcp4, max)).toEqual({ header: spec4, length: 28 });
    });

    it("reads TCP over IPv6", () => {
        expect(parseProxyHeader(tcp6, max)).toEqual({
            header: {
                command: "proxy",
                family: "ipv6",
                source: { address: "2001:db8::1", port: 56324 },
                destination: { address: "2001:db8::2", port: 443 },
            },
            length: 52,
        });
        const all = parseProxyHeader(tcp6Max, max)?.header;
        expect(all).toMatchObject({
            source: { address: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", port: 65535 },
        });
    });

    it("reads LOCAL and skips any address block it carries", () => {
        expect(parseProxyHeader(local, max)).toEqual({ header: { command: "local" }, length: 16 });
        expect(parseProxyHeader(localWithBlock, max)).toEqual({
            header: { command: "local" },
            length: 28,
        });
    });

    it("skips TLVs and stops at the header's end", () => {
        const tail = hex("16030100");
        expect(parseProxyHeader(Buffer.concat([tcp4Tlvs, tail]), max)).toEqual({
            header: spec4,
            length: 50,
        });
        expect(parseProxyHeader(Buffer.concat([tcp4, tail]), max)?.length).toBe(28);
    });

    it("waits on every truncation of a valid header", () => {
        for (const v of [tcp4, tcp6, local, tcp4Tlvs]) {
            for (let n = 0; n < v.length; n += 1) {
                expect(parseProxyHeader(v.subarray(0, n), max)).toBeUndefined();
            }
        }
    });

    it("refuses garbage at its first wrong byte", () => {
        const refusals: [string, Buffer, RegExp][] = [
            ["HTTP", Buffer.from("GET / HTTP/1.1\r\n"), /signature/],
            ["version 1", Buffer.from("PROXY TCP4 192.168.0.1 192.168.0.11 56324 443\r\n"), /sig/],
            ["a TLS ClientHello", hex("16030100c8010000c40303"), /signature/],
            ["a broken signature", hex("0d0a0d0a000d0a5155495420"), /signature/],
            ["version 1 binary", hex(`${sig} 11`), /version/],
            ["version 3", hex(`${sig} 31`), /version/],
            ["command 2", hex(`${sig} 22`), /command/],
            ["family 4", hex(`${sig} 21 41`), /family/],
            ["transport 3", hex(`${sig} 21 13`), /family/],
        ];
        for (const [, bytes, why] of refusals) {
            expect(() => parseProxyHeader(bytes, max)).toThrow(ProxyHeaderError);
            expect(() => parseProxyHeader(bytes, max)).toThrow(why);
        }
    });

    it("accepts only TCP over IPv4 or IPv6 for PROXY", () => {
        for (const fam of ["00", "12", "22", "31", "32"]) {
            const len = { "00": 0, "12": 12, "22": 36, "31": 216, "32": 216 }[fam] as number;
            const v = Buffer.concat([
                hex(`${sig} 21 ${fam}`),
                Buffer.from([len >> 8, len & 0xff]),
                Buffer.alloc(len),
            ]);
            expect(() => parseProxyHeader(v, max)).toThrow(/only TCP/);
        }
    });

    it("refuses short address blocks and broken TLVs", () => {
        expect(() => parseProxyHeader(hex(`${sig} 21 11 0008 c0a80001 c0a8000b`), max)).toThrow(
            /too short/,
        );
        expect(() => parseProxyHeader(hex(`${sig} 21 21 000c ${"00".repeat(12)}`), max)).toThrow(
            /too short/,
        );
        const cut = hex(`${sig} 21 11 000e c0a80001 c0a8000b dc04 01bb 0400`);
        expect(() => parseProxyHeader(cut, max)).toThrow(/truncated TLV/);
        const over = hex(`${sig} 21 11 0010 c0a80001 c0a8000b dc04 01bb 04 0005 00`);
        expect(() => parseProxyHeader(over, max)).toThrow(/past the header/);
    });

    it("refuses a header over the cap from its length field alone", () => {
        expect(() => parseProxyHeader(hex(`${sig} 21 11 ffff`), max)).toThrow(/cap/);
        expect(() => parseProxyHeader(tcp6, 51)).toThrow(/cap/);
        expect(parseProxyHeader(tcp6, 52)?.length).toBe(52);
    });

    it("writes IPv6 the way RFC 5952 and the URL parser do", () => {
        for (let i = 0; i < 2000; i += 1) {
            const b = randomBytes(16);
            for (let g = 0; g < 8; g += 1) if (Math.random() < 0.5) b.writeUInt16BE(0, g * 2);
            if (b.readUInt16BE(10) === 0xffff) b.writeUInt16BE(1, 10);
            const groups = Array.from({ length: 8 }, (_, k) => b.readUInt16BE(k * 2).toString(16));
            const canonical = new URL(`http://[${groups.join(":")}]`).hostname.slice(1, -1);
            expect(ipv6(b)).toBe(canonical);
        }
        expect(ipv6(Buffer.alloc(16))).toBe("::");
        expect(ipv6(hex("00000000000000000000ffffc0000201"))).toBe("::ffff:192.0.2.1");
        expect(ipv6(hex("20010db8000000010000000000000001"))).toBe("2001:db8:0:1::1");
        expect(ipv6(hex("20010db8000100010001000100010001"))).toBe("2001:db8:1:1:1:1:1:1");
    });
});

describe("reading the header from a socket", () => {
    const servers: Server[] = [];
    afterEach(async () => {
        for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
    });

    interface Received {
        header?: ProxyHeader;
        error?: Error;
        rest: Buffer;
    }

    async function receive(
        send: (c: Socket) => Promise<void>,
        opts = { timeoutMs: 500, maxBytes: max },
    ): Promise<Received> {
        let done: (r: Received) => void = () => {};
        const result = new Promise<Received>((r) => (done = r));
        const server = createServer((sock) => {
            sock.on("error", () => {});
            readProxyHeader(sock, opts).then(
                (header) => {
                    const chunks: Buffer[] = [];
                    sock.on("data", (c: Buffer) => chunks.push(c));
                    sock.on("end", () => done({ header, rest: Buffer.concat(chunks) }));
                },
                (error: Error) => {
                    sock.destroy();
                    done({ error, rest: Buffer.alloc(0) });
                },
            );
        });
        servers.push(server);
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const { port } = server.address() as AddressInfo;
        const client = connect(port, "127.0.0.1");
        client.on("error", () => {});
        await new Promise((r) => client.once("connect", r));
        await send(client);
        return result;
    }

    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it("hands on the bytes after the header untouched", async () => {
        const body = randomBytes(5000);
        const r = await receive(async (c) => {
            c.end(Buffer.concat([tcp4Tlvs, body]));
        });
        expect(r.header).toEqual(spec4);
        expect(r.rest.equals(body)).toBe(true);
    });

    it("joins a header split across segments", async () => {
        const r = await receive(async (c) => {
            for (const byte of tcp6) {
                c.write(Buffer.from([byte]));
                await pause(2);
            }
            c.end("hello");
        });
        expect(r.header).toMatchObject({ family: "ipv6", source: { address: "2001:db8::1" } });
        expect(r.rest.toString()).toBe("hello");
    });

    it("refuses a client that speaks TLS without a header", async () => {
        const r = await receive(async (c) => {
            c.write(hex("16030100c8010000c40303"));
        });
        expect(r.error?.message).toMatch(/signature/);
    });

    it("gives up on a header that never completes", async () => {
        const started = Date.now();
        const r = await receive(
            async (c) => {
                c.write(tcp4.subarray(0, 20));
            },
            { timeoutMs: 150, maxBytes: max },
        );
        expect(r.error?.message).toMatch(/within 150 ms/);
        expect(Date.now() - started).toBeLessThan(2000);
    });

    it("refuses a connection that closes inside the header", async () => {
        const r = await receive(async (c) => {
            c.end(tcp4.subarray(0, 20));
        });
        expect(r.error?.message).toMatch(/closed inside the header/);
    });

    it("refuses an oversized header before it arrives", async () => {
        const r = await receive(async (c) => {
            c.write(hex(`${sig} 21 11 0400`));
        });
        expect(r.error?.message).toMatch(/cap/);
    });
});
