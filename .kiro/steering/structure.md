# VoC Data Lake - Project Structure

## Repository Layout

```
voice-of-customer-datalake/       # Root repository
├── docs/                         # Documentation (one file per topic; README links every one)
│   ├── deployment.md             # Deployment guide
│   ├── …                         # agents, memory, mcp, categories, dimensions, plugins, pipeline, …
│   └── images/                   # README architecture diagram (architecture.drawio + PNG) and screenshots
├── scripts/                      # Repo-wide tooling
│   ├── validate.sh               # Every quality gate (CI runs only this); validate-affected.sh = changed paths only
│   ├── check-version.mjs         # CHANGELOG ↔ package.json version check
│   ├── dev-with-mock.mjs         # `npm run dev`: mock API + Vite
│   ├── codeql*.{sh,mjs,yml}, gitleaks-tree.sh, knip-production.mjs, quality-baseline.sh
│   ├── mutation-*                # Per-module mutation programme (planner, rounds, done lists, brief)
│   └── git-hooks/pre-push        # Optional Kiro CLI AI review before push (install: CONTRIBUTING.md)
├── eslint-rules/                 # Shared ESLint gate rules (human-owned)
├── tools/kiro-acp-bridge/        # Browser → local kiro-cli bridge (docs/kiro-acp-browser-bridge.md)
├── package.json                  # Root scripts (shortcuts)
└── voc-datalake/                 # Main CDK project
    ├── bin/
    │   └── voc-datalake.ts           # CDK app entry point - defines all stacks
    ├── lib/stacks/                   # CDK stack definitions (TypeScript) - 5 stacks
    │   ├── api-stack.ts              # VocApiStack: composes the api-*.ts builders, webhooks, frontend deploy, outputs
    │   ├── api-*.ts                  # Its builders (resources created ON the stack, logical ids unchanged): api-context, api-data-lambdas, api-engagement-lambdas, api-projects-lambda, api-fixture-provider, api-job-lambdas, api-document-workflow, api-assistant-lambdas, api-gateway (stage, throttles, CORS, authorizer), api-routes, api-mcp
    │   ├── bedrock-access-stack.ts   # Bedrock model access configuration
    │   ├── core-stack.ts             # Core infrastructure (DynamoDB, KMS, product-doc extractor; composes core-buckets/core-cdn/core-auth)
    │   ├── core-buckets.ts           # S3 buckets (versioned + bounded lifecycle)
    │   ├── core-cdn.ts               # CloudFront, URL-signing keys, design-integrations secret
    │   ├── core-auth.ts              # Cognito user/identity pools, admin bootstrap, model pin
    │   ├── ingestion-stack.ts        # Plugin Lambdas, EventBridge schedules, SQS, Secrets
    │   ├── processing-stack-consolidated.ts # Processing + Research (Bedrock, Step Functions)
    │   └── processing-research-workflow.ts  # Research state machine
    ├── lambda/                       # Python Lambda functions
    │   ├── processor/handler.py      # SQS consumer - Bedrock/Comprehend enrichment
    │   ├── aggregator/handler.py     # DynamoDB Streams consumer - real-time metrics
    │   ├── research/
    │   │   └── research_step_handler.py  # Step Functions task handler
    │   ├── jobs/category_reprocess/handler.py # Category reprocess worker (VocProcessingStack, self re-invoking)
    │   ├── jobs/retention/handler.py # voc-retention: retention + erasure deletes (VocProcessingStack, docs/source-policies.md)
    │   ├── memory/{extractor,scanner,retention}/handler.py # Memory workers (VocProcessingStack, docs/memory.md)
    │   ├── agents/{heartbeat,conductor,persona_panel}/handler.py # Agent runtime (VocProcessingStack, docs/autonomous-agents.md)
    │   ├── shared/                   # Shared utilities across Lambdas (a selection — see the directory)
    │   │   ├── __init__.py
    │   │   ├── api.py                # API response helpers
    │   │   ├── auth.py               # Authentication utilities
    │   │   ├── avatar.py             # Avatar generation utilities
    │   │   ├── aws.py                # AWS client helpers
    │   │   ├── converse.py           # Bedrock conversation utilities
    │   │   ├── enabled_sources.py    # Source ids an unfiltered /sources/status or /logs listing covers (#256)
    │   │   ├── dimension_config.py   # Dimensions config, tags, `dims` param (docs/dimensions.md)
    │   │   ├── item_filters.py       # channel / dims / tag item matching (metrics + reprocess)
    │   │   ├── source_profiles.py    # Source profiles (PII policy, retention, restricted), cached lookup
    │   │   ├── source_policy.py      # apply_source_policy: redaction before archive/SQS
    │   │   ├── pii_redaction.py      # Regex + Comprehend PII redaction
    │   │   ├── feedback.py           # Feedback data utilities
    │   │   ├── http.py               # HTTP utilities
    │   │   ├── data_version.py       # Data/config/Radar version counters the read caches key on (docs/caching.md)
    │   │   ├── response_cache.py     # Opt-in warm-container memo for read-only GETs (metrics, Radar)
    │   │   ├── http_cache.py         # ETag/304 on API GETs; NO_STORE_PATTERNS for per-user live state
    │   │   ├── idempotency.py        # Idempotency helpers
    │   │   ├── ingest_schemas.py     # Pydantic schemas validating every processing-queue message
    │   │   ├── logging.py            # Logging utilities
    │   │   ├── prompts.py            # Prompt management utilities
    │   │   ├── scraper_run_errors.py # Read-time redaction of stored scraper-run errors
    │   │   ├── url_policy.py         # Outbound URL policy for scraper fetches (SSRF guard, #244)
    │   │   ├── usefulness.py         # Heuristic usefulness band low|medium|high (processor, reprocess; docs/data-quality.md)
    │   │   └── data_quality.py       # Per-source band distribution for GET /metrics/data-quality
    │   ├── api/                      # Split into domain-specific Lambdas (20KB IAM policy limit) - 20 handlers
    │   │   ├── metrics_handler.py        # /feedback/*, /metrics/* (read-only queries)
    │   │   ├── feedback_edit_handler.py  # PUT /feedback/{id}/category (the only feedback write route)
    │   │   ├── memory_handler.py         # /memory/* (company + personal memory)
    │   │   ├── agents_handler.py         # /agents/*, /workflows/* (autonomous agents)
    │   │   ├── mcp_global_handler.py     # POST /mcp/global (one MCP server for the whole app, docs/mcp.md)
    │   │   ├── mcp_tokens_handler.py     # /connect/tokens (mint / list / revoke global MCP tokens, audit)
    │   │   ├── chat_handler.py           # /chat/* (conversations)
    │   │   ├── integrations_handler.py   # /integrations/*, /sources/* (credentials, schedules)
    │   │   ├── scrapers_handler.py       # /scrapers/* (web scraper management)
    │   │   ├── settings_handler.py       # /settings/* (brand, categories config)
    │   │   ├── projects_handler.py       # /projects/* (research projects, personas)
    │   │   ├── users_handler.py          # /users/* (Cognito user administration)
    │   │   ├── feedback_form_handler.py  # /feedback-forms/* (embeddable forms)
    │   │   ├── data_explorer_handler.py  # /data-explorer/* (admin-only S3 raw data & DynamoDB browser, no deletes)
    │   │   ├── logs_handler.py           # /logs/* (system logs)
    │   │   ├── manual_import_handler.py  # /scrapers/manual/* (admin-only paste/CSV/JSON import)
    │   │   ├── s3_import_handler.py      # /s3-import/* (admin-only S3 import bucket explorer)
    │   │   ├── engagement_handler.py     # /participants/*, /feature-requests/* (feedback boards), POST /unsubscribe (routers in shared/*_routes.py)
    │   │   ├── ballots_handler.py        # /voting-sessions/* (room votes on a Prioritization row; config + submit are public)
    │   │   ├── radar_handler.py          # /radar/* (other brands' reviews, docs/radar.md)
    │   │   ├── manual_import_processor.py # Manual import processing logic
    │   │   ├── projects.py               # Projects business logic (shared)
    │   │   └── prompts/                  # LLM prompt templates (6 templates)
    │   │       ├── avatar-generation.json
    │   │       ├── persona-generation.json
    │   │       ├── persona-import.json
    │   │       ├── prd-generation.json
    │   │       ├── prfaq-generation.json
    │   │       └── research-analysis.json
    │   ├── stream/                   # Unified AI assistant Lambda (TypeScript, esbuild) — AG-UI 1.0 SSE at /chat/stream via API Gateway
    │   └── layers/
    │       ├── ingestion-deps/       # Layer: requests, aws-lambda-powertools, beautifulsoup4, app-review scrapers
    │       ├── processing-deps/      # Layer (ApiDepsLayer + ProcessingDepsLayer): aws-lambda-powertools, pydantic, requests
    │       ├── signing-deps/         # Layer: cryptography, only for the 5 functions that sign CloudFront URLs
    │       └── email-intake-deps/    # Layer: lxml, only for the (opt-in) inbound-email intake
    ├── plugins/                      # Data source plugins
    │   ├── _shared/                  # Shared plugin utilities
    │   ├── _template/                # Template for new plugins
    │   ├── github_issues/            # GitHub Issues: ingestor (30 min) + signed webhook, version/label enrichment (docs/github-issues.md; enabled, idle until a token + repos are saved)
    │   ├── web_reviews/              # Generic review pages read with the AgentCore managed browser (CDP), JSON-LD / LLM extraction, source web_<site>_<app_name> (stored source_id), blocked sites reported (docs/web-reviews.md; enabled, idle until a page is added)
    │   └── webscraper/               # Configurable web scraper
    ├── frontend/                     # React dashboard (Vite + Tailwind)
    │   ├── src/
    │   │   ├── api/
    │   │   │   ├── client.ts         # API client, fetch helpers
    │   │   │   ├── types.ts          # API type definitions
    │   │   │   ├── projectsApi.ts    # Projects API (lazy-loaded)
    │   │   │   └── projectQueryKeys.ts # Query keys shared across features
    │   │   ├── assistant/            # Unified AI assistant (AG-UI client, thread reducer, sessions, approvals, panel UI)
    │   │   ├── services/auth.ts      # Cognito authentication service
    │   │   ├── components/           # Each component in its own folder (58 folders; a selection below)
    │   │   │   ├── AdminRoute/           # Admin-only route wrapper
    │   │   │   ├── Breadcrumbs/          # Navigation breadcrumbs
    │   │   │   ├── CategoriesManager/    # Category management UI
    │   │   │   ├── ConfirmModal/         # Confirmation dialog
    │   │   │   ├── DataSourceWizard/     # Data source setup wizard
    │   │   │   ├── DocumentExportMenu/   # Export documents
    │   │   │   ├── FeedbackCard/         # Feedback item display
    │   │   │   ├── Layout/               # Main layout with sidebar (reads menu-config.json)
    │   │   │   ├── MetricCard/           # Dashboard metric card
    │   │   │   ├── PageLoader/           # Page loading indicator
    │   │   │   ├── PersonaExportMenu/    # Export personas
    │   │   │   ├── ProtectedRoute/       # Auth-protected route wrapper
    │   │   │   ├── S3ImportExplorer/     # S3 file browser
    │   │   │   ├── SentimentBadge/       # Sentiment indicator
    │   │   │   ├── SocialFeed/           # Live social media feed
    │   │   │   ├── TimeRangeSelector/    # Date range picker
    │   │   │   ├── UserAdmin/            # User administration
    │   │   │   └── UserProfileModal/     # User profile modal
    │   │   ├── pages/                # Each page in its own folder (25 folders; a selection below)
    │   │   │   ├── Categories/       # Category breakdown and analysis
    │   │   │   ├── Chat/             # Full-page view of the unified AI assistant
    │   │   │   ├── Dashboard/        # Overview with charts and social feed
    │   │   │   ├── DataExplorer/     # S3 raw data and DynamoDB browser
    │   │   │   ├── FeedbackDetail/   # Single feedback item view
    │   │   │   ├── FeedbackForms/    # Feedback form management
    │   │   │   ├── Login/            # Cognito login page
    │   │   │   ├── Prioritization/   # Issue prioritization
    │   │   │   ├── ProblemAnalysis/  # Problem analysis dashboard
    │   │   │   ├── ProjectDetail/    # Single project view
    │   │   │   ├── Projects/         # Research projects list
    │   │   │   ├── Scrapers/         # The "Data sources" page (web scrapers, app/review pages, imports)
    │   │   │   └── Settings/         # Configuration and integrations (uses getEnabledPlugins)
    │   │   ├── store/
    │   │   │   ├── configStore.ts    # Zustand state (config, time range, custom dates)
    │   │   │   ├── authStore.ts      # Authentication state
    │   │   │   └── manualImportStore.ts # Manual import state
    │   │   ├── plugins/              # Frontend plugin system
    │   │   │   ├── index.ts          # Plugin loader (getEnabledPlugins, getPluginManifests)
    │   │   │   ├── types.ts          # Plugin type definitions (with enabled field)
    │   │   │   └── manifests.json    # Generated plugin manifests
    │   │   ├── config/
    │   │   │   └── menu-config.json  # Generated menu visibility config
    │   │   ├── constants/
    │   │   │   └── filters.ts        # Filter constants and options
    │   │   └── utils/
    │   │       └── dateUtils.ts      # Date utility functions
    │   ├── package.json
    │   └── vite.config.ts
    ├── schemas/
    │   └── persona.schema.json       # Canonical persona shape (shared/persona_context.py, stream allowlists)
    ├── scripts/
    │   ├── build-layers.sh           # Build Lambda layers with Docker (ARM64)
    │   ├── cdk-deploy.sh             # `deploy:infra`: cdk deploy, then refresh-api-stage.sh
    │   ├── test-api.sh               # API validation script
    │   ├── generate-manifests.ts     # Generate plugin manifests with enabled status
    │   ├── generate-menu-config.ts   # Generate menu config from cdk.context.json
    │   ├── generate-integrity.ts     # Generate plugin integrity hashes
    │   └── validate-plugins.ts       # Validate plugin configurations (plugin loader tests: lib/plugin-loader.test.ts)
    ├── cdk.json
    ├── tsconfig.json
    └── package.json
```

