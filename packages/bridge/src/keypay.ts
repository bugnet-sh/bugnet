// Pays a Bugnet order from the local wallet file, building the transaction itself and signing
// nothing it did not build. Ported byte for byte from Payments' src/x402/build.ts
import {
    type Address,
    address,
    appendTransactionMessageInstructions,
    blockhash,
    compileTransaction,
    createNoopSigner,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    type Instruction,
    type KeyPairSigner,
    partiallySignTransaction,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    type Transaction,
} from "@solana/kit";
import {
    getSetComputeUnitLimitInstruction,
    getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
    findAssociatedTokenPda,
    getTransferCheckedInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import type { SignerSettings } from "./config.ts";
import { KeyError } from "./keyfile.ts";
import type { Log } from "./log.ts";
import { spentRefusals } from "./orders.ts";
import {
    type OrderPayer,
    type PaymentStep,
    type PayOutcome,
    payTimeoutMs,
    solanaMainnet,
    usdcMint,
} from "./pay.ts";
import { LedgerError, type SpendLedger } from "./spend.ts";

const usdc = address(usdcMint);
const usdcDecimals = 6;
// The legacy Memo program, as x402 and Payments use
const memoProgram = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const challengeTimeoutMs = 15_000;
const jsonAccept = { Accept: "application/json" };

export interface Offer {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    extra: {
        feePayer: string;
        memo: string;
        recentBlockhash: string;
        lastValidBlockHeight: string;
        transactionVersions?: unknown;
    };
}

async function usdcAta(owner: Address): Promise<Address> {
    const [ata] = await findAssociatedTokenPda({
        owner,
        mint: usdc,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return ata;
}

export async function buildKeyPayment(offer: Offer, payer: Address): Promise<Transaction> {
    const { feePayer, memo, recentBlockhash, lastValidBlockHeight } = offer.extra;
    const transfer = getTransferCheckedInstruction({
        source: await usdcAta(payer),
        mint: usdc,
        destination: await usdcAta(address(offer.payTo)),
        // The noop signer only marks the authority as a signer in the message
        authority: createNoopSigner(payer),
        amount: BigInt(offer.amount),
        decimals: usdcDecimals,
    });
    const memoInstruction: Instruction = {
        programAddress: memoProgram,
        data: new TextEncoder().encode(memo),
    };
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(address(feePayer), m),
        (m) =>
            setTransactionMessageLifetimeUsingBlockhash(
                {
                    blockhash: blockhash(recentBlockhash),
                    lastValidBlockHeight: BigInt(lastValidBlockHeight),
                },
                m,
            ),
        (m) =>
            appendTransactionMessageInstructions(
                [
                    getSetComputeUnitLimitInstruction({ units: 20_000 }),
                    getSetComputeUnitPriceInstruction({ microLamports: 1n }),
                    transfer,
                    memoInstruction,
                ],
                m,
            ),
    );
    return compileTransaction(message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface Challenge {
    resource: unknown;
    offer: unknown;
}

function decodeChallenge(header: string | null): Challenge | null {
    if (header === null) return null;
    try {
        const pr: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
        if (!isRecord(pr) || pr.x402Version !== 2 || !Array.isArray(pr.accepts)) return null;
        return { resource: pr.resource, offer: pr.accepts[0] };
    } catch {
        return null;
    }
}

export type Refusal = { kind: "declined" | "unavailable"; reason: string };

const declined = (reason: string): Refusal => ({ kind: "declined", reason: `key_${reason}` });
const unavailable = (reason: string): Refusal => ({ kind: "unavailable", reason: `key_${reason}` });

// The step's link must be this origin's /o/{orderId}, nothing more
export function stepRefusal(step: PaymentStep, origin: string): Refusal | null {
    const url = new URL(step.payUrl);
    if (url.origin !== origin || url.username !== "" || url.password !== "") {
        return declined("origin");
    }
    if (url.pathname !== `/o/${step.orderId}` || url.search !== "" || url.hash !== "") {
        return declined("path");
    }
    return null;
}

// Every check on the offer before a reservation, in a fixed order; the first failure wins
export function offerRefusal(
    step: PaymentStep,
    offer: unknown,
    settings: SignerSettings,
    maxMicros: number,
    own: string,
): Refusal | null {
    if (!isRecord(offer) || !isRecord(offer.extra)) return declined("challenge");
    const extra = offer.extra;
    if (offer.scheme !== "exact" || offer.network !== solanaMainnet || offer.asset !== usdcMint) {
        return declined("network");
    }
    if (typeof extra.memo !== "string" || extra.memo !== step.orderId) return declined("memo");
    const payable = settings.keyPaysAllowances
        ? [...settings.payTo, ...settings.allowancePayTo]
        : settings.payTo;
    if (typeof offer.payTo !== "string" || !payable.includes(offer.payTo)) {
        return declined("pay_to");
    }
    if (
        typeof extra.feePayer !== "string" ||
        !settings.feePayer.includes(extra.feePayer) ||
        extra.feePayer === own
    ) {
        return declined("fee_payer");
    }
    const versions = extra.transactionVersions;
    if (versions !== undefined && !(Array.isArray(versions) && versions.includes(0))) {
        return declined("version");
    }
    if (
        typeof extra.recentBlockhash !== "string" ||
        typeof extra.lastValidBlockHeight !== "string" ||
        !/^\d{1,20}$/.test(extra.lastValidBlockHeight)
    ) {
        return unavailable("no_blockhash");
    }
    if (typeof offer.amount !== "string" || !/^\d{1,15}$/.test(offer.amount)) {
        return declined("amount");
    }
    const amount = Number(offer.amount);
    if (amount <= 0 || amount > maxMicros) return declined("price");
    if (amount > settings.maxPaymentMicros) return unavailable("payment_cap");
    return null;
}

async function reasonOf(res: Response): Promise<string> {
    const body: unknown = await res.json().catch(() => null);
    const field = (name: string) => {
        const v = isRecord(body) ? body[name] : undefined;
        return typeof v === "string" && /^[a-z0-9_]{1,64}$/.test(v) ? v : undefined;
    };
    return field("refused") ?? field("error") ?? `http_${res.status}`;
}

function isAllowanceStep(step: PaymentStep): boolean {
    return step.allowance === true || step.tool === "bugnet_x402_budget";
}

// Allowance orders go to the key unless key_pays_allowances = false, then to today's path:
// the pay CLI with Touch ID, or the pay link when there is none
export function routeAllowances(
    key: OrderPayer,
    other: OrderPayer | null,
    keyPaysAllowances: boolean,
): OrderPayer {
    return {
        pay(step, maxMicros, onProgress) {
            if (keyPaysAllowances || !isAllowanceStep(step)) {
                return key.pay(step, maxMicros, onProgress);
            }
            if (other) return other.pay(step, maxMicros, onProgress);
            return Promise.resolve({ kind: "unavailable", reason: "key_allowance" });
        },
    };
}

export interface KeyPayerOptions {
    origin: string;
    settings: SignerSettings;
    // Loads the wallet file; called per payment until it succeeds
    signer: () => Promise<KeyPairSigner>;
    ledger: SpendLedger;
    log: Log;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

export class KeyPayer implements OrderPayer {
    private readonly opts: KeyPayerOptions;

    constructor(opts: KeyPayerOptions) {
        this.opts = opts;
    }

    async pay(step: PaymentStep, maxMicros: number): Promise<PayOutcome> {
        const { log } = this.opts;
        log.info("key pay started", { orderId: step.orderId });
        const outcome = await this.attempt(step, maxMicros);
        log.info("key pay finished", {
            orderId: step.orderId,
            outcome: outcome.kind,
            ...("reason" in outcome ? { reason: outcome.reason } : {}),
        });
        return outcome;
    }

    private async attempt(step: PaymentStep, maxMicros: number): Promise<PayOutcome> {
        const { origin, settings, ledger, log } = this.opts;
        const fetcher = this.opts.fetch ?? fetch;
        const early = stepRefusal(step, origin);
        if (early) return early;
        if (isAllowanceStep(step) && !settings.keyPaysAllowances) return unavailable("allowance");
        if (settings.payTo.length === 0 || settings.feePayer.length === 0) {
            return unavailable("no_pins");
        }
        let signer: KeyPairSigner;
        try {
            signer = await this.opts.signer();
        } catch (e) {
            return unavailable(e instanceof KeyError ? e.code : "wallet");
        }
        const orderUrl = `${origin}/o/${step.orderId}`;
        let first: Response;
        try {
            first = await fetcher(orderUrl, {
                headers: jsonAccept,
                redirect: "error",
                signal: AbortSignal.timeout(challengeTimeoutMs),
            });
        } catch {
            return unavailable("fetch");
        }
        if (first.status === 200) return { kind: "paid" };
        // Settling: the bridge rereads the order's status and redeems once it is paid
        if (first.status === 202) return { kind: "unknown" };
        if (first.status === 429 || first.status >= 500) return unavailable("busy");
        if (first.status !== 402) return { kind: "declined", reason: await reasonOf(first) };
        const challenge = decodeChallenge(first.headers.get("PAYMENT-REQUIRED"));
        if (challenge === null) return declined("challenge");
        const refusal = offerRefusal(step, challenge.offer, settings, maxMicros, signer.address);
        if (refusal) return refusal;
        const offer = challenge.offer as Offer;
        const amount = Number(offer.amount);
        try {
            if (!(await ledger.reserve(step.orderId, amount, settings.dailyMicros))) {
                return unavailable("daily_cap");
            }
        } catch (e) {
            return unavailable(e instanceof LedgerError ? e.code : "ledger");
        }
        let wire: string;
        try {
            const tx = await buildKeyPayment(offer, signer.address);
            wire = getBase64EncodedWireTransaction(
                await partiallySignTransaction([signer.keyPair], tx),
            );
        } catch {
            await ledger.settle(step.orderId, false).catch(() => {});
            return unavailable("build");
        }
        const payment = {
            x402Version: 2,
            resource: challenge.resource,
            accepted: challenge.offer,
            payload: { transaction: wire },
        };
        const outcome = await this.submit(fetcher, orderUrl, payment);
        // Anything but a clear refusal before broadcast stays counted
        const spent =
            outcome.kind === "paid" ||
            outcome.kind === "unknown" ||
            (outcome.kind === "declined" && spentRefusals.has(outcome.reason));
        await ledger.settle(step.orderId, spent).catch(() => {
            log.warn("key ledger settle failed", { orderId: step.orderId });
        });
        return outcome;
    }

    private async submit(
        fetcher: typeof fetch,
        orderUrl: string,
        payment: unknown,
    ): Promise<PayOutcome> {
        let res: Response;
        try {
            // Payments records any other client than its checkout as pay_cli; it has no "key" label
            res = await fetcher(orderUrl, {
                headers: {
                    ...jsonAccept,
                    "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payment)).toString("base64"),
                },
                redirect: "error",
                signal: AbortSignal.timeout(this.opts.timeoutMs ?? payTimeoutMs),
            });
        } catch {
            // The server may have broadcast before the connection dropped
            return { kind: "unknown" };
        }
        if (res.status === 200) return { kind: "paid" };
        if (res.status === 202 || res.status >= 500) return { kind: "unknown" };
        if (res.status === 429) return { kind: "unavailable", reason: "key_busy" };
        return { kind: "declined", reason: await reasonOf(res) };
    }
}
