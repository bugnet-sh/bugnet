// HAProxy's PROXY v2 header names the real client, so it is read from the raw socket before TLS
import type { Socket } from "node:net";

export const proxySignature = Buffer.from([
    0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);

const fixedBytes = 16;

export interface Endpoint {
    address: string;
    port: number;
}

export type ProxyHeader =
    | { command: "local" }
    | { command: "proxy"; family: "ipv4" | "ipv6"; source: Endpoint; destination: Endpoint };

export class ProxyHeaderError extends Error {
    // A connection that closed before sending a byte, as a plain TCP health check does
    readonly empty: boolean;

    constructor(message: string, empty = false) {
        super(message);
        this.empty = empty;
    }
}

export interface ParsedHeader {
    header: ProxyHeader;
    // Bytes the header took, the connection's own data starts after them
    length: number;
}

function ipv4(b: Buffer): string {
    return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
}

// RFC 5952 text, with IPv4-mapped addresses in their dotted form
export function ipv6(b: Buffer): string {
    const groups = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2));
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
        return `::ffff:${ipv4(b.subarray(12, 16))}`;
    }
    let start = -1;
    let run = 0;
    for (let i = 0; i < 8;) {
        let j = i;
        while (j < 8 && groups[j] === 0) j += 1;
        if (j - i > run) [start, run] = [i, j - i];
        i = j === i ? i + 1 : j;
    }
    const hex = groups.map((g) => g.toString(16));
    if (run < 2) return hex.join(":");
    return `${hex.slice(0, start).join(":")}::${hex.slice(start + run).join(":")}`;
}

function checkTlvs(tlvs: Buffer): void {
    for (let at = 0; at < tlvs.length;) {
        if (at + 3 > tlvs.length) throw new ProxyHeaderError("truncated TLV");
        at += 3 + tlvs.readUInt16BE(at + 1);
        if (at > tlvs.length) throw new ProxyHeaderError("TLV runs past the header");
    }
}

// Undefined while the bytes so far are a valid start of a header, so garbage fails at its first byte
export function parseProxyHeader(buf: Buffer, maxBytes: number): ParsedHeader | undefined {
    const seen = Math.min(buf.length, proxySignature.length);
    if (!buf.subarray(0, seen).equals(proxySignature.subarray(0, seen))) {
        throw new ProxyHeaderError("no PROXY v2 signature");
    }
    if (buf.length < 13) return undefined;
    const verCmd = buf[12] as number;
    if (verCmd >> 4 !== 2) throw new ProxyHeaderError("PROXY version is not 2");
    const command = verCmd & 0x0f;
    if (command > 1) throw new ProxyHeaderError("unknown PROXY command");
    if (buf.length < 14) return undefined;
    const family = (buf[13] as number) >> 4;
    const transport = (buf[13] as number) & 0x0f;
    if (family > 3 || transport > 2) throw new ProxyHeaderError("unknown address family");
    if (buf.length < fixedBytes) return undefined;
    const total = fixedBytes + buf.readUInt16BE(14);
    if (total > maxBytes) throw new ProxyHeaderError(`header over the ${maxBytes} byte cap`);
    if (buf.length < total) return undefined;
    // A LOCAL connection is the proxy's own, its address block is skipped unread
    if (command === 0) return { header: { command: "local" }, length: total };
    if (transport !== 1 || (family !== 1 && family !== 2)) {
        throw new ProxyHeaderError("only TCP over IPv4 or IPv6 is accepted");
    }
    const block = buf.subarray(fixedBytes, total);
    const size = family === 1 ? 4 : 16;
    if (block.length < 2 * size + 4) throw new ProxyHeaderError("address block too short");
    checkTlvs(block.subarray(2 * size + 4));
    const text = family === 1 ? ipv4 : ipv6;
    return {
        header: {
            command: "proxy",
            family: family === 1 ? "ipv4" : "ipv6",
            source: {
                address: text(block.subarray(0, size)),
                port: block.readUInt16BE(2 * size),
            },
            destination: {
                address: text(block.subarray(size, 2 * size)),
                port: block.readUInt16BE(2 * size + 2),
            },
        },
        length: total,
    };
}

export interface ReadOptions {
    timeoutMs: number;
    maxBytes: number;
}

// Leaves the socket paused with any bytes after the header unshifted back for the next reader
export function readProxyHeader(socket: Socket, opts: ReadOptions): Promise<ProxyHeader> {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const finish = (err: Error | null, header?: ProxyHeader, rest?: Buffer) => {
            clearTimeout(timer);
            socket.removeListener("readable", onReadable);
            socket.removeListener("end", onEnd);
            socket.removeListener("close", onEnd);
            socket.removeListener("error", onError);
            if (err) return reject(err);
            if (rest && rest.length > 0) socket.unshift(rest);
            resolve(header as ProxyHeader);
        };
        const onReadable = () => {
            let chunk: Buffer | null;
            while ((chunk = socket.read() as Buffer | null) !== null) {
                buf = Buffer.concat([buf, chunk]);
                let parsed: ParsedHeader | undefined;
                try {
                    parsed = parseProxyHeader(buf, opts.maxBytes);
                } catch (e) {
                    return finish(e as Error);
                }
                if (parsed) return finish(null, parsed.header, buf.subarray(parsed.length));
            }
        };
        const onEnd = () =>
            finish(
                buf.length > 0
                    ? new ProxyHeaderError("connection closed inside the header")
                    : new ProxyHeaderError("connection closed before the header", true),
            );
        const onError = (e: Error) => finish(e);
        const timer = setTimeout(
            () => finish(new ProxyHeaderError(`no complete header within ${opts.timeoutMs} ms`)),
            opts.timeoutMs,
        );
        socket.on("readable", onReadable);
        socket.on("end", onEnd);
        socket.on("close", onEnd);
        socket.on("error", onError);
    });
}
