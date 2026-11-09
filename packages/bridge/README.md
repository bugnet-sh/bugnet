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

It needs Node 20.19.3 or newer.

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
pay_link_dialog = false                     # true opens pay links in the client's URL dialog, which waits for a click
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

1. It checks that the pay link is `pay_origin` followed by `/o/` and the order, that the payment's
   memo is that order, that it asks for USDC on Solana mainnet, and that the amount is at most the
   `confirmPriceUsd` you approved. When `~/.config/bugnet/mcp.toml` pins wallets, sandbox time
   must go to a `pay_to` or `allowance_pay_to` one, and an x402 allowance to an `allowance_pay_to`
   one (`pay_to` never pins an allowance, which pays Bugnet's allowance wallet).
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
same sandbox, instead of paying again. Without `pay`, or with `pay_command = ""`, the agent shows
you the pay link and calls `bugnet_redeem` at once, which waits up to 10 minutes and goes on by
itself as soon as you pay in the browser. With `pay_link_dialog = true`, a client that can open
links shows the link in its own dialog instead, and goes on only once you answer that dialog.

### Paying from a local wallet file

Instead of `pay`, the bridge can sign Bugnet orders itself from a Solana key, with no prompt. It
takes the key one of three ways, simplest first:

1. **The key in your project's `.env`.** Add a line such as `BUGNET_WALLET_KEY=<key>` to the
   `.env` in the folder the bridge runs in (the project folder, for a client that starts it
   there), with the key as base58 or a JSON array of 64 numbers, and set `wallet_env` below. The
   coding agent working in that folder can read the file, so keep only a small balance there.
2. **`bugnet-mcp key import`.** Run `bugnet-mcp key import --from ./.env --var BUGNET_WALLET_KEY`
   in your own terminal. It moves the key into the bridge's own wallet file,
   `~/.config/bugnet/wallet.json` (mode 0600, in a 0700 folder), and prints the address and that
   path. Then delete the line from `.env`. A key that sat in a project `.env` may already be
   exposed: agents can read `.env`, transcripts keep what they read, and git history may hold it.
3. **`bugnet-mcp key new`.** Run it in your own terminal. It creates a fresh wallet in
   `~/.config/bugnet/wallet.json` and prints only its address.

Send the wallet's address a small amount of USDC on Solana. It needs no SOL: Bugnet pays the fee.

Then turn it on in `~/.config/bugnet/mcp.toml`. The bridge reads these keys only from that exact
file, never from `--config` or `XDG_CONFIG_HOME`. Once the file sets any of them, it must be yours
and not writable by group or others. For the `.env` way:

```toml
pay_signer = "key"                # "pay" (the default) keeps using the pay CLI
wallet_env = "BUGNET_WALLET_KEY"  # the variable holding the key; leave it out to use wallet.json
max_payment_usd = 1               # per payment, default 1, at most 20
daily_usd = 5                     # per UTC day across all bridges, default 5, at most 100
# Bugnet's wallets for sandbox time and its fee payer; without them it signs nothing
pay_to = ["4JJ6XsUTFKQSCdJ6Qo8AQENvexWLtm5uHLeinbv4AScD"]
fee_payer = ["AxsYqFSYfxJKJgj8iTCJhVWLi1mphAx6Sh3cMLMdqyyr"]
# Bugnet's x402 allowance wallet, never one of the pay_to wallets
allowance_pay_to = ["DG9LtTcLRYgKHCvDkoxd4DcVLfCndQFFBnzVf8ACmwzA"]
key_pays_allowances = true        # the default; false sends x402 allowances to pay with Touch ID
```

For `key import` and `key new`, use the same file without the `wallet_env` line. The three
addresses are Bugnet's production wallets.

With `wallet_env`, the bridge reads that variable from `.env` in the folder it runs in, and from
its own environment when `.env` has no such line or leaves it empty. It reads it again for each
payment, so an edit counts from the next payment on, and it never opens `wallet.json`. It still
checks `~/.config/bugnet`, which holds the spend ledger, as it does for the wallet file: a folder
you own with mode 0700 (`chmod 700 ~/.config/bugnet`), not inside the working folder. It refuses a
`.env` that is unreadable, a link, not a regular file or over 64 KiB. When the variable is missing
or not a Solana keypair, or a check fails, it signs nothing and you get the pay link; the log shows
only `key_wallet_env_missing`, `key_wallet_env_invalid`, `key_wallet_env_file`, `key_folder_mode`,
`key_inside_cwd` or `key_no_home`. Every cap, pin and check below applies the same.

Setting `pay_signer = "key"` is your approval for the agent to spend from this wallet, within the
caps and with no prompt: it pays sandbox time, and by default x402 allowances too
(`bugnet_x402_budget`, or `bugnet_start` with an allowance). With `key_pays_allowances = false` an
allowance goes to `pay` instead, or to the pay link without `pay`. With `allowance_pay_to` unset,
Touch ID (or pay's in-client prompt) is the only check on an allowance sent to `pay`, since no
wallet pins it. Where pay has no Touch ID it asks through MCP elicitation, and the bridge's own pay
client offers none, so pay fails closed there and the bridge falls back to the pay link. The
wallet file works the same on macOS and Linux; on Windows it cannot be loaded yet, so every
payment goes to `pay` or the pay link.
The bridge tells an allowance first by the order's own `kind` and `allowanceMicros`, which Payments
sends on the payment step, and falls back to a payment to an `allowance_pay_to` wallet.
The default trades a prompt for speed: the allowance wallet later pays sellers the agent picked, so
without Touch ID an injected agent could send up to `daily_usd` a day to an x402 host of its own.
Keep `daily_usd` low, or set `key_pays_allowances = false`.

Before signing, the bridge fetches the order's payment request itself and checks that it is
`pay_origin`'s `/o/` link for this order, USDC on Solana mainnet, with the order as memo, paid to a
`pay_to` wallet (or an `allowance_pay_to` one when allowed) with a `fee_payer` wallet as fee payer, and within the price you approved, the
per-payment cap and what is left of the daily cap (kept in `~/.config/bugnet/spend/`, a folder per UTC day). It
builds the transfer itself and never signs bytes it was sent. A payment that fails a check is not
signed: you get the pay link or the payment step back. Once a signed payment has been sent, it stays
counted against the daily cap unless Payments refuses it before broadcasting (`payment_invalid`,
`payment_malformed`, `payment_order_mismatch`, `too_many_attempts` or a `payer_` refusal); any other
answer, a timeout included, counts as spent.

Earlier versions kept the daily total in `~/.config/bugnet/spend.json` and `spend.json.lock`.
Neither is used any more, and both can be deleted. On the day you upgrade, spend recorded in the
old file is not counted against that day's cap.

With `pay_signer = "key"`, every payment uses the `pay_origin` in `~/.config/bugnet/mcp.toml`
(default `https://pay.bugnet.sh`); a `pay_origin` from `--config` is ignored and logged. For a local
stack, put `pay_origin` in that file. `bugnet_secret_from_env` refuses a Solana keypair under any name: 64 bytes whose second half is
the first half's Ed25519 public key, as base58, base64, a JSON array, hex or inside a JSON wallet
export at any depth. It also refuses an Ed25519 private key as PEM, PKCS#8 or OpenSSH, and a seed
phrase. RSA and EC keys, certificates, public keys and 64 random bytes go through. It refuses the
names `SOLANA_PRIVATE_KEY`, `PRIVATE_KEY`, `*_KEYPAIR`, `WALLET_KEY`, `*_WALLET_KEY`, `MNEMONIC`
and `SEED_PHRASE`. A 32-byte value counts as a seed only under a wallet-like name (one with `SOL`,
`WALLET`, `PAYER`, `SIGNER`, `KEYPAIR` or `PHANTOM` before `KEY`, or `PRIVATE_KEY`, `MNEMONIC`,
`SEED_PHRASE`) or a `secret_key`/`private_key` JSON field, so a Solana address or an
`openssl rand -base64 32` secret under another name goes through.

The bridge reads the wallet file byte by byte, never as text, and zeroes its copies once the key
sits in a non-extractable WebCrypto key; `key new` writes it the same way. `key import` reads the
`.env` value as text, and `wallet_env` reads it as text at each payment, so clearing those
copies is best effort.

When your client starts the bridge in a folder below your home folder, that folder must not hold
`~/.config/bugnet` (the bridge then refuses `mcp.toml`, the wallet file, the `wallet_env` signer
and the `key` commands).
Starting in `/`, in your home folder or above it is fine. This does not apply to the project
`.env` that `wallet_env` names. Keep a small balance: any process running as you can read the
wallet file, and the agent can read a project `.env`.

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
