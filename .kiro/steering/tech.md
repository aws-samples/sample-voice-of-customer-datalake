# VoC Data Lake - Tech Stack & Best Practices

## Infrastructure (AWS CDK)

- **Language**: TypeScript
- **CDK Version**: 2.275.0 (exact) per `voc-datalake/package.json` (the `aws-cdk` CLI is pinned exactly too, as a devDependency; assembly schema 54+)
- **Runtime**: Node.js 22.22.2+ or 24.15+ (root `package.json` `engines`)
- **Entry Point**: `bin/voc-datalake.ts`

### AWS Services (All Serverless)

| Service | Purpose | Key Config |
|---------|---------|------------|
| **DynamoDB** | Processed data, streams | On-demand billing, KMS encryption, TTL |
| **S3** | Raw data lake, avatars | KMS encryption, partitioned by source/date |
| **Lambda** | Compute | Python 3.14 (the assistant stream: Node.js 24), ARM64 (Graviton), Powertools |
| **SQS** | Processing queue | DLQ, visibility timeout, batch processing |
| **API Gateway** | REST API | Throttling, CORS, Cognito auth |
| **Cognito** | Authentication | User Pool, admins/users groups |
| **API Gateway throttling** | API protection | Per-method stage throttles (`lib/stacks/api-gateway.ts`); no WAF by default (a fixed monthly cost); opt in with `-c enableWaf=true` (`lib/utils/waf.ts`, also on with `-c performanceTier=true`) |
| **EventBridge** | Scheduled ingestion | Rate expressions (1-30 min) |
| **Secrets Manager** | API credentials | Auto-rotation capable |
| **KMS** | Encryption | Customer-managed key, key rotation |
| **Bedrock** | LLM inference | Per-surface model picker (Claude 5.5 generation: Sonnet 5.5 for the AI assistant, documents, utilities, agent workers/personas; Opus 5.5 for prototypes and the agent conductor/reviewer; Haiku 5.5 for enrichment and memory; allowlist in `lib/utils/model-allowlist.ts`, resolution via `shared/model_config.py`); `-c inferenceScope=eu` maps `global.` → `eu.` profiles at call time (docs/eu-deployment.md) |
| **Comprehend** | NLP | Sentiment, language detection, key phrases; `DetectPiiEntities` for source-policy redaction (en/es, `PII_COMPREHEND=1`) |
| **Translate** | Multi-language | Auto language pair detection |
| **Step Functions** | Long-running jobs | Research workflows, persona generation |
| **CloudFront** | CDN | Frontend distribution, avatar images |
| **AppSync Events** | Push notices to the SPA | One Event API in VocCoreStack (`lib/stacks/core-realtime.ts`); publish grants = one managed policy per namespace, attached to each publisher's role in its own stack; namespaces `jobs`, `chat`, `runs`, channels `/<ns>/<cognito sub>`; subscribe = app pool (SPA client only) + own-channel onSubscribe handler, publish = IAM only; pay per use, no fixed cost; polling stays the fallback (docs/realtime.md) |

## Data Sources

| Source | Type | Auth | Schedule |
|--------|------|------|----------|
| Web Scraper | HTTP | None | Configurable |
| Feedback Forms | API | None (public) | Real-time |
| GitHub Issues (plugin, enabled; idle until configured) | GitHub REST + webhook | Read-only token + webhook secret in the plugin's Secrets Manager secret | 30 min (+ real-time webhook) |
| Web Reviews (plugin `web_reviews`, enabled; idle until a page is added) | AgentCore Browser `aws.browser.v1` over CDP (`websocket-client`), JSON-LD or `enrichment`-model extraction; one source per connector `web_<site>_<app_name>` (stored on the target as `source_id`); blocked sites reported (docs/web-reviews.md) | IAM only (Start/StopBrowserSession on aws.browser.v1, ConnectBrowserAutomationStream on `*`) | Manual / per-target frequency (15 min tick, rule disabled) |

## Backend (Lambda - Python)

### Runtime & Libraries

- **Runtime**: Python 3.14 (CDK `Runtime.PYTHON_3_14`; ruff, pyright and CI still target 3.12)
- **Architecture**: ARM64 (Graviton) for better price/performance
- **Core**: `aws-lambda-powertools` (logging, tracing, metrics, batch processing)
- **HTTP**: `requests`
- **Scraping**: `beautifulsoup4`, `lxml`
- **Pattern**: Base class inheritance for ingestors

### API Lambda Split (20KB IAM Policy Limit)

AWS Lambda execution roles have a **20KB policy size limit**. To stay under this limit, the API is split into focused, domain-specific Lambdas, one per `lambda/api/*_handler.py` (21 handlers) plus the TypeScript assistant stream:

