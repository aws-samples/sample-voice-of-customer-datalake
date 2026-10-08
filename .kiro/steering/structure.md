# VoC Data Lake - Project Structure

## Repository Layout

```
voice-of-customer-datalake/       # Root repository
├── docs/                         # Documentation
│   ├── data-lake-structure.md    # Data lake architecture documentation
│   ├── deployment.md             # Deployment guide
│   ├── feedback-forms.md         # Feedback forms documentation
│   ├── getting-started-plugins.md # Plugin development guide
│   ├── plugin-architecture.md    # Plugin system architecture
│   ├── processing-pipeline.md    # Processing pipeline documentation
│   └── scrapers.md               # Web scraper documentation
├── scripts/                      # Root-level scripts
│   └── find-*.sh                 # Dead code analysis scripts
├── static/                       # Static assets (demo videos, thumbnails)
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
    │   │   ├── idempotency.py        # Idempotency helpers
    │   │   ├── ingest_schemas.py     # Pydantic schemas validating every processing-queue message
    │   │   ├── logging.py            # Logging utilities
    │   │   ├── prompts.py            # Prompt management utilities
    │   │   ├── scraper_run_errors.py # Read-time redaction of stored scraper-run errors
    │   │   └── url_policy.py         # Outbound URL policy for scraper fetches (SSRF guard, #244)
    │   ├── api/                      # Split into domain-specific Lambdas (20KB IAM policy limit) - 15 handlers
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
    │   │   ├── manual_import_handler.py  # /manual-import/* (manual data import)
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
    │       ├── ingestion-deps/       # Layer: requests, aws-lambda-powertools, beautifulsoup4
    │       └── processing-deps/      # Layer: aws-lambda-powertools
    ├── plugins/                      # Data source plugins
    │   ├── _shared/                  # Shared plugin utilities
    │   ├── _template/                # Template for new plugins
    │   ├── github_issues/            # GitHub Issues: ingestor (30 min) + signed webhook, version/label enrichment (docs/github-issues.md; enabled, idle until a token + repos are saved)
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
    │   │   ├── components/           # Each component in its own folder with index.tsx (23 total)
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
    │   │   ├── pages/                # Each page in its own folder (14 total)
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
    │   │   │   ├── Scrapers/         # Web scraper configuration
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
    │   └── feedback-event.schema.json
    ├── scripts/
    │   ├── build-layers.sh           # Build Lambda layers with Docker (ARM64)
    │   ├── test-api.sh               # API validation script
    │   ├── generate-manifests.ts     # Generate plugin manifests with enabled status
    │   ├── generate-menu-config.ts   # Generate menu config from cdk.context.json
    │   ├── generate-integrity.ts     # Generate plugin integrity hashes
    │   ├── validate-plugins.ts       # Validate plugin configurations
    │   └── test-plugin-loader.ts     # Test plugin loading
    ├── cdk.json
    ├── tsconfig.json
    └── package.json
```

## Storage

### S3 Raw Data Lake

| Bucket | Structure | Purpose |
|--------|-----------|---------|
| `voc-raw-data-{account}-{region}` | `raw/{source}/{year}/{month}/{day}/{id}.json` | Raw scraped/ingested data archival — immutable, never deleted, bucket RETAINed |
| `voc-raw-data-{account}-{region}` | `avatars/{project_id}/{persona_id}.png` | AI-generated persona avatars |

### DynamoDB Tables

| Table | PK | SK | Purpose |
|-------|----|----|---------|
| `voc-feedback` | `SOURCE#{platform}` | `FEEDBACK#{id}` | Processed feedback with GSIs for date, category, urgency; optional `author`, `title`, `metadata`, `dimensions`, `dimension_sources`, `tags`, `pii_policy` — no TTL, RETAINed; only `voc-retention` deletes (opt-in per source profile) |
| `voc-aggregates` | `METRIC#{type}` | `{date}` | Pre-computed metrics (no TTL), brand config, category config, `CATEGORY_ACCESS`/`USER#{sub}` (+ `sources`), `SETTINGS#dimensions`/`SETTINGS#sources` `config`, `METRIC#daily_dim…`/`METRIC#daily_tag#…`, `JOB#erasure`/`er_…`, `AUDIT#retention`, `JOB#category_reprocess`/`rp_…`, `METRIC#meta`/`earliest_date`, form configs — RETAINed |
| `voc-watermarks` | `{source}` | - | Ingestion state tracking |
| `voc-projects` | `PROJECT#{id}` | `META\|PERSONA#{id}\|PRD#{id}\|PRFAQ#{id}` | Projects with personas, PRDs, PR/FAQs — RETAINed |
| `voc-jobs` | `PROJECT#{id}` | `JOB#{id}` | Long-running async jobs (research, persona generation) |
| `voc-conversations` | `USER#{id}` | `CONV#{id}` | AI chat conversation history; assistant items also carry `run_id`/`run_status`/`revision`, written by the stream Lambda while a run streams |
| `voc-idempotency` | `{id}` | - | Lambda Powertools idempotency tracking |
| `voc-memory` | `MEM#company\|MEM#user#{sub}`, `MEMEVT#{id}`, `MEMCURSOR`, `MEMIMPORT` | `MEM#{id}`, `{iso}#{n}`, `SESSION#{id}`, `{import_id}` | Memories (index `gsi1-by-memory-status`), audit, extraction cursors, imports — RETAINed, never deleted (docs/memory.md) |
| `voc-agents` | `AGENT#{id}`, `WORKFLOW#{id}`, `RUN#{run_id}` | `META\|RUN#{run_id}`, `REV#{n}\|CURRENT`, `EVT#{seq}\|MATE#{role}#{seq}` | Agents, versioned workflows, runs + journal (index `gsi1-by-agents-listing`) — RETAINed (docs/autonomous-agents.md) |

