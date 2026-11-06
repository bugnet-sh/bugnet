/**
 * An OTLP/HTTP trace receiver for tests.
 *
 * It listens on 127.0.0.1 at a free port, keeps each export request's headers and raw body, and
 * decodes ExportTraceServiceRequest far enough for the trace tests, meaning ids, names, kinds,
 * attributes, links, status and the resource. It reads the wire format itself, so tests need no
 * OTLP schema.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";

export type AttrValue = string | boolean | number | bigint;

export interface ExportedLink {
    traceId: string;
    spanId: string;
    attributes: Record<string, AttrValue>;
}

export interface ExportedSpan {
    traceId: string;
    spanId: string;
    parentSpanId: string;
    name: string;
    // 1 internal, 2 server, 3 client
    kind: number;
    attributes: Record<string, AttrValue>;
    links: ExportedLink[];
    events: number;
    status: { code: number; message: string };
    resource: Record<string, AttrValue>;
}

export interface ExportRequest {
    headers: IncomingMessage["headers"];
    // The decompressed protobuf body, for leak scans
    body: Buffer;
    spans: ExportedSpan[];
}

export interface OtlpReceiver {
    url: string;
    requests: ExportRequest[];
    spans(): ExportedSpan[];
    close(): Promise<void>;
}

type Fields = Map<number, (Uint8Array | bigint | number)[]>;

function fields(bytes: Uint8Array): Fields {
    const out: Fields = new Map();
    const r = new BinaryReader(bytes);
    while (r.pos < r.len) {
        const [no, type] = r.tag();
        let v: Uint8Array | bigint | number;
        if (type === WireType.LengthDelimited) v = r.bytes();
        else if (type === WireType.Varint) v = BigInt(r.uint64());
        else if (type === WireType.Bit64) v = BigInt(r.fixed64());
        else if (type === WireType.Bit32) v = r.fixed32();
        else throw new Error(`wire type ${type} in OTLP body`);
        out.set(no, [...(out.get(no) ?? []), v]);
    }
    return out;
}

const all = (f: Fields, no: number) => (f.get(no) ?? []) as Uint8Array[];
const one = (f: Fields, no: number) => all(f, no)[0] ?? new Uint8Array();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const num = (f: Fields, no: number) => Number((f.get(no) ?? [0])[0]);

function anyValue(bytes: Uint8Array): AttrValue {
    const f = fields(bytes);
    if (f.has(1)) return text(one(f, 1));
    if (f.has(2)) return (f.get(2)?.[0] as bigint) !== 0n;
    if (f.has(3)) return f.get(3)?.[0] as bigint;
    if (f.has(4)) {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(f.get(4)?.[0] as bigint);
        return b.readDoubleLE(0);
    }
    return "(unsupported)";
}

function attributes(f: Fields, no: number): Record<string, AttrValue> {
    const out: Record<string, AttrValue> = {};
    for (const kv of all(f, no)) {
        const k = fields(kv);
        out[text(one(k, 1))] = anyValue(one(k, 2));
    }
    return out;
}

export function decodeTraces(body: Uint8Array): ExportedSpan[] {
    const spans: ExportedSpan[] = [];
    for (const rs of all(fields(body), 1)) {
        const r = fields(rs);
        const resource = attributes(fields(one(r, 1)), 1);
        for (const ss of all(r, 2)) {
            for (const raw of all(fields(ss), 2)) {
                const s = fields(raw);
                const status = fields(one(s, 15));
                spans.push({
                    traceId: hex(one(s, 1)),
                    spanId: hex(one(s, 2)),
                    parentSpanId: hex(one(s, 4)),
                    name: text(one(s, 5)),
                    kind: num(s, 6),
                    attributes: attributes(s, 9),
                    links: all(s, 13).map((l) => {
                        const lf = fields(l);
                        return {
                            traceId: hex(one(lf, 1)),
                            spanId: hex(one(lf, 2)),
                            attributes: attributes(lf, 4),
                        };
                    }),
                    events: all(s, 11).length,
                    status: { code: num(status, 3), message: text(one(status, 2)) },
                    resource,
                });
            }
        }
    }
    return spans;
}

// status sets the answer to every export, as a backend refusing the credentials would
export async function startOtlpReceiver(status = 200): Promise<OtlpReceiver> {
    const requests: ExportRequest[] = [];
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks);
            const body = req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
            requests.push({ headers: req.headers, body, spans: decodeTraces(body) });
            res.writeHead(status, { "content-type": "application/x-protobuf" }).end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/v1/traces`,
        requests,
        spans: () => requests.flatMap((r) => r.spans),
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
