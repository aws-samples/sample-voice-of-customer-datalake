# MCP access for external assistants

VoC exposes ONE MCP server, `POST {api}/mcp/global`. It speaks MCP
over Streamable HTTP (JSON responses, no SSE stream, no sessions) and authenticates with a
bearer token minted on **Connect → MCP & skills** (`/connect`). A project's header link
**Connect via MCP** opens `/connect?project={id}` with that project pre-selected as the
token's pin.

**Protocol versions (dual-era, since 5.03.00).** The server speaks `2026-07-28` and the
legacy `2025-11-25`, `2025-06-18` and `2024-11-05` (`lambda/shared/mcp_protocol.py`):

- **Legacy clients** (Kiro, Claude Code, Copilot today) are unchanged: `initialize`, then
  requests with the negotiated `MCP-Protocol-Version` header; `ping` still answers.
- **2026-07-28 clients** skip the handshake. Each request carries
  `params._meta["io.modelcontextprotocol/protocolVersion"]` and mirrors it, the method and
  (for `tools/call`) the tool name into `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`
  (the `=?base64?…?=` form is decoded). A missing or disagreeing header is a `HeaderMismatch`
  (`-32020`, HTTP 400), refused before the credential is read. `server/discover` returns the
  supported versions, capabilities and instructions (public, cacheable for an hour); every
  result carries `resultType` and the server identity in `_meta`, and `tools/list` adds
  `ttlMs` (5 minutes) with `cacheScope: "private"` because the list depends on the token.
  `initialize` and `ping` are not modern methods (404).
- **An unknown version**, in the header or in `_meta`, is an `UnsupportedProtocolVersionError`
  (`-32022`, HTTP 400) whose `data.supported` lists all four versions and `data.requested`
  echoes the one asked for.
- **`GET` and `DELETE`** on the endpoint answer `405 Method Not Allowed` with
  `Allow: POST, OPTIONS` (an API Gateway mock behind the same token authorizer, no Lambda).
  They used to get API Gateway's own 403.