## API Endpoints

### Metrics (metrics_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/feedback` | List feedback with filters (days, source, category, sentiment) |
| GET | `/feedback/{id}` | Get single feedback item |
| GET | `/feedback/{id}/similar` | Get similar feedback items |
| GET | `/feedback/access` | The caller's scope `{all, categories, sources_all, sources, source_rule: all\|allow\|deny, sources_denied}` |
| GET | `/feedback/urgent` | Get high-urgency items |
| GET | `/feedback/entities` | Keywords, categories, issues, `channels`, `tags`, `dimensions` for filters |
| GET | `/metrics/summary` | Dashboard summary metrics |
| GET | `/metrics/sentiment` | Sentiment breakdown |
| GET | `/metrics/categories` | Category breakdown |
| GET | `/metrics/sources` | Source breakdown |
| GET | `/metrics/personas` | Persona breakdown |
| GET | `/metrics/dimensions` | `?key=<dim>`: per-value counts + sentiment split, `unassigned` (docs/dimensions.md) |
| GET | `/metrics/github` | GitHub Issues per release and per label (counts, 👍 weight, sentiment, top complaints, new since the last release); `/feedback` also takes `version` and `label` filters |

`days` is 0–9999 everywhere; `0` = all time. Every route that takes `source` also
takes `channel`, `dims=key:value,…` (400 when malformed) and `tag`. Every route enforces the caller's
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

Every route is scoped to `USER#{cognito sub}`. The assistant itself streams at
`POST /chat/stream` (`voc-chat-stream`, TypeScript): AG-UI `RunAgentInput` in,
AG-UI events out; read-only server tools, human-approved client-tool writes.

**Server-side session persistence.** While a run streams, `voc-chat-stream` saves the
conversation (user turn + the in-progress answer, tool calls/results trimmed) to the
SAME assistant item, in the caller's own `USER#{verified sub}` partition (enforced in
code: `lambda/stream/src/assistant/session/`), adding `run_id`, `run_status`
(`running|finished|failed|interrupted`) and `revision` (grows only). Writes are
throttled (every 2 s / 2,000 chars, at tool boundaries, at the end), ordered,
fire-and-forget, capped at ~350 KB, and the run completes without a client. GET/list
return `runStatus`/`runId`/`revision`; a `running` record older than
`STALE_RUN_SECONDS` (360) is dead. The SPA shows a reloaded running session as
"still generating" and polls GET until it ends. The server owns the answer: a POST
carries `baseRevision` (from the stream's `assistant.session` event or a GET) and is
refused **409** while the run is live or when the stored revision is newer; the SPA
then adopts the server copy.

### Integrations (integrations_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/integrations/status` | Integration status |
| PUT | `/integrations/{source}/credentials` | Update credentials |
| POST | `/integrations/{source}/test` | Test integration |
| GET | `/sources/status` | Source schedule status |
| PUT | `/sources/{source}/enable` | Enable source |
| PUT | `/sources/{source}/disable` | Disable source |

### Scrapers (scrapers_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/scrapers` | List scraper configs |
| POST | `/scrapers` | Save scraper config |
| DELETE | `/scrapers/{id}` | Delete scraper |
| GET | `/scrapers/templates` | Get scraper templates |
| POST | `/scrapers/{id}/run` | Trigger scraper run |

### Settings (settings_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/settings/brand` | Get brand configuration |
| PUT | `/settings/brand` | Save brand configuration |
| POST | `/settings/model/test` | Test one model `{model_id}` (admin; 400 unless allowlisted): ONE minimal Converse to exactly that model, no fallback → `{model_id, invoked_id, status: available\|no_access\|not_in_region\|no_capacity\|throttled\|not_ready\|unavailable\|error, ok, latency_ms, message, quota, checked_at}` (`shared/model_capacity.py`) |
| GET | `/settings/model/capacity` | Every allowlisted model's tokens-per-minute quota from Service Quotas `{models: [{model_id, label, quota}]}` (admin; no model call, cached 10 min) |
| GET | `/settings/categories` | Get category configuration |
| PUT | `/settings/categories` | Save category configuration — admin-only; categories carry `product` + `owners` |
| POST | `/settings/categories/generate` | AI-generate categories |
| POST | `/settings/categories/reprocess` | Start a reprocess job `{mode: processed\|raw\|dimensions, days, include_manual?}` (admin) → 202 `{job}`, 409 if one is active |
| GET | `/settings/categories/reprocess` | Latest reprocess job |
| GET | `/settings/categories/reprocess/{job_id}` | One reprocess job |
| POST | `/settings/categories/reprocess/{job_id}/cancel` | Cancel a reprocess job |
| GET/PUT | `/settings/dimensions` | Dimensions config (GET any user, PUT admin) — docs/dimensions.md |
| GET/PUT | `/settings/sources` | Source profiles (admin full; others `{id, label, restricted}`; PUT admin) — docs/source-policies.md |
| POST/GET | `/settings/erasure` | Start an erasure `{field, value, source?}` → 202 `{job}` (async `voc-retention`; value only hashed) / list jobs (admin) |
| GET | `/settings/my-onboarding` | The caller's onboarding-buddy preference `{state, hidden_until, visible, start_page}` + first-run `signals` (self only) |
| PUT | `/settings/my-onboarding` | Set `{state?: active\|hidden\|dismissed\|skipped, start_page?: home\|dashboard}` — only the named fields change (`hidden` = one-day snooze, server clock; `start_page: dashboard` = opening the app lands on the dashboard) |

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

### Feedback Forms (feedback_form_handler.py)

Every route requires Cognito **except** the three marked public, which the
embeddable widget calls from the customer's own site.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/feedback-forms` | Cognito | List all forms |
| POST | `/feedback-forms` | Cognito | Create form |
| GET | `/feedback-forms/{id}` | Cognito | Get form |
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
> cross-origin); `POST /submit` shows a modal "Failed to submit." alert and is
> retryable; `GET /iframe` runs no widget code at all (the browser navigates to it
> directly), so it is a raw API Gateway error page inside the customer's iframe.
> `GET /voting-sessions/{session_id}/config` carries 20 rps / 40 for a different
> reason (a room is bounded by `MAX_BALLOT_CAP`), and its sibling
> `POST /voting-sessions/{session_id}/submit` carries 20 rps / 40 on that same reasoning.

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