| Lambda | Handler | Routes | Permissions |
|--------|---------|--------|-------------|
| `voc-metrics-api` | `metrics_handler.py` | `/feedback/*`, `/metrics/*` | DynamoDB read (feedback, aggregates) |
| `voc-chat-api` | `chat_handler.py` | `/chat/*` | DynamoDB RW (conversations), and voc-workspaces GetItem on `WS#*` only (inside a workspace the caller's conversations are `WS#{ws}#USER#{sub}`, their membership read through `lambda/shared/request_workspace.py` with `elevate=False`) — no feedback/aggregates access, no Bedrock (the assistant is `voc-chat-stream`) |
| `voc-integrations-api` | `integrations_handler.py` | `/integrations/*`, `/sources/*` | Secrets Manager (the deployment's shared secret), SSM Get/Put/GetParametersByPath on one workspace's `/voc/ws/{ws}/credentials/*` (decision 19), DynamoDB (aggregates: a workspace's `WS#{ws}#PLUGIN_CONFIG` rows; voc-workspaces GetItem of a `PLUGIN#*` row's `pk`, Run now's check since 7.14.00), EventBridge |
| `voc-scrapers-api` | `scrapers_handler.py` | `/scrapers/*` | Secrets Manager (the deployment's shared secret), SSM Get/Put/GetParametersByPath on one workspace's `/voc/ws/{ws}/credentials/*` (decision 19), Lambda invoke, Bedrock, DynamoDB (aggregates, a workspace's `WS#{ws}#PLUGIN_CONFIG` rows; voc-workspaces GetItem of a `PLUGIN#*` row's `pk`, a run's check since 7.14.00) |
| `voc-settings-api` | `settings_handler.py` | `/settings/*` (incl. dimensions, sources, erasure, model test/capacity) | DynamoDB (aggregates, a workspace's erasure jobs and lock under `WS#{ws}#JOB#erasure` included, since 7.09.00: the erasure routes' `X-Workspace-Id`, member admins only, the membership read through the workspace-resolution policy below), Bedrock, `servicequotas:ListServiceQuotas` + `GetServiceQuota` on `bedrock/*` (read-only), invoke `voc-category-reprocess` + `voc-retention` + its assist twin `voc-settings-assist`; image-model row: `bedrock:InvokeModel` on the image model ARN only, `bedrock:GetFoundationModelAvailability`, Marketplace ViewSubscriptions + Subscribe (ProductId-scoped, `lib/stacks/api-marketplace.ts`); Cognito `AdminGetUser` + `AdminListGroupsForUser` on the user pool (the brief's email; the live platform-admin check of `PUT /settings/appearance`, `lambda/shared/platform_admin_gate.py`, and of a platform admin entering a workspace); voc-workspaces GetItem on `WS#*` and `AUDIT#WS#*`, PutItem on `AUDIT#WS#*` only, through the stack's one workspace-resolution managed policy (`GET`/`PUT /settings/resolved-problems` and `/settings/brand` act in the caller's workspace, `lambda/shared/request_workspace.py`, `lib/utils/workspace-resolution-grants.ts`; the rows `WS#{ws}#SETTINGS#resolved_problems` and `WS#{ws}#SETTINGS#brand`; a request with no `X-Workspace-Id` keeps `SETTINGS#resolved_problems` and `SETTINGS#brand`, as before) |
| `voc-projects-api` | `projects_handler.py` | `/projects/*`, `/review/*` (document review links, board authorizer; docs/document-review.md), `/company-personas/*` (the company persona library, admin writes; docs/project-workspace.md → Company personas) | DynamoDB (projects, jobs, feedback), Step Functions, Bedrock, S3 |
| `voc-users-api` | `users_handler.py` | `/users/*` (incl. `PUT /users/{username}/platform-admin`, platform admins only; `DELETE /users/{username}` first removes the user's workspace memberships, `lambda/shared/workspace_members.py`) | Cognito admin; DynamoDB aggregates GetItem/PutItem/BatchGetItem (+ the version bump), its only audit write there the `AUDIT#platform-admins` partition (a conditional put; the audit-row guard denies it every other audit partition and any change or removal); since 6.11.00 workspaces Query on `USER#*`/`WS#*`, GetItem on `WS#*`/`AUDIT#WS#*`, ConditionCheckItem on `WS#*`, PutItem on `AUDIT#WS#*` only (each removal's audit row; the guard names it a writer of that pattern only), DeleteItem on `USER#*`/`WS#*` (the code deletes `MEMBER#` and `USER#` keys only) |
| `voc-feedback-form-api` | `feedback_form_handler.py` | `/feedback-forms/*` | DynamoDB (aggregates), SQS |
| `voc-chat-stream` | `lambda/stream` (TypeScript, esbuild-bundled) | `/chat/stream` — unified AI assistant, AG-UI 1.0 SSE via API Gateway | DynamoDB read (feedback, aggregates), Bedrock streaming, `lambda:InvokeFunction` on exactly ProjectsApi/MetricsApi/FeedbackFormApi/SettingsApi/ScrapersApi/MemoryApi/AgentsApi/UsersApi/EngagementApi (UsersApi only for the admin-only `list_users` / `get_user_access` reads; EngagementApi for the participants tools); conversations `GetItem`/`PutItem` (table ARN only) — its ONE write is the caller's own session, saved while a run streams (`assistant/session/`; partition `USER#{verified sub}`, or `WS#{ws}#USER#{verified sub}` inside a workspace the caller is a verified member of, enforced in code, IAM cannot pin it; voc-workspaces GetItem on `WS#*` only, for that membership check, `assistant/session/workspace-member.ts`); no projects-table access, no business-data writes; its only POSTs are reads (`READ_POSTS`: chat context, memory retrieve, workflow validate, `POST /scrapers/analyze-url` for admins, which starts an assist job the tool then polls); the Lambda and the `/chat/stream` integration run up to 15 min (900 s), `STALE_RUN_SECONDS` 960; `forwardedProps.mentions` (project pages) runs a review-only persona round of `consult_personas` calls before the model's turn, no new grant (docs/assistant-mentions.md) |
| `voc-data-explorer-api` | `data_explorer_handler.py` | `/data-explorer/*` | S3, DynamoDB (feedback) |
| `voc-logs-api` | `logs_handler.py` | `/logs/*` | CloudWatch Logs read; CloudWatch Put/Delete/DescribeAlarms on `alarm:voc-alerts-<suffix>-*`; SNS Subscribe/Unsubscribe/ListSubscriptionsByTopic on the ops topic (Administration → System → Logs → Alerts); Logs Insights for `GET /logs/system*` (System errors, `lib/stacks/api-logs-diagnostics.ts`): `logs:DescribeLogGroups` on `log-group:*`, `logs:StartQuery` on `/aws/lambda/` + `/aws/stepfunctions/[<prefix>-]voc-*-<account>-<region>`, the API access log and VocCoreStack's CFN-named Lambda log groups (`<stack>-<construct id>*`) only, `logs:GetQueryResults`/`StopQuery` + `cloudwatch:GetMetricData` on `*`; failure-queue peek: `sqs:GetQueueUrl`/`GetQueueAttributes`/`ReceiveMessage` on exactly the `OPS_ALERTS_QUEUES` (no delete), `kms:Decrypt` via SQS for those queues only; Cognito `AdminGetUser` + `AdminListGroupsForUser` on the user pool (the live platform-admin check of the alert writes, `lambda/shared/platform_admin_gate.py`) |
| `voc-manual-import-api` | `manual_import_handler.py` | `/scrapers/manual/*` (admin-only) | DynamoDB (aggregates RW; feedback `BatchGetItem` only, for a CSV dataset preview, docs/csv-import.md), SQS, S3 |
| `voc-feedback-edit-api` | `feedback_edit_handler.py` | `PUT /feedback/{id}/category`, `PUT /feedback/{id}/dimensions` (correct a review's category / dimensions + tags) | DynamoDB (feedback RW, aggregates read) |
| `voc-memory-api` | `memory_handler.py` | `/memory`, `/memory/{proxy+}` (inside a workspace, its memories: `WS#{ws}#MEM…`, its admins curating) | DynamoDB (memory Get/BatchGet/Put/Update/Query — no delete, aggregates read), the stack's workspace-resolution managed policy and Cognito `AdminListGroupsForUser`/`AdminGetUser` (a platform admin's entry, live-checked), SQS memory-extract, S3 `memory-imports/*` read+put, Bedrock + Titan Embed V2 |
| `voc-agents-api` | `agents_handler.py` | `/agents/*` (incl. `/agents/plans*`, not admin-only), `/workflows/*` | DynamoDB (agents Get/Put/Update/Query, aggregates read), Step Functions start/stop on `voc-agent-run` only |
| `voc-mcp-global-api` | `mcp_global_handler.py` | `POST /mcp/global` (global MCP token) | DynamoDB projects `MCPGTOKEN` Get/Update, jobs audit Put; Cognito AdminGetUser/AdminListGroupsForUser; `lambda:InvokeFunction` on exactly Metrics/Settings/Memory/Projects/Agents/Engagement/Radar/FeedbackEdit/Integrations APIs |
| `voc-mcp-tokens-api` | `mcp_tokens_handler.py` | `/connect/tokens/*` (Cognito) | DynamoDB projects `MCPGTOKEN` Query/Get/Put/Update + `PROJECT#*` Get (pin check), jobs audit Query; voc-workspaces GetItem on `WS#*` (a mint inside a workspace pins it, with the minter's own membership: `lambda/shared/request_workspace.py` `elevate=False`) |
| `voc-engagement-api` | `engagement_handler.py` (routers in `shared/*_routes.py`) | `/participants/*`, `/feature-requests/*` (board authorizer: app + board pools), public `POST /unsubscribe` | DynamoDB participants + feature-requests RW, projects read, aggregates GetItem, KMS, `ses:SendEmail` (only with `-c emailFrom`, `ses:FromAddress` pinned), invoke itself (async send slices, no retries) |
| `voc-ballots-api` | `ballots_handler.py` | `/voting-sessions/*` (room votes on a Prioritization row; `GET .../config` and `POST .../submit` public) | DynamoDB aggregates Get/Put/Update, projects GetItem, KMS |
| `voc-radar-api` | `radar_handler.py` | `/radar`, `/radar/{proxy+}` (other brands, docs/radar.md) | DynamoDB radar Get/Query/Put/BatchGet, aggregates read, KMS, invoke the Radar scan worker |
| `voc-workspaces-api` | `workspaces_handler.py` (`lambda/shared/workspace.py`, `platform_workspaces.py`, `platform_admin.py`, `workspace_members.py`) | `GET`/`POST`/`PUT`/`DELETE /me/{proxy+}`: `GET /me/workspaces`, `GET /me/workspaces/current`, `GET`/`POST /me/workspaces/current/members` and `PUT`/`DELETE /me/workspaces/current/members/{sub}` (any member reads; workspace admins add, change roles and remove; a member may leave), `GET /me/workspaces/current/plugins` and `PUT /me/workspaces/current/plugins/{plugin_id}` (`workspace_plugin_settings.py`: any member reads, workspace admins turn a plugin of the deployment on or off, an enable puts `PLUGIN#{plugin}` / `WS#{ws}` and a disable deletes it, since 7.14.00; `PutItem` and `DeleteItem` on `PLUGIN#*`, `ENABLED_SOURCES` the ceiling); `GET`/`POST /platform/{proxy+}`: `GET /platform/workspaces`, `POST /platform/workspaces` (platform admins only, live check; docs/multi-workspace.md) | DynamoDB workspaces Query/GetItem, PutItem only where `dynamodb:LeadingKeys` matches `AUDIT#WS#*`, `PLUGIN#*`, `SLUG#*`, `USER#*`, `WORKSPACES` or `WS#*` (a workspace's creation and a member's add, and since 7.14.00 a plugin enabled, each one transaction of conditional puts, and the audit rows of an entry and a membership change; the audit-row guard names this role the table's audit writer), UpdateItem only on `WS#*` and `USER#*` and only the attribute `role` (`dynamodb:Attributes`; a member's role change), DeleteItem only on `PLUGIN#*`, `WS#*` and `USER#*` (a plugin disabled; a member's removal: the code deletes `MEMBER#` and `USER#` keys; IAM cannot pin the sort key), ConditionCheckItem only on `WS#*`; KMS; Cognito `AdminListGroupsForUser` + `AdminGetUser` on the user pool (the live platform-admin check), `ListUsers` + `AdminCreateUser` (adding a member: the email's account, or a new one); no Secrets Manager or SSM (decision 19, since 7.12.00: a workspace's credentials are SSM Parameter Store SecureStrings, one per plugin, made by their first save; `lib/utils/workspace-secrets.ts`); no other table |
| `voc-s3-import-api` | `s3_import_handler.py` | `/s3-import/*` (admin-only; incl. `POST /s3-import/reprocess`, `GET /s3-import/reprocess/{run_id}`) | S3 import bucket RW, KMS; with the `s3_import` plugin enabled (`lib/stacks/api-s3-import-lambda.ts`): `lambda:InvokeFunction` on exactly `voc-ingestor-s3_import` (by name, env `S3_IMPORT_INGESTOR_FUNCTION`) and aggregates Put/Get/UpdateItem + Query (the duplicate-run check, 409) pinned by `dynamodb:LeadingKeys` to `SOURCE_RUN#s3_import` (the reprocess run rows) |

Push notices (6.04.00, docs/realtime.md): `appsync:EventPublish` on exactly one namespace each, as VocCoreStack's
managed policy for that namespace (`RealtimeJobsPublishPolicy` / `RealtimeChatPublishPolicy` / `RealtimeRunsPublishPolicy`,
`lib/stacks/core-realtime.ts`) attached to the publisher's role in its own stack (`lib/utils/realtime.ts`
`grantRealtimePublish`), with `REALTIME_HTTP_DNS` (Core's Event API HTTP host, a stack reference) in the environment:
`jobs` for the projects, settings and scrapers roles (each shared with its assist twin, which publishes when an assist
job ends), `chat` for `voc-chat-stream` (a run's session notice), `runs` for `voc-agent-conductor` (VocProcessingStack;
run / plan status notices). Job ends (`shared/job_notices.py`, `{type: 'job', job_id, job_type, status, project_id?}`
to the starter's `/jobs/<sub>`) are published on `jobs` too: in VocApiStack by the four project job Lambdas
(`job_handler`) and `voc-manual-import-processor`; in VocProcessingStack by `voc-research-step`, `voc-category-reprocess`,
`voc-retention` (erase mode), `voc-memory-extractor` (page imports) and `voc-briefing` (a settled brief); in
VocIngestionStack by the `s3_import` ingestor (an API-started reprocess run; its manifest's
`infrastructure.ingestor.jobNotices` gives it a dedicated role `IngestorRoleS3Import`, so no other plugin may publish).

Assist twins (4.00.00, `lib/stacks/api-assist-workers.ts`): `voc-projects-assist`,
`voc-settings-assist`, `voc-scrapers-assist` run the SAME code, handler, role and env as their API
Lambda with a 15-minute timeout (async invoke, no retries, max event age 1 h, failure destination).
The API Lambda answers a model-backed route 202 + `job_id` and async-invokes its twin
(`ASSIST_WORKER_FUNCTION`); the handler's first line routes an assist event to
`lambda/shared/assist_jobs.py` `run`. No model call sits on a 29 s REST path except the one-shot
`POST /settings/model/test`. Routes and poll paths: structure.md → Scrapers → "Assist jobs".

Not behind API Gateway (Processing stack), memory + agents: `voc-memory-scanner`
(15 min) → SQS `voc-memory-extract` (+DLQ) → `voc-memory-extractor`; `voc-memory-retention`
(daily); `voc-agent-heartbeat` (15 min) → Step Functions `voc-agent-run` (24 h max). The state
machine is the runtime's own rendered definition (`lambda/agents/state_machine.asl.json`). It runs a
conductor loop, `voc-agent-conductor` (init / advance / fail), dispatching each workflow node to
`voc-agent-nodes`, or to `voc-agent-persona-panel` for `persona_review`. Handlers
are path-style (`memory/extractor/handler.lambda_handler`). The runtime reaches
project, feedback and memory data only by invoking `voc-projects-api` / `voc-metrics-api` /
`voc-memory-api` as the `agent:` principal (names from `lib/utils/function-names.ts`); a finished
run is queued to `voc-memory-extract` as an `agent_run` memory source. Settings also gains the
`voc/design-integrations` secret and `company-context/*` (docs/company-context.md); the stream
Lambda may now invoke eight domain APIs (+ memory, agents, users).

Plan mode (docs/assistant-plan-mode.md, docs/autonomous-agents.md → "Plans"): an approved
assistant plan runs on `voc-agent-run` too (input `{run_kind: 'plan', plan_id}`). The conductor's
`plan_decide` / `plan_prepare` / `plan_record` / `plan_fail` walk it; `plan_prepare` re-checks the
approver in Cognito (AdminGetUser/AdminListGroupsForUser) and forwards `admins` only for an
admin-only step; the state machine (≤ 3 in a Map) invokes `voc-plan-step` (Node, built from
`lambda/stream/src/plan-step/handler.ts`), which runs the step as the approver through the domain
APIs (`lambda:InvokeFunction` on exactly `PLAN_STEP_DELEGATES` — the stream's eight + integrations +
feedback edit — by name, aggregates GetItem/Query, feedback read for think steps, Bedrock allowlist,
no table writes; bundled like `voc-chat-stream`). Its answers carry `model_calls` and the executed
write's `fingerprint`. Waits read `SOURCE_RUN#…` / `SCRAPER_RUN#…` / jobs rows (the conductor's
aggregates + jobs GetItem). Plans are proposed in the ordinary chat run (`plan_catalogue`,
`plan_lookup`, then the `propose_plan` client tool, whose card is the plan card).

Not behind API Gateway (Processing stack): `voc-category-reprocess` —
`lambda/jobs/category_reprocess/handler.py`, async worker started by
`POST /settings/categories/reprocess` (the settings Lambda holds its name in
`CATEGORY_REPROCESS_FUNCTION` plus an invoke grant). Re-categorises stored
feedback in place, checkpointing and re-invoking itself before its 15-minute
timeout. A job started with `X-Workspace-Id` (since 7.13.00; `workspace_id` on its
event and row) replays only that workspace's `WS#{ws}#…` reviews, through the
workspace layer, with the workspace's own categories and dimensions. Permissions:
feedback Scan/GetItem/UpdateItem, aggregates GetItem/UpdateItem, raw-bucket read
(`raw/*` and one workspace's `ws/{ws}/raw/*`), PutObject on `silver/*` and one
workspace's `ws/{ws}/silver/*`, KMS, Bedrock, Comprehend, Translate, invoke itself.

Not behind API Gateway (Processing stack): `voc-retention` —
`lambda/jobs/retention/handler.py`, daily schedule (mode `retention`) + async
invoke from `POST /settings/erasure` (mode `erase`, env `RETENTION_FUNCTION` on
the settings Lambda). The ONLY role with a customer-data delete; does nothing
unless a source profile sets `retention_days` or an erasure is requested, each
with a legal basis (`shared/legal_basis.py`; `legal_basis` required on the
route, `retention_legal_basis` on a profile with a period). Every deleted item
first gets a tombstone (`AUDIT#tombstone#{source}` / `{feedback_id}`, no ttl).
Phases: `voc-feedback` items, `voc-radar` reviews (+ markers), whole-source
raw sweep, then lineage (artifacts in `voc-projects` citing an erased id lose
it and get `erased_evidence`). Whole-file uploads (`raw/csv_upload/*`,
`raw/json_upload/*`) are deleted only by a whole-source erasure of their source,
else listed as `files_needing_review`. A whole-source erasure (`field: 'source'`) scans by
`source_platform`, then sweeps `raw/{source}/` (every version), writing progress
to the job row. Permissions: feedback Get/Query/Scan/DeleteItem,
aggregates Get/Put/Update/Query + BatchGet (jobs, `AUDIT#retention`, tombstones one PutItem each; no BatchWrite, which would allow deletes),
radar Scan/DeleteItem + the `SETTINGS#radar` version bump, projects Scan/UpdateItem, workspaces Scan + UpdateItem
pinned to `WS#*` and the attributes `email` and `name` (since 6.11.00 an erasure by email without a source
de-identifies the person's `MEMBER#` rows, `lambda/jobs/retention/members.py`), raw bucket
`s3:DeleteObject`/`DeleteObjectVersion` on `raw/*`, `silver/*` and (since 7.03.00: an erasure by email and a
retention window reach a workspace's items, tombstoned `AUDIT#tombstone#{source}` / `{ws}#{feedback_id}`) each
workspace's `ws/{ws}/raw/*` and `ws/{ws}/silver/*` (one workspace id per pattern), `ListBucketVersions` on those
prefixes, and an explicit Deny of any delete under `ws/{ws}/raw/s3_import/*` (`DenyWorkspaceImportOriginalDeletes`,
`lib/stacks/retention-worker.ts`: import originals are listed for review), KMS,
invoke itself; an erasure job's end notice to its starter (6.04.00: VocCoreStack's `jobs` publish managed policy,
`appsync:EventPublish` on `jobs` only; docs/realtime.md). Ingestion-side Lambdas (plugins, webhooks, manual import,
feedback forms, data explorer) apply the source policy before archive/SQS and
hold `comprehend:DetectPiiEntities` (docs/source-policies.md).

**Benefits:**
- Each Lambda stays under 20KB policy limit
- Faster cold starts (smaller deployment packages)
- Independent scaling per endpoint type
- Easier to reason about permissions

### Code Style

```python
from aws_lambda_powertools import Logger, Tracer, Metrics

logger = Logger()
tracer = Tracer()
metrics = Metrics()

@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    pass
```

## Frontend (React)

### Stack

| Tool | Version | Purpose |
|------|---------|---------|
| React | ^19.3.1 | UI framework |
| Vite | ^8.3.5 | Build tool |
| Tailwind CSS | ^4.3.4 | Styling |
| Zustand | ^5.0.16 | State management (persisted) |
| TanStack Query | ^5.106.0 | Data fetching/caching |
| React Router | ^7.18.5 | Routing (react-router-dom) |
| Recharts | ^3.10.1 | Charts (Line, Bar, Pie) |
| Lucide React | ^1.68.0 | Icons |
| date-fns | ^4.4.0 | Date formatting |
| clsx | ^2.1.1 | Conditional classes |
| react-markdown | ^10.1.0 | Markdown rendering |
| remark-gfm | ^4.0.1 | GitHub Flavored Markdown |
| aws-amplify | ^6.22.2 | Cognito sign-in for the app user pool (`aws-amplify/auth`); the board pool uses plain Cognito calls (`services/boardAuth.ts`, `services/boardSession.ts`) |
| Zod | 4.6.7 | Runtime validation (frontend) |
| TypeScript | 6.0.3 | Type safety |
| Vitest | 5.1.0 | Testing framework (frontend) |

### Pages

The main pages (a selection: `frontend/src/pages/` has 28 page folders; the router is `src/routes.tsx`):

| Page | Route | Features |
|------|-------|----------|
| Login | `/login` | Cognito authentication |
| Home | `/` | Morning brief |
| Dashboard | `/dashboard` | Charts, metrics, social feed, urgent issues |
| Feedback Detail | `/feedback/:id` | Single item with similar feedback |
| Categories | `/categories` | Category breakdown, feedback list (All/search/urgent), filters |
| Problem Analysis | `/problems` | Problem analysis dashboard |
| Prioritization | `/prioritization` | Issue prioritization |
| AI Chat | `/chat` | Full-width view of the unified AI assistant: conversation sidebar (open conversations, which can run at the same time, plus saved history) beside the chat; also a floating bubble on every protected page |
| Projects | `/projects` | Research projects list |
| Project Detail | `/projects/:id` | Personas, PRDs, PR/FAQs (the AI assistant is page-aware here) |
| Data Explorer | `/data-explorer` | S3 raw data and DynamoDB browser |
| Data sources (code: `pages/Scrapers`) | `/scrapers` | Every feedback source: web scrapers, app/review pages, imports; CSS/JSON-LD selectors behind Advanced |
| Feedback Forms | `/feedback-forms` | Embeddable form management |
| Settings | `/admin` (`/settings` redirects) | Software settings in six tabs with section switches (`?tab=&section=`, old tab ids redirect): General, Sources, Taxonomy, Privacy & access, AI models, System (`?tab=system&section=version`: build version/commit/time + CHANGELOG). Privacy & access → Workspaces (`?tab=access&section=workspaces`) is the platform console, for platform admins only, with the deployment's default brand (a request without `X-Workspace-Id`, `fetchApi(…, 'deployment')`). Personal preferences live on `/account` (docs/account-vs-admin.md) |
| Members | `/members` (inside a workspace: `/w/{slug}/members`) | The current workspace's members: everyone reads; workspace admins add by email, change roles, remove; any member leaves (docs/multi-workspace.md). "Page not found" outside a workspace |
| Workspace settings (code: `pages/WorkspaceSettings`) | `/workspace-settings` (inside a workspace: `/w/{slug}/workspace-settings`) | The current workspace's brand (its admins save it, also outside `admins`; everyone else reads) and the plugins the deployment offers with whether the workspace enabled each (its admins get Enable and Disable; since 7.14.00 an enabled plugin runs in the workspace on its schedule and through Run now, docs/multi-workspace.md). "Page not found" outside a workspace |

Note: Each page is organized in its own folder under `frontend/src/pages/` with an index.tsx entry point.

Workspaces (6.12.00, docs/multi-workspace.md): inside a workspace every route above lives under `/w/{slug}/`
(the router's `basename`, read once at load by `src/workspace/workspacePath.ts`), so links stay written as
`/dashboard`; code that reads `window.location.pathname` compares `appPathname()` instead, and a plain `href` or a
copied link uses `pageHref()`. The signed-in routes pass through `WorkspaceGate` (picker, not-found, or the app;
with no workspace the app as before); the public routes do not. Since 6.13.00 the header's workspace menu opens
`/members` (and since 7.02.00 `/workspace-settings`), and a platform admin's Enter in the platform console records the workspace for the gate
(`src/workspace/platformEntry.ts`), which opens a workspace outside the caller's list only once
`GET /me/workspaces/current` answers it.

### Code Style

```typescript
import { useQuery } from '@tanstack/react-query'
import { api, getDaysFromRange } from '../api/client'
import { useConfigStore } from '../store/configStore'
import { useAuthStore } from '../store/authStore'
import type { FeedbackItem } from '../api/client'

export default function Dashboard() {
  const { timeRange, customDateRange, config } = useConfigStore()
  const { isAuthenticated } = useAuthStore()
  const days = getDaysFromRange(timeRange, customDateRange)

  const { data, isLoading } = useQuery({
    queryKey: ['summary', days],
    queryFn: () => api.getSummary(days),
    enabled: isAuthenticated && !!config.apiEndpoint,
  })
  
  if (!isAuthenticated) return <Navigate to="/login" />
  if (isLoading) return <Loading />
  
  return <div className="space-y-6">...</div>
}
```

## Common Commands

```bash
# CDK Infrastructure
cd voc-datalake
npm install && npm run build
npx cdk deploy --all

# Lambda Layers (build with Docker for ARM64)
./scripts/build-layers.sh

# Frontend
cd frontend
npm install
npm run dev    # Dev server at localhost:5173
npm run mock   # Mock API at localhost:3001

# Configuration Generation
npm run generate:config   # Generate plugin manifests + menu config
npm run generate:manifests  # Generate plugin manifests only
npm run generate:menu       # Generate menu config only
```

### Mock-only local dev notes

- Without Cognito configured, DEV builds treat the session as an admin
  (mirrors the ProtectedRoute/AdminRoute bypass; production fails closed) —
  Settings, Users tab, and the AI Models card are all reachable locally.
- The mock serves stateful fixtures for the full app surface, including
  project detail (`/projects/proj_1`), the Product tab (context, docs upload,
  report jobs), user admin, scrapers, and feedback forms.
  Several fixtures are deliberately sparse (legacy-shaped records) so the
  Zod boundary normalizers stay exercised in dev — don't "fix" them to be
  complete.
- Wire-shape rule: components never trust runtime data to match declared
  types. Every list/query boundary normalizes through a lenient Zod schema
  (`formSchema.ts`, `scrapersSchema.ts`, `categoriesSchema.ts` are the
  precedents), and crash-prone render sites carry belt-and-braces guards.
  Route-level errors are contained by `RouteErrorBoundary` (one bad page
  never blanks the app).
- **Every frontend API call must be mocked (gated).** When a feature adds or
  changes a `fetchApi(...)` call (or a raw `` fetch(`${getBaseUrl()}…`) `` of a
  public route), in the same change:
  1. Mock the route in the dev mock with the real handler's wire shape
     (envelope, field names, error statuses), stateful for the process
     lifetime. Small additions go in `mock-server.js`. A new domain gets its
     own `frontend/mock-<domain>.js`, wired in `handleDomainModules`. Domain
     modules claim only their own routes and get shared fixtures through
     `shared`; they never import back from `mock-server.js`. Unlike
     `mock-server.js`, `mock-*.js` files are linted.
  2. Add the call site to `frontend/mock-coverage.json` with a concrete probe
     (real fixture ids, a minimal valid body).
  3. Run `npm run check:mock`. It is a `validate.sh` step and part of
     `npm run check`. It fails when a call site has no entry, an entry is
     stale, or a probe gets the mock's generic `{"error":"Not found"}`, a 405
     or a 5xx.
  Then open the page against the mock (`npm run dev`) and make sure it shows
  data, not an empty state.

## Secrets Manager Structure

```json
{
  "webscraper_configs": "[]"
}
```

## Security & Cost Best Practices

- **Authentication**: Cognito User Pool with admins/users groups
- **API Protection**: per-method API Gateway throttling (`lib/stacks/api-gateway.ts`); no WAF by default (a fixed monthly cost); opt in with `-c enableWaf=true` (`lib/utils/waf.ts`, also on with `-c performanceTier=true`), recommended for production. IAM: no CDK grant wildcards (`lib/utils/exact-grants.ts`), per-function log grants (`lib/utils/lambda-log-grants.ts`), Claude grants in AWS's cross-Region shape (`lib/utils/claude-model-grant.ts`); exact DynamoDB writes per role,
  a delete only where the code deletes, operational deletes pinned by `dynamodb:LeadingKeys`
  (`lib/utils/table-write-grants.ts`, inventory `lib/customer-data-deletes.test.ts`); an explicit Deny on `AUDIT#*`
  rows for every writer but the named ones (`AUDIT_WRITERS` in `lib/utils/audit-row-guard.ts`); workspace deleters remove every S3 version
  on their own prefixes (`lib/utils/workspace-object-deletes.ts`); the processor and the aggregator have a role each
  (`lib/stacks/processing-roles.ts`); Cognito Plus is opt-in (`-c cognitoPlus=true`, `lib/utils/cognito-plus.ts`)
- **Encryption**: KMS at rest, TLS in transit
- **IAM**: Least-privilege per Lambda
- **Secrets**: Never hardcode; use Secrets Manager
- **DynamoDB**: On-demand billing, TTL for old data
- **S3**: Raw data archival, partitioned for cost-effective querying
- **Lambda**: ARM64 (Graviton), right-size memory, reserved concurrency
- **Bedrock**: resolve models via `shared/model_config.py` (never hardcode ids); batch when possible
- **Caching** (docs/caching.md): reads key on version counters (`shared/data_version.py`) bumped once per
  write batch; warm-container memo on metrics/Radar GETs; ETag/304 on API GETs, `no-store` for per-user
  live state (`http_cache.NO_STORE_PATTERNS`); SPA per-family query defaults (`api/queryPolicies.ts`) and
  `invalidateFeedbackData` after writes that move feedback
