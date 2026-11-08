import { createHash, randomBytes, randomUUID } from "node:crypto";
import { base58Encode, solanaNetwork, urlParts, usdcAsset } from "../x402/lines.ts";
import { orderKey, signOrderToken } from "./ordertoken.ts";
import { orderIdPattern, paymentMemo } from "./port.ts";
import type {
    AwaitingPayment,
    OrderRequest,
    OrderResult,
    OrderTerms,
    PaidAllowanceOrder,
    PaidOrder,
    Payments,
    RefusedOrder,
    RefusalReason,
    X402Account,
    X402AccountAnswer,
    X402AccountService,
    X402AccountState,
    X402ConfigureRefused,
    X402ConfigureResult,
    X402Refund,
    X402SellerStats,
    X402ServicePin,
    X402ServiceState,
    X402Setup,
    X402Terms,
} from "./port.ts";

export const devUnpaidTtlMs = 15 * 60_000;

const devAddress = (seed: string) => base58Encode(createHash("sha256").update(seed).digest());

// The spec 7.15 example values
export const devTerms: X402Terms = {
    enabled: true,
    startWithX402: true,
    network: solanaNetwork,
    asset: usdcAsset,
    sessionFeeMicros: 3_000,
    minAllowanceMicros: 100_000,
    suggestedAllowanceMicros: 1_000_000,
    maxAllowancePerSandboxMicros: 5_000_000,
    maxPricePerCallMicros: 500_000,
    defaultSpendPerMinuteMicros: 500_000,
    minSpendPerMinuteMicros: 10_000,
    maxSpendPerMinuteMicros: 5_000_000,
    maxServices: 5,
    maxNewServicesPerOrder: 5,
    sellerMemoMaxBytes: 32,
    refundMinMicros: 10_000,
    bugnetAddresses: [
        devAddress("bugnet dev fee payer"),
        devAddress("bugnet dev allowance wallet"),
        devAddress("bugnet dev refund wallet"),
        devAddress("bugnet dev recipient"),
    ],
};

export interface DevPaymentsOptions {
    requirePayment?: boolean;
    payBaseUrl?: string;
    terms?: Partial<X402Terms>;
}

export interface DevAccountPatch {
    state?: X402AccountState;
    spentMicros?: number;
    heldMicros?: number;
    paidCalls?: number;
    pendingCalls?: number;
    refund?: X402Refund;
    serviceStates?: Record<string, X402ServiceState>;
}

interface LedgerAccount {
    state: X402AccountState;
    funded: number;
    spent: number;
    held: number;
    paidCalls: number;
    pendingCalls: number;
    spendPerMinute: number | null;
    feePaid: boolean;
    services: (X402ServicePin & { state: X402ServiceState })[];
    refund: X402Refund | null;
}

const byServiceId = (a: { serviceId: string }, b: { serviceId: string }) =>
    a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0;

// Spec 7.15's canonical form, so a resend compares equal whatever the probe saw
export function canonicalSetup(s: X402Setup | undefined): string {
    return JSON.stringify({
        services: [...(s?.services ?? [])].sort(byServiceId).map((v) => ({
            serviceId: v.serviceId,
            method: v.method,
            host: v.host,
            prefix: v.prefix,
            url: v.url,
            maxPriceMicros: v.maxPriceMicros,
            payTo: v.payTo,
        })),
        disable: [...new Set(s?.disable ?? [])].sort(),
        spendPerMinuteMicros: s?.spendPerMinuteMicros ?? null,
    });
}

// An in-memory stand-in for the router's x402 accounts behind Payments
export class DevX402Ledger {
    readonly terms: X402Terms;
    private readonly accounts = new Map<string, LedgerAccount>();
    private readonly orderRefusals: RefusedOrder[] = [];
    private readonly configureRefusals: X402ConfigureRefused[] = [];
    private readonly configured = new Map<
        string,
        { request: string; answer: X402ConfigureResult }
    >();
    private readonly paid = new Set<string>();
    private stats: Record<string, X402SellerStats> = {};
    private payerIndex = 0;

    constructor(terms: X402Terms) {
        this.terms = terms;
    }

