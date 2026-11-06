# bugnet-gateway

The Bugnet MCP gateway: the public MCP server coding agents call to rent short-lived cloud Linux
sandboxes, plus the intent detection that makes agents suggest it when a user is about to run
untrusted code or heavy AI models. There is no login and no API key; runs are paid per use in
USDC on Solana through x402. No AI model runs on the server.

The design is in [../docs/mcp-gateway/design.md](../docs/mcp-gateway/design.md), the
requirements in [../docs/mcp-gateway/requirements.md](../docs/mcp-gateway/requirements.md) and
the contract Payments implements in
[../docs/mcp-gateway/payments-port.md](../docs/mcp-gateway/payments-port.md).

## Layout

| Path                              | What it holds                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/gateway`                | The MCP server: tools, router client, quotes, the Payments port, `bugnet_assess`         |
| `packages/intent`                 | Intent detection rules shared by the plugin's hooks and `bugnet_assess`, no dependencies |
| `packages/bridge`                 | `npx @bugnet/mcp`, a local stdio proxy to the gateway that adds `bugnet_secret_from_env` |
| `packages/seal`                   | Sealing a secret to the egress proxy's pinned box keys, shared by the bridge and page    |
| `packages/secret-page`            | The secret entry page, a static bundle for the secrets route, see its README             |
| `plugin`                          | The Claude Code plugin: MCP server entry, `run-in-sandbox` skill, hint hooks             |
| `.claude-plugin/marketplace.json` | Lets this repository install as a plugin marketplace                                     |
| `integrations`                    | Rules for clients without hooks (Cursor, Codex)                                          |
| `eval/intent`                     | Labelled prompts and commands, dev and held-out test splits, and the offline judge       |
| `eval/agent`                      | The live judge: real Claude Code sessions with and without Bugnet                        |
| `config`                          | `example.toml` with every setting, `dev.toml` for a local run                            |
| `deploy`                          | The systemd unit the VPS runs the gateway with                                           |

## Prerequisites

- Node 26 and pnpm 12
- `buf` and the `bugnet-proto` checkout next to this repository: `pnpm --filter @bugnet/gateway
proto` generates the router client into `packages/gateway/src/gen` (git-ignored)
- A running router (`../bugnet-router`, see its README) for anything past unit tests

```sh
pnpm install
pnpm --filter @bugnet/gateway proto
```

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
claude mcp add --transport http bugnet-sandbox http://127.0.0.1:8787/mcp
# or, with the skill and hint hooks:
BUGNET_MCP_URL=http://127.0.0.1:8787/mcp claude --plugin-dir ./plugin
```

## Tools

Every tool but `bugnet_start` and `bugnet_extend` is free. Approval means the tool carries
`anthropic/requiresUserInteraction`, which `tools.require_user_approval` turns off for unattended
test gateways only.

| Tool                                  | What it does                                                        | Cost and prompts                        |
| ------------------------------------- | ------------------------------------------------------------------- | --------------------------------------- |
| `bugnet_assess`                       | Says whether a repo, model or command belongs in a sandbox, quoted  | Read-only                               |
| `bugnet_quote`                        | Prices the packages for the work and signs a quote id               | Read-only                               |
| `bugnet_start`                        | Pays for a package and starts the sandbox, returning its handle     | Paid, asks for approval                 |
| `bugnet_status`                       | State, deadline, extension prices, SSH alias and where the repo is  | Starts a fetch a start left pending     |
| `bugnet_stop`                         | Destroys the sandbox and everything in it                           | Destructive                             |
| `bugnet_exec`                         | Runs a command and returns its exit code and the end of its output  |                                         |
| `bugnet_job`                          | Follows a command still running                                     | Read-only                               |
| `bugnet_cancel_job`                   | Cancels a command                                                   |                                         |
| `bugnet_list_files`                   | Lists a folder                                                      | Read-only                               |
| `bugnet_read_file`                    | Reads up to 256 KiB of a file a call                                | Read-only                               |
| `bugnet_write_file`                   | Writes a file                                                       |                                         |
| `bugnet_extend`                       | Pays for more time                                                  | Paid, asks for approval                 |
| `bugnet_fetch_source`                 | Puts the quoted GitHub repo in the sandbox                          |                                         |
| `bugnet_preview`                      | Makes an HTTPS link to a port in the sandbox                        |                                         |
| `bugnet_transfer`                     | Makes a one-use curl link to upload or download a file              | Asks, unless `confirm_transfers` is off |
| `bugnet_ssh`                          | Authorizes an SSH key and returns the command and ssh_config stanza |                                         |
| `bugnet_ssh_remove`                   | Takes an SSH key off                                                | Destructive                             |
| `bugnet_secret_link`                  | Makes a page where the user types a secret for the sandbox          |                                         |
| `bugnet_secrets`                      | Lists the sandbox's secrets, never their values                     | Read-only                               |
| `bugnet_secret_delete`                | Deletes a secret                                                    | Destructive                             |
| `bugnet_secret_put_grant`             | A grant the bridge stores a secret with, hidden by the bridge       |                                         |
| `bugnet_secret_from_env`, bridge only | Stores a secret from this machine without it passing through chat   | Asks the user when the client can       |

