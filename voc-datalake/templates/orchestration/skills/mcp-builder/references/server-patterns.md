# MCP Server Patterns

Skeletons and wiring for MCP servers. Tools-first: the model-controlled `tools`
primitive is the only one with universal client support.

## Python: FastMCP (stdio)

The `mcp` SDK's `FastMCP` is the shortest path. Decorate functions as tools; the
signature + docstring become the schema + description the model matches on.

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("orders")

@mcp.tool()
def search_orders(customer_id: str, limit: int = 20) -> list[dict]:
    """Search orders for a customer. Returns most recent first."""
    # validate at the boundary
    if not customer_id.strip():
        return [{"error": "customer_id required"}]
    limit = max(1, min(limit, 100))
    return _query(customer_id, limit)  # parameterized query, scoped creds

if __name__ == "__main__":
    mcp.run()  # stdio transport by default
```

## Python: Streamable HTTP (remote/hosted)

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("orders", stateless_http=True)

# expose as an ASGI app; put auth middleware in front of it
app = mcp.streamable_http_app()
```

Run behind an auth layer (bearer/OAuth). Never expose unauthenticated.

## TypeScript: @modelcontextprotocol/sdk (stdio)

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "orders", version: "1.0.0" });

server.tool(
  "search_orders",
  "Search orders for a customer. Returns most recent first.",
  { customer_id: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) },
  async ({ customer_id, limit }) => ({
    content: [{ type: "text", text: JSON.stringify(await query(customer_id, limit)) }],
  }),
);

await server.connect(new StdioServerTransport());
```

## Transport decision

| Situation | Transport |
|---|---|
| Local dev tool, single user, runs on same machine | **stdio** (default) |
| Shared/hosted server, multiple users, remote | **Streamable HTTP** |
| Anything new | never SSE, deprecated in the 2025-03-26 spec revision |

- stdio servers are launched by the client (`command` + `args` in config).
- HTTP servers run independently; the client connects by `url`.

## Output discipline

- Return structured JSON, not prose paragraphs.
- Cap payload size. For large results, return a summary + an ID/URI the caller can
  fetch on demand rather than dumping everything into the model's context.
- Errors are data: `{"error": "..."}`, not exceptions that crash the transport.

## Client config shapes

stdio (Claude Code / Cursor / Cline / Continue, `mcpServers` key):
```json
{ "mcpServers": { "orders": { "command": "python3", "args": ["server.py"] } } }
```

HTTP (remote):
```json
{ "mcpServers": { "orders": { "type": "http", "url": "https://host/mcp" } } }
```

Copilot (VS Code) uses `.vscode/mcp.json` with a `servers` key instead of `mcpServers`.