    private get payer(): string {
        return this.payerIndex === 0 ? "dev" : `dev-${this.payerIndex}`;
    }

    private startKey = (orderId: string) => `start:${orderId}`;

    // A start order's account has no handle hash until a test binds it, as LookupPlacement would
    bind(startOrderId: string, handleSha256: string): void {
        const key = this.startKey(startOrderId);
        const held = this.accounts.get(key);
        if (!held) throw new Error("no x402 account for that order");
        this.accounts.delete(key);
        this.accounts.set(handleSha256, held);
    }

    patch(handleSha256: string, patch: DevAccountPatch): void {
        const a = this.accounts.get(handleSha256);
        if (!a) throw new Error("no x402 account for that handle");
        if (patch.state !== undefined) a.state = patch.state;
        if (patch.spentMicros !== undefined) a.spent = patch.spentMicros;
        if (patch.heldMicros !== undefined) a.held = patch.heldMicros;
        if (patch.paidCalls !== undefined) a.paidCalls = patch.paidCalls;
        if (patch.pendingCalls !== undefined) a.pendingCalls = patch.pendingCalls;
        if (patch.refund !== undefined) a.refund = patch.refund;
        for (const [id, state] of Object.entries(patch.serviceStates ?? {})) {
            const s = a.services.find((v) => v.serviceId === id);
            if (s) s.state = state;
        }
    }

    // The next order answers this refusal once
    refuseNextOrder(r: Omit<RefusedOrder, "status">): void {
        this.orderRefusals.push({ status: "refused", ...r });
    }

    // The next configure answers this refusal once
    refuseNextConfigure(r: Omit<X402ConfigureRefused, "status">): void {
        this.configureRefusals.push({ status: "refused", ...r });
    }

    setSellers(stats: Record<string, X402SellerStats>): void {
        this.stats = stats;
    }

    // A fresh fake payer, so its first allowance answers firstUse true
    newPayer(): void {
        this.payerIndex += 1;
    }

    takeOrderRefusal(): RefusedOrder | null {
        return this.orderRefusals.shift() ?? null;
    }

    takeConfigureRefusal(): X402ConfigureRefused | null {
        return this.configureRefusals.shift() ?? null;
    }

    // The prices of the services left after the change, held ones only in the states counted
    private pricesAfter(
        held: LedgerAccount | undefined,
        pins: X402ServicePin[],
        disable: string[],
        counted: (state: X402ServiceState) => boolean,
    ): Map<string, number> {
        const prices = new Map<string, number>();
        for (const s of held?.services ?? []) {
            if (counted(s.state)) prices.set(s.serviceId, s.maxPriceMicros);
        }
        for (const p of pins) prices.set(p.serviceId, p.maxPriceMicros);
        for (const id of disable) prices.delete(id);
        return prices;
    }

    // maxServices counts every service not disabled, unreliable ones included
    private servicesAfter(
        held: LedgerAccount | undefined,
        pins: X402ServicePin[],
        disable: string[],
    ): number {
        return this.pricesAfter(held, pins, disable, (s) => s !== "disabled").size;
    }

    // Spec 7.15 holds the minute limit against the enabled services' max only
    private rateProblem(
        held: LedgerAccount | undefined,
        pins: X402ServicePin[],
        disable: string[],
        limit: number,
    ): boolean {
        const t = this.terms;
        if (limit < t.minSpendPerMinuteMicros || limit > t.maxSpendPerMinuteMicros) return true;
        const prices = this.pricesAfter(held, pins, disable, (s) => s === "enabled");
        for (const price of prices.values()) if (price > limit) return true;
        return false;
    }

