import {
    Client,
    StreamableHTTPClientTransport,
    type CallToolResult,
    type InputRequiredResult,
    type Progress,
    type Tool,
} from "@modelcontextprotocol/client";
import type { Log } from "./log.ts";

export type RemoteResult = CallToolResult | InputRequiredResult;

export interface CallOptions {
    signal: AbortSignal;
    onprogress?: (p: Progress) => void;
}

// The remote gateway as the bridge's server side uses it, so tests can stand in for it
export interface RemoteTools {
    instructions(): string | undefined;
    listTools(signal: AbortSignal): Promise<Tool[]>;
    callTool(params: Record<string, unknown>, opts: CallOptions): Promise<RemoteResult>;
}

export interface RemoteOptions {
    url: string;
    version: string;
    connectTimeoutMs: number;
    callTimeoutMs: number;
    log: Log;
    fetch?: typeof fetch;
}

// One client for the bridge's life, reconnected after a failed connect or a closed transport
export class RemoteGateway implements RemoteTools {
    private client: Client | null = null;
    private pending: Promise<Client> | null = null;
    private serverInstructions: string | undefined;
    private readonly opts: RemoteOptions;

    constructor(opts: RemoteOptions) {
        this.opts = opts;
    }

    instructions(): string | undefined {
        return this.serverInstructions;
    }

    connect(): Promise<Client> {
        if (this.client) return Promise.resolve(this.client);
        this.pending ??= this.open().then(
            (c) => {
                this.client = c;
                return c;
            },
            (e: unknown) => {
                this.pending = null;
                throw e;
            },
        );
        return this.pending;
    }

    private async open(): Promise<Client> {
        const client = new Client(
            { name: "bugnet-bridge", version: this.opts.version },
            {
                versionNegotiation: { mode: "auto" },
                // Input requests go back to the bridge's own client, which shows them to the user
                inputRequired: { autoFulfill: false },
            },
        );
        const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
            ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
        });
        await client.connect(transport, { timeout: this.opts.connectTimeoutMs });
        this.serverInstructions = client.getInstructions();
        client.onclose = () => {
            if (this.client === client) {
                this.client = null;
                this.pending = null;
            }
        };
        return client;
    }

    async listTools(signal: AbortSignal): Promise<Tool[]> {
        const client = await this.connect();
        const res = await client.listTools(undefined, {
            signal,
            timeout: this.opts.connectTimeoutMs,
            cacheMode: "bypass",
        });
        return res.tools;
    }

    async callTool(params: Record<string, unknown>, opts: CallOptions): Promise<RemoteResult> {
        const client = await this.connect();
        const res = await client.request(
            { method: "tools/call", params },
            {
                signal: opts.signal,
                timeout: this.opts.callTimeoutMs,
                resetTimeoutOnProgress: true,
                allowInputRequired: true,
                ...(opts.onprogress ? { onprogress: opts.onprogress } : {}),
            },
        );
        return res as RemoteResult;
    }

    async close(): Promise<void> {
        const client = this.client;
        this.client = null;
        this.pending = null;
        await client?.close();
    }
}
