// Picks the Payments client the settings name
import type { Config } from "../config.ts";
import { DevPayments } from "./dev.ts";
import { HttpPayments } from "./http.ts";
import type { Payments } from "./port.ts";

// DevPayments for mode dev, its pay links on public_url's origin, else HttpPayments
export function paymentsFor(cfg: Config): Payments {
    if (cfg.payments.mode === "dev") {
        return new DevPayments(
            cfg.secrets.orderPrivateKey as Buffer,
            cfg.payments.order_token_ttl,
            Date.now,
            {
                requirePayment: cfg.payments.dev_require_payment,
                payBaseUrl: new URL(cfg.public_url).origin,
            },
        );
    }
    return new HttpPayments(cfg.payments.url, cfg.secrets.paymentsToken);
}