    admit(req: OrderTerms): RefusedOrder | null {
        const t = this.terms;
        const refuse = (reason: RefusalReason): RefusedOrder => ({ status: "refused", reason });
        if (!t.enabled) return refuse("x402_disabled");
        if (req.kind === "start" && !t.startWithX402) return refuse("x402_start_unavailable");
        if (req.kind === "allowance" && !req.handleSha256) return refuse("bad_request");
        const held = req.handleSha256 ? this.accounts.get(req.handleSha256) : undefined;
        const allowance = req.allowanceMicros ?? 0;
        if (allowance < t.minAllowanceMicros) return refuse("amount_too_small");
        const feeDue = req.kind === "start" || !held?.feePaid ? t.sessionFeeMicros : 0;
        if ((req.feeMicros ?? 0) !== feeDue) return refuse("fee_mismatch");
        if (held && held.state !== "open") return refuse("sandbox_ended");
        const pins = req.x402?.services ?? [];
        const disable = req.x402?.disable ?? [];
        if (this.servicesAfter(held, pins, disable) > t.maxServices) {
            return refuse("too_many_services");
        }
        if (pins.some((p) => p.maxPriceMicros > t.maxPricePerCallMicros)) {
            return refuse("price_above_ceiling");
        }
        const limit =
            req.x402?.spendPerMinuteMicros ?? held?.spendPerMinute ?? t.defaultSpendPerMinuteMicros;
        if (this.rateProblem(held, pins, disable, limit)) return refuse("spend_rate_out_of_range");
        const fresh = pins.filter((p) => {
            const h = held?.services.find((s) => s.serviceId === p.serviceId);
            return (
                !h ||
                h.url !== p.url ||
                h.maxPriceMicros !== p.maxPriceMicros ||
                h.payTo !== p.payTo
            );
        });
        if (fresh.length > t.maxNewServicesPerOrder) return refuse("description_too_long");
        if ((held?.funded ?? 0) + allowance > t.maxAllowancePerSandboxMicros) {
            return refuse("allowance_ceiling");
        }
        return null;
    }

    private apply(a: LedgerAccount, setup: X402Setup | undefined): void {
        for (const p of setup?.services ?? []) {
            const held = a.services.find((s) => s.serviceId === p.serviceId);
            if (held) Object.assign(held, { ...p, state: "enabled" as const });
            else a.services.push({ ...p, state: "enabled" });
        }
        for (const id of setup?.disable ?? []) {
            const held = a.services.find((s) => s.serviceId === id);
            if (held) held.state = "disabled";
        }
        if (setup?.spendPerMinuteMicros !== undefined)
            a.spendPerMinute = setup.spendPerMinuteMicros;
    }

    settle(
        orderId: string,
        req: OrderTerms,
    ): Pick<PaidAllowanceOrder, "allowanceMicros" | "firstUse" | "x402" | "payer"> | RefusedOrder {
        const key = req.kind === "start" ? this.startKey(orderId) : (req.handleSha256 as string);
        let a = this.accounts.get(key);
        const allowance = req.allowanceMicros ?? 0;
        if (a && a.state !== "open") {
            return { status: "refused", orderId, reason: "sandbox_ended", refundPending: true };
        }
        if ((a?.funded ?? 0) + allowance > this.terms.maxAllowancePerSandboxMicros) {
            return { status: "refused", orderId, reason: "allowance_ceiling", refundPending: true };
        }
        if (!a) {
            a = {
                state: "open",
                funded: 0,
                spent: 0,
                held: 0,
                paidCalls: 0,
                pendingCalls: 0,
                spendPerMinute: null,
                feePaid: false,
                services: [],
                refund: null,
            };
            this.accounts.set(key, a);
        }
        a.funded += allowance;
        if ((req.feeMicros ?? 0) > 0) a.feePaid = true;
        this.apply(a, req.x402);
        const payer = this.payer;
        const firstUse = !this.paid.has(payer);
        this.paid.add(payer);
        return { allowanceMicros: allowance, firstUse, x402: this.view(a), payer };
    }

