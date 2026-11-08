# @bugnet/mcp

The local bridge to [Bugnet](https://github.com/bugnet-sh/bugnet): your AI coding agent runs risky or
heavy code in a throwaway cloud Linux sandbox instead of on your computer, and pays for it per
run.

```sh
npx -y @bugnet/mcp@0.1.0
```

The bridge runs on your computer. Your MCP client talks to it over stdio, and it passes every call
on to Bugnet's server at `https://mcp.bugnet.sh/mcp` unchanged, except that it pays or opens the pay link for a payment step. It adds what only a program on
your machine can do.

## Do you need it?

Most people do not. Every client that speaks Streamable HTTP can use
`https://mcp.bugnet.sh/mcp` directly, with no sign-in and no API key. The
[main README](https://github.com/bugnet-sh/bugnet#install) shows how for each client.

Use the bridge when you want one of these:

- **Paying from the `pay` wallet on your computer.** When a paid call needs a payment, the bridge has [`pay`](https://pay.sh) pay it after you approve with Touch ID, then finishes the order. It pays only links on `pay.bugnet.sh`, on Solana mainnet, up to the price you approved.
- **To add secrets from your machine.** The bridge adds the tool `bugnet_secret_from_env`, which
  reads a token from an environment variable, a `.env` file or the macOS keychain, and seals it
  before it leaves your computer.
- **A client that only runs local servers.**

Use the bridge instead of the URL, not both, or every tool shows up twice.

## Install

It needs Node 20.3 or newer.

**Claude Code**

```sh
claude mcp add --scope user --transport stdio bugnet -- npx -y @bugnet/mcp@0.1.0
```

or `claude plugin install bugnet-wallet@bugnet` from the `bugnet-sh/bugnet` marketplace, which also adds the skill and hint hooks. Start Claude Code as plain `claude`, never `pay claude`, which loads only pay's own server and hides Bugnet.

**Codex CLI**

```sh
codex mcp add bugnet -- npx -y @bugnet/mcp@0.1.0
```

A paid call waits while you approve the payment and the first start downloads the bridge, so give both more time in `~/.codex/config.toml`:

```toml
[mcp_servers.bugnet]
command = "npx"
args = ["-y", "@bugnet/mcp@0.1.0"]
startup_timeout_sec = 30
tool_timeout_sec = 400
```

**Cursor** (`.cursor/mcp.json`) **and Devin Desktop, formerly Windsurf**
(`~/.config/devin/mcp_config.json`)

```json
{
    "mcpServers": {
        "bugnet": {
            "command": "npx",
            "args": ["-y", "@bugnet/mcp@0.1.0"]
        }
    }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{
    "servers": {
        "bugnet": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@bugnet/mcp@0.1.0"]
        }
    }
}
```

**Claude Desktop**: download `bugnet.mcpb` from the latest release and open it.

claude.ai cannot run local programs, so it uses the URL and adds secrets through the secret page.

## Settings

```text
bugnet-mcp [--gateway URL] [--config FILE]

  --gateway URL   remote gateway, default https://mcp.bugnet.sh/mcp
  --config FILE   settings file, default ~/.config/bugnet/mcp.toml when it exists
  --help          this text
  --version       the bridge version
```

The settings file is TOML. The bridge reads `~/.config/bugnet/mcp.toml` when it exists, or
`$XDG_CONFIG_HOME/bugnet/mcp.toml` when that variable is set. An unknown key is an error that
names it. The file never holds secrets. Every setting, at its default:

```toml
gateway_url = "https://mcp.bugnet.sh/mcp"   # Bugnet's server, https or http on this machine
secrets_url = "https://secrets.bugnet.sh"   # where sealed secrets go, https or http on this machine
connect_timeout = "5s"                      # longest wait to reach the server at start
call_timeout = "5m"                         # longest wait for one tool call, reset by progress
secrets_timeout = "30s"                     # longest wait to store one secret
pay_command = "pay"                         # the pay CLI that pays from this machine, "" for none
pay_origin = "https://pay.bugnet.sh"        # the only pay link origin it pays, https or http on this machine
```

The bridge refuses plain `http` to any other machine, so a sandbox handle never crosses the
network unencrypted. It logs to stderr, and its logs never hold a secret's value.

Against a gateway on this machine, set `pay_origin` to that gateway's own origin, since a dev
gateway's pay links are on it. With `gateway_url = "http://127.0.0.1:8787/mcp"` (or `--gateway`
with that URL), add `pay_origin = "http://127.0.0.1:8787"`. Without it the bridge refuses every pay
link as off its origin and hands the payment step back unpaid.

## Paying

When `bugnet_start`, `bugnet_extend` or `bugnet_x402_budget` answers with a payment step, the
bridge pays it:

1. It checks that the pay link is `pay_origin` followed by `/o/` and the order, that the payment
   names that order, that it asks for USDC on Solana mainnet, and that the amount is at most the
   `confirmPriceUsd` you approved.
2. It starts `pay mcp --allow-origin https://pay.bugnet.sh --allow-network mainnet
--max-payment <that price>`, with every `PAY_` variable removed and without letting pay ask
   through your client, so pay asks for Touch ID or pays nothing. pay 0.29.0 refuses every
   payment once these limits are set, because it cannot read the Solana network's name. When it
   answers that, the bridge starts pay once more without the limits, relying on its own checks
   above. Touch ID still approves the payment.
3. Once pay has paid, it calls the tool again with the order and its claim, and you get the
   sandbox, the time or the x402 allowance.

It pays an order at most once. If your client stops waiting, the bridge keeps the paid order for
30 minutes and uses it on the next call for the same size, or the next x402 allowance call for the
same sandbox, instead of paying again. Without `pay`, or with `pay_command = ""`, it opens the pay
link in your client when the client can open links, waits up to 10 minutes for you to pay in the
browser, and goes on. Other clients get the pay link to show you.

### Paying from a local wallet file

Instead of `pay`, the bridge can sign Bugnet orders itself from a wallet file, with no prompt:

1. Run `bugnet-mcp key new` in your own terminal. It creates `~/.config/bugnet/wallet.json`
   (mode 0600, in a 0700 folder) and prints only its address. To move a key you already have,
   run `bugnet-mcp key import --from ./.env --var NAME`, then delete that line as it tells you.
2. Send that address a small amount of USDC on Solana. It needs no SOL: Bugnet pays the fee.
3. Turn it on in `~/.config/bugnet/mcp.toml`. The bridge reads these keys only from that exact
   file, which must be yours and not writable by group or others, never from `--config` or
   `XDG_CONFIG_HOME`:

```toml
pay_signer = "key"           # "pay" (the default) keeps using the pay CLI
max_payment_usd = 1          # per payment, default 1, at most 20
daily_usd = 5                # per UTC day across all bridges, default 5, at most 100
# Bugnet's wallets the bridge may pay and let pay the fee; without them it signs nothing
pay_to = ["Bhhc3XNdjtCNr3pj2aZwhCt8pHwsU8wRL7dqJNDZEExw", "9gw8RJhnpnYgrfhj1UWAFbQvDVfYGYVk8ndb6bLUmzDo"]
fee_payer = ["73iCm2eWpXsEqTpYkNHe4VoiR4Eq7nyCLv9wYZzEnFM9"]
```

Before signing, the bridge fetches the order's payment request itself and checks that it is
`pay_origin`'s `/o/` link for this order, USDC on Solana mainnet, with the order as memo, paid to a
`pay_to` wallet with a `fee_payer` wallet as fee payer, and within the price you approved, the
per-payment cap and what is left of the daily cap (kept in `~/.config/bugnet/spend.json`). It
builds the transfer itself and never signs bytes it was sent. A payment that fails a check is not
signed: you get the pay link or the payment step back. `bugnet_secret_from_env` refuses any value
that looks like a wallet key, and names such as `PRIVATE_KEY`, `SECRET_KEY`, `KEYPAIR`, `MNEMONIC`
or `SEED`.

Keep a small balance: any process running as you can read the file.

## Secrets from your machine

Never paste a token into the chat. Ask your agent to add it with `bugnet_secret_from_env`
instead. It takes:

| Argument      | What it is                                                                          |
| ------------- | ----------------------------------------------------------------------------------- |
| `handle`      | The sandbox to add the secret to                                                    |
| `name`        | The variable name inside the sandbox, such as `HF_TOKEN`                            |
| `source`      | Where to read it: an environment variable, a `.env` key, or a keychain item         |
| `hosts`       | The hosts it may be sent to, such as `huggingface.co`                               |
| `headerNames` | Headers besides `Authorization` that carry it, the service's usual ones if left out |

`source` is one of these:

- an environment variable: `{ "type": "env", "variable": "HF_TOKEN" }`
- a key in a `.env` file: `{ "type": "dotenv", "path": ".env", "key": "HF_TOKEN" }`
- a macOS keychain item: `{ "type": "keychain", "service": "huggingface", "account": "me" }`,
  where `account` is optional

A `.env` file must be inside the folder your client started the bridge in, or your home folder.
The keychain works on macOS only. An environment variable must be visible to the bridge, so set it
where your client runs, or in the client's `env` block for the server.

What happens next:

1. The bridge asks you to confirm the sandbox, the name, where it reads from, and the hosts. It
   asks every time. It reads nothing before you accept.
2. It reads the value and seals it with a public key built into the bridge, so only Bugnet's
   outgoing proxy can open it. It refuses any key it was not built with.
3. Inside the sandbox, the variable holds a placeholder. When code there makes an HTTPS request to
   one of your hosts, the proxy swaps in the real value. No other host ever gets it. The proxy
   decrypts all traffic to those hosts, request bodies included.

If your client cannot ask you, the bridge decides alone and takes only what is plainly yours: a
well-known token sent to its usual hosts, such as `HF_TOKEN` to `huggingface.co`, read from a
variable or `.env` key of that same name, and added to a sandbox this bridge started. It never
reads the keychain without asking.

The well-known tokens are `HF_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY` and `NPM_TOKEN`.

## Security

The bridge is a package on your computer, so no server can change the code that seals your
secrets. The rest of Bugnet's security model, and what Bugnet can and cannot see, is in the
[main README](https://github.com/bugnet-sh/bugnet#security-model). Report a security problem as
[SECURITY.md](https://github.com/bugnet-sh/bugnet/blob/main/SECURITY.md) says, never in a public issue.

## License

Licensed under the [Apache License 2.0](../../LICENSE).