Owner and member `email` (and `owner_email`) appear in project list/get and
`GET /projects/{id}/members` only for `can_manage` callers (owner/admin).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/projects` | List projects the caller can view; `?ids=a,b` (≤ 200) → `{details: [{project, documents}]}` for the viewable ones (Prioritization's one-call read; unviewable/missing ids are simply absent) |
| POST | `/projects` | Create project (caller becomes owner; default private) |
| GET | `/projects/{id}` | Get project with personas/documents and members |
| PUT | `/projects/{id}` | Update project |
| DELETE | `/projects/{id}` | Delete project (manage) |
| POST | `/projects/{id}/personas/generate` | Generate personas from feedback |
| POST | `/projects/{id}/research` | Run research job (Step Functions) |
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

### Webhooks
| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/{plugin}` | Plugin webhook receiver (public) |

> `POST /webhooks/github_issues` exists only when `pluginStatus.github_issues` is true. It checks
> `X-Hub-Signature-256` (HMAC, constant-time), caps bodies at 1 MB, and is throttled 10 rps / 20.

### Logs (logs_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/logs` | Get system logs |
| GET | `/logs/errors` | Get error logs |

### Manual Import (manual_import_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/manual-import` | Import data manually |
| GET | `/manual-import/status` | Get import status |
| POST | `/manual-import/validate` | Validate import data |

### Memory (memory_handler.py, `voc-memory-api`) — all Cognito, see docs/memory.md
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/memory` | List (`scope`, `status`, `kind`, `q`, `cursor`) / add (user_explicit; company by admin or memory reviewer, else `proposed`) |
| ANY | `/memory/{proxy+}` | `{id}/confirm\|forget\|restore`, `PUT {id}`, `merge`, `review`, `review/{id}/resolve`, `imports`, `stats`, internal `retrieve` + `conflict-check` |

### Agents (agents_handler.py, `voc-agents-api`) — all Cognito, writes admin-only, see docs/autonomous-agents.md
| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/agents` | List / create |
| ANY | `/agents/{proxy+}` | `{id}` get/update/archive, `enable\|disable`, `run` (202), `runs`, `runs/{run_id}[/events\|/cancel]` |
| GET/POST | `/workflows` | List / create |
| ANY | `/workflows/{proxy+}` | `{id}` (+ revisions), `PUT {id}` (409 stale), `duplicate`, `import`, `export`, `validate` |

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
`DELETE /data-explorer/s3` or `DELETE /data-explorer/feedback` (explicit routes in
`api-routes.ts`, no `{proxy+}`; the role holds no delete permission).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/data-explorer/buckets` | List logical buckets |
| GET | `/data-explorer/s3` | Browse S3 raw data bucket with folder navigation |
| GET | `/data-explorer/s3/preview` | Preview JSON file content from S3 |
| PUT | `/data-explorer/s3` | Create S3 file (409 when overwriting an existing `raw/` object) |
| PUT | `/data-explorer/feedback` | Update DynamoDB feedback record in place |
| GET | `/data-explorer/stats` | Get data lake statistics |

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