    private view(a: LedgerAccount): X402Account {
        const services: X402AccountService[] = a.services.map((s) => ({
            serviceId: s.serviceId,
            method: s.method,
            host: s.host,
            prefix: s.prefix,
            url: s.url,
            paidPath: s.listed === "unlisted" ? (urlParts(s.url)?.path ?? null) : null,
            maxPriceMicros: s.maxPriceMicros,
            payTo: s.payTo,
            listed: s.listed,
            state: s.state,
        }));
        return {
            state: a.state,
            fundedMicros: a.funded,
            spentMicros: a.spent,
            heldMicros: a.held,
            leftMicros: a.funded - a.spent - a.held,
            allowanceRoomMicros: this.terms.maxAllowancePerSandboxMicros - a.funded,
            paidCalls: a.paidCalls,
            pendingCalls: a.pendingCalls,
            spendPerMinuteMicros: a.spendPerMinute ?? this.terms.defaultSpendPerMinuteMicros,
            services,
            ...(a.state !== "open"
                ? {
                      refund: a.refund ?? {
                          state:
                              a.state === "closing" ? ("waiting" as const) : ("confirmed" as const),
                          amountMicros: 0,
                          keptMicros: 0,
                          txs: [],
                      },
                  }
                : {}),
        };
    }

    account(handleSha256: string): X402AccountAnswer {
        const a = this.accounts.get(handleSha256);
        return { x402: a ? this.view(a) : null, feeDue: a ? !a.feePaid : true };
    }

    configure(handleSha256: string, setup: X402Setup, requestId: string): X402ConfigureResult {
        const request = JSON.stringify([handleSha256, canonicalSetup(setup)]);
        const stored = this.configured.get(requestId);
        if (stored) {
            return stored.request === request
                ? stored.answer
                : { status: "refused", reason: "idempotency_conflict" };
        }
        const refuse = (reason: X402ConfigureRefused["reason"]): X402ConfigureResult => ({
            status: "refused",
            reason,
        });
        const a = this.accounts.get(handleSha256);
        if (!a) return refuse("no_account");
        if (a.state !== "open") return refuse("sandbox_ended");
        const pins = setup.services ?? [];
        const needsPayment = pins.some((p) => {
            const h = a.services.find((s) => s.serviceId === p.serviceId);
            return (
                !h ||
                h.method !== p.method ||
                h.host !== p.host ||
                h.prefix !== p.prefix ||
                h.payTo !== p.payTo
            );
        });
        const unheldDisable = (setup.disable ?? []).some(
            (id) => !a.services.some((s) => s.serviceId === id),
        );
        if (needsPayment || unheldDisable) return refuse("needs_payment");
        if (pins.some((p) => p.maxPriceMicros > this.terms.maxPricePerCallMicros)) {
            return refuse("price_above_ceiling");
        }
        const disable = setup.disable ?? [];
        if (this.servicesAfter(a, pins, disable) > this.terms.maxServices) {
            return refuse("too_many_services");
        }
        const limit =
            setup.spendPerMinuteMicros ??
            a.spendPerMinute ??
            this.terms.defaultSpendPerMinuteMicros;
        if (this.rateProblem(a, pins, disable, limit)) return refuse("spend_rate_out_of_range");
        this.apply(a, setup);
        const answer: X402ConfigureResult = { status: "ok", x402: this.view(a) };
        this.configured.set(requestId, { request, answer });
        return answer;
    }

    sellers(hosts: string[]): Record<string, X402SellerStats> {
        const out: Record<string, X402SellerStats> = {};
        for (const h of hosts.slice(0, 20)) {
            const s = this.stats[h];
            if (s) out[h] = s;
        }
        return out;
    }
}

export interface DevPublicAnswer {
    status: number;
    body: Record<string, unknown>;
}

const idAlphabet = "abcdefghijklmnopqrstuvwxyz234567";
const minIdempotencyKeyLength = 16;
const solanaMainnet = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface StoredOrder extends OrderTerms {
    orderId: string;
    claim: string | null;
    state: "unpaid" | "paid" | "redeemed";
    createdAt: number;
    // The JSON of the payment that paid it, null when paid at the pay link
    paidBy: string | null;
    // The idempotencyKey of the call whose payment paid it
    paidKey: string | null;
    // The settled answer, a token order or an x402 allowance answer
    token: PaidOrder | PaidAllowanceOrder | RefusedOrder | null;
    // Null for an answer that never expires
    tokenExpiresAt: number | null;
    settled: SettledAllowance | null;
}

type SettledAllowance = Pick<PaidAllowanceOrder, "allowanceMicros" | "firstUse" | "x402" | "payer">;

