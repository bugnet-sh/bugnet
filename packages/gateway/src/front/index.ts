import type { Server as HttpServer } from "node:http";
import { join } from "node:path";
import { acmeDomains, ConfigError, type Settings } from "../config.ts";
import type { Log } from "../log.ts";
import { Acme, acmeOrder, describePair, type Order } from "./acme.ts";
import { CertStore } from "./certs.ts";
import { startFront, type Front } from "./tls.ts";

export interface TlsFront {
    front: Front;
    certs: CertStore;
    acme: Acme | undefined;
    // Rereads the certificate files, as SIGHUP asks
    reload(): void;
    close(): Promise<void>;
}

export async function startTlsFront(
    settings: Settings,
    http: HttpServer,
    log: Log,
    order?: Order,
): Promise<TlsFront> {
    const f = settings.front;
    const acmeOn = f.acme_directory !== "";
    const certs = acmeOn
        ? new CertStore(join(f.acme_dir, "cert.pem"), join(f.acme_dir, "key.pem"))
        : new CertStore(f.cert_file, f.key_file);
    try {
        log.info("certificate loaded", describePair(certs.reload()));
    } catch (e) {
        if (!acmeOn) throw new ConfigError(`front certificate: ${(e as Error).message}`);
        log.info("no usable certificate yet, ACME orders one", { err: (e as Error).message });
    }
    const front = await startFront({ settings: f, certs, http, log });
    const acme = acmeOn
        ? new Acme({
              dir: f.acme_dir,
              domains: acmeDomains(settings),
              renewBeforeMs: f.acme_renew_before,
              certs,
              order: order ?? acmeOrder(f.acme_directory, f.acme_email),
              log,
          })
        : undefined;
    acme?.start();
    return {
        front,
        certs,
        acme,
        reload() {
            try {
                log.info("certificate reloaded", describePair(certs.reload()));
            } catch (e) {
                log.error("certificate reload failed, the old one stays", {
                    err: (e as Error).message,
                });
            }
            void acme?.check();
        },
        async close() {
            acme?.stop();
            await front.close();
        },
    };
}
