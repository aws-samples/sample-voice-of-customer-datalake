# Sources

Verification of the concrete facts asserted in this skill.

| Claim | Source | Checked |
|---|---|---|
| Streamable HTTP replaced the HTTP+SSE transport starting at protocol version 2025-03-26 | https://github.com/modelcontextprotocol/modelcontextprotocol, `docs/specification/2025-06-18/basic/transports.mdx` | 2026-10-28 |
| Aider has no native MCP client support (open feature request, not merged) | https://github.com/Aider-AI/aider/issues/3314 ("MCP SUPPORT", open) | 2026-10-28 |
| VS Code Copilot MCP config lives at `.vscode/mcp.json` (workspace) and uses a `servers` key, not `mcpServers` | https://code.visualstudio.com/docs/copilot/chat/mcp-servers | 2026-10-28 |
| `mcpServers` is the key used by Claude Code, Cursor, Continue, and Cline config files | Each client's own docs/config schema (`.cursor/mcp.json`, Continue `config.yaml`, Claude Code `.mcp.json`) | 2026-10-28 |
| MCP's own HTTP authorization flow is OAuth 2.1 + Protected Resource Metadata (RFC 9728) + Dynamic Client Registration (RFC 7591); stdio servers read credentials from env and must not implement this flow | https://github.com/modelcontextprotocol/modelcontextprotocol, `docs/specification/2025-06-18/basic/authorization.mdx` | 2026-10-28 |
