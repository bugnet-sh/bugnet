import { AsyncLocalStorage } from "node:async_hooks";
import type { Socket } from "node:net";

interface RequestContext {
    clientAddress: string | undefined;
    // The client shows a URL prompt a server sends in the middle of a call
    urlPrompts: boolean;
}

interface ToolCall {
    signal: AbortSignal;
    // Moves the call's time limit to ms from now
    extend: (ms: number) => void;
}

const store = new AsyncLocalStorage<RequestContext>();
const toolCalls = new AsyncLocalStorage<ToolCall>();
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

export function withClientAddress<T>(
    address: string | undefined,
    work: () => T,
    urlPrompts = false,
): T {
    return store.run({ clientAddress: address, urlPrompts }, work);
}

// Whether the client of the HTTP request running shows URL prompts mid-call
export function takesUrlPrompts(): boolean {
    return store.getStore()?.urlPrompts === true;
}

// Claude Code from protocol 2025-11-25 shows a URL prompt pushed during a call, and says who it is
export function urlPromptClient(
    userAgent: string | undefined,
    protocol: string | undefined,
): boolean {
    return (
        typeof userAgent === "string" &&
        userAgent.startsWith("claude-code/") &&
        typeof protocol === "string" &&
        protocol >= "2025-11-25"
    );
}

// The address of the client whose HTTP request is running, undefined outside one
export function clientAddress(): string | undefined {
    return store.getStore()?.clientAddress;
}

// Runs one tool call, whose router calls stop when the client cancels it
export function withToolCall<T>(
    signal: AbortSignal,
    work: () => T,
    extend: (ms: number) => void = () => {},
): T {
    return toolCalls.run({ signal, extend }, work);
}

// The abort signal of the tool call running, undefined outside one
export function toolCallSignal(): AbortSignal | undefined {
    return toolCalls.getStore()?.signal;
}

// Gives the tool call running ms from now before its time limit ends it
export function extendToolCall(ms: number): void {
    toolCalls.getStore()?.extend(ms);
}