## Storage

### S3 Raw Data Lake

| Bucket | Structure | Purpose |
|--------|-----------|---------|
| `voc-raw-data-{account}-{region}` | `raw/{source}/{year}/{month}/{day}/{id}.json` | Raw scraped/ingested data archival — immutable, never deleted while the platform runs; bucket deleted with the stack |
| `voc-raw-data-{account}-{region}` | `avatars/{project_id}/{persona_id}.png` | AI-generated persona avatars |

### DynamoDB Tables

| Table | PK | SK | Purpose |
|-------|----|----|---------|
| `voc-feedback` | `SOURCE#{platform}` | `FEEDBACK#{id}` | Processed feedback with GSIs for date, category, urgency; optional `author`, `title`, `metadata`, `dimensions`, `dimension_sources`, `tags`, `pii_policy`, `usefulness` (`low\|medium\|high` heuristic band, absent = unrated, docs/data-quality.md), `csv_dataset` + `csv_content_hash` (a CSV dataset row, docs/csv-import.md) — kept while the platform runs (no TTL), deleted with the stack; only `voc-retention` deletes at runtime (opt-in per source profile) |
| `voc-aggregates` | `METRIC#{type}` | `{date}` | Pre-computed metrics (no TTL), brand config, category config, `CATEGORY_ACCESS`/`USER#{sub}` (+ `sources`), `SETTINGS#dimensions`/`SETTINGS#sources` `config`, `METRIC#daily_dim…`/`METRIC#daily_tag#…`/`METRIC#daily_usefulness#<source>#<band>` (docs/data-quality.md), `JOB#erasure`/`er_…` (+ `SRCLOCK#{source}`, the whole-source erasure lock), `AUDIT#retention`, `JOB#category_reprocess`/`rp_…`, `METRIC#meta`/`earliest_date`, `data_version`, `config_version` (cache version counters, docs/caching.md), `IMPORT_RUN`/`{started_at}#{run_id}` + `IMPORT_RUN#{run_id}`/`RUN` (import history, `ttl` 90 days, docs/import-history.md), form configs — METRIC# rows kept while the platform runs (no TTL), deleted with the stack |
| `voc-watermarks` | `{source}` | - | Ingestion state tracking |
| `voc-projects` | `PROJECT#{id}` | `META\|PERSONA#{id}\|PRD#{id}\|PRFAQ#{id}` | Projects with personas, PRDs, PR/FAQs — kept while the platform runs (no TTL), deleted with the stack |
| `voc-jobs` | `PROJECT#{id}` | `JOB#{id}` | Long-running async jobs (research, persona generation) |
| `voc-conversations` | `USER#{id}` | `CONV#{id}` | AI chat conversation history; assistant items also carry `run_id`/`run_status`/`revision`, written by the stream Lambda while a run streams |
| `voc-idempotency` | `{id}` | - | Lambda Powertools idempotency tracking |
| `voc-memory` | `MEM#company\|MEM#user#{sub}`, `MEMEVT#{id}`, `MEMCURSOR`, `MEMIMPORT` | `MEM#{id}`, `{iso}#{n}`, `SESSION#{id}`, `{import_id}` | Memories (index `gsi1-by-memory-status`), audit, extraction cursors, imports — kept while the platform runs (no TTL), deleted with the stack (docs/memory.md) |
| `voc-agents` | `AGENT#{id}`, `WORKFLOW#{id}`, `RUN#{run_id}`, `PLAN#{plan_id}` | `META\|RUN#{run_id}`, `REV#{n}\|CURRENT`, `EVT#{seq}\|MATE#{role}#{seq}`, `META\|STEP#{id}\|EVT#{seq}` | Agents, versioned workflows, runs + journal, approved assistant plans + steps (index `gsi1-by-agents-listing`, plans under `PLANS#{approver_sub}`) — kept while the platform runs (no TTL), deleted with the stack (docs/autonomous-agents.md) |
| `voc-radar` | `SETTINGS#radar`, `RELEASE#{brand}`, `RADAR#{brand}#…` | `brands` (the brand list `{brands: [{label, domains}]}`), `config` (scan settings), … | OTHER brands' reviews, counters and releases, kept out of our numbers (layout `lambda/shared/radar_store.py`, docs/radar.md) |
| `voc-participants` | `PERSON#{id}`, `EMAIL#{sha}`, `LIST#{id}`, `PROJECT#{id}`, `ASK#{id}`, `TOKEN#{sha}`, `SETTINGS`, `SENDCOUNT#{day}` | `META`, `LIST#…`, `MEMBER#…`, `RCPT#…`, `RESPONSE\|UNSUB`, `engagement`, `COUNT` | People to ask for feedback, lists, project links, asks + recipients, email tokens (sha256 only), engagement settings (company domains) — layout `lambda/shared/participants_*.py`, docs/participants.md |
| `voc-feature-requests` | `BOARD#{id}`, `SLUG#{slug}`, `FR#{id}`, `RATE#{board}#{hash}#{day}` | `META`, `BOARD`, `META\|SUP#{id}`, `COUNT` | Feedback boards (template, fields, statuses, audience; gsi1pk `BOARDS`), slug guards, requests (`board_id` absent = seeded `brd_sales`; `fields`, totals per template, status, promoted project; gsi1pk `FRS`) and supports (+1 field values), `anyone`-board rate counters (`ttl`) — docs/feature-requests.md |

