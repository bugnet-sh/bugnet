import { AsyncLocalStorage } from "node:async_hooks";
import type { Socket } from "node:net";

interface RequestContext {
    clientAddress: string | undefined;
}

const store = new AsyncLocalStorage<RequestContext>();
const toolCalls = new AsyncLocalStorage<AbortSignal>();
const peers = new WeakMap<Socket, string>();

// IPv4 peers of a dual-stack listener arrive as ::ffff:a.b.c.d, which would split one client in two
function normalise(address: string): string {
    const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    return v4 ? (v4[1] as string) : address.toLowerCase();
}

// A front that reads the PROXY protocol header names the real client of a connection here
export function setPeerAddress(socket: Socket, address: string): void {
    peers.set(socket, normalise(address));
}

export function peerAddress(socket: Socket): string | undefined {
    const known = peers.get(socket);
    if (known) return known;
    return socket.remoteAddress ? normalise(socket.remoteAddress) : undefined;
}

export function withClientAddress<T>(address: string | undefined, work: () => T): T {
    return store.run({ clientAddress: address }, work);
}

// The address of the client whose HTTP request is running, undefined outside one
export function clientAddress(): string | undefined {
    return store.getStore()?.clientAddress;
}

// Runs one tool call, whose router calls stop when the client cancels it
export function withToolCall<T>(signal: AbortSignal, work: () => T): T {
    return toolCalls.run(signal, work);
}

// The abort signal of the tool call running, undefined outside one
export function toolCallSignal(): AbortSignal | undefined {
    return toolCalls.getStore();
}
