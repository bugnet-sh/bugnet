import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    address,
    generateKeyPairSigner,
    getBase58Decoder,
    getBase64Encoder,
    getTransactionDecoder,
    type KeyPairSigner,
} from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SignerSettings } from "./config.ts";
import { generateKeyPairSync } from "node:crypto";
import { signerFromBytes } from "./keyfile.ts";
import { buildKeyPayment, KeyPayer, type Offer } from "./keypay.ts";
import { silentLog, stderrLog } from "./log.ts";
import type { PaymentStep } from "./pay.ts";
import { SpendLedger } from "./spend.ts";

const origin = "https://pay.bugnet.sh";
const orderId = "ord_test123";
const recipient = "Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw";
const feePayer = "73iCm2eWpXsEqTpYkNHe4VoiR4Eq7nyCLv9wYZzEnFM9";
const allowanceWallet = "9gw8RJhnpnYgrfhj1UWAFbQvDVfYGYVk8ndb6bLUmzDo";

// Computed once from bugnet-payments src/x402/build.ts buildPaymentTransaction with these inputs
const golden =
    "800201040859d7df0b5435cb5a172fef6f61f85b7df4e5bc20d18cd06b2883a40be9017f80069b8857feab8184" +
    "fb687f634618c035dac439dc1aeb3b5598a0f000000000016deba598270b92a714a14bac14dd8b3766d6140fa7" +
    "a92d1fb204c7ea05ac61d9b68f785a0402bc7e8ae32ba8d13745441ca39c1219c3c88a50a2b9ff5c40eae60306" +
    "466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a40000000c6fa7af3bedbad3a3d65f36aabc974" +
    "31b1bbe4c2d2f6e0e47ca60203452f5d61054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa840" +
    "4105448d06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a98118597eee83752cf5" +
    "facbfc8b88bf507323f50a1f6040077ce28178f329795a0404000502204e00000400090301000000000000000704" +
    "030502010a0c50c30000000000000606000b6f72645f7465737431323300";

function offer(): Offer {
    return {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: "50000",
        payTo: recipient,
        maxTimeoutSeconds: 300,
        extra: {
            feePayer,
            memo: orderId,
            transactionVersions: [0],
            recentBlockhash: "9gw8RJhnpnYgrfhj1UWAFbQvDVfYGYVk8ndb6bLUmzDo",
            lastValidBlockHeight: "312345678",
        },
    };
}

const step: PaymentStep = {
    tool: "bugnet_start",
    orderId,
    claim: "c".repeat(43),
    payUrl: `${origin}/o/${orderId}`,
    amountMicros: 50_000,
};

const settings: SignerSettings = {
    paySigner: "key",
    maxPaymentMicros: 1_000_000,
    dailyMicros: 5_000_000,
    payTo: [recipient],
    feePayer: [feePayer],
    keyPaysAllowances: false,
    allowancePayTo: [allowanceWallet],
    keyOrigin: origin,
};

interface Sent {
    url: string;
    headers: Record<string, string>;
}

function fakePayments(o: unknown, submit: () => Response = () => Response.json({ paid: true })) {
    const sent: Sent[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        sent.push({ url, headers });
        if (headers["PAYMENT-SIGNATURE"] !== undefined) return submit();
        const pr = { x402Version: 2, resource: { url: `${origin}/o/${orderId}` }, accepts: [o] };
        return Response.json(pr, {
            status: 402,
            headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") },
        });
    }) as typeof fetch;
    return { sent, fetcher };
}

let dir = "";
let key: KeyPairSigner;
let ledger: SpendLedger;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bugnet-keypay-"));
    key = await generateKeyPairSigner();
    ledger = new SpendLedger({ dir: join(dir, "spend") });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

function payer(fetcher: typeof fetch, s: SignerSettings = settings) {
    return new KeyPayer({
        origin,
        settings: s,
        signer: async () => key,
        ledger,
        log: silentLog,
        fetch: fetcher,
    });
}

