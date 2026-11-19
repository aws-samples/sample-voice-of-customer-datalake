# MCP Server Security Checklist

An MCP server is executable attack surface exposed to an agent. Treat every tool
argument as untrusted and every external call as a privilege boundary.

## Secrets and credentials
- [ ] No hardcoded secrets, tokens, or connection strings. Read from env only.
- [ ] Document required env vars in the README; fail fast with a clear message if unset.
- [ ] Credentials scoped to what the tool needs, a read tool does not hold write access.

## Input handling (arguments are untrusted)
- [ ] Every tool validates inputs against its schema at the boundary.
- [ ] Database access uses parameterized queries, never string-interpolate SQL.
- [ ] No shelling out with unsanitized argument strings. If you must, allowlist commands
      and pass args as a list, never through a shell.
- [ ] File-path arguments are resolved and constrained to an allowlisted root; reject
      paths that escape it (`..`, absolute paths outside the root, symlinks).
- [ ] Numeric/enum inputs are range-checked and clamped.

## Transport
- [ ] stdio for local single-user; the client owns the process lifecycle, credentials
      come from env, never implement the OAuth flow below over stdio.
- [ ] HTTP transport requires authentication on every request. The MCP spec's own
      authorization flow is OAuth 2.1, with the server as resource server, Protected
      Resource Metadata (RFC 9728) for discovery, and Dynamic Client Registration
      (RFC 7591); a bearer token from any OAuth 2.1-compliant provider is also valid.
- [ ] HTTP servers bind to loopback unless deliberately remote; no unauthenticated
      public endpoint (this is the MCP analogue of an open API).
- [ ] No SSE transport on new servers (deprecated since protocol version 2025-03-26,
      replaced by Streamable HTTP).

## Output and prompt injection
- [ ] Tool output is data, not instructions. If a tool returns content from an untrusted
      source (web pages, user records, tickets), say so in the tool description so the
      calling agent treats it as data.
- [ ] Do not reflect raw upstream error text (stack traces, DB errors) to the client,
      return a sanitized structured error.
- [ ] Cap output size; large blobs both burn context and can smuggle injected text.

## Blast radius
- [ ] Destructive tools (delete, write, spend) are clearly marked and require explicit,
      non-default arguments, no silent side effects.
- [ ] Log tool invocations (name + non-sensitive args) for auditability.
- [ ] Rate-limit or guard tools that hit paid/external APIs.

## Before shipping
- [ ] `tools/list` returns every tool with a description and schema.
- [ ] A real `tools/call` with a flat sample input returns structured output.
- [ ] Confirmed no secret is printed in logs or returned in any tool response.