const carriesAllowance = (t: Partial<OrderTerms>): boolean =>
    t.kind === "allowance" || (t.kind === "start" && (t.allowanceMicros ?? 0) > 0);

function newOrderId(): string {
    let id = "ord_";
    for (const byte of randomBytes(26)) id += idAlphabet[byte & 31];
    return id;
}

// Settles orders without charging, at once or at a loopback pay link, for a gateway that serves only this machine
export class DevPayments implements Payments {
    readonly mode = "dev";
    readonly requiresPayment: boolean;
    readonly x402: DevX402Ledger;
    private readonly key;
    private readonly payBaseUrl: string;
    private readonly orders = new Map<string, StoredOrder>();
    private readonly byKey = new Map<string, string>();

    constructor(
        seed: Buffer,
        private readonly ttlMs: number,
        private readonly now: () => number = Date.now,
        opts: DevPaymentsOptions = {},
    ) {
        this.key = orderKey(seed);
        this.requiresPayment = opts.requirePayment ?? false;
        this.payBaseUrl = opts.payBaseUrl ?? "http://127.0.0.1:8787";
        this.x402 = new DevX402Ledger({ ...devTerms, ...opts.terms });
    }

    x402Terms(_signal?: AbortSignal): Promise<X402Terms> {
        return Promise.resolve(this.x402.terms);
    }

    async x402Account(handleSha256: string, _signal?: AbortSignal): Promise<X402AccountAnswer> {
        return this.x402.account(handleSha256);
    }

    async x402Configure(
        handleSha256: string,
        setup: X402Setup,
        requestId: string,
        _signal?: AbortSignal,
    ): Promise<X402ConfigureResult> {
        const set = this.x402.takeConfigureRefusal();
        if (set) return set;
        return this.x402.configure(handleSha256, setup, requestId);
    }

    async x402Sellers(
        hosts: string[],
        _signal?: AbortSignal,
    ): Promise<Record<string, X402SellerStats>> {
        return this.x402.sellers(hosts);
    }

    private paid(o: StoredOrder): PaidOrder {
        const kind = o.kind as PaidOrder["kind"];
        const orderToken = signOrderToken(this.key, {
            order_id: o.orderId,
            kind,
            package_id: o.packageId,
            amount_micros: o.amountMicros,
            ...(kind === "start" && (o.allowanceMicros ?? 0) > 0
                ? { allowance_micros: o.allowanceMicros }
                : {}),
            expires_at: new Date(this.now() + this.ttlMs).toISOString(),
            ...(o.handleSha256 ? { handle_sha256: o.handleSha256 } : {}),
        });
        return {
            status: "paid",
            orderId: o.orderId,
            orderToken,
            payer: o.settled?.payer ?? "dev",
            kind,
            packageId: o.packageId,
            amountMicros: o.amountMicros,
            ...(o.handleSha256 ? { handleSha256: o.handleSha256 } : {}),
            ...(o.settled
                ? {
                      allowanceMicros: o.settled.allowanceMicros,
                      firstUse: o.settled.firstUse,
                      x402: o.settled.x402,
                  }
                : {}),
        };
    }

    // Settles an allowance-carrying order once and keeps its answer
    private settleStored(o: StoredOrder): OrderResult {
        const r = this.x402.settle(o.orderId, o);
        o.state = "redeemed";
        if ("status" in r) {
            o.tokenExpiresAt = null;
            o.token = r;
            return r;
        }
        o.settled = r;
        if (o.kind === "allowance") {
            o.tokenExpiresAt = null;
            o.token = {
                status: "paid",
                orderId: o.orderId,
                kind: "allowance",
                handleSha256: o.handleSha256 as string,
                amountMicros: o.amountMicros,
                ...r,
            };
        } else {
            o.tokenExpiresAt = this.now() + this.ttlMs;
            o.token = this.paid(o);
        }
        return o.token;
    }

