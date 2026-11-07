import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startHttp } from "@bugnet/gateway/server";
import { DevPayments, testConfig, testDeps, testOrderSeed } from "@bugnet/gateway/testing";
import { afterAll, describe, expect, it } from "vitest";
import { PayCli, type PaymentStep } from "./pay.ts";
import { recordingLog } from "./testing/harness.ts";

// Runs the real pay CLI against a dev order served on this machine
describe.skipIf(process.env.BUGNET_LIVE_PAY !== "1")("the real pay CLI", () => {
    const stops: (() => Promise<void>)[] = [];
    afterAll(async () => {
        for (const stop of stops.splice(0)) await stop();
    });

    it("pays a dev order at its loopback pay link", async () => {
        const probe = createServer();
        await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
        const { port } = probe.address() as AddressInfo;
        await new Promise((r) => probe.close(r));
        const origin = `http://127.0.0.1:${port}`;
        const dev = new DevPayments(testOrderSeed, 600_000, Date.now, {
            requirePayment: true,
            payBaseUrl: origin,
        });
        const http = await startHttp(
            testDeps({ config: testConfig(`listen_addr = "127.0.0.1:${port}"`), payments: dev }),
        );
        stops.push(() => new Promise((r) => http.close(() => r())));
        const r = await dev.order({
            kind: "start",
            packageId: "small-10m",
            amountMicros: 50_000,
            description: "live pay check",
        });
        if (r.status !== "payment_required" || r.claim === undefined) {
            throw new Error(`no payment step, the dev order answered ${r.status}`);
        }
        const step: PaymentStep = {
            tool: "bugnet_start",
            orderId: r.orderId,
            claim: r.claim,
            payUrl: r.payUrl,
            amountMicros: 50_000,
        };
        const { log, lines } = recordingLog();
        const cli = new PayCli({
            command: process.env.BUGNET_PAY_COMMAND ?? "pay",
            origin,
            env: process.env,
            log,
        });
        const outcome = await cli.pay(step, 50_000, () => {});
        expect(outcome, `outcome ${JSON.stringify(outcome)}, log ${lines.join("")}`).toEqual({
            kind: "paid",
        });
        expect(dev.status(r.orderId).body.state).toBe("paid");
    }, 320_000);
});