## API Endpoints

### Metrics (metrics_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/feedback` | List feedback with filters (days, source, category, sentiment) |
| GET | `/feedback/{id}` | Get single feedback item |
| GET | `/feedback/{id}/similar` | Get similar feedback items |
| GET | `/feedback/access` | The caller's scope `{all, categories, sources_all, sources, source_rule: all\|allow\|deny, sources_denied}` |
| GET | `/feedback/urgent` | Get high-urgency items |
| GET | `/feedback/problems` | The Problem Analysis tree over the whole window (docs/problem-analysis.md): the header's `days` + `date_basis` like every route; ≤ 100,000 slim rows, ≤ 1,000 problems listed (`problems_truncated`); answers `window` + `type_counts` |
| GET | `/feedback/entities` | Keywords, categories, issues, `channels`, `tags`, `dimensions` for filters |
| GET | `/metrics/summary` | Dashboard summary metrics |
| GET | `/metrics/sentiment` | Sentiment breakdown |
| GET | `/metrics/categories` | Category breakdown |
| GET | `/metrics/sources` | Source breakdown |
| GET | `/metrics/personas` | Persona breakdown |
| GET | `/metrics/dimensions` | `?key=<dim>`: per-value counts + sentiment split, `unassigned` (docs/dimensions.md) |
| GET | `/metrics/data-quality` | Per-source usefulness distribution `{sources: [{source, low, medium, high, unrated, total}], overall}` (counters `METRIC#daily_usefulness#<source>#<band>`; restricted callers / review basis count the items; docs/data-quality.md) |
| GET | `/metrics/github` | GitHub Issues per release and per label (counts, 👍 weight, sentiment, top complaints, new since the last release); `/feedback` also takes `version` and `label` filters |

