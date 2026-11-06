# @bugnet/mcp

The local bridge to [Bugnet](https://github.com/bugnet-sh/bugnet): your AI coding agent runs risky or
heavy code in a throwaway cloud Linux sandbox instead of on your computer, and pays for it per
run.

<!-- PENDING: @bugnet/mcp is not published on npm yet, and the public server at mcp.bugnet.sh is not deployed yet -->

```sh
npx -y @bugnet/mcp
```

The bridge runs on your computer. Your MCP client talks to it over stdio, and it passes every call
on to Bugnet's server at `https://mcp.bugnet.sh/mcp` unchanged. It adds what only a program on
your machine can do.

## Do you need it?

Most people do not. Every client that speaks Streamable HTTP can use
`https://mcp.bugnet.sh/mcp` directly, with no sign-in and no API key. The
[main README](https://github.com/bugnet-sh/bugnet#install) shows how for each client.

Use the bridge when you want one of these:

- **To pay from a Solana wallet on your computer.** The bridge signs each x402 payment locally,
  within spend limits you set, so your wallet keys never leave your machine.
  <!-- PENDING: the payment signer is still being built, so today a paid call's payment step goes back to your agent -->
- **To add secrets from your machine.** The bridge adds the tool `bugnet_secret_from_env`, which
  reads a token from an environment variable, a `.env` file or the macOS keychain, and seals it
  before it leaves your computer.
- **A client that only runs local servers.**

Use the bridge instead of the URL, not both, or every tool shows up twice.

## Install

It needs Node 20 or newer.

**Claude Code**

```sh
claude mcp add --transport stdio bugnet -- npx -y @bugnet/mcp
```

**Codex CLI**

```sh
codex mcp add bugnet -- npx -y @bugnet/mcp
```

**Cursor** (`.cursor/mcp.json`) **and Devin Desktop, formerly Windsurf**
(`~/.config/devin/mcp_config.json`)

```json
{
    "mcpServers": {
        "bugnet": {
            "command": "npx",
            "args": ["-y", "@bugnet/mcp"]
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
            "args": ["-y", "@bugnet/mcp"]
        }
    }
}
```

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
```

The bridge refuses plain `http` to any other machine, so a sandbox handle never crosses the
network unencrypted. It logs to stderr, and its logs never hold a secret's value.

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

<!-- PENDING: the proxy's public key is built in at launch and the proxy is still being built, until then the bridge refuses to seal -->

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

<!-- Waits on founder decision 18, which picks the license -->

License: to be announced.
