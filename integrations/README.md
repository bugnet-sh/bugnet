# Bugnet for clients without the Claude Code plugin

Every MCP client loads the gateway's server instructions, which say when to offer Bugnet. These
files add the same guidance where a client reads rules instead. The Cursor and Codex commands
follow their docs and were not run here, since neither client is installed on the build machine.

| Client                        | Add the server                                                                     | Add the guidance                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Cursor                        | `.cursor/mcp.json`: `{"mcpServers": {"bugnet-sandbox": {"url": "<gateway>/mcp"}}}` | Copy `cursor/bugnet.mdc` to `.cursor/rules/bugnet.mdc`. Cursor does not document reading MCP server instructions, so the rule carries them |
| Codex CLI                     | `codex mcp add bugnet-sandbox --url <gateway>/mcp`                                 | Codex reads the server instructions. Optionally paste `agents-md/AGENTS.snippet.md` into `AGENTS.md`                                       |
| Any agent reading `AGENTS.md` | the client's own MCP setup                                                         | Paste `agents-md/AGENTS.snippet.md` into `AGENTS.md`                                                                                       |