describe("key payment transaction", () => {
    it("matches Payments' buildPaymentTransaction byte for byte", async () => {
        const tx = await buildKeyPayment(
            offer(),
            address("So11111111111111111111111111111111111111112"),
        );
        expect(Buffer.from(tx.messageBytes).toString("hex")).toBe(golden);
    });
});

// The live source, from BUGNET_PAYMENTS_DIR or a Payments checkout next to this repo, so a change
// there fails here
const paymentsBuild = resolve(
    process.env.BUGNET_PAYMENTS_DIR ?? resolve(import.meta.dirname, "../../../../bugnet-payments"),
    "src/x402/build.ts",
);

describe.skipIf(!existsSync(paymentsBuild))("key payment against Payments' own builder", () => {
    it("builds the same message bytes as buildPaymentTransaction", async () => {
        type Build = (req: Offer, payer: string) => Promise<{ messageBytes: Uint8Array }>;
        const mod = (await import(/* @vite-ignore */ paymentsBuild)) as {
            buildPaymentTransaction: Build;
        };
        const payer = address("So11111111111111111111111111111111111111112");
        const theirs = await mod.buildPaymentTransaction(offer(), payer);
        const ours = await buildKeyPayment(offer(), payer);
        expect(Buffer.from(ours.messageBytes).toString("hex")).toBe(
            Buffer.from(theirs.messageBytes).toString("hex"),
        );
    });
});