## The bridge

`npx @bugnet/mcp` is a local stdio MCP server that passes every gateway tool through unchanged,
x402 payments included, and adds `bugnet_secret_from_env`. That tool reads a secret from an
environment variable, a `.env` file or a macOS keychain item, asks the user to confirm the name,
source and hosts, and seals it to the egress proxy, so the value never enters the chat. A client
that cannot ask gets only the preset hosts of a known secret, for a sandbox this bridge started.

```sh
claude mcp add bugnet -- npx -y @bugnet/mcp
```

It reads `~/.config/bugnet/mcp.toml` when it exists, or the file `--config` names, and
`--gateway` overrides `gateway_url`.
[`packages/bridge/config/example.toml`](packages/bridge/config/example.toml) lists every setting
at its default. It holds no secrets.

The bridge ships without a payment signer, so a paid call's payment step reaches the agent, which
shows the pay link. `src/payment.ts` is the port the Payments team implements: the signer gets
the x402 `PaymentRequired` of a paid call and the call it belongs to, and a payload it returns is
sent once as `_meta["x402/payment"]` on a retry with the same arguments and `_meta`, so the
gateway's idempotency key still names one order. `null` leaves the result to the agent. The
signer owns the user's spend caps, the confirmation and the wallet keys.

## Sealing keys

`packages/seal/src/pinned.ts` pins the egress proxy's box public keys the bridge and the page seal
to (data-plane 10.2), so neither the router nor the secrets route can hand out a key of its own.
The real key is made once at deploy with
`bugnet-egress box-key new --id k1 --out /etc/bugnet/keys` (data-plane 15.5). Its public half goes
into the router's `secrets.box_public_keys` and into `pinned.ts` as key id `k1` with the public
key in base64url without padding, then a new bridge and page ship. A rotation adds the new key
first, keeps the old one until its sandboxes have ended, and ships before the router lists the new
key. The development key in `src/testing` never goes there.

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

On the VPS, HAProxy passes `mcp.bugnet.sh`'s raw TLS to `front.tls_addr` (`127.0.0.1:8444`) with
`send-proxy-v2`. The gateway takes that header only from a peer in `front.proxy_protocol_from`
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
handle (data-plane 20.2.1). `telemetry.sample_ratio` must equal the router's. Spans name a sandbox
only by `bugnet.handle_hash`, and no `OTEL_` variable changes anything.

## Deployment

[`deploy/bugnet-gateway@.service`](deploy/bugnet-gateway@.service) runs the gateway as data-plane
15.3 runs the router's services: a templated unit per versioned directory under
`/opt/bugnet/gateway/<version>`, settings in `/etc/bugnet/gateway.toml`, secrets in
`/etc/bugnet/gateway.env` (`root:root 0600`) and the ACME state in `/var/lib/bugnet-gateway`. It
runs as the Unix user `bugnet-gateway` and nothing else, so the deploy check that proves no other
user reaches Postgres, Valkey or the egress proxy takes `GATEWAY_USERS="bugnet-gateway"`.

## The plugin

`plugin/` is a Claude Code plugin named `bugnet` whose MCP server is `sandbox`, so tools appear as
`mcp__plugin_bugnet_sandbox__bugnet_*`. Its hooks run `plugin/hooks/bugnet-hook.mjs`, bundled from
`packages/intent` with `pnpm run build:plugin` and committed so the plugin works straight from git.
They need Node and stay silent without it. `BUGNET_HINTS=off` turns hints off and `quiet` keeps only
hints after a failed local command. Install from a clone of this repository:

```sh
claude plugin marketplace add ./bugnet-gateway
claude plugin install bugnet@bugnet
```

The server URL defaults to `http://127.0.0.1:8787/mcp` until a public gateway exists;
`BUGNET_MCP_URL` overrides it.

## Tests

```sh
pnpm test                                   # unit tests
pnpm run eval:intent --split dev            # offline intent judge, per-item misses
pnpm run eval:intent --split test           # held-out split, totals only
BUGNET_E2E_MCP_URL=http://127.0.0.1:8787/mcp pnpm test   # end to end against a live gateway
node_modules/.bin/tsx eval/agent/run.ts --split test     # live judge, real Claude Code sessions
```

The live judge spends Claude usage: each session is a real model run (about $0.01 to $0.10 at API
prices), capped by `budgetUsd` in [`eval/agent/config.json`](eval/agent/config.json). It runs every
prompt in an empty directory with the user's settings, memory, CLAUDE.md and connectors left out,
denies shell commands, and allows only the free Bugnet tools.
