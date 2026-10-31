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

**The 401 challenge header.** A refused credential (a token that is unknown, wrong, revoked,
expired, per-project or whose minter is disabled; an OAuth access token that fails any check
in [OAuth sign-in](#oauth-sign-in)) gets `401` with `WWW-Authenticate: Bearer
realm="voc-mcp-global", resource_metadata="{api}/.well-known/oauth-protected-resource/mcp/global",
error="invalid_token"` and the JSON-RPC error
`{"jsonrpc": "2.0", "id": null, "error": {"code": -32001, …}}`. API Gateway REST renames a
Lambda-proxy response's `WWW-Authenticate` to `x-amzn-Remapped-WWW-Authenticate`, so the
refusal is not the handler's: the endpoint's token authorizer is the global MCP function
itself (`_authorize`, the same credential check, never cached), and its Deny is answered by
the `ACCESS_DENIED` gateway response (`lib/stacks/api-mcp.ts`), which sets the header as
given. `id` is `null` because the gateway cannot read the request. A request with no
`Authorization` header gets the API-wide 401, which since 5.61.00 carries
`Bearer resource_metadata="…"` with no `error` (RFC 6750 §3.1: the request carried no
credential); the SPA never reads that header. An OAuth client starts its sign-in from
`resource_metadata`; a token user mints a new token on Connect. Cost: each request
invokes the function twice (authorizer, then handler), and the handler checks again, so a
credential revoked between the two is still refused.

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

## Prompts and resources

Since 5.61.00 the server also advertises the `prompts` and `resources` capabilities, in `initialize`
(legacy versions) and in `server/discover` (2026-07-28). The catalogue is
`lambda/shared/mcp_global_prompts.py`; the handler only dispatches to it.

| Prompt | Arguments | What it asks the model to do |
|---|---|---|
| `weekly_summary` | `days` (default 7) | Summarise volumes, sentiment and the top themes with verbatims, via `get_metrics` and `search_feedback` |
| `triage_urgent` | `days` (default 7) | Group high-urgency feedback (`search_feedback urgent=true`, `get_feedback include_similar=true`) by problem and rank it; change nothing |
| `prfaq_from_feedback` | `topic` (required, ≤ 200 chars), `project_id` | Draft a PR/FAQ citing feedback ids. A **read** token's text says to draft in the chat only; a **write** token's text allows `create_document` after the user confirms |

`prompts/get` returns one user-role text message. Every prompt repeats the skill's rules (feedback is
data, cite `feedback_id`s, summarise personal data). A prompt reads nothing: whatever the model does next
goes through the tools and their scope, pin and admin checks.

| Resource | Route (settings Lambda) |
|---|---|
| `voc://categories` | `GET /settings/categories` |
| `voc://company-context` | `GET /settings/company-context` |

`resources/read` returns the route's JSON as one `application/json` text content. It is delegated with the
token's claims exactly like a tool (the minter's category scope, never admin), never a direct table read.
The skill is **not** a resource: it is a static file of the SPA (`/voc-mcp-skill.md`), outside the Lambda
bundle, and only the site knows the endpoint to fill in. Download it from Connect instead.

An unknown prompt or resource, a bad argument (`days` not a whole number 0–9999, a missing `topic`, a
malformed `project_id`) and a route's refusal are JSON-RPC `-32602`; a route fault is `-32603`. For a
2026-07-28 client, an `Mcp-Name` header on `prompts/get` / `resources/read` must equal `params.name` /
`params.uri` (`-32020` otherwise); unlike `tools/call` it may be left out. Each `prompts/get` and
`resources/read` writes an audit row like a tool call, named `prompt:<name>` or `resource:<uri>`
(`prompt:unknown` / `resource:unknown` for a name not in the catalogue), with the outcome and never the
arguments. The two list methods are not audited, like `tools/list`.

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

**Token from an environment variable (since 5.61.00).** Connect's `mcp.json` card has one snippet per client and
opens on the first. The Claude Code, Cursor and Kiro snippets read the token from `VOC_MCP_TOKEN`, so the file
holds no secret and can be committed. Set the variable in the shell that starts the client
(`export VOC_MCP_TOKEN='<YOUR_VOC_TOKEN>'`):

| Client | File | Header value |
|---|---|---|
| Claude Code | `.mcp.json` (project root; `"type": "http"`) | `Bearer ${VOC_MCP_TOKEN}` |
| Cursor | `.cursor/mcp.json` or `~/.cursor/mcp.json` | `Bearer ${env:VOC_MCP_TOKEN}` |
| Kiro | `.kiro/settings/mcp.json` or `~/.kiro/settings/mcp.json` | `Bearer ${VOC_MCP_TOKEN}`. The IDE expands only approved variables: add `VOC_MCP_TOKEN` under Settings → *Mcp Approved Env Vars*. Kiro CLI reads it from the shell; a project `.env` is not loaded ([kiro.dev MCP configuration](https://kiro.dev/docs/mcp/configuration)) |
| Other clients | their own config | the inline snippet above, with the token pasted in |

The builders are `buildClientMcpJson` / `tokenExportLine` in `frontend/src/pages/Connect/connectSnippets.ts`
(exact JSON per client pinned in `connectSnippets.test.ts`).

## OAuth sign-in

Since 5.61.00 an MCP client can connect **without a token**: add the server URL, and the client
opens the browser, the person approves it on VoC's consent screen and signs in with their VoC
account. Personal `voc_tok_` tokens keep working beside it.

**Clients.** Verified flow (as in the reference implementation this port follows): **Kiro**,
**Claude Code** and **Cursor**. Connect shows a snippet per client with the URL only:

- Kiro and Cursor: `{"mcpServers": {"voc-datalake": {"url": "<api>/mcp/global"}}}` (no `headers`).
- Claude Code: `claude mcp add --transport http voc-datalake <api>/mcp/global`, then `/mcp` in a session.

**Web assistants (Claude.ai, ChatGPT, Amazon Quick) are untested until someone signs in with them
live.** Their callbacks are not built in: an operator lists them with
`-c mcpOAuthWebCallbacks='["https://…/callback"]'` (exact `https://` URLs, at most 10), which
creates the `web` client; without it there is no web client at all. Reported, unverified callbacks:
Claude.ai `https://claude.ai/api/mcp/auth_callback`, ChatGPT
`https://chatgpt.com/connector_platform_oauth_redirect`, Amazon Quick
`https://<region>.quicksight.aws.amazon.com/sn/oauthcallback`. Cursor's web callback
(`https://www.cursor.com/agents/mcp/oauth/callback`) is the default of `-c mcpOAuthCursorCallbacks`.

**Same identity as a token.** An OAuth caller acts as the person who approved it exactly like a
token acts for its minter: the grant row has the token row's fields (`created_by`,
`created_by_username`, `minted_by_admin`, `scope`, `project_id`, `expires_at`, `revoked_at`) in the
same `MCPGTOKEN` partition, so the handler's code after authentication is unchanged. Never admin,
at most editor, category and source access via delegation, `AdminGetUser` on every request (a
disabled or deleted person is refused), `run_agent` only for an administrator's write grant and
re-checked per call, the per-minute rate limit and one audit row per tool call (partition
`MCPAUDIT#{grant id}`).

**Scopes.** The Cognito resource server's identifier is the exact MCP URL
(`<api>/v1/mcp/global`), so the scopes are `<mcp url>/read` and `<mcp url>/write`. The consent
screen offers read only, or read and write when the client asked for write (or for no scope), plus
an optional project pin (the person must be able to view it). Cognito is asked for exactly the
consented scopes; per request the grant's scope is narrowed again by the token's
(`write` only when both say so).

**No app session for an MCP client.** The MCP app clients are allowed ONLY the two MCP scopes (no
`openid`, `email` or `profile`) and no SRP, password or custom auth flow (hosted-UI authorization
code + refresh only), so Cognito issues them no ID token; `openid` in a client's request is accepted
and dropped, discovery and registration no longer advertise it, and the token facade never passes an
`id_token` on in any case. The access token still carries `username` (Cognito sets it without
`openid`); the person's groups are read from Cognito per request, never from the token. As defence in
depth, every REST API Lambda and the assistant stream refuse, with a 401, a token issued to any app
client other than the SPA's web client and the board pool's client (`APP_CLIENT_IDS`, set on every
VocApiStack function; `shared/app_clients.py`, `lambda/stream/src/assistant/runtime/app-client.ts`):
API Gateway's Cognito authorizer accepts a token of any client of the pool, so without it an MCP
client's token would act on every REST route with the person's full rights, admin included.
`/mcp/global` keeps its own verification (below).

### How a sign-in works

| Step | Route (all under the `/v1` stage) | What happens |
|---|---|---|
| 1 | `POST /mcp/global` without a credential | 401 + `WWW-Authenticate: Bearer resource_metadata=…` |
| 2 | `GET /.well-known/oauth-protected-resource[/mcp/global]` | RFC 9728: `resource` = the MCP URL, `authorization_servers` = [`<api>/v1`] |
| 3 | `GET /.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | RFC 8414 metadata of the facade: `code_challenge_methods_supported: ["S256"]`, endpoints below, Cognito's `jwks_uri` |
| 4 | `POST /oauth/register` | DCR facade: stores nothing, answers the PRE-registered public client the redirect URIs select (loopback `/oauth/callback` = Kiro; `/callback` = Cursor when `client_name` says so, else Claude Code; an exact configured web callback = Cursor or web). Unknown web URIs are dropped, a confidential client or other grant types refused, refusals logged with the public metadata |
| 5 | `GET /oauth/authorize?…` | Checks client + redirect (else a plain 400, never a redirect), other faults go back to the client; then 302 to the SPA `https://<frontend>/oauth/authorize?<same query>` |
| 6 | SPA consent (`GET`/`POST /connect/oauth/consent`, Cognito) | The person approves: the grant is stored (replacing an earlier one of this person and client, which ends its tokens) with a 10-minute window for ONE new sign-in, bound to this authorize request (the SHA-256 of its `code_challenge` is stored on the grant); a loopback redirect gets a single-use relay row; the answer is Cognito's `/oauth2/authorize` with PKCE and state preserved |
| 7 | Cognito hosted sign-in | The person signs in again (the SPA signs in with SRP, so there is no hosted-UI session) |
| 8 | `GET /oauth/callback?code&state` | Loopback relay: consumes the relay row (state = 256-bit id, 10 min, single use), records which client and loopback URI got the code (sha256 of the code only), 302 to the client's own loopback URI, any port 1024–65535 (RFC 8252 §7.3) |
| 9 | `POST /oauth/token` | Forwards to Cognito (`redirect_uri` put back to the relay URL after checking the code's client and loopback URI). On success it records the token's `origin_jti` (its refresh chain) on the grant, only inside the consent window and only when the `code_verifier` S256-matches the consented `code_challenge` (another authorization started meanwhile cannot take the consent over); a refresh must come from a recorded chain of an active grant. Any refusal revokes the refresh token at Cognito and answers `invalid_grant` |
| 10 | `POST /mcp/global` with `Bearer <access token>` | Verified as below, then the token path's rules |

`POST /oauth/revoke` forwards to Cognito's `/oauth2/revoke`. Every facade answer is
`Cache-Control: no-store`; bodies are capped (register 8 KB, forms 16 KB); throttles are stage
method settings (`MCP_OAUTH_METHOD_THROTTLE`: register 5 rps / 10, the rest 10 rps / 20). The
anonymous routes are exactly these nine (`INTENTIONALLY_PUBLIC_OAUTH_ROUTES`, pinned by
`api-stack.test.ts`) and have no CORS preflight: native clients call them, a browser only
navigates to authorize and callback.

**Verification on `/mcp/global`** (`shared/mcp_credentials.py`, `shared/mcp_oauth_jwt.py`, also the
API Gateway authorizer): RS256 only (`alg` other than RS256, including `none` and HS256, is refused
before any key), signature by a key of the pool's JWKS (fetched from the fixed issuer URL, cached
1 h, re-read at most once a minute for an unknown `kid`; a JWKS fault is a 500, not a 401),
`iss` = the pool, `token_use` = `access`, `client_id` ∈ the MCP clients (never the web app's),
`exp` in the future, `iat` not, `aud` when present = the canonical MCP URL, an MCP scope, then the
grant for (sub, client) active and the token's `origin_jti` one of its recorded chains, the
username the grant's, and the person still current in Cognito. Tokens are never logged.

**Where the consent page sends the browser** (`frontend/src/api/oauthRedirect.ts`). Before it follows
the consent API's answer (Approve, Deny, or a refused request) the SPA checks it and shows its error state
otherwise: the configured hosted UI (`cognito.hostedUiDomain` in `config.json`, written by the CDK deploy
and `deploy:frontend` from VocCoreStack's `UserPoolDomain`), an RFC 8252 loopback `http://127.0.0.1`,
`localhost` or `[::1]` with a port, or the exact https callback (origin and path) the assistant's own
request named. A `config.json` without the hosted UI (written before 5.61.00) refuses the approval until
the next deploy.

**Revocation is immediate.** Connect lists the person's signed-in assistants (one per client) with
revoke (`GET /connect/oauth/grants`, `DELETE /connect/oauth/grants/{grant_id}`). Revoking marks the
grant and empties its chains, so the next request of every access token is a 401, even one
refreshed at Cognito directly. **Refresh tokens are never stored** by VoC. A grant lasts 90 days;
Cognito refresh tokens 30 days; access tokens 1 hour.

**RFC 8707 `resource`.** A `resource` other than the MCP URL is refused (`invalid_target`). By
default it is then NOT passed to Cognito: the app pool's hosted UI is the classic one and older
pools may be on the Lite plan, where Cognito's resource binding is unavailable. The token is still
bound to this server by its client id and URL-prefixed scopes, and `aud` is checked whenever
Cognito sets it. On a pool known to accept it, `-c mcpOAuthResourceIndicator=true` forwards it.

**Turning token minting off.** `-c mcpTokenMinting=false` makes `POST /connect/tokens` answer 403
and Connect hide the mint form; existing tokens keep working until they expire or are revoked.

**Where things live.** Grants: projects table, `MCPGTOKEN` / `TOKEN#oag_<sha256(sub, client)>`
(`shared/mcp_oauth_grants.py`, conditional writes in `mcp_oauth_store.py`). Relay and code rows:
jobs table `MCPOAUTH#RELAY#…` / `MCPOAUTH#CODE#…` with `ttl` (the projects table has none), consumed
by a DeleteItem returning the old row. Routes: `voc-mcp-tokens-api` (`shared/mcp_oauth_routes.py`,
`shared/mcp_oauth_consent_routes.py`); its role gains Put/Delete on `MCPOAUTH#*` only. Cognito
resource server and clients: `lib/stacks/api-mcp-oauth.ts` on VocApiStack. `cryptography` (the
signing layer) is attached to the MCP endpoint function only.

### Live-test runbook (after a deploy)

Do these against the deployed API (`<api>` = the `ApiEndpoint` output, ending in `/v1/`) with a
test user who is NOT an administrator, then once with an administrator for `run_agent`.

1. **Discovery, anonymous.** `curl -si <api>mcp/global -X POST -d '{}'` → `401` with
   `www-authenticate: Bearer resource_metadata="<api>.well-known/oauth-protected-resource/mcp/global"`.
   `curl -s <api>.well-known/oauth-protected-resource/mcp/global` and
   `<api>.well-known/openid-configuration` → the two JSON documents, `code_challenge_methods_supported: ["S256"]`.
   `curl -si -X GET <api>mcp/global` with no header → 401 (with a valid token: 405).
2. **Kiro, headless.** Put `{"mcpServers": {"voc-datalake": {"url": "<api>mcp/global"}}}` in
   `~/.kiro/settings/mcp.json`, start `kiro-cli chat`; it registers (201 in the tokens Lambda log,
   `client_kind: kiro`) and prints a sign-in URL. Over ACP the client gets an `oauth_request`; open
   the URL, approve on the consent page, sign in. Check `/mcp` lists the tools, call `list_projects`
   and `search_feedback`; a second Kiro session (another port) signs in too.
3. **Claude Code.** `claude mcp add --transport http voc-datalake <api>mcp/global`, `claude`, `/mcp`
   → authenticate → approve with **read only** → `create_document` is not offered. Re-approve with
   read and write: the first session's token is refused at once (new consent = new grant).
4. **Cursor.** Add the same `mcp.json` entry to `~/.cursor/mcp.json`, connect, approve. Cursor may
   sign in via its web callback: that is `-c mcpOAuthCursorCallbacks`.
5. **Revoke.** On Connect → Signed-in assistants, revoke Kiro: its next tool call is a 401 and Kiro
   asks to sign in again. Disable the test user in Cognito: every client of that user is refused.
6. **Web assistants** (only if `-c mcpOAuthWebCallbacks` is set): add the URL as a custom
   connector and record the result in this file; until then they stay "untested".
7. **Logs.** No token, code or state in `/aws/lambda/voc-mcp-tokens-api*` or
   `/aws/lambda/voc-mcp-global-api*` (`MCP OAuth token refused` lines name only the failed check).

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

## Alarms and concurrency

**Alarms (runtime-managed, since 5.61.00).** Like every operational alert, the endpoint's alarms exist only
while an admin has alerting on (**Administration → System → Logs → Alerts**, [deployment.md](deployment.md)):
the logs API creates them under the deployment's `voc-alerts-<account>-<region>-` prefix and they notify the
ops SNS topic. Each is the Sum of one custom metric (namespace `VoC-MCP-Global`, dimension
`service=voc-mcp-global-api`) over one 5-minute period, above a named constant in
`lambda/shared/ops_alerts.py`:

| Alarm | Metric (emitted by `mcp_global_handler.py`) | Fires above | Usually means |
|---|---|---|---|
| `mcp-auth-denied` | `AuthDenied`: an authorizer Deny, a handler 401, or a 403 for a foreign `Origin` | 50 (`MCP_AUTH_DENIED_THRESHOLD`) | A token scan, or many clients still configured with revoked / expired tokens |
| `mcp-tool-denied` | `ToolCall_denied`: scope, pin, admin or route-403 refusals of `tools/call` (and of a prompt or resource) | 20 (`MCP_TOOL_DENIED_THRESHOLD`) | A client probing beyond its token; check the token audit logs on Connect |
| `mcp-tool-failed` | `ToolCall_failed`: calls a server fault stopped (`-32603`) | 5 (`MCP_TOOL_FAILED_THRESHOLD`) | A domain Lambda or the delegation is failing |
| `mcp-rate-limited` | `RateLimited`: 429s from the per-token budget | 30 (`MCP_RATE_LIMITED_THRESHOLD`) | A client looping |

`AuthDenied` is new in 5.61.00; the other three were already emitted. The metrics carry the Powertools
`service` dimension, which is the function's base name, not the deployment-unique one: two deployments in one
account and region (a `deploymentPrefix` beside the default) share these metrics, so each one's alarms count
both. Four more alarm metrics cost $0.40 a month at the list price while alerting is on.

**Reserved concurrency.** `voc-mcp-global-api` reserves **20** concurrent executions
(`GLOBAL_MCP_RESERVED_CONCURRENCY` in `lib/stacks/global-mcp.ts`, pinned by
`api-stack-mcp-global-ops.test.ts`). The function is also its own token authorizer, so a request is two short
invocations; at the stage ceiling (20 rps) that needs well under 20. The reservation keeps a runaway client
from starving the account's other Lambdas and guarantees the endpoint its share. Past it, invocations are
throttled and API Gateway answers with a 5xx. The 20 come out of the account's
unreserved pool, which Lambda keeps at 100 or more, so the account's concurrency quota must be at least 120
or the deploy fails. It is the only reservation in the app; `docs/lambda-sizing.md` covers memory only.

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