describe("key payer", () => {
    it("signs only its own slot and sends the checkout's payload", async () => {
        const { sent, fetcher } = fakePayments(offer());
        expect(await payer(fetcher).pay(step, 50_000)).toEqual({ kind: "paid" });
        expect(sent).toHaveLength(2);
        const submit = sent[1] as Sent;
        expect(submit.url).toBe(`${origin}/o/${orderId}`);
        expect(submit.headers["Bugnet-Client"]).toBeUndefined();
        const payload = JSON.parse(
            Buffer.from(submit.headers["PAYMENT-SIGNATURE"] as string, "base64").toString(),
        );
        expect(payload.x402Version).toBe(2);
        expect(payload.accepted).toEqual(offer());
        const tx = getTransactionDecoder().decode(
            getBase64Encoder().encode(payload.payload.transaction),
        );
        const built = await buildKeyPayment(offer(), key.address);
        expect(Buffer.from(tx.messageBytes)).toEqual(Buffer.from(built.messageBytes));
        expect(tx.signatures[address(feePayer)]).toBeNull();
        expect(tx.signatures[key.address]).not.toBeNull();
        expect(await ledger.spentToday()).toBe(50_000);
    });

    it("signs nothing for an order already paid", async () => {
        const sent: string[] = [];
        const fetcher = (async (url: string) => {
            sent.push(url);
            return Response.json({ paid: true, orderId });
        }) as typeof fetch;
        expect(await payer(fetcher).pay(step, 50_000)).toEqual({ kind: "paid" });
        expect(sent).toHaveLength(1);
    });

    it("counts a server error after submit as spent and unknown", async () => {
        const { fetcher } = fakePayments(offer(), () => Response.json({}, { status: 502 }));
        expect(await payer(fetcher).pay(step, 50_000)).toEqual({ kind: "unknown" });
        expect(await ledger.spentToday()).toBe(50_000);
    });

    it("frees the reservation when Payments refuses before money moved", async () => {
        const { fetcher } = fakePayments(offer(), () =>
            Response.json({ refused: "payment_malformed" }, { status: 400 }),
        );
        expect(await payer(fetcher).pay(step, 50_000)).toEqual({
            kind: "declined",
            reason: "payment_malformed",
        });
        expect(await ledger.spentToday()).toBe(0);
    });

    it("frees the reservation after submit only for a refusal Payments makes before broadcast", async () => {
        const answers: [() => Response, boolean][] = [
            [() => Response.json({}, { status: 400 }), true],
            [() => Response.json({ refused: "payment_replayed" }, { status: 409 }), true],
            [() => Response.json({ error: "rate_limited" }, { status: 429 }), true],
            [() => Response.json({ refused: "order_paid" }, { status: 404 }), true],
            [() => new Response("nope", { status: 418 }), true],
            [() => Response.json({ refused: "payment_invalid" }, { status: 400 }), false],
            [() => Response.json({ refused: "payment_order_mismatch" }, { status: 400 }), false],
            [() => Response.json({ refused: "too_many_attempts" }, { status: 429 }), false],
            [() => Response.json({ refused: "payer_blocked" }, { status: 403 }), false],
        ];
        for (const [i, [answer, kept]] of answers.entries()) {
            ledger = new SpendLedger({ dir: join(dir, `spend-${i}`) });
            const { sent, fetcher } = fakePayments(offer(), answer);
            await payer(fetcher).pay(step, 50_000);
            expect(sent, String(i)).toHaveLength(2);
            expect(await ledger.spentToday(), String(i)).toBe(kept ? 50_000 : 0);
        }
    });

    type Case = [string, (o: Offer) => unknown, string, SignerSettings?, PaymentStep?];
    const cases: Case[] = [
        [
            "origin",
            (o) => o,
            "key_origin",
            settings,
            { ...step, payUrl: `https://evil.sh/o/${orderId}` },
        ],
        ["path", (o) => o, "key_path", settings, { ...step, payUrl: `${origin}/o/${orderId}/x` }],
        ["no pins", (o) => o, "key_no_pins", { ...settings, payTo: [] }],
        ["scheme", (o) => ({ ...o, scheme: "upto" }), "key_network"],
        ["network", (o) => ({ ...o, network: "solana:devnet" }), "key_network"],
        ["asset", (o) => ({ ...o, asset: feePayer }), "key_network"],
        ["memo missing", (o) => ({ ...o, extra: { ...o.extra, memo: undefined } }), "key_memo"],
        ["memo other", (o) => ({ ...o, extra: { ...o.extra, memo: "ord_other" } }), "key_memo"],
        ["pay_to", (o) => ({ ...o, payTo: feePayer }), "key_pay_to"],
        [
            "fee payer unpinned",
            (o) => ({ ...o, extra: { ...o.extra, feePayer: recipient } }),
            "key_fee_payer",
        ],
        [
            "no blockhash",
            (o) => ({ ...o, extra: { ...o.extra, recentBlockhash: undefined } }),
            "key_no_blockhash",
        ],
        ["over the approved price", (o) => ({ ...o, amount: "50001" }), "key_price"],
        [
            "over max_payment_usd",
            (o) => o,
            "key_payment_cap",
            { ...settings, maxPaymentMicros: 49_999 },
        ],
        ["over the daily cap", (o) => o, "key_daily_cap", { ...settings, dailyMicros: 49_999 }],
    ];

    it.each(cases)("refuses before signing: %s", async (_, change, reason, s, st) => {
        const { sent, fetcher } = fakePayments(change(offer()));
        const out = await payer(fetcher, s).pay(st ?? step, 50_000);
        expect(out).toMatchObject({ reason });
        expect(sent.filter((x) => x.headers["PAYMENT-SIGNATURE"] !== undefined)).toEqual([]);
        expect(await ledger.spentToday()).toBe(0);
    });

    it("refuses an order another payment already reserved, apart from the daily cap", async () => {
        expect(await ledger.claim(orderId, 50_000, 5_000_000)).toBe("reserved");
        const { sent, fetcher } = fakePayments(offer());
        expect(await payer(fetcher).pay(step, 50_000)).toEqual({
            kind: "unavailable",
            reason: "key_already_reserved",
        });
        expect(sent.filter((x) => x.headers["PAYMENT-SIGNATURE"] !== undefined)).toEqual([]);
        expect(await ledger.spentToday()).toBe(50_000);
    });

    it("refuses a fee payer that is the key itself", async () => {
        const own = { ...offer(), extra: { ...offer().extra, feePayer: key.address } };
        const { sent, fetcher } = fakePayments(own);
        const s = { ...settings, feePayer: [feePayer, key.address] };
        expect(await payer(fetcher, s).pay(step, 50_000)).toMatchObject({
            reason: "key_fee_payer",
        });
        expect(sent).toHaveLength(1);
    });

    it("pays no allowance unless key_pays_allowances is set, and then only to its pinned wallet", async () => {
        const budget: PaymentStep = { ...step, tool: "bugnet_x402_budget" };
        const toAllowance = { ...offer(), payTo: allowanceWallet };
        for (const st of [budget, { ...step, allowance: true } as PaymentStep]) {
            const { sent, fetcher } = fakePayments(toAllowance);
            expect(await payer(fetcher).pay(st, 50_000)).toEqual({
                kind: "unavailable",
                reason: "key_allowance",
            });
            expect(sent).toEqual([]);
        }
        // A step that looked like time but whose fresh challenge pays the allowance wallet
        const { sent, fetcher } = fakePayments(toAllowance);
        expect(await payer(fetcher).pay(step, 50_000)).toMatchObject({ reason: "key_pay_to" });
        expect(sent).toHaveLength(1);
        const allowed = { ...settings, keyPaysAllowances: true };
        const ok = fakePayments(toAllowance);
        expect(await payer(ok.fetcher, allowed).pay(budget, 50_000)).toEqual({ kind: "paid" });
    });

    it("pays an allowance only to an allowance_pay_to wallet when one is pinned", async () => {
        const allowed = { ...settings, keyPaysAllowances: true };
        const budget: PaymentStep = { ...step, tool: "bugnet_x402_budget" };
        for (const st of [budget, { ...step, allowance: true } as PaymentStep]) {
            const toTime = fakePayments(offer());
            expect(await payer(toTime.fetcher, allowed).pay(st, 50_000)).toMatchObject({
                reason: "key_pay_to",
            });
            expect(toTime.sent).toHaveLength(1);
        }
        // Unpinned, an allowance may pay a pay_to wallet
        const open = fakePayments(offer());
        const unpinned = { ...allowed, allowancePayTo: [] };
        expect(await payer(open.fetcher, unpinned).pay(budget, 50_000)).toEqual({ kind: "paid" });
        // Time still pays either set when allowances are on
        ledger = new SpendLedger({ dir: join(dir, "spend-time") });
        const time = fakePayments({ ...offer(), payTo: allowanceWallet });
        expect(await payer(time.fetcher, allowed).pay(step, 50_000)).toEqual({ kind: "paid" });
    });

    it("never puts the key or the signed transaction in the log or the outcome", async () => {
        const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
        const bytes = new Uint8Array(64);
        bytes.set(Buffer.from(jwk.d as string, "base64url"));
        bytes.set(Buffer.from(jwk.x as string, "base64url"), 32);
        const forms = [
            `[${Array.from(bytes).join(",")}]`,
            Array.from(bytes).join(","),
            getBase58Decoder().decode(bytes),
            getBase58Decoder().decode(bytes.subarray(0, 32)),
            Buffer.from(bytes).toString("hex"),
            Buffer.from(bytes).toString("base64"),
        ];
        key = await signerFromBytes(bytes.slice());
        const submits = [
            () => Response.json({ paid: true }),
            () => Response.json({ refused: "payment_malformed" }, { status: 400 }),
            () => Response.json({}, { status: 502 }),
        ];
        for (const [i, submit] of submits.entries()) {
            const { sent, fetcher } = fakePayments(offer(), submit);
            const lines: string[] = [];
            const p = new KeyPayer({
                origin,
                settings,
                signer: async () => key,
                ledger: new SpendLedger({ dir: join(dir, `spend-${i}`) }),
                log: stderrLog((l) => lines.push(l)),
                fetch: fetcher,
            });
            const out = JSON.stringify(await p.pay(step, 50_000));
            const header = sent[1]!.headers["PAYMENT-SIGNATURE"] as string;
            const wire = JSON.parse(Buffer.from(header, "base64").toString()).payload.transaction;
            const text = lines.join("") + out;
            expect(lines.length).toBeGreaterThan(0);
            for (const f of [...forms, wire, wire.slice(0, 40), header.slice(0, 40)]) {
                expect(text).not.toContain(f);
            }
        }
    });
});