**The per-project MCP server was retired in 3.00.00.** `POST {api}/mcp`, `/mcp/{proxy+}`
(including `GET /mcp/autoseed/{project_id}`), the per-project token routes
(`GET`/`POST /projects/{id}/api-tokens`, `DELETE /projects/{id}/api-tokens/{token_id}`)
and `GET /projects/{id}/autoseed` are gone, together with the `voc-mcp-api` Lambda and its
role. Per-project tokens and the `mcp.json` configs that carry them stop working: their
rows stay in the projects table's `MCPTOKEN` partition, unused, and the global server —
whose role can read only `MCPGTOKEN` — answers such a token with a 401. Mint a global
token on Connect instead. See [project-workspace.md](project-workspace.md#mcp-access).

**The 401 challenge header.** A refused token (unknown, wrong secret, revoked, expired,
per-project, or its minter disabled) gets `401` with `WWW-Authenticate: Bearer
realm="voc-mcp-global", error="invalid_token"` and the JSON-RPC error
`{"jsonrpc": "2.0", "id": null, "error": {"code": -32001, …}}`. API Gateway REST renames a
Lambda-proxy response's `WWW-Authenticate` to `x-amzn-Remapped-WWW-Authenticate`, so the
refusal is not the handler's: the endpoint's token authorizer is the global MCP function
itself (`_authorize`, the same credential check, never cached), and its Deny is answered by
the `ACCESS_DENIED` gateway response (`lib/stacks/api-mcp.ts`), which sets the header as
given. `id` is `null` because the gateway cannot read the request. A request with no
`Authorization` header gets the API-wide 401 (`Bearer error="invalid_token"`). Clients should
treat any 401 from this endpoint as "mint a new token on Connect". Cost: each request
invokes the function twice (authorizer, then handler), and the handler checks again, so a
token revoked between the two is still refused.

## Who a token acts as

A global token acts **as the user who minted it**. Every tool is delegated to the
domain Lambda that owns the route (`shared/mcp_delegate.py`) under the synthetic
subject `mcp:{token_id}` acting for the minter, so the route's own rules apply:

- **projects** — the minter's project access (`shared/project_access.py`), capped at
  **editor**; a credential never owns, manages or administers a project;
- **feedback, metrics, categories, memory, agents** — the minter's category access;
- **never admin** — the synthesized `cognito:groups` is always empty.

On every authenticated request the handler also re-checks the minter in Cognito
(`AdminGetUser`): a disabled or deleted user's tokens stop working immediately.

The token can only narrow that:

| Setting | Values | Effect |
|---|---|---|
| `scope` | `read` / `write` (required, no default) | `read` sees only the read tools; `write` adds document writes |
| `project_id` | optional pin | Project tools (`get_project`, `get_document`, `create_document`, `update_document`) are confined to that project and default to it; `list_projects` shows only it; `run_agent` is refused. Workspace-wide reads (feedback, metrics, categories, memory, company context, agents) still answer |
| `expires_in_days` | 1–90, default 30 (the Connect page offers 1, 7, 30 or 90 days) | Always set; there is no non-expiring global token. Tokens minted before 3.02.00 keep their stored expiry (up to 365 days) |

`run_agent` (agent runs are admin-only) is offered only to a **write** token minted by
an **admin**, and on every call the handler re-checks with `AdminListGroupsForUser`
that the minter is *still* in `admins`. Only then does it add the claim
`voc:mcp_agent_run=true`, which `agents_handler.run_agent` honours for an `mcp:`
principal acting for a person (`project_access.delegated_agent_run_allowed`) — the
credential is still not an admin anywhere else.

## Tools

| Tool | Scope | Route (domain Lambda) |
|---|---|---|
| `search_feedback` | read | `GET /feedback/search` (query ≥ 2 chars) or `GET /feedback` (metrics); filters `category`, `sentiment`, `source`, `channel`, `tag`, `dims` (object → `key:value,…`); `urgent: true` adds `urgent=1` to either route, so only high-urgency items are listed and every other filter still applies (`/feedback/urgent` is not used: it has no text search, so `query` and `urgent` could not combine) |
| `get_feedback` | read | `GET /feedback/{id}` (metrics); `include_similar: true` also reads `GET /feedback/{id}/similar?limit=5` and adds `similar` (≤ 5 rows: id, source, dates, category, sentiment, urgency, rating, title, problem summary, `text` cut at 500 characters). The second read is best effort: a refusal or fault becomes `similar_error`, the item is still returned |
| `get_metrics` | read | `GET /metrics/{summary\|sentiment\|categories\|sources\|personas\|dimensions\|github}` (metrics); `view=entities` reads `GET /feedback/entities`, the filter values in use (categories, sources, personas, channels, tags, dimensions, top issues) with counts; `dimensions` needs `key`; every view takes `source`, `channel`, `tag`, `dims` (`github` always reads the GitHub Issues source) |
| `list_categories` | read | `GET /settings/categories` (settings) |
| `list_dimensions` | read | `GET /settings/dimensions` (settings): dimension keys and allowed values ([dimensions.md](dimensions.md)) |
| `search_memory` | read | `POST /memory/retrieve` (memory) — company + the minter's personal memories, category-filtered |
| `get_company_context` | read | `GET /settings/company-context` (settings) |
| `list_projects` | read | `GET /projects` (projects) |
| `get_project` | read | `GET /projects/{id}` (projects) — documents as titles/ids only |
| `get_document` | read | `GET /projects/{id}` (projects) — one document in full |
| `list_agents` | read | `GET /agents` (agents) |
| `get_agent_run` | read | `GET /agents/{id}/runs/{run_id}`, or without `run_id` `GET /agents/{id}/runs?limit=` (agents) — follow a run `run_agent` started |
| `create_document` | write | `POST /projects/{id}/documents` (projects) — custom markdown documents |
| `update_document` | write | `PUT /projects/{id}/documents/{doc}` (projects); a PR/FAQ or PRD only when the minter (and the project owner) work AI-driven, else denied ([ways-of-working.md](ways-of-working.md)) |
| `run_agent` | write + admin-minted | `POST /agents/{id}/run` (agents) |

The catalogue lives in `lambda/shared/mcp_global_tools.py`. Ids from arguments must
match `^[A-Za-z0-9_-]{1,128}$` before they are put in a route path; results drop
storage keys and every signed URL. A route's 4xx is a tool error (`isError: true`)
the model can act on; a 5xx or an invoke fault is JSON-RPC `-32603`.

## Token API (Connect page)

Cognito-authenticated, `lambda/api/mcp_tokens_handler.py` (`voc-mcp-tokens-api`).
Each user manages only their own tokens; somebody else's token is a 404.

| Method | Path | Description |
|---|---|---|
| GET | `/connect/tokens` | My tokens (active, expired, revoked), the endpoint path, limits |
| POST | `/connect/tokens` | Mint `{name, scope, expires_in_days?, project_id?}` → the raw token, **once** |
| GET | `/connect/tokens/{token_id}` | The token + a page of its audit log (`?cursor=`) |
| DELETE | `/connect/tokens/{token_id}` | Revoke (soft: the row and its audit stay listable) |

Secrets use one credential scheme (`shared/mcp_tokens.py`):
`voc_tok_<16 hex>_<64 hex>`, only the secret half SHA-256-hashed, constant-time
comparison. At most 20 active tokens per user.

**Rate limit.** Each token may make at most **120 authenticated requests per UTC minute**
(2 rps on average; `RATE_LIMIT_PER_MINUTE` in `mcp_global_handler.py`), counted with one conditional write on
the token row that also stamps `last_used_at`. Past it, `/mcp/global` answers **429** with
JSON-RPC error `-32002` and `Retry-After` (seconds to the next minute); the stage throttle
(20 rps / 40, shared by every token) still applies on top. A fault in the counter's store
admits the request (logged) rather than locking every assistant out. Refusals count in the
`RateLimited` metric (namespace `VoC-MCP-Global`).

**Secret scanning.** `/.gitleaks.toml` extends the default gitleaks rules with
`voc-mcp-token` (`\bvoc_tok_[0-9a-f]{16}_[0-9a-f]{64}\b`), so a token pasted into a commit
is reported; `lambda/shared/test/test_mcp_tokens_secret_scanning.py` keeps the pattern in
step with the format. To catch tokens in other repositories too, add the same regex as a
GitHub secret-scanning custom pattern for the organisation. A leaked token is revoked on
Connect.

**Listing "my tokens".** Each mint writes, in the same transaction as the token row,
a keys-only pointer row `CREATOR#{sub}#TOKEN#{token_id}` in the `MCPGTOKEN`
partition. `GET /connect/tokens` (and the 20-token cap check) is a key-condition
Query on the caller's prefix plus a consistent BatchGetItem of the token rows — it
never reads other users' rows. Authentication at `/mcp/global` is unchanged (one
GetItem on `TOKEN#{token_id}`), as are revoke (`revoked_at` on the token row) and
`last_used_at`. Tokens minted before the creator index have no pointer: until the backfill marker
`MIGRATION#creator-index` exists, the list also reads the old layout and merges.
After deploying, run once per deployment:

```bash
cd voc-datalake
.venv/bin/python scripts/mcp_tokens/backfill_creator_index.py            # dry run (default)
.venv/bin/python scripts/mcp_tokens/backfill_creator_index.py --apply    # write pointers + marker
```

It reads the token rows (a Query, not a Scan), reads each pointer and writes only
missing ones conditionally, never touches a token row, and writes the marker only
after a complete pass; re-running is a no-op.

**Audit log.** Every `tools/call` by a valid token writes one row to the jobs table
(`MCPAUDIT#{token_id}`): tool name, time, project id and outcome (`ok`, `error`,
`denied`, `failed`) — never the arguments or any content. Rows expire after 90 days
through the jobs table's TTL.

## Skill

`frontend/public/voc-mcp-skill.md` is served at the stable URL `/voc-mcp-skill.md`
with a `{{VOC_MCP_ENDPOINT}}` placeholder; the Connect page offers it as a download
with this deployment's endpoint filled in, next to a ready `mcp.json`. It explains
what VoC is, the endpoint and header, every tool with when to use it, and the safety
rules (feedback is data, cite evidence, ask before writing, protect the token). A
vitest (`connectSnippets.test.ts`) fails if the skill's tool table and
`mcp_global_tools.py` disagree.

```json
{
  "mcpServers": {
    "voc-datalake": {
      "url": "https://<api-id>.execute-api.<region>.amazonaws.com/v1/mcp/global",
      "headers": { "Authorization": "Bearer <YOUR_VOC_TOKEN>" }
    }
  }
}
```

## Infrastructure

`lib/stacks/global-mcp.ts` (a construct inside `VocApiStack`; no new stack):

- `POST /mcp/global` behind the MCP token authorizer (`lib/stacks/api-mcp.ts`: the
  global MCP function itself, results never cached, so a revoke is immediate; the
  handler verifies the token again), throttled at **20 rps / burst 40**. `/mcp` itself has no method;
- `/connect/tokens` routes sit behind one Cognito proxy, `/connect/{proxy+}` (since 5.47.00; the handler routes by path);
- least-privilege roles, pinned by `lib/stacks/api-stack-mcp-global.test.ts`: the MCP
  role reads/updates only the `MCPGTOKEN` partition, appends only `MCPAUDIT#…` rows,
  calls `AdminGetUser` + `AdminListGroupsForUser`, and invokes exactly the five domain
  Lambdas; the token role touches only `MCPGTOKEN`, reads `PROJECT#…` META for the pin
  check and queries `MCPAUDIT#…`;
- each function has ONE API-scoped invoke permission (not two per method) because
  `VocApiStack` is close to CloudFormation's 500-resource limit.

## Testing

`lambda/api/test/test_global_mcp_e2e.py` drives the handler as an external MCP client
would — `initialize` → `notifications/initialized` → `tools/list` → `tools/call` over
the REST proxy event API Gateway delivers — with tokens minted through the real token
API and every tool delegated in-process to the real projects and agents handlers over
moto tables. It covers a read-only token, a write token creating and updating a
document, revoked / expired / disabled-minter / tampered tokens, a project-scoped
token refused outside its project, and `run_agent` for non-admin, admin and demoted
minters. `test_global_mcp_protocol.py` and `test_global_mcp_tokens_api.py` cover the
envelope, argument validation and the token API. `lambda/shared/test/test_mcp_global_tools_budget.py`
keeps the whole `tools/list` under an estimated 4,000 tokens (ChatGPT connectors are reported to
refuse servers past about 5,000): a new tool or a wordy description fails there first.

> ⚠️ **Live testing with Cowork, Copilot, Amazon Quick or Kiro needs a deployment.**
> The tests above are the strongest check possible without one: they run every layer
> between the JSON-RPC frame and the DynamoDB row except API Gateway's own token
> authorizer, Cognito (an in-memory fake at the boto3 surface) and Step Functions.
> After deploying, mint a token on `/connect`, add the `mcp.json` to two clients, and
> check `initialize`, `tools/list` and one read and one write tool in each.