    private store(
        orderId: string,
        terms: OrderTerms,
        extra: Partial<StoredOrder> = {},
    ): StoredOrder {
        const stored: StoredOrder = {
            orderId,
            kind: terms.kind,
            packageId: terms.packageId,
            amountMicros: terms.amountMicros,
            description: terms.description,
            ...(terms.handleSha256 ? { handleSha256: terms.handleSha256 } : {}),
            ...(terms.allowanceMicros !== undefined
                ? { allowanceMicros: terms.allowanceMicros }
                : {}),
            ...(terms.feeMicros !== undefined ? { feeMicros: terms.feeMicros } : {}),
            ...(terms.x402 !== undefined ? { x402: terms.x402 } : {}),
            claim: null,
            state: "paid",
            createdAt: this.now(),
            paidBy: null,
            paidKey: null,
            token: null,
            tokenExpiresAt: null,
            settled: null,
            ...extra,
        };
        this.orders.set(orderId, stored);
        return stored;
    }

    async order(req: OrderRequest): Promise<OrderResult> {
        const set = this.x402.takeOrderRefusal();
        if (set) return set;
        if ((req.description?.length ?? 0) > 200)
            return { status: "refused", reason: "bad_request" };
        return this.requiresPayment ? this.requireOrder(req) : this.settleAtOnce(req);
    }

    private settleAtOnce(req: OrderRequest): OrderResult {
        // An orderId with a claim or a payment and no terms asks after a stored order
        if (req.claim !== undefined || req.kind === undefined) {
            const stored = req.orderId === undefined ? undefined : this.orders.get(req.orderId);
            if (!stored) return this.unknown(req.orderId ?? "");
            return (stored.token as OrderResult | null) ?? this.paid(stored);
        }
        const orderId = req.orderId ?? req.idempotencyKey ?? randomUUID();
        const terms = req as OrderTerms;
        if (!carriesAllowance(terms)) return this.paid(this.store(orderId, terms));
        const known = this.orders.get(orderId);
        if (known?.token) return known.token;
        const refused = this.x402.admit(terms);
        if (refused) return refused;
        return this.settleStored(this.store(orderId, terms));
    }

    // Port §2, orderId only when the order is known or the id is well formed
    private unknown(orderId: string): RefusedOrder {
        return {
            status: "refused",
            ...(orderIdPattern.test(orderId) ? { orderId } : {}),
            reason: "order_unknown",
        };
    }

    private expired(o: StoredOrder): boolean {
        return o.state === "unpaid" && this.now() >= o.createdAt + devUnpaidTtlMs;
    }

    private awaiting(o: StoredOrder, withClaim: boolean): AwaitingPayment {
        const payUrl = `${this.payBaseUrl}/o/${o.orderId}`;
        return {
            status: "payment_required",
            orderId: o.orderId,
            ...(withClaim && o.claim ? { claim: o.claim } : {}),
            payUrl,
            paymentRequired: {
                x402Version: 2,
                resource: { url: payUrl, description: o.description, mimeType: "application/json" },
                accepts: [
                    {
                        scheme: "exact",
                        network: solanaMainnet,
                        asset: usdcMint,
                        amount: String(o.amountMicros),
                        payTo: "BugnetDevPayee",
                        maxTimeoutSeconds: 300,
                        extra: { memo: o.orderId },
                    },
                ],
            },
        };
    }

    private refuse(o: StoredOrder, reason: RefusalReason): RefusedOrder {
        return { status: "refused", orderId: o.orderId, reason };
    }

