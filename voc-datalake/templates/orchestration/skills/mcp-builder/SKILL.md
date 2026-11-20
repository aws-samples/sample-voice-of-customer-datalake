---
name: mcp-builder
description: "Builds and reviews Model Context Protocol (MCP) servers in Python (mcp SDK, FastMCP) or TypeScript (@modelcontextprotocol/sdk): tools over prompts and resources, tool design, stdio or Streamable HTTP, security, client config. Read it when writing or reviewing an MCP server."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/mcp-builder"
license: MIT
adapted: "Discovery and verification use the agent's own tools: the server is exercised through a test the agent writes and runs with run (tools/list and tools/call over stdio), offline. Client configurations are generated for the clients the task names. The report goes in the finish; description and emphasis reworded for Claude 5.5 skill discovery"
---

Build or review the MCP server your task names.

MCP is the one capability primitive that ports across assistants: a server's
**tools** work identically in Claude Code, Cursor, Windsurf, Copilot (VS Code),
Continue, and Cline. Prefer MCP tools over assistant-specific rule text whenever a
capability needs real execution (query a DB, call an API, run a linter).

## Step 1: Detect stack and intent

Read `pyproject.toml`, `package.json`, existing `*.py`/`*.ts` servers, and any
`.mcp.json` / `mcp.json` config. Decide:
- **Language**: Python (`mcp` SDK, `FastMCP`) or TypeScript (`@modelcontextprotocol/sdk`).
- **Transport**: `stdio` (local, default) or **Streamable HTTP** (remote/hosted). SSE is
  deprecated, do not add it to new servers.
- **Primitive**: almost always **tools**. See Step 2 before choosing resources/prompts.

## Step 2: Choose the right primitive (this is the load-bearing decision)

| Primitive | Controlled by | Cross-client support | Use for |
|---|---|---|---|
| **Tools** | model | Universal | Anything the agent should *do*. DEFAULT. |
| **Resources** | host app | Partial (host decides injection) | Read-only context the *app* chooses to attach |
| **Prompts** | user | Weak (many clients ignore) | Optional UX slash-commands only |

- Put behavior in **tools**, because prompts and resources are structurally in the spec
  but client support is inconsistent, a client that lacks them silently ignores the
  capability with no error.
- Do not rely on prompts/resources as the primary delivery mechanism for a
  capability. If it must work everywhere, it is a tool.
- Optionally, expose prompts as a convenience for clients that support them, never as the
  only path.

## Step 3: Design tools well

- One tool = one clear action. Name with a verb (`search_orders`, not `orders`).
- Give every tool a precise JSON Schema for inputs and a `description` the model
  can match, because the description is how the model decides to call it.
- Validate every input at the tool boundary, because tool arguments come from the model and
  are untrusted; return structured errors, never raise raw stack traces to the client.
- Keep tool output small and structured. Large blobs burn the caller's context, return a
  summary + a resource URI or an ID to fetch detail on demand.
- Make tools idempotent where possible, so a retried call does no harm; mark destructive tools clearly in the
  description and require explicit args (no silent deletes).

See `references/server-patterns.md` for Python (FastMCP) and TypeScript skeletons,
transport wiring, and a stdio/HTTP decision guide.

## Step 4: Security (MCP servers are attack surface)

- Do not hardcode secrets, because the source is shared and a committed secret leaks. Read
  credentials from env; document required vars.
- Scope every external call (DB, API, filesystem) to least privilege, so a misused tool can do
  little: a tool that reads should not hold write credentials.
- Treat tool arguments as untrusted input, because the model fills them from text it read:
  parameterize DB queries, never shell out with unsanitized strings, constrain file paths to
  an allowlisted root.
- For HTTP transport: require auth, bind to loopback unless deliberately remote, and
  never expose an unauthenticated public endpoint. The MCP spec's own authorization
  flow is OAuth 2.1 with Protected Resource Metadata (RFC 9728) for server discovery
  and Dynamic Client Registration (RFC 7591); stdio servers read credentials from env
  instead, never implement this flow over stdio.
- Prompt-injection: tool *outputs* may carry adversarial text. Note in descriptions when
  output is untrusted so the calling agent treats it as data, not instructions.

See `references/security-checklist.md` for the full gate.

## Step 5: Wire clients and verify

Generate the config for each client the task names (paths differ per assistant):

| Assistant | Config location | Key |
|---|---|---|
| Claude Code | `.mcp.json` (project) or plugin `.mcp.json` | `mcpServers` |
| Cursor | `.cursor/mcp.json` / `~/.cursor/mcp.json` | `mcpServers` |
| Windsurf | Cascade MCP config | `mcpServers` |
| Copilot (VS Code) | `.vscode/mcp.json` | `servers` |
| Continue | `config.yaml` `mcpServers:` block | `mcpServers` |
| Cline | MCP settings | `mcpServers` |

- Aider has **no** MCP support, if the task needs Aider, the capability must ship as a
  script/CONVENTIONS.md note instead. State this explicitly.
- Test the server before declaring done, because a server that fails to start or list its
  tools looks fine until a client calls it: list tools, call one with a flat sample
  input, confirm structured output. For stdio, write a test that starts the server as a
  subprocess and exercises `tools/list` + `tools/call` (the SDKs' in-memory or stdio client),
  and run it with `run`; it needs no network. Put the actual result in your finish, do not
  assume it works. An HTTP server is tested on loopback in the same way.

## Checklist

- [ ] Capability expressed as **tools** (not prompts/resources) unless UX-only
- [ ] Every tool has input JSON Schema + a model-matchable description
- [ ] Inputs validated at the boundary; errors returned as structured data
- [ ] No secrets in code; external calls least-privilege
- [ ] Transport chosen correctly (stdio local / Streamable HTTP remote; no SSE)
- [ ] Client config generated for each client the task names
- [ ] Aider gap called out if relevant
- [ ] Server tested with a real `tools/call` before reporting success
