# Contributing to Bugnet

Thanks for helping. This file covers how to build, test and run this repository, how it is laid
out, and what a pull request needs. What Bugnet is and how people install it is in the
[README](README.md).

- **Bugs and ideas:** use the [issue forms](https://github.com/bugnet-sh/bugnet/issues/new/choose).
- **Security problems:** never in a public issue. See [SECURITY.md](SECURITY.md).
- **Pull requests:** small and focused, with tests. The checklist is in the
  [pull request template](.github/PULL_REQUEST_TEMPLATE.md).

## Layout

| Path                              | What it holds                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/gateway`                | The MCP server: tools, router client, quotes, the Payments port, `bugnet_assess`                       |
| `packages/intent`                 | Intent detection rules shared by the plugin's hooks and `bugnet_assess`, no dependencies               |
| `packages/bridge`                 | `npx @bugnet/mcp`, a local stdio proxy to the gateway that adds `bugnet_secret_from_env`               |
| `packages/seal`                   | Sealing a secret to the egress proxy's pinned box keys, shared by the bridge and page                  |
| `packages/secret-page`            | The secret entry page, a static bundle for the secrets route, see its README                           |
| `plugin`                          | The Claude Code plugin over HTTP, paying by link: MCP server entry, `run-in-sandbox` skill, hint hooks |
| `plugin-wallet`                   | The same plugin running the bridge (`npx @bugnet/mcp`), so it pays from the `pay` wallet               |
| `.claude-plugin/marketplace.json` | Lets this repository install as a plugin marketplace                                                   |
| `integrations`                    | Rules for clients without hooks (Cursor, Codex, `AGENTS.md`)                                           |
| `eval/intent`                     | Labelled prompts and commands, dev and held-out test splits, and the offline judge                     |
| `eval/agent`                      | The live judge: real Claude Code sessions with and without Bugnet                                      |
| `config`                          | `example.toml` with every setting, `dev.toml` for a local run                                          |
| `deploy`                          | The systemd unit the server runs the gateway with                                                      |

The gateway is a stateless TypeScript MCP server. It checks quotes, asks the Payments service for
an order, calls the router (Bugnet's backend, which places and drives sandboxes) over Connect, and
cleans what comes back. No AI model runs in it.

## Prerequisites

- Node 26 and pnpm 12.6.0, the version `packageManager` in `package.json` names
- `buf` and the `bugnet-proto` checkout next to this repository:
  `pnpm --filter @bugnet/gateway proto` generates the router client into `packages/gateway/src/gen`,
  which git ignores
- A running router (`../bugnet-router`, see its README) for anything past unit tests

<!-- PENDING: bugnet-proto and bugnet-router are not public, so outside contributors cannot run the codegen yet -->

```sh
pnpm install
pnpm --filter @bugnet/gateway proto
```

## Checks

Every pull request must pass these three:

```sh
pnpm lint                         # ESLint, then Prettier on code, Markdown and YAML
pnpm typecheck                    # tsc in every package
pnpm test --no-file-parallelism   # unit tests, one file at a time
```

`pnpm format` rewrites files the way `pnpm lint` wants them.

## Running locally

1. Start the router with `../bugnet-router/scripts/dev-up.sh` (local provider, port 8080).
2. Copy `.env.example` to `.env` and fill it: `BUGNET_INTERNAL_TOKEN` and
   `BUGNET_ORDER_PRIVATE_KEY` are the router's values in `../bugnet-router/.env.keys`, and
   `BUGNET_QUOTE_KEY` is `openssl rand -base64 32`.
3. Start the gateway on `127.0.0.1:8787` with dev payments, which start sandboxes without
   charging and refuse to run anywhere but loopback:

```sh
set -a; . ./.env; set +a
pnpm --filter @bugnet/gateway dev
```

4. Point Claude Code at it, either as a plain MCP server or as the plugin:

```sh
claude mcp add --transport http bugnet http://127.0.0.1:8787/mcp
# or, with the skill and hint hooks:
BUGNET_MCP_URL=http://127.0.0.1:8787/mcp claude --plugin-dir ./plugin
```

`claude mcp list` shows whether it connected. With the plugin, run
`BUGNET_MCP_URL=http://127.0.0.1:8787/mcp claude --plugin-dir ./plugin mcp list`.

5. To pay through the bridge, add `dev_require_payment = true` under `[payments]` in
   `config/dev.toml`, so dev orders answer with a pay link on the gateway's `public_url`, and put
   `pay_origin = "http://127.0.0.1:8787"` in `~/.config/bugnet/mcp.toml`. The bridge pays only
   links on `pay_origin`, so without that line it refuses every link as off its origin. Then run
   `BUGNET_MCP_URL=http://127.0.0.1:8787/mcp claude --plugin-dir ./plugin-wallet`, or the bridge
   built from this tree (see [The bridge](#the-bridge)) with `--gateway http://127.0.0.1:8787/mcp`.

## Tests

```sh
pnpm test                                   # unit tests
pnpm run eval:intent --split dev            # offline intent judge, per-item misses
pnpm run eval:intent --split test           # held-out split, totals only
BUGNET_E2E_MCP_URL=http://127.0.0.1:8787/mcp pnpm test   # end to end against a live gateway
node_modules/.bin/tsx eval/agent/run.ts --split test     # live judge, real Claude Code sessions
```

The end-to-end run starts and stops one sandbox through a gateway in dev payments mode, so point
it only at a local router.

The seal interop test runs only with Go on the `PATH`, and the secret page's browser tests only
with a browser Playwright can launch, so install them to run everything CI runs:

```sh
pnpm --filter ./packages/secret-page exec \
    playwright-core install --only-shell chromium firefox webkit
```

CI (`.github/workflows/ci.yml`) runs on every push and pull request: a frozen install, the proto
codegen, `pnpm lint`, `pnpm typecheck`, a check that the committed hook bundle matches a fresh
`pnpm build:plugin`, and `pnpm test` with Go and Playwright's Chromium, Firefox and WebKit, failing
if the Go or browser tests skipped. It checks out the private `bugnet-proto` beside this repository
with the `PROTO_READ_TOKEN` secret, a fine-grained token with read-only Contents on that repository,
so pull requests from forks stop at that step. The evals stay out of CI because they spend money and
need API keys.

The live judge spends Claude usage: each session is a real model run, up to `perRun.maxBudgetUsd`
($0.40) at API prices, and the whole run is capped by `budgetUsd` in
[`eval/agent/config.json`](eval/agent/config.json). One session cost $0.15 on 2026-11-06. It runs
every prompt in an empty directory with the user's settings, memory, CLAUDE.md and connectors left
out, denies shell commands, and allows only the free Bugnet tools. The smallest run is one
session:

```sh
node_modules/.bin/tsx eval/agent/run.ts --split test --arms mcp --limit 1 --budget 0.4 \
    --gateway-url http://127.0.0.1:8787/mcp
```

The header of [`eval/agent/run.ts`](eval/agent/run.ts) lists every flag.

### The README's tools table

`packages/gateway/src/readme.test.ts` checks that the README's tools table names every tool the
gateway serves, once each, and marks as paid exactly the tools whose title says paid. Adding,
removing or renaming a tool means updating that table in the same pull request.

## Tools

The README's [tools table](README.md#tools) lists every tool for users. Each tool's annotations
(read-only, destructive, idempotent) are set where it is registered in `packages/gateway/src/tools`.
Every tool but `bugnet_start` and `bugnet_extend` is free. Approval means the tool carries
`anthropic/requiresUserInteraction`, which `tools.require_user_approval` turns off for unattended
test gateways only. `bugnet_transfer` asks too while `tools.confirm_transfers` is on.

Until the router builds an RPC, the tool that calls it answers that the feature is not available
yet, and says a retry gets the same answer.

## The plugin

`plugin/` is a Claude Code plugin named `bugnet` whose MCP server is `sandbox`, connected over HTTP
and paying by link, so tools appear as `mcp__plugin_bugnet_sandbox__bugnet_*`. `plugin-wallet/` is
the plugin `bugnet-wallet`, whose `sandbox` server is the bridge, so tools appear as
`mcp__plugin_bugnet-wallet_sandbox__bugnet_*` and payments go through the `pay` wallet. Both carry
the same skill and hooks. The hooks run `hooks/bugnet-hook.mjs`, bundled from `packages/intent`
and committed so the plugins work straight from git. `pnpm run build:plugin` writes the bundle
into both, and `plugin.test.ts` checks that the two copies match. The hooks need Node and stay
silent without it. `BUGNET_HINTS=off` turns hints off and `quiet` keeps only hints after a failed
local command. Install from a clone of this repository:

```sh
claude plugin marketplace add ./bugnet-gateway
claude plugin install bugnet@bugnet
claude plugin install bugnet-wallet@bugnet
```

`claude plugin validate ./bugnet-gateway` checks the marketplace and the plugin first. Install one
plugin, not both.

The server URL defaults to `https://mcp.bugnet.sh/mcp`; `BUGNET_MCP_URL` overrides it, as in the
local run above.

## The bridge

`npx @bugnet/mcp` is a local stdio MCP server that passes every gateway tool through unchanged,
except that it pays or opens the pay link for a payment step of `bugnet_start` or `bugnet_extend`,
and adds `bugnet_secret_from_env`. That tool reads a secret from an
environment variable, a `.env` file or a macOS keychain item, asks the user to confirm the name,
source and hosts, and seals it to the egress proxy, so the value never enters the chat. A client
that cannot ask gets only the preset hosts of a known secret, for a sandbox this bridge started.

```sh
pnpm --filter @bugnet/mcp build      # writes packages/bridge/dist/main.js
claude mcp add bugnet -- npx -y @bugnet/mcp
```

It reads `~/.config/bugnet/mcp.toml` when it exists, or the file `--config` names, and
`--gateway` overrides `gateway_url`.
[`packages/bridge/config/example.toml`](packages/bridge/config/example.toml) lists every setting
at its default. It holds no secrets.

When `bugnet_start` or `bugnet_extend` answers with a payment step, the bridge pays it with the
`pay` CLI (`src/pay.ts`). It checks that the pay link is `pay_origin` plus `/o/<orderId>`, that the
x402 memo names the order and that the amount is at most `confirmPriceUsd`, then starts
`pay mcp --allow-origin <pay_origin> --allow-network mainnet --max-payment <confirmPriceUsd>` with
every `PAY_*` variable and `NO_DNA` removed and no client capabilities, so pay asks for Touch ID and
fails closed without it. It pays an order at most once, keeps a paid order it could not use for 30
minutes (`src/orders.ts`) and uses it before opening a new order for the same package.
`pay_command = ""` turns pay off. `BUGNET_LIVE_PAY=1 pnpm test packages/bridge/src/pay.live.test.ts`
runs the real `pay`.

Without `pay`, or after pay could not start, it asks a client that declares URL elicitation to open
the pay link and polls `/o/<orderId>/status` every 2.5 s for up to 10 minutes (`src/linkpay.ts`);
other clients get the payment step unchanged. `pnpm --filter @bugnet/mcp mcpb` writes the Claude
Desktop extension to `packages/bridge/dist/bugnet.mcpb`.

## The secret page

```sh
pnpm --filter @bugnet/secret-page build
```

[`packages/secret-page/README.md`](packages/secret-page/README.md) covers what the build writes,
the headers the route must send, and how the page is tested in real browsers.

## Sealing keys

`packages/seal/src/pinned.ts` pins the egress proxy's box public keys the bridge and the page seal
to, so neither the router nor the secrets route can hand out a key of its own. The real key is
made once at deploy, on the server, with
`bugnet-egress box-key new --id k1 --out /etc/bugnet/keys`. Its public half goes into the
router's `secrets.box_public_keys` and into `pinned.ts` as key id `k1` with the public key in
base64url without padding, then a new bridge and page ship. A rotation adds the new key first,
keeps the old one until its sandboxes have ended, and ships before the router lists the new key.
The development key in `src/testing` never goes there.

<!-- PENDING: bugnet-egress, its box-key command and the router's secrets.box_public_keys are still being built -->

`pnpm --filter @bugnet/seal interop` checks with Go that the router side opens what the bridge
and the page seal.

## Settings and secrets

Settings come from the TOML file given with `-config`, decoded strictly, so an unknown key is an
error naming it. [`config/example.toml`](config/example.toml) lists every key at its default.
Secrets come only from the environment ([`.env.example`](.env.example)):

| Variable                    | Needed for                                                         |
| --------------------------- | ------------------------------------------------------------------ |
| `BUGNET_INTERNAL_TOKEN`     | Always, the router's bearer token                                  |
| `BUGNET_QUOTE_KEY`          | Always, base64 of 32+ bytes signing quote ids                      |
| `BUGNET_ORDER_PRIVATE_KEY`  | `payments.mode = "dev"` only                                       |
| `BUGNET_PAYMENTS_TOKEN`     | `payments.mode = "http"` only                                      |
| `GITHUB_TOKEN`, `HF_TOKEN`  | Optional, raise `bugnet_assess`'s API limits and read gated models |
| `BUGNET_OTLP_AUTHORIZATION` | Optional, the trace backend's whole `Authorization` header value   |

Give `GITHUB_TOKEN` and `HF_TOKEN` read access to public data only. `bugnet_assess` answers any
caller for free and reports private repos and models as missing, and a token without private access
keeps them hidden even if that check is ever missed.

## Public front

On the server, HAProxy passes `mcp.bugnet.sh`'s raw TLS to `front.tls_addr` (`127.0.0.1:8444`)
with `send-proxy-v2`. The gateway takes that header only from a peer in `front.proxy_protocol_from`
(loopback by default) and closes any other connection unread. It reads the header for the client's
address, terminates TLS 1.2 or 1.3 with HTTP/1.1, and serves the same `/mcp` and `/healthz` as the
plain listener, which stays for local runs. The certificate comes either from `cert_file` and
`key_file`, reread on `SIGHUP`, or from ACME: with `acme_directory` set, the gateway orders it by
TLS-ALPN-01 through HAProxy's SNI split, keeps the account key and the certificate in `acme_dir`,
and renews 30 days before expiry.

## Traces

With `telemetry.traces = true` (off by default) the gateway exports a span per tool call and per
router call over OTLP/HTTP, and sends `traceparent` on every router call so the router continues
the trace. A call about a sandbox joins its order's trace, whose ids every party derives from the
handle. `telemetry.sample_ratio` must equal the router's. Spans name a sandbox only by
`bugnet.handle_hash`, and no `OTEL_` variable changes anything.

## Deployment

[`deploy/bugnet-gateway@.service`](deploy/bugnet-gateway@.service) runs the gateway the way the
router's services run: a templated unit per versioned directory under
`/opt/bugnet/gateway/<version>`, settings in `/etc/bugnet/gateway.toml`, secrets in
`/etc/bugnet/gateway.env` (`root:root 0600`) and the ACME state in `/var/lib/bugnet-gateway`. It
runs as the Unix user `bugnet-gateway` and nothing else, so the deploy check that proves no other
user reaches Postgres, Valkey or the egress proxy takes `GATEWAY_USERS="bugnet-gateway"`.

## Style

- TypeScript is strict ESM. Prettier formats everything at 4 spaces and 100 columns.
- Settings go in TOML, secrets only in the environment. Never commit a `.env`.
- A comment is one line, and only for a reason the code cannot show, or a `/* Section */`
  divider. No colons, semicolons, em dashes or trailing periods in comments. YAML and shell
  comments follow the same rules.
- Text an agent or a user reads, such as tool descriptions, results and errors, uses plain words.
  It never names the hosting companies Bugnet's sandboxes run on.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`,
  `docs:`, `test:`, `build:`, `ci:` or `chore:`, then what changed and why.

## License

Contributions are accepted under the repository's license, which is still to be announced.

<!-- PENDING: waits on founder decision 18, which picks the license and whether contributors sign anything -->