`days` is 0–9999 everywhere; `0` = all time. A review-date window's cutoff is the REQUESTED window
(none for all time), never the import history the walk is clamped to. `source`, `category`, `subcategory`,
`sentiment` and `usefulness` (`low|medium|high`, `unrated` = no stored band) take one value or a comma list
meaning any of them (`shared/item_facets.py`; ≤ 50 values of ≤ 128 chars, an unknown sentiment or band is a 400;
sources pushed down as `=` / `IN`; `/feedback/problems` leaves `category` / `subcategory` to its tree;
docs/categories.md → Filtering by several values). Every route that takes `source` also
takes `channel`, `dims=key:value,…` (400 when malformed; `key:a|b` = either value, `~unset` = no value), `tag`, `rating_min`/`rating_max` and `urgent=1`
(only high-urgency items; the Categories page's breakdowns send its rating and urgent filters). Every route enforces the caller's
category access (no `CATEGORY_ACCESS` row = all; admins and a category's owners
always see it) AND source access (no `sources` = every non-`restricted` source;
a hidden source forces the item path); `/feedback/{id}` and `/similar` answer 404 when forbidden.
Per-day walks stop on a time budget and say so (`is_partial`, `partial_reason:
'time_budget'`, `scanned_through`). See `docs/categories.md`.

### Feedback Edit (feedback_edit_handler.py, `voc-feedback-edit-api`)
| Method | Path | Description |
|--------|------|-------------|
| PUT | `/feedback/{id}/category` | Correct a review's category `{category, subcategory?}` in place (`category_source='manual'`); 400 unknown category, 404 not found/not visible, 409 concurrent change |
| PUT | `/feedback/{id}/dimensions` | Set `{dimensions?: {key: value\|null}, tags?}` (`dimension_sources[key]='manual'`); 400 unknown key/value, 404, 409 |

### Chat (chat_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/chat/conversations/_list[?kind=assistant\|chat]` | Caller's sessions, newest `updatedAt` first, ≤100, no message bodies |
| GET | `/chat/conversations/{id}` | Get session (`messages`, `page`, `pendingInterrupts` decoded) |
| POST | `/chat/conversations/{id}` | Save session; body `kind:'assistant'` (+ `baseRevision`) → validated JSON blobs, 400 on bad/mismatched id, 409 while the server run is live or its revision is newer, 413 over ~350 KB (no `kind` = legacy save) |
| DELETE | `/chat/conversations/{id}` | Delete conversation |
| PUT | `/chat/conversations/{id}/title` | Rename (title only; `custom_title` survives later saves and runs; 409 while a run is live) |
| POST | `/chat/conversations/{id}/cancel` | Stop `{runId}`: writes the `RUNCANCEL#{id}` marker (TTL 1 day) the running stream Lambda polls; it stops generating and saves the partial answer as `stopped` |

Every route is scoped to `USER#{cognito sub}`. The assistant itself streams at
`POST /chat/stream` (`voc-chat-stream`, TypeScript): AG-UI `RunAgentInput` in,
AG-UI events out; read-only server tools, human-approved client-tool writes.

**Server-side session persistence.** While a run streams, `voc-chat-stream` saves the
conversation (user turn + the in-progress answer, tool calls/results trimmed) to the
SAME assistant item, in the caller's own `USER#{verified sub}` partition (enforced in
code: `lambda/stream/src/assistant/session/`), adding `run_id`, `run_status`
(`running|finished|failed|interrupted|stopped`) and `revision` (grows only). Writes are
throttled (every 2 s / 2,000 chars, at tool boundaries, at the end), ordered,
fire-and-forget, capped at ~350 KB, and the run completes without a client. GET/list
return `runStatus`/`runId`/`revision`; a `running` record older than
`STALE_RUN_SECONDS` (960) is dead. The SPA shows a reloaded running session as
"still generating" and polls GET until it ends. The server owns the answer: a POST
carries `baseRevision` (from the stream's `assistant.session` event or a GET) and is
refused **409** while the run is live or when the stored revision is newer; the SPA
then adopts the server copy. **Stop** (5.35): the browser's abort does not end the stream Lambda, so Stop
also calls `POST .../cancel {runId}`; the run polls that marker (`session/cancel.ts`, every 1.5 s),
aborts its Bedrock stream, starts no further turn and saves `stopped` with `metadata.voc.stopped` on
the answer (the SPA shows a Stopped marker, also after a reload). The last answer of a settled thread
has **Regenerate** (drops it and re-runs the question), also when the turn ends on a tool call; after Stop
the SPA sends no save of its own (it would be refused 409) and adopts the server's `stopped` copy. Every
user turn's `<context>` block names the page it was sent from. The assistant's page context carries the
Categories / Problem Analysis URL filters as `page.filters` (`PAGE_FILTER_KEYS`; values in the
`<context>` data block), and `search_feedback` takes an explicit `days`.
**Filter floor + chat scope** (#429 port, docs/assistant-chat-scope.md): a /chat run also carries
`forwardedProps.scope = {filters?: <PAGE_FILTER_KEYS → string>, limit?: 1–1000}` (`chatScopeSchema`,
lockstepped; the SPA sends it from /chat only, from the filter panel above the composer). `page.filters`
and `scope.filters` intersect into a floor (`tools/server/feedback-floor.ts`) that `search_feedback`,
`list_feedback`, `get_urgent_feedback`, `get_entities` and `get_metrics` cannot widen: a model argument
outside it matches nothing, a filter a route cannot apply is refused; `limit` (default 1000) caps the
reviews one read uses. The panel's live count reads `GET /metrics/sentiment`.
**Mentions** (5.46, docs/assistant-mentions.md): on a project page the composer's `@` / `#` lists put
`forwardedProps.mentions = {personas?: [ids] | 'all', documents?: [{document_id, version?}]}` (≤ 6 / ≤ 3,
`mentionsSchema`, lockstepped; refused off a project page). Before the model's turn the stream runs a persona
round (`runtime/persona-round.ts`): one `consult_personas` call per persona (ids `mention_…`, one assistant
message, review only, grounded on the tagged documents), then a `<mentions>` data block for a short synthesis.
`consult_personas` takes `document_ids` (≤ 3). Persona results are stored JSON-safe (32,000 chars,
`session/persona-result.ts` = SPA `sessions/personaResult.ts`), so the cards survive a reload.

### Integrations (integrations_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/integrations/status` | Integration status |
| PUT | `/integrations/{source}/credentials` | Update credentials |
| GET | `/sources/status` | Source schedule status |
| PUT | `/sources/{source}/enable` | Enable source (also closes a tripped circuit breaker) |
| PUT | `/sources/{source}/disable` | Disable source |
| POST | `/sources/{source}/reset` | Close a tripped circuit breaker without enabling the schedule (admin) |

`GET /sources/status` carries `circuit {tripped, tripped_at, failure_count, last_error (admins only)}` per source; the
breaker's state lives in voc-aggregates (`CIRCUIT#<plugin>` / `TRIPPED`).

### Scrapers (scrapers_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/scrapers` | List scraper configs |
| POST | `/scrapers` | Save scraper config (admin); optional `radar_brand` (a Radar brand key) makes it a Radar source |
| DELETE | `/scrapers/{id}` | Delete scraper (admin) |
| GET | `/scrapers/templates` | Get scraper templates |
| GET | `/scrapers/connectors` | iOS / Android app connectors and Web Reviews pages with their `radar_brand` (read-only, any signed-in user; the assistant's `list_scrapers` reads it, docs/radar.md) |
| POST | `/scrapers/{id}/run` | Trigger scraper run (admin) |
| GET | `/scrapers/{id}/status` | Latest run (errors redacted) |
| POST | `/scrapers/analyze-url` | AI selector detection (admin) → 202 `{success, job_id, status:'pending'}` (assist job, below) |
| GET | `/scrapers/jobs/{job_id}` | Poll an analyze-url assist job (its starter only; 404 otherwise) |

Every scraper write and analyze-url is admin-only (owner decision 2026-10-08: they write the
shared API-credentials secret, drive scheduled scraping and spend Bedrock); the reads stay open to
every signed-in user. MCP tokens and agents are never admin. See `docs/scrapers.md`.

**Assist jobs (4.00.00).** No model call sits on a 29 s REST path. Six routes do their 4xx checks
synchronously, then write a pending row in voc-jobs (`lambda/shared/assist_jobs.py`, TTL 1 day),
async-invoke their API Lambda's 15-minute twin (`voc-projects-assist`, `voc-settings-assist`,
`voc-scrapers-assist`: same code and role, `lib/stacks/api-assist-workers.ts`) and answer **202**
`{success, job_id, status:'pending'}`. Poll until `status` is `completed` (`result`) or `failed` (`error`):
`POST /settings/categories/generate` → `GET /settings/jobs/{job_id}`; `POST /scrapers/analyze-url` →
`GET /scrapers/jobs/{job_id}` (both owner-only, pk `ASSIST#{sub}`); and `POST /projects/{id}/prfaq-autofill`,
`/documents/suggest-brief`, `/research/suggest-questions`,
`/personas/{pid}/regenerate-avatar` → `GET /projects/{id}/jobs/{job_id}` (pk `PROJECT#{id}`, view access;
`GET /projects/{id}/jobs` hides `assist_*`). The SPA polls via `frontend/src/api/assistJobs.ts`.

AI assistant on `/scrapers` (page kind `scrapers`, pack `scrapers`; all ADMIN-ONLY, dropped for non-admins
and refused before any card): read `analyze_scraper_url` (the stream's one read POST here,
`READ_POSTS` in `lambda/stream/src/assistant/tools/internal-api.ts`; it starts the assist job and polls
`GET /scrapers/jobs/{job_id}`, `tools/server/assist-job.ts`), client writes `create_scraper` /
`update_scraper` (→ `POST /scrapers`) and `create_app_connector` (→ `POST /integrations/{source}/apps`),
next to `run_scraper`. Deterministic approval cards (`frontend/src/assistant/approvals/previews/ScraperPreviews.tsx`).
A create never overwrites, and a stale update is refused. Bounds are lockstepped by `scraperSchemas.lockstep.test.ts`.
These tools are NOT on `/mcp/global`. Details: `docs/scrapers.md` → "With the AI assistant".
Plan mode (3.17.00) adds to the `scrapers` pack: client write `run_source` (admin; → `POST /sources/{source}/run`,
`source` ∈ the plugins with a manual run), reads `get_source_run` (admin; the `SOURCE_RUN#{source}` row) and
`find_app_store_app` (Apple iTunes Search API; Google Play package names via web search). Also new: `build_prototype`
(project pack, → `POST /projects/{id}/build-prototype`, the route's own body names) and in `core` the reads
`plan_catalogue` / `plan_lookup` / `get_plan` and the client tools `propose_plan` (its card is the plan card; approve →
`POST /agents/plans`) and `cancel_plan`. None of them is on `/mcp/global`. See docs/assistant-plan-mode.md.

### Settings (settings_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/settings/brand` | Get brand configuration (any signed-in user) |
| PUT | `/settings/brand` | Save brand configuration — admin-only (owner decision 2026-10-08, #242); the Admin page's brand form is read-only for non-admins |
| GET | `/settings/model` | Per-surface model overrides + allowlist + `image_model: {id, label, region, avatars_enabled}` (the fixed persona-avatar model, `shared/image_model_status.py`) (any signed-in user — the agent detail Models tab reads it; NOT admin-gated, pending an owner decision on that caller) |
| POST | `/settings/model/test` | Test one model `{model_id}` (admin; 400 unless allowlisted or the image model): ONE minimal Converse to exactly that model, no fallback (the image model: ONE small image, nothing stored, a few cents) → `{model_id, invoked_id, status: available\|no_access\|not_in_region\|no_capacity\|throttled\|not_ready\|unavailable\|error, ok, latency_ms, message, quota, checked_at}` (`shared/model_capacity.py`) |
| GET | `/settings/model/capacity` | Every allowlisted model's tokens-per-minute quota from Service Quotas `{models: [{model_id, label, quota}], image: {…image_model, access: {status: available\|no_access\|not_subscribed\|not_in_region\|unknown, …}, quota: {name, value, unit: 'requests_per_minute'}\|null, quota_state: fresh\|stale\|pending\|unknown}}` (admin; no model call; stored in aggregates `SETTINGS#model_quotas`, 10 min in memory; older than 1 h it answers at once with `quota.stale: true` while the `voc-settings-assist` twin re-reads it by quota code (async `model_quota_refresh`); also stale on a Service Quotas throttle; the image quota lives in `SETTINGS#image_model_quota`, refreshed by the twin via `image_model_quota_refresh` — docs/deployment.md) |
| GET | `/settings/categories` | Get category configuration |
| PUT | `/settings/categories` | Save category configuration — admin-only; categories carry `product` + `owners` |
| POST | `/settings/categories/generate` | AI-generate categories — admin-only (Bedrock spend; owner decision 2026-10-08, #242); the AI panel is hidden for non-admins. 202 + assist job (see Scrapers → Assist jobs) |
| GET | `/settings/jobs/{job_id}` | Poll a categories assist job (its starter only; 404 otherwise) |
| POST | `/settings/categories/reprocess` | Start a reprocess job `{mode: processed\|raw\|dimensions, days, include_manual?}` (admin) → 202 `{job}`, 409 if one is active |
| GET | `/settings/categories/reprocess` | Latest reprocess job |
| POST | `/settings/categories/reprocess/{job_id}/cancel` | Cancel a reprocess job |
| GET/PUT | `/settings/dimensions` | Dimensions config (GET any user, PUT admin); the built-in `feedback_type` (`shared/feedback_types.py`) is listed first with `builtin: true` and never stored — docs/dimensions.md |
| GET/PUT | `/settings/sources` | Source profiles (admin full; others `{id, label, restricted}`; PUT admin) — docs/source-policies.md |
| POST/GET | `/settings/erasure` | Start an erasure `{field, value, source?}` → 202 `{job}` (async `voc-retention`; value only hashed) / list `{jobs, sources}` (admin). `field: 'source'` = delete all data from one source: `{value: <source id>, confirm: <same id>}`, 400 on a confirm mismatch or an unknown source (not a profile and no `METRIC#daily_source#` row), 409 while an erasure of that source is live (conditional `SRCLOCK#{source}` lock row, released by the worker); deletes its items by `source_platform` and everything under `raw/{source}/` (docs/source-policies.md → Delete all data from a source) |
| GET | `/settings/my-onboarding` | The caller's onboarding-buddy preference `{state, hidden_until, visible, start_page, guide, subscribe_prompt, dismissed_decision_runs}` + first-run `signals` (self only) |
| PUT | `/settings/my-onboarding` | Set `{state?: active\|hidden\|dismissed\|skipped, start_page?: home\|dashboard, guide?: open\|skipped, subscribe_prompt?: shown\|dismissed, dismiss_decision_run?: <run id>}` (the last two close Home's subscribe / agent-decision cards) — only the named fields change (`hidden` = one-day snooze, server clock; `skipped` = the checklist stays on Home collapsed; `guide: skipped` = "How it works" starts collapsed; `start_page: dashboard` = opening the app lands on the dashboard) |

Every mutating route in `lambda/api/*_handler.py` is listed as ADMIN_ONLY (structurally gated by
`require_admin`, a helper reaching it, or an admin middleware) or OPEN_BY_DECISION (with its reason) in
`lambda/api/test/test_route_admin_gates.py`; a new unclassified route fails that test (#242).

### Users (users_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/users` | List Cognito users |
| POST | `/users` | Create user |
| PUT | `/users/{username}` | Update user |
| DELETE | `/users/{username}` | Delete user |
| POST | `/users/{username}/reset-password` | Reset password |
| GET | `/users/{username}/category-access` | A user's category access (admin) |
| PUT | `/users/{username}/category-access` | Set it: `{categories: ['*'] \| [names], sources?: ['*'] \| [ids] \| null}` (admin; omitted = unchanged, null = default rule) |
| PUT | `/users/{username}/flags` | `{fallback_owner?, memory_reviewer?, ai_mode?: human_driven\|ai_assisted\|ai_driven, ai_writing_prfaq?, ai_writing_prd?}` (admin; the way of working is its own row `USERFLAGS#{sub}`/`ai_mode`, docs/ways-of-working.md) |
| GET | `/users/me/ai-mode` | The caller's own way of working `{mode, ai_writing_prfaq, ai_writing_prd}` (any signed-in user, no-store; no row = `ai_driven`) |

AI assistant on `/settings` (page kind `settings`, pack `settings` — an ADMIN-ONLY pack, dropped for
non-admins; every tool below is also on the per-tool admin lists and refused before any card): reads
`list_users` (→ `GET /users`; no `sub`, no flags reach the model) and `get_user_access`
(→ `GET /users/{username}/category-access`), client writes `create_user` (→ `POST /users`; Cognito emails
the temporary password), `update_user` (name → `PUT /users/{u}`, role → `PUT /users/{u}/group`, enabled →
`PUT /users/{u}/enable|disable`, applied in that order and stopped at the first failure) and
`set_user_access` (→ `PUT /users/{u}/category-access`). The stream Lambda invokes `voc-users-api` as the
caller (env `USERS_FUNCTION`), so the routes' `require_admin` holds for the reads too. Refused before a card: a
duplicate email, an unknown username, the caller's own role or enabled state, an access rule for an
administrator, an unconfigured category or source; the SPA re-checks on approve (duplicate email, a user or
grant that changed since the card was shown — fingerprints on the shown record). NOT tools: deleting a user,
password resets, user flags → Administration → Privacy & access → Users. Not on `/mcp/global`. Deterministic cards in
`frontend/src/assistant/approvals/previews/UserPreviews.tsx`; bounds lockstepped by `userSchemas.lockstep.test.ts`.

### Feedback Forms (feedback_form_handler.py)

Every route requires Cognito **except** the three marked public, which the
embeddable widget calls from the customer's own site.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/feedback-forms` | Cognito | List all forms |
| POST | `/feedback-forms` | Cognito | Create form |
| PUT | `/feedback-forms/{id}` | Cognito | Update form |
| DELETE | `/feedback-forms/{id}` | Cognito | Delete form |
| GET | `/feedback-forms/{id}/submissions` | Cognito | Read submitted feedback |
| GET | `/feedback-forms/{id}/stats` | Cognito | Submission count + average rating |
| GET | `/feedback-forms/{id}/config` | **public** | Form config for the widget |
| POST | `/feedback-forms/{id}/submit` | **public** | Submit feedback |
| GET | `/feedback-forms/{id}/iframe` | **public** | Iframe embed variant |

> **Rate limits on the three public routes** are stage method settings in
> `api-gateway.ts`, and are EXTERNALLY OBSERVABLE to anyone embedding the widget:
>
> <!-- LOCKSTEPPED against the stack by `the public feedback-form routes` in
>      voc-datalake/lib/stacks/api-stack.test.ts, which parses every line below
>      that names a route and states a rate. Write a pair as `<rate> rps / <burst>`
>      or `<rate> req/s, burst <burst>`; the burst must sit immediately after the
>      `/` or the `, burst `, so `(burst N)` will not parse. Prose about throughput
>      is not judged — only digits immediately before a per-second unit are. -->
>
> | Route | Rate / burst | Why |
> |---|---|---|
> | `POST /submit` | **20 rps / 40** | Each submission enqueues a record that drives Comprehend, Translate and a Bedrock invocation in the processor — a per-request model call against a shared quota |
> | `GET /config`, `GET /iframe` | **100 rps / 200** | Fetched on every page load of every embed; cheap (one `get_item`, and a static HTML render, respectively) |
>
> The method-setting keys spell the variable `{form_id}` — the resource is created
> as `addResource('{form_id}')`, so that is the path to look for in the template,
> even though the table above uses `{id}` for brevity like the rest of this file.
>
> These four numbers are PINNED against the synthesized template by a lockstep case
> in `api-stack.test.ts`, so tuning them in `api-stack.ts` without updating this
> table fails the CDK suite. The stack is the source of truth.
>
> A method setting is keyed by PATH with that variable left as-is, so each ceiling is
> shared across **every form in the deployment and every caller** — not per form
> and not per client. 100 rps is therefore the aggregate widget page-view rate a
> deployment supports.
>
> Above it, **each of the three fails differently and none names the limit**, so a
> busy embed is fixed by raising the number rather than widget-side: `GET /config`
> renders a flat "Failed to load form." with no retry (the gateway 429 carries the
> deployment's frontend origin, `*` only in dev, so the widget cannot read it
> cross-origin); `POST /submit` shows an inline "Failed to submit. Please try again."
> notice (an alert region beside the arrows; the API's own reason when it gave one)
> and is retryable with the typed feedback kept; `GET /iframe` runs no widget code at
> all (the browser navigates to it directly), so it is a raw API Gateway error page
> inside the customer's iframe.
> `GET /voting-sessions/{session_id}/config` carries 20 rps / 40 for a different
> reason (a room is bounded by `MAX_BALLOT_CAP`), and its sibling
> `POST /voting-sessions/{session_id}/submit` carries 20 rps / 40 on that same reasoning.
> `GET /voting-sessions?row_id=` (Cognito, VIEW on the row's project) returns a Prioritization row's
> one open room vote, or null; opening a vote while one runs returns that vote.

> There is no `/feedback-form/*` (singular) API. These routes are declared
> **explicitly** in `api-routes.ts` rather than behind a `{proxy+}`, so adding a
> route to the handler also requires wiring it there. That is deliberate: a
> proxy without `defaultMethodOptions` defaults to `AuthorizationType: NONE`,
> which is how form update/delete and submission reads were once public.
> `api-stack.test.ts` asserts the handler and stack stay in step, and that only
> the three public routes are unauthenticated.

> ⚠️ **"Cognito" above means authenticated, NOT authorized.** These routes check
> that the caller has a valid token; they do not check *which* forms the caller
> owns. `feedback_form_handler.py` imports no auth helper, so **any authenticated
> user can read, update or delete any form and read any form's submissions**.
> That residual gap is tracked separately — unlike projects, which now enforce
> per-project visibility and membership (see the Projects table below) — do not
> read this table as "fully protected".

### Projects (projects_handler.py)

Per-project access (`lambda/shared/project_access.py`): `public` = every
signed-in user views + edits; `private` (the default for new projects) = owner,
invited `editor`/`viewer` members and `admins` only. Unowned legacy projects read
public; only admins manage them. A caller without view gets 404 (no existence
leak). Default level per route: GET = view, other methods = edit; the routes
marked manage are owner/admin only. Stream chat and MCP tokens act as the calling
user (tokens as their minter, never admin, capped at editor).

On a project the caller can only view, the assistant drops the project write
tools and refuses a project write aimed at it before any approval card; REST
re-checks edit on approval. Sharing/visibility/membership/ownership are never
assistant tools.

PR/FAQ and PRD AI writing also follows the person's way of working with AI
(Human-driven / AI-assisted / AI-driven, `shared/ai_writing.py`, docs/ways-of-working.md):
generate, pursue, merge into prfaq/prd, prfaq-autofill and suggest-brief are 403 unless
allowed; an agent / plan step / MCP token (autonomous) also needs AI-driven for the
project owner, and for PUT/restore of a PR/FAQ / PRD. The assistant coaches instead of
writing for a Human-driven person.

Owner and member `email` (and `owner_email`) appear in project list/get and
`GET /projects/{id}/members` only for `can_manage` callers (owner/admin).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/projects` | List projects the caller can view; `?ids=a,b` (≤ 200) → `{details: [{project, documents}]}` for the viewable ones (Prioritization's one-call read; unviewable/missing ids are simply absent) |
| POST | `/projects` | Create project (caller becomes owner; default private) |
| GET | `/projects/{id}` | Get project with personas/documents and members |
| PUT | `/projects/{id}` | Update project |
| DELETE | `/projects/{id}` | Delete project (manage) |
| POST | `/projects/{id}/personas/generate` | Generate personas from feedback; `keep_existing_personas: true` adds next to the existing ones (name clashes dropped), absent/false replaces them (docs/persona-generation.md) |
| POST | `/projects/{id}/feedback-preview` | The persona / research wizards' live count `{sources, categories, sentiments, days, date_basis, mode: estimate\|exact, purpose: personas\|research}` → `{matched, matched_is_lower_bound, estimated, sample_limit}`: exact = the generation's own read (20 s budget, then a lower bound), estimate = a scaled feedback-id-index sample; cached 5 min per project + selection + scope (`shared/persona_feedback_preview.py`, docs/project-workspace.md) |
| PUT | `/projects/{id}/personas/{persona_id}/protection` | `{protected: bool}` (400 otherwise, 404 unknown persona): a replace regeneration keeps a protected persona and tells the model about it (`shared/persona_replace.py`) |
| POST | `/projects/{id}/research` | Run research job (Step Functions) |
| POST | `/projects/{id}/documents` | Create a custom document, or a hand-written PR/FAQ / PRD from a blank template (`document_type: prfaq\|prd`, `{title, content?, create_id?}`, `origin: human`) |
| — | (project chat) | Now the unified AI assistant at `POST /chat/stream` with `forwardedProps.page.projectId` |
| PUT | `/projects/{id}/visibility` | Set public/private (manage) |
| GET | `/projects/{id}/members` | Owner, members, caller's access (view) |
| GET | `/projects/{id}/members/candidates` | Cognito user prefix search, `?q=` (manage) |
| POST | `/projects/{id}/members` | Invite member `{sub, role}` (manage) |
| PUT | `/projects/{id}/members/{sub}` | Change member role (manage) |
| DELETE | `/projects/{id}/members/{sub}` | Remove member (manage) or leave (self) |
| POST | `/projects/{id}/owner` | Transfer ownership (manage) |
| GET | `/projects/{id}/prototypes/{document_id}/pins` | Tester pins on a prototype, `?status=open\|addressed\|resolved` (edit) — docs/feedback-forms.md |
| POST | `/projects/{id}/prototypes/{document_id}/pins/{pin_id}/replies\|resolve\|reopen` | Pin thread reply / resolve / reopen (edit) |
| POST | `/projects/{id}/prototypes/{document_id}/pins/addressed\|resolve` | Batch: mark pins addressed by a revision / resolve addressed pins (edit; used by agents) |
| POST | `/projects/{id}/personas/{persona_id}/promote` | Copy a persona into the company library (edit + admin) → 201 `{success, persona}` |
| GET | `/projects/{id}/personas/copy-sources` | The company library + the OTHER projects the caller owns or is a member of, with personas (view) |
| POST | `/projects/{id}/personas/copy` | Copy `{source: {scope: company} \| {scope: project, project_id}, persona_ids: [1–20]}` in (edit) → 201 `{success, personas}`; notes never copied, avatars copied |

### Company personas (`shared/company_personas_routes.py`, included by projects_handler.py) — docs/project-workspace.md → Company personas
Reads (`GET /company-personas` → `{personas, can_edit}`, `GET /company-personas/jobs`) for every signed-in user; admin writes:
`POST …/generate` (always additive), `POST …/import`, `GET …/jobs/{job_id}`, `PUT/DELETE …/{persona_id}`, `POST …/{persona_id}/notes`,
`POST …/{persona_id}/regenerate-avatar` (202). Stored in the reserved container `PROJECT#company_personas` (no `gsi1pk`);
every `/projects/company_personas/...` route is 404, admins included. The assistant never sees company personas.

| PUT | `/projects/prioritization/rows/{row_id}/lineage-ack` | "Keep both versions": mark / unmark a row's Crosses-generations label as intentional `{project_id, acknowledged, document_ids}` (edit on the row's project; 409 unless `document_ids` is the row's stored set); stored on the row as `lineage_ack` (aggregates `PRIORITIZATION`/`ROW#…`), lapses when the set changes — docs/prioritization.md |

### Document comments and review links (`shared/document_review_routes.py`, included by projects_handler.py) — docs/document-review.md
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/projects/{id}/documents/{doc}/comments` | A PR/FAQ / PRD series' threads + its review link + `can_edit` / new thread `{text, anchor?}` (view: a viewer may comment) |
| POST/DELETE | `/projects/{id}/documents/{doc}/comments/{cid}[/replies\|/resolve\|/reopen]` | Reply (≤ 50), resolve, reopen (view); delete (author or edit) |
| GET/POST/DELETE | `/projects/{id}/documents/{doc}/share` | The series' review link (view) / create `{audience?, expires_in_days?}` (edit; one active per series) / turn off (edit) |
| POST | `/projects/{id}/documents/{doc}/persona-review` | `{persona_ids?: ≤6}` → 202 assist job `assist_persona_review` (edit; every way of working; one `documents` model call per persona; only verbatim quotes are filed) |
| GET | `/review/{share_id}` | BOARD authorizer, throttled 10 rps / 20: the newest version + the caller's own threads |
| POST | `/review/{share_id}/comments[/{cid}/replies]` | BOARD authorizer, throttled 10 rps / 20: a comment / reply (40 writes a day per reviewer and link, 429 `rate_limited`) |

Rows (projects table): `DCOMMENTS#{project}#{series}` / `C#{id}` (threads) and `SHARE`, `DOCSHARE#{share_id}` / `META`
(the link, `ttl`), `DCRATE#{share_id}#{email digest}` / `{day}`. Page `/review/:shareId` (outside `ProtectedRoute`).

### Ballots (ballots_handler.py, `voc-ballots-api`) — room votes on one Prioritization row
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/voting-sessions` | Cognito | Open a vote for a row (edit on its project; an open vote of that row is returned instead) |
| GET | `/voting-sessions` | Cognito | `?row_id=`: the row's open vote, or null |
| GET | `/voting-sessions/{session_id}` | Cognito | Facilitator status (open, ballot count) |
| POST | `/voting-sessions/{session_id}/close` | Cognito | Close the vote (revokes the ballot link) |
| GET | `/voting-sessions/{session_id}/config` | **public** | What the ballot page shows (20 rps / 40); 410 `gone` once its row or project is deleted |
| POST | `/voting-sessions/{session_id}/submit` | **public** | One anonymous ballot (20 rps / 40); 410 `gone` once its row or project is deleted |

### Radar (radar_handler.py, `voc-radar-api`) — all under `/radar/{proxy+}`, see docs/radar.md
| Method | Path | Description |
|--------|------|-------------|
| GET | `/radar/brands` | Effective brands `{brands: [{key, label, domains, origin: list\|profile, sources, language, effective_language, feed_urls, search_terms, exclude_terms}]}` (the list ∪ legacy profile brands, by key) |
| PUT | `/radar/brands` | Replace the brand list `{brands: [{label, domains?, language?, feed_urls?, search_terms?, exclude_terms?}]}` (admin; ≤ 25, ≤ 10 domains, ≤ 3 feeds, ≤ 8 search / exclude terms of ≤ 60 chars each; never deletes reviews) |
| GET | `/radar/brands/{brand}/reviews/{feedback_id}` | One Radar review for the review modal `{brand: {key, label}, review}` (404 when absent / hidden) |

Scrapers, Web Reviews targets, app connectors and CSV / JSON uploads take `radar_brand: <brand key>`; their
reviews go to `voc-radar`, never `voc-feedback`.

### Participants + feedback boards (`engagement_handler.py`, `voc-engagement-api`; routers in `lambda/shared/*_routes.py`)
| Method | Path | Description |
|--------|------|-------------|
| ANY | `/participants/{proxy+}` | Lists, people, project participants, asks (email via SES, async self-invoked sends), settings (Cognito app pool; list/person delete and settings PUT admin) — docs/participants.md |
| POST | `/unsubscribe` | PUBLIC, always 200; the emailed token is the control (own stage throttle, `api-gateway.ts`) |
| GET/POST, ANY | `/feature-requests`, `/feature-requests/{proxy+}` | Feedback boards (5.36, `shared/feature_boards_routes.py` included before `feature_requests_routes.py`): `GET/POST /feature-requests/boards` (list, seeds `brd_sales` / `sales-feature-requests` when none; create admin, 409 `slug_taken`), `GET/PUT/DELETE /feature-requests/boards/{slug_or_id}` (PUT/DELETE admin; 409 `status_in_use` / `board_not_empty`; PUT `paused` = temporary read-only board, every request / +1 / edit write 409 `board_paused`, admins still triage; archive = the step before delete, the UI offers Delete only on an archived board; a request never changes board); `GET /feature-requests?board=` + `POST /feature-requests {board?, fields}` (no board = the seeded one), request/support/status/promote routes check the request's board (`board_access`, `shared/feature_boards_access.py`: app users every non-archived board, board-pool users per audience `company`/`list`/`anyone`; invisible = 404), statuses per board, fields per template (`shared/feature_board_fields.py`), `anyone` boards 429 `rate_limited`. BOARD authorizer = app pool + the board's own pool (`voc-board-user-pool`, on every deployment since 5.45.00: SES + email OTP with `-c emailFrom`, else Cognito's default email + confirmation / reset codes; never auto-confirms; PreSignUp admits an email some non-archived board would admit, from `SETTINGS`/`board_audience` + company domains in voc-participants, or an active review link `DOCSHARE#{id}`) — docs/feature-requests.md |

Errors are `{success: false, error}`. A board-pool token is accepted by NO other route (the main authorizer knows only
the app pool). Assistant tools on `/participants` (pack `participants`, card-only writes): `list_participant_lists`,
`create_participant_list`, `add_participants` (≤ 200 rows).

### Webhooks
| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/{plugin}` | Plugin webhook receiver (public) |

> `POST /webhooks/github_issues` exists only when `pluginStatus.github_issues` is true. It checks
> `X-Hub-Signature-256` (HMAC, constant-time), caps bodies at 1 MB, and is throttled 10 rps / 20.

### Logs (logs_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/logs/validation` | Validation failures |
| DELETE | `/logs/validation/{source}` | Clear one source's validation failures (admin) |
| GET | `/logs/processing` | Processing errors |
| GET | `/logs/scraper/{scraper_id}` | One scraper's run log |
| GET | `/logs/summary` | Counts per source and log type |
| GET | `/logs/system` | System errors: this deployment's Lambda ERROR/CRITICAL (`level=warning`: + WARNING) and platform lines, Step Functions failure events and API 5xx (+ telling 4xx) via Logs Insights, grouped by `source` (`lambda`/`workflow`/`api`), redacted; `days` 1–30; `running` + `query_id` to poll (admin, no-store; docs/deployment.md → System errors) |
| GET | `/logs/system/request` | `?function=&request_id=&at=`: every line (any level) of one invocation, `at` ± 20 min, ≤ 500, oldest first; 404 for `api` / unknown; `running` + `query_id` (admin, no-store) |
| GET | `/logs/system/queues` | Every failure queue (`OPS_ALERTS_QUEUES`): count, oldest age, ≤ 3 redacted bodies peeked with `VisibilityTimeout=0`, never deleted (admin, no-store) |
| GET | `/logs/system/environment` | Region, account last 4, prefix, sources, web search, inference scope, image model, models per surface, alerting + alarm states, open circuits, log coverage — nothing secret (admin, no-store) |
| GET / PUT | `/logs/alerts` | Alerting status / turn the runtime CloudWatch alarms on or off (admin) |
| POST | `/logs/alerts/recipients` | Add an SNS email recipient (admin; pending until confirmed) |
| POST | `/logs/alerts/recipients/remove` | Remove an email recipient (admin) |

### Manual Import (manual_import_handler.py) — ADMIN ONLY, every route (module middleware; owner decision 2026-10-08, #242)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/scrapers/manual/parse` | Start an LLM parse of pasted review text (admin) |
| GET | `/scrapers/manual/parse/{job_id}` | Poll a parse job (admin) |
| POST | `/scrapers/manual/confirm` | Import the parsed reviews (admin) |
| POST | `/scrapers/manual/csv-upload` | Import CSV rows (admin); optional `dataset_name` keys rows with an id as `csv-row-v2` (dataset + id): `dry_run` answers `{counts: {new, changed, unchanged, v1_rows}, changed_rows (≤ 50), changed_rows_truncated}`, a real upload that changes stored rows is 409 without `apply_updates`; confirmed rows are queued with `csv_replace` and updated in place by the processor (`shared/csv_updates.py`, docs/csv-import.md) |
| POST | `/scrapers/manual/json-upload` | Import JSON items (admin) |
| GET | `/scrapers/manual/history` | Import runs, newest first, `?limit=` (1-100) `&cursor=` (admin; docs/import-history.md) |
| GET | `/scrapers/manual/history/{run_id}` | One import run with its warnings and errors (admin; 404 unknown/expired) |

Paste confirm, CSV and JSON upload (incl. the assistant's `import_reviews`, tagged `import_origin: 'assistant'`) and the
S3 import ingestor (one per file) write a run record through `lambda/shared/import_runs.py`; a failed write never
fails the import.

### S3 Import (s3_import_handler.py) — ADMIN ONLY, every route (module middleware; owner decision 2026-10-08, #242)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/s3-import/sources` | Source folders + bucket name (admin) |
| POST | `/s3-import/sources` | Create a source folder (admin) |
| GET | `/s3-import/files` | Staged files (admin) |
| POST | `/s3-import/upload-url` | Create-only presigned PUT (409 existing key; `If-None-Match: *` signed) (admin) |
| DELETE | `/s3-import/file/{key}` | Delete `<source>/<file>` only — 400 for `..`, leading `/`, `processed/` (admin) |
| POST | `/s3-import/reprocess` | Re-run one file `{key}` (`<source>/<file>` or `processed/<source>/<file>`) through the `s3_import` ingestor → 202 `{success, run}`; 404 missing file; 409 while a run of that file is `running` and younger than the ingestor timeout (300 s); the ingestor reads only its `S3_IMPORT_BUCKET` (admin; docs/data-lake-structure.md → Reprocessing a file) |
| GET | `/s3-import/reprocess/{run_id}` | One run: the `SOURCE_RUN#s3_import` / `<run id>` row the ingestor moves to completed / error (admin) |

### Memory (memory_handler.py, `voc-memory-api`) — all Cognito, see docs/memory.md
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/memory` | List (`scope`, `status`, `kind`, `q`, `cursor`) / add (user_explicit; company by admin or memory reviewer, else `proposed`) |
| ANY | `/memory/{proxy+}` | `{id}/confirm\|forget\|restore`, `PUT {id}`, `merge`, `review`, `review/{id}/resolve`, `imports`, internal `retrieve` + `conflict-check` |

### Agents (agents_handler.py, `voc-agents-api`) — all Cognito, writes admin-only, see docs/autonomous-agents.md
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/agents` | List / create |
| ANY | `/agents/{proxy+}` | `{id}` get/update/archive, `enable\|disable`, `run` (202), `runs`, `runs/{run_id}[/events\|/cancel]` |
| GET/POST | `/workflows` | List / create |
| ANY | `/workflows/{proxy+}` | `{id}` (+ revisions), `{id}/revisions/{revision}` (one revision with its definition, read like `{id}`; 400 bad number, 404 absent), `PUT {id}` (409 stale), `duplicate`, `export`, `validate` |
| POST/GET | `/agents/plans` | Approve + start an assistant plan `{plan, conversation_id?}` → 202 `{plan_id, status}` (any signed-in user = approver; 400 lists `errors`; 409 at 3 active) / the caller's plans `?limit=` — NOT admin-only (docs/assistant-plan-mode.md) |
| GET | `/agents/plans/{plan_id}` | `{plan: PlanView}` (approver or admin, else 404) |
| POST | `/agents/plans/{plan_id}/cancel`, `/steps/{step_id}/approve\|decline` | Cancel (approver or admin) / resolve a paused step (approver only; 409 unless `needs_approval`) |
| DELETE | `/agents/plans/{plan_id}` | Remove a finished plan from the caller's list (approver or admin; kept with `hidden_at`, still readable by id; 409 while active) |

### Global MCP + Connect tokens (`mcp_global_handler.py` / `voc-mcp-global-api`, `mcp_tokens_handler.py` / `voc-mcp-tokens-api`) — see docs/mcp.md
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/mcp/global` | global MCP token | JSON-RPC MCP server for the whole app (throttled 20 rps / 40); acts as the minting user — their project + category access, never admin, ≤ editor |
| GET/POST | `/connect/tokens` | Cognito | List my tokens / mint one (`read` or `write` scope, expiry ≤ 365 days, optional project pin) |
| GET | `/connect/tokens/{token_id}` | Cognito | One token and its audit log (tool, time, project, outcome — never arguments) |
| DELETE | `/connect/tokens/{token_id}` | Cognito | Revoke (soft; the row is kept) |

> Global tokens live in their own `MCPGTOKEN` partition. The per-project MCP server (`POST /mcp`,
> `/projects/{id}/api-tokens`) and `GET /projects/{id}/autoseed` were retired in 3.00.00; a leftover per-project
> (`MCPTOKEN`) token is a 401 at `/mcp/global`. The minter is re-checked in Cognito on every call, so a disabled or demoted user's
> tokens stop working at once. `run_agent` needs a write token minted by an admin, and admin membership is re-checked
> per call. The skill is a static file at `/voc-mcp-skill.md`, and the Connect page fills in the endpoint.

### Data Explorer (data_explorer_handler.py)

Admin-only on every route. Customer data is never deleted: there is **no**
`DELETE /data-explorer/s3` or `DELETE /data-explorer/feedback` (`/data-explorer/{proxy+}` in
`api-routes.ts` carries GET and PUT only, no ANY or DELETE; the role holds no delete permission).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/data-explorer/buckets` | List logical buckets |
| GET | `/data-explorer/s3` | Browse S3 raw data bucket with folder navigation |
| GET | `/data-explorer/s3/preview` | Preview JSON file content from S3 |
| PUT | `/data-explorer/s3` | Create S3 file (409 when overwriting an existing `raw/` object) |
| PUT | `/data-explorer/feedback` | Update DynamoDB feedback record in place |

## Adding a New Data Source

1. Create plugin in `plugins/{source}/` with `manifest.json` and `handler.py`
2. Follow the template in `plugins/_template/`
3. Run `npm run validate:plugins` to verify configuration
4. Add source config to `ingestion-stack.ts` (schedule, timeout)
5. Add credentials to Secrets Manager template
6. Update frontend Settings page with source fields

## CDK Stack Dependencies

```
VocCoreStack (DynamoDB tables, S3 raw data bucket, KMS, Cognito, CloudFront)
       │
       ├──▶ VocIngestionStack (Plugin Lambdas, EventBridge, SQS, Secrets)
       │           │
       │           └──▶ VocProcessingStack (Processor, Aggregator, Step Functions incl. voc-agent-run, category reprocess worker, voc-retention (the only customer-data delete role), memory workers + memory-extract queue, agent heartbeat/conductor/persona panel, Bedrock)
       │
       ├──▶ VocApiStack (API Gateway + per-method throttles, API Lambdas, Webhooks; no WAF)
       │           │
       │           └── Depends on: processingQueue, secretsArn, researchStateMachine, userPool

AI-enablement stack, NO dependency on the core chain (but Processing/Api import
its gateway exports, so it deploys first):
  VocWebSearchStack (always us-east-1) = web-search gateway (default-on, opt out
    with -c enableWebSearch=false) + Bedrock model access / Anthropic use case
    (only when anthropicUseCase is set). Not created when both halves are off.
```