    // Follows Payments' handleOrderRequest, with the pay link standing in for the chain
    private requireOrder(req: OrderRequest): OrderResult {
        const memo = paymentMemo(req.payment);
        const keyed =
            req.idempotencyKey !== undefined && req.idempotencyKey.length >= minIdempotencyKeyLength
                ? req.idempotencyKey
                : null;
        let stored: StoredOrder | undefined;
        let replay = false;
        if (req.orderId !== undefined || memo !== null) {
            const id = req.orderId ?? (memo as string);
            stored = this.orders.get(id);
            if (!stored) return this.unknown(id);
        } else if (keyed !== null && this.byKey.has(keyed)) {
            stored = this.orders.get(this.byKey.get(keyed) as string);
            replay = true;
        }
        if (!stored) {
            if (carriesAllowance(req)) {
                const refused = this.x402.admit(req as OrderTerms);
                if (refused) return refused;
            }
            const orderId = newOrderId();
            const created = this.store(orderId, req as OrderTerms, {
                state: "unpaid",
                claim: randomBytes(32).toString("base64url"),
            });
            if (keyed !== null) this.byKey.set(keyed, orderId);
            return this.awaiting(created, true);
        }
        const differs =
            (req.kind !== undefined && req.kind !== stored.kind) ||
            (req.packageId !== undefined && req.packageId !== stored.packageId) ||
            (req.amountMicros !== undefined && req.amountMicros !== stored.amountMicros) ||
            (req.handleSha256 !== undefined && req.handleSha256 !== stored.handleSha256) ||
            (req.allowanceMicros !== undefined &&
                req.allowanceMicros !== (stored.allowanceMicros ?? 0)) ||
            (req.feeMicros !== undefined && req.feeMicros !== (stored.feeMicros ?? 0)) ||
            (req.x402 !== undefined && canonicalSetup(req.x402) !== canonicalSetup(stored.x402));
        if (differs) return this.refuse(stored, replay ? "idempotency_conflict" : "terms_mismatch");

        // The payment settles first and the claim is checked after it (port §2)
        let authorized = false;
        if (req.payment !== undefined) {
            // Payments checks the memo of a payment for an unpaid order before anything else
            const unpaid = stored.state === "unpaid" && !this.expired(stored);
            if (memo === null && unpaid) return this.refuse(stored, "payment_order_mismatch");
            if (memo !== null) {
                if (memo !== stored.orderId) return this.refuse(stored, "payment_order_mismatch");
                const json = JSON.stringify(req.payment);
                if (stored.state === "unpaid") {
                    if (!this.expired(stored)) {
                        stored.state = "paid";
                        stored.paidBy = json;
                        stored.paidKey = keyed;
                    }
                    authorized = true;
                } else {
                    // Port §2, a public settled payment proves nothing without its own call's key
                    authorized =
                        stored.paidBy === json &&
                        stored.paidKey !== null &&
                        stored.paidKey === keyed;
                }
            }
        }
        if (req.claim !== undefined) {
            if (req.claim !== stored.claim) return this.refuse(stored, "claim_mismatch");
            authorized = true;
        }
        if (this.expired(stored)) return this.refuse(stored, "order_expired");
        if (!authorized) {
            if (stored.state === "unpaid") return this.awaiting(stored, replay);
            return this.refuse(stored, "paid_claim_required");
        }
        if (stored.state === "unpaid") return this.awaiting(stored, false);
        if (stored.state === "paid") {
            if (carriesAllowance(stored)) return this.settleStored(stored);
            stored.state = "redeemed";
            stored.tokenExpiresAt = this.now() + this.ttlMs;
            stored.token = this.paid(stored);
            return stored.token;
        }
        if (stored.tokenExpiresAt === null || this.now() < stored.tokenExpiresAt) {
            return stored.token as OrderResult;
        }
        return this.refuse(stored, "token_expired");
    }

    // Marks an unpaid order paid, in place of Payments' 402 for a request with no payment header
    pay(orderId: string): DevPublicAnswer {
        const stored = this.orders.get(orderId);
        if (!stored) return { status: 404, body: { error: "order_unknown" } };
        if (this.expired(stored)) {
            return { status: 410, body: { error: "order_expired", orderId } };
        }
        if (stored.state === "unpaid") stored.state = "paid";
        return { status: 200, body: { paid: true, orderId } };
    }

    status(orderId: string): DevPublicAnswer {
        const stored = this.orders.get(orderId);
        if (!stored) return { status: 404, body: { error: "order_unknown" } };
        const state = this.expired(stored)
            ? "expired"
            : stored.state === "unpaid"
              ? "unpaid"
              : "paid";
        return {
            status: 200,
            body: {
                orderId,
                state,
                expiresAt: new Date(stored.createdAt + devUnpaidTtlMs).toISOString(),
            },
        };
    }

    async abandon(): Promise<void> {}
}
