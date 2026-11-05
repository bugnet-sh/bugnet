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
| `plugin`                          | The Claude Code plugin: MCP server entry, `run-in-sandbox` skill, hint hooks             |
| `.claude-plugin/marketplace.json` | Lets this repository install as a plugin marketplace                                     |
| `integrations`                    | Rules for clients without hooks (Cursor, Codex)                                          |
| `eval/intent`                     | Labelled prompts and commands, dev and held-out test splits, and the offline judge       |
| `eval/agent`                      | The live judge: real Claude Code sessions with and without Bugnet                        |
| `config`                          | `example.toml` with every setting, `dev.toml` for a local run                            |

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

## Settings and secrets

Settings come from the TOML file given with `-config`, decoded strictly, so an unknown key is an
error naming it. [`config/example.toml`](config/example.toml) lists every key at its default.
Secrets come only from the environment ([`.env.example`](.env.example)):

| Variable                   | Needed for                                                         |
| -------------------------- | ------------------------------------------------------------------ |
| `BUGNET_INTERNAL_TOKEN`    | Always, the router's bearer token                                  |
| `BUGNET_QUOTE_KEY`         | Always, base64 of 32+ bytes signing quote ids                      |
| `BUGNET_ORDER_PRIVATE_KEY` | `payments.mode = "dev"` only                                       |
| `BUGNET_PAYMENTS_TOKEN`    | `payments.mode = "http"` only                                      |
| `GITHUB_TOKEN`, `HF_TOKEN` | Optional, raise `bugnet_assess`'s API limits and read gated models |

Give `GITHUB_TOKEN` and `HF_TOKEN` read access to public data only. `bugnet_assess` answers any
caller for free and reports private repos and models as missing, and a token without private access
keeps them hidden even if that check is ever missed.

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
