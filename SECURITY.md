# Security policy

Bugnet runs code people do not trust, and it handles payments and secrets. We take reports about
it seriously and thank everyone who sends one.

## Reporting a problem

Please do not open a public issue, pull request or discussion for a security problem.

<!-- PENDING: security@bugnet.sh is a placeholder until the founder confirms the address and that the mailbox exists -->

Report it privately in one of these two ways:

- Email **security@bugnet.sh**.
- Use GitHub's private reporting: the **Report a vulnerability** button under this repository's
  [Security tab](https://github.com/bugnet-sh/bugnet/security/advisories/new).

<!-- PENDING: private vulnerability reporting must be turned on in the repository settings -->

Please include:

- what the problem is and what someone could do with it;
- the steps to show it, as short as you can make them;
- the component and version, such as the bridge version from `npx @bugnet/mcp --version`, the
  plugin version, or the date you saw it on `mcp.bugnet.sh`;
- whether you want to be credited, and under what name.

Never include a real sandbox handle (it starts with `sbx_`), a token, a wallet key or a seed
phrase. A handle is the full key to a sandbox. Describe it instead, for example "the handle of a
sandbox I started at 14:05 UTC".

We will confirm we got your report, keep you updated while we fix it, and tell you before we
publish anything about it.

## What counts

In scope:

- the MCP server in `packages/gateway`, including the public server at `mcp.bugnet.sh`;
- the bridge, `npx @bugnet/mcp`, in `packages/bridge`;
- the secret page in `packages/secret-page`, and the sealing code in `packages/seal`;
- the Claude Code plugin in `plugin/`, and the rules in `integrations/`.

Examples of what we want to hear about:

- reaching or controlling a sandbox you did not start;
- reading a secret's value anywhere outside the sandbox it was added to and the hosts it was
  allowed for;
- making the bridge or the secret page seal to a key that is not built into them;
- starting a sandbox without paying, or paying a price other than the one approved;
- tool output that gets an agent to act against its user, past the cleaning Bugnet does;
- the plugin's hooks sending anything off the user's machine.

Out of scope:

- reports from automated scanners with no working example;
- slowing the free tools down by calling them a lot, since they are rate limited by design;
- what code does inside your own sandbox, which is the point of a sandbox;
- problems in your AI client or in the cloud machines themselves, which belong to their vendors.

To report abuse of a sandbox, such as one used for attacks, write to the same address.

<!-- PENDING: a separate abuse address is an open founder decision -->

## Testing rules

<!-- PENDING: the founder must confirm this good-faith promise -->

If you act in good faith and follow these rules, we will not pursue or support legal action
against you for your research:

- test only against sandboxes you started and paid for yourself;
- never touch another person's sandbox, data, wallet or secrets;
- never run what Bugnet does not allow, such as miners, floods, or scans of other people's
  machines, even as a test;
- stop and report as soon as you find a problem, and do not keep or share data you came across;
- give us a reasonable time to fix it before you publish anything.

## Supported versions

Only the latest release of the bridge and the plugin, and the current public server, get
security fixes. Use `npx -y @bugnet/mcp@latest` in your client's settings so the bridge always
starts at the latest release, and update the plugin with `claude plugin update bugnet@bugnet`.
