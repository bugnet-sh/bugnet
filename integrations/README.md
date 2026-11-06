# Bugnet rules for clients without the plugin

Bugnet's server sends every MCP client instructions that say when to offer a sandbox. Some
clients do not read them, or read only the start. The files here give those clients
the same guidance as rules they do read. The Claude Code plugin does not need them.

How to add the server itself to each client is in the README's [Install](../README.md#install)
section. These files add only the guidance.

<!-- PENDING: the public server at mcp.bugnet.sh is not deployed yet -->

| Client                           | Add the server                                                  | Add the guidance                                                                              |
| -------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Cursor                           | `.cursor/mcp.json`, see [Cursor](../README.md#cursor)           | Copy [`cursor/bugnet.mdc`](cursor/bugnet.mdc) to `.cursor/rules/bugnet.mdc`                   |
| Codex CLI                        | `codex mcp add bugnet --url https://mcp.bugnet.sh/mcp`          | Optional: paste [`agents-md/AGENTS.snippet.md`](agents-md/AGENTS.snippet.md) into `AGENTS.md` |
| Any agent that reads `AGENTS.md` | The client's own MCP setup, see [Install](../README.md#install) | Paste [`agents-md/AGENTS.snippet.md`](agents-md/AGENTS.snippet.md) into `AGENTS.md`           |

- **Cursor's** docs do not say it reads MCP server instructions, so the rule carries them. The
  rule is not always on: Cursor's agent picks it up when a request matches its description.
- **Codex** reads the instructions. Their first paragraph stands alone, in case a client shows
  only the start. The `AGENTS.md` snippet repeats it for projects that want it written down.

The Cursor and Codex steps follow those clients' own docs. They were not run here, since neither
client is installed on the machine these files were written on.
