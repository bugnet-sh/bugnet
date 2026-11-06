/**
 * The public TLS front.
 *
 * HAProxy passes mcp.bugnet.sh's raw TLS through with a PROXY v2 header first. A connection from a
 * peer outside proxy_protocol_from closes unread. Every other one reads that header, records the
 * real client for clientAddress(), then terminates TLS and hands the decrypted socket to the same
 * HTTP server the plain listener uses. A connection offering acme-tls/1 for a name with a
 * challenge in flight gets the challenge certificate instead and closes after the handshake, as
 * RFC 8737 asks.
 */
import { createServer, type Server as NetServer, type Socket } from "node:net";
import type { Server as HttpServer } from "node:http";
import { createSecureContext, TLSSocket } from "node:tls";
import { hostPort, type Settings } from "../config.ts";
import type { Log } from "../log.ts";
import { rangeFilter } from "../ratelimit.ts";
import { setPeerAddress } from "../request.ts";
import type { CertStore } from "./certs.ts";
import { minVersion } from "./certs.ts";
import { ProxyHeaderError, readProxyHeader } from "./proxy.ts";

export const acmeProtocol = "acme-tls/1";

export interface FrontOptions {
    settings: Settings["front"];
    certs: CertStore;
    http: HttpServer;
    log: Log;
}

export interface Front {
    server: NetServer;
    close(): Promise<void>;
}

// Before the first certificate exists every handshake but an ACME challenge fails
const noCertificate = createSecureContext({ minVersion });

function handshake(
    raw: Socket,
    client: string | undefined,
    o: FrontOptions,
    pending: Set<Socket>,
): void {
    const socket: TLSSocket = new TLSSocket(raw, {
        isServer: true,
        secureContext: o.certs.current?.context ?? noCertificate,
        ALPNCallback: ({ servername, protocols }) => {
            if (protocols.includes(acmeProtocol)) {
                const challenge = servername ? o.certs.challenge(servername) : undefined;
                if (!challenge) return undefined;
                socket.setKeyCert(challenge);
                return acmeProtocol;
            }
            return protocols.includes("http/1.1") ? "http/1.1" : undefined;
        },
    });
    if (client) setPeerAddress(socket, client);
    const timer = setTimeout(() => socket.destroy(), o.settings.handshake_timeout);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => clearTimeout(timer));
    socket.once("secure", () => {
        clearTimeout(timer);
        pending.delete(raw);
        if (socket.alpnProtocol === acmeProtocol) {
            socket.end();
            return;
        }
        o.http.emit("connection", socket);
    });
}

function accept(raw: Socket, o: FrontOptions, pending: Set<Socket>, proxy: Peers): void {
    if (o.settings.proxy_protocol && !proxy.trusted(raw.remoteAddress)) {
        proxy.refused();
        raw.destroy();
        return;
    }
    pending.add(raw);
    raw.once("close", () => pending.delete(raw));
    raw.on("error", () => raw.destroy());
    if (!o.settings.proxy_protocol) {
        handshake(raw, undefined, o, pending);
        return;
    }
    const { proxy_timeout, proxy_max_bytes } = o.settings;
    readProxyHeader(raw, { timeoutMs: proxy_timeout, maxBytes: proxy_max_bytes }).then(
        (header) => {
            if (raw.destroyed) return;
            const client = header.command === "proxy" ? header.source.address : undefined;
            handshake(raw, client, o, pending);
        },
        (e: Error) => {
            if (!(e instanceof ProxyHeaderError && e.empty)) {
                o.log.warn("proxy header refused", { err: e.message });
            }
            raw.destroy();
        },
    );
}

interface Peers {
    trusted(address: string | undefined): boolean;
    refused(): void;
}

// Only a peer in proxy_protocol_from may name the client, so any other closes unread
function proxyPeers(o: FrontOptions): Peers {
    let warnedAt = Number.NEGATIVE_INFINITY;
    return {
        trusted: rangeFilter(o.settings.proxy_protocol_from),
        refused() {
            if (Date.now() - warnedAt < 60_000) return;
            warnedAt = Date.now();
            o.log.warn("closed a connection from outside front.proxy_protocol_from");
        },
    };
}

export function startFront(o: FrontOptions): Promise<Front> {
    // Connections still before their handshake, the HTTP server owns the rest
    const pending = new Set<Socket>();
    const proxy = proxyPeers(o);
    const server = createServer((raw) => accept(raw, o, pending, proxy));
    const { host, port } = hostPort(o.settings.tls_addr, "front.tls_addr");
    const close = () =>
        new Promise<void>((resolve) => {
            server.close(() => resolve());
            for (const raw of pending) raw.destroy();
        });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host || "0.0.0.0", () => {
            server.removeListener("error", reject);
            resolve({ server, close });
        });
    });
}
