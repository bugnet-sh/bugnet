# Secret entry page

The page behind `bugnet_secret_link`, served by the secrets route at
`https://secrets.bugnet.sh/l/<link token>` (data-plane 8.4, gateway requirements 9). It reads the
link, shows the pairing code, the sandbox's source and its creation time, takes a name, a value
and hosts, seals the value in the browser with `@bugnet/seal` to a key built into the bundle, and
sends the sealed body once. It sets no cookies, loads nothing from any other origin and has no
inline script or style.

## Build

```sh
pnpm --filter @bugnet/secret-page build
```

The build writes `dist/`:

| File                                                                                                  | Served as                                               |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `index.html`                                                                                          | every `GET /l/*`                                        |
| `assets/page.js`                                                                                      | `GET /assets/page.js`                                   |
| `assets/page.css`                                                                                     | `GET /assets/page.css`                                  |
| `assets/icon.svg`                                                                                     | `GET /assets/icon.svg`, `image/svg+xml`                 |
| `assets/fonts/manrope-400.woff2`, `manrope-600.woff2`, `lexend-deca-200.woff2`, `obel-mono-400.woff2` | `GET /assets/fonts/<name>`, `font/woff2`                |
| `assets/fonts/OFL-manrope.txt`, `OFL-lexend-deca.txt`, `OFL-obel-mono.txt`                            | `GET /assets/fonts/<name>`, `text/plain; charset=utf-8` |
| `headers.txt`                                                                                         | not served, the headers listed below                    |

`index.html` pins `page.js` and `page.css` by SHA-384, so the three files deploy together: a page
from one build never runs a script from another.

## Deploy

Copy `dist/` into the route's `page_dir` (`/srv/bugnet/secrets-page`), root-owned and read-only to
`bugnet-secrets`. The route sends every line of `headers.txt` with every file from `page_dir`, as
data-plane 8.4 gives them:

```text
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'
```

In `headers.txt`, each line is `Name: value`, and lines starting with `#` are comments. The
`Content-Type` follows the extension: `text/html; charset=utf-8`, `text/javascript;
charset=utf-8`, `text/css; charset=utf-8` and `image/svg+xml`.

## Pinned keys

The bundle seals only to the keys in [`../seal/src/pinned.ts`](../seal/src/pinned.ts), and refuses
the page before anything is typed when the link lists none of them. That list is empty until the
proxy's box key is made at deploy (data-plane 15.5), so the build warns, and the page it makes
refuses every key. A rotation adds the new key there, rebuilds and redeploys this bundle and the
bridge, and only then lets the router list the new key first (data-plane 10.2).

A release build refuses a key whose id starts with `dev-`, and the development public key under
any id. The development key in `../seal/src/testing` goes only into the test builds, which show a
banner saying so.

## What the page decides

- **Hosts.** A known name fills in its preset's hosts from
  [`../seal/src/presets.ts`](../seal/src/presets.ts), which must match the router's table in
  data-plane 10.3. A suggested host outside the preset is dropped even if the router sent it, so
  custom hosts are always typed by the user. Every host is shown as the proxy matches it, in
  lower-case punycode, and hosts outside every preset are marked as typed.
- **GitHub.** A secret whose hosts include `api.github.com`, the host the router fetches a private
  repository through, is fetch only unless the user ticks "Also let code in the sandbox use this
  token" (data-plane 10.7). Any other secret, `GH_TOKEN` bound to `github.com` alone included, is
  an ordinary one.
- **Value.** A text field masked with CSS, never a password field, which browsers offer to save
  once the form goes away. A value that fits 64 KiB but not the 70 KiB box once JSON escapes it is
  named on its field before sealing.
- **Times.** The creation and expiry times are refreshed every 30 seconds, and an expired link
  says so before anything is typed.
- **Errors.** Each reason of data-plane 8.4 and 11.3 has a fixed sentence, and the route's own
  `message` is never shown. A refusal that leaves the link unusable removes the form.
- **Retries.** One `submissionId` per page load, so a retried PUT is answered with the first
  result.

## Tests

- Unit tests for each module in `src/`.
- `test/smoke.test.ts` builds the release bundle into `dist/` and a development bundle into a
  temporary folder, serves them with the fake secrets route of `src/testing/route.ts` on port 0,
  and drives them in an installed headless Chromium: Playwright's own, a Chrome or Chromium in the
  usual places, or `BUGNET_CHROME`. It never downloads a browser. Without one, or with
  `BUGNET_PAGE_SMOKE=jsdom`, it runs the same bundle under jsdom, which enforces no CSP. Both open
  every PUT body with the development private key.
- The same file also saves a secret in Firefox and WebKit when either is installed: Playwright's
  own build, an older one in Playwright's cache, or `BUGNET_FIREFOX` and `BUGNET_WEBKIT`. Those
  two follow the Fetch rules on a `PUT`'s `Origin` that Chromium does not.

## Notes for the secrets route

- Browsers send no `Origin` header on a same-origin `GET`, so `GET /v1/links/<token>` arrives
  without one. It does carry `Sec-Fetch-Site: same-origin`. The `PUT` carries both.
- The page's calls use the referrer policy `strict-origin`, so `Referer` names only the origin,
  never the path with the link's token. Under `no-referrer`, Firefox and WebKit send a `PUT`'s
  `Origin` as `null`, as the Fetch standard says, and the route would refuse every save there.
  The document itself keeps `no-referrer`.
- The CSP has no `wasm-unsafe-eval`, so libsodium's WebAssembly is refused, once per load, and it
  falls back to its asm.js build. That makes `page.js` about 1 MB, or 330 KB gzipped.
