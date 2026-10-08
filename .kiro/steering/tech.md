# VoC Data Lake - Tech Stack & Best Practices

## Infrastructure (AWS CDK)

- **Language**: TypeScript
- **CDK Version**: ^2.261.0 per `voc-datalake/package.json` (CLI pinned as devDependency, assembly schema 54+)
- **Runtime**: Node.js 18+
- **Entry Point**: `bin/voc-datalake.ts`

### AWS Services (All Serverless)

| Service | Purpose | Key Config |
|---------|---------|------------|
| **DynamoDB** | Processed data, streams | On-demand billing, KMS encryption, TTL |
| **S3** | Raw data lake, avatars | KMS encryption, partitioned by source/date |
| **Lambda** | Compute | Python 3.12, ARM64 (Graviton), Powertools |
| **SQS** | Processing queue | DLQ, visibility timeout, batch processing |
| **API Gateway** | REST API | Throttling, CORS, Cognito auth |
| **Cognito** | Authentication | User Pool, admins/users groups |
| **API Gateway throttling** | API protection | Per-method stage throttles (`lib/stacks/api-gateway.ts`); no WAF is deployed (cost decision) — add one for production |
| **EventBridge** | Scheduled ingestion | Rate expressions (1-30 min) |
| **Secrets Manager** | API credentials | Auto-rotation capable |
| **KMS** | Encryption | Customer-managed key, key rotation |
| **Bedrock** | LLM inference | Per-surface model picker (Claude 5.5 generation: Sonnet 5.5 for the AI assistant, documents, utilities, agent workers/personas; Opus 5.5 for prototypes and the agent conductor/reviewer; Haiku 5.5 for enrichment and memory; allowlist in `lib/utils/model-allowlist.ts`, resolution via `shared/model_config.py`); `-c inferenceScope=eu` maps `global.` → `eu.` profiles at call time (docs/eu-deployment.md) |
| **Comprehend** | NLP | Sentiment, language detection, key phrases; `DetectPiiEntities` for source-policy redaction (en/es, `PII_COMPREHEND=1`) |
| **Translate** | Multi-language | Auto language pair detection |
| **Step Functions** | Long-running jobs | Research workflows, persona generation |
| **CloudFront** | CDN | Frontend distribution, avatar images |

## Data Sources

| Source | Type | Auth | Schedule |
|--------|------|------|----------|
| Web Scraper | HTTP | None | Configurable |
| Feedback Forms | API | None (public) | Real-time |
| GitHub Issues (plugin, enabled; idle until configured) | GitHub REST + webhook | Read-only token + webhook secret in the plugin's Secrets Manager secret | 30 min (+ real-time webhook) |

## Backend (Lambda - Python)

### Runtime & Libraries

- **Runtime**: Python 3.12
- **Architecture**: ARM64 (Graviton) for better price/performance
- **Core**: `aws-lambda-powertools` (logging, tracing, metrics, batch processing)
- **HTTP**: `requests`
- **Scraping**: `beautifulsoup4`, `lxml`
- **Pattern**: Base class inheritance for ingestors

### API Lambda Split (20KB IAM Policy Limit)

AWS Lambda execution roles have a **20KB policy size limit**. To stay under this limit, the API is split into 15 focused, domain-specific Lambdas:

| Lambda | Handler | Routes | Permissions |
|--------|---------|--------|-------------|
| `voc-metrics-api` | `metrics_handler.py` | `/feedback/*`, `/metrics/*` | DynamoDB read (feedback, aggregates) |
| `voc-chat-api` | `chat_handler.py` | `/chat/*` | DynamoDB (feedback read, aggregates/conversations RW), Bedrock |
| `voc-integrations-api` | `integrations_handler.py` | `/integrations/*`, `/sources/*` | Secrets Manager, EventBridge |
| `voc-scrapers-api` | `scrapers_handler.py` | `/scrapers/*` | Secrets Manager, Lambda invoke, Bedrock, DynamoDB (aggregates) |
| `voc-settings-api` | `settings_handler.py` | `/settings/*` (incl. dimensions, sources, erasure, model test/capacity) | DynamoDB (aggregates), Bedrock, `servicequotas:ListServiceQuotas` (read-only), invoke `voc-category-reprocess` + `voc-retention` |
| `voc-projects-api` | `projects_handler.py` | `/projects/*` | DynamoDB (projects, jobs, feedback), Step Functions, Bedrock, S3 |
| `voc-users-api` | `users_handler.py` | `/users/*` | Cognito admin |
| `voc-feedback-form-api` | `feedback_form_handler.py` | `/feedback-forms/*` | DynamoDB (aggregates), SQS |
| `voc-chat-stream` | `lambda/stream` (TypeScript, esbuild-bundled) | `/chat/stream` — unified AI assistant, AG-UI 1.0 SSE via API Gateway | DynamoDB read (feedback, aggregates), Bedrock streaming, `lambda:InvokeFunction` on exactly ProjectsApi/MetricsApi/FeedbackFormApi/SettingsApi/ScrapersApi/MemoryApi/AgentsApi; conversations `GetItem`/`PutItem` (table ARN only) — its ONE write is the caller's own session, saved while a run streams (`assistant/session/`; partition `USER#{verified sub}` enforced in code, IAM cannot pin it); no projects-table access, no business-data writes |
| `voc-data-explorer-api` | `data_explorer_handler.py` | `/data-explorer/*` | S3, DynamoDB (feedback) |
| `voc-logs-api` | `logs_handler.py` | `/logs/*` | CloudWatch Logs read |
| `voc-manual-import-api` | `manual_import_handler.py` | `/manual-import/*` | DynamoDB, SQS, S3 |
| `voc-feedback-edit-api` | `feedback_edit_handler.py` | `PUT /feedback/{id}/category`, `PUT /feedback/{id}/dimensions` (correct a review's category / dimensions + tags) | DynamoDB (feedback RW, aggregates read) |
| `voc-memory-api` | `memory_handler.py` | `/memory`, `/memory/{proxy+}` | DynamoDB (memory Get/BatchGet/Put/Update/Query — no delete, aggregates read), SQS memory-extract, S3 `memory-imports/*` read+put, Bedrock + Titan Embed V2 |
| `voc-agents-api` | `agents_handler.py` | `/agents/*`, `/workflows/*` | DynamoDB (agents Get/Put/Update/Query, aggregates read), Step Functions start/stop on `voc-agent-run` only |
| `voc-mcp-global-api` | `mcp_global_handler.py` | `POST /mcp/global` (global MCP token) | DynamoDB projects `MCPGTOKEN` Get/Update, jobs audit Put; Cognito AdminGetUser/AdminListGroupsForUser; `lambda:InvokeFunction` on exactly Metrics/Settings/Memory/Projects/Agents APIs |
| `voc-mcp-tokens-api` | `mcp_tokens_handler.py` | `/connect/tokens/*` (Cognito) | DynamoDB projects `MCPGTOKEN` Query/Get/Put/Update + `PROJECT#*` Get (pin check), jobs audit Query |

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
Lambda may now invoke seven domain APIs (+ memory, agents).

Not behind API Gateway (Processing stack): `voc-category-reprocess` —
`lambda/jobs/category_reprocess/handler.py`, async worker started by
`POST /settings/categories/reprocess` (the settings Lambda holds its name in
`CATEGORY_REPROCESS_FUNCTION` plus an invoke grant). Re-categorises stored
feedback in place, checkpointing and re-invoking itself before its 15-minute
timeout. Permissions: feedback Scan/GetItem/UpdateItem, aggregates
Get/Put/Update/Query, raw-bucket read (`raw/*`), KMS, Bedrock, Comprehend,
Translate, invoke itself.

Not behind API Gateway (Processing stack): `voc-retention` —
`lambda/jobs/retention/handler.py`, daily schedule (mode `retention`) + async
invoke from `POST /settings/erasure` (mode `erase`, env `RETENTION_FUNCTION` on
the settings Lambda). The ONLY role with a customer-data delete; does nothing
unless a source profile sets `retention_days` or an erasure is requested; never
touches `raw/csv_upload/*`. Permissions: feedback Get/Query/Scan/DeleteItem,
aggregates Get/Put/Update/Query (jobs, `AUDIT#retention`), raw bucket
`s3:DeleteObject`/`DeleteObjectVersion` on `raw/*` + `ListBucketVersions`, KMS,
invoke itself. Ingestion-side Lambdas (plugins, webhooks, manual import,
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
| React | ^19.2.0 | UI framework |
| Vite | ^7.2.4 | Build tool |
| Tailwind CSS | ^4.1.17 | Styling |
| Zustand | ^5.0.8 | State management (persisted) |
| TanStack Query | ^5.90.10 | Data fetching/caching |
| React Router | ^7.9.6 | Routing (react-router-dom) |
| Recharts | ^3.5.0 | Charts (Line, Bar, Pie) |
| Lucide React | ^0.554.0 | Icons |
| date-fns | ^4.1.0 | Date formatting |
| clsx | ^2.1.1 | Conditional classes |
| react-markdown | ^10.1.0 | Markdown rendering |
| remark-gfm | ^4.0.1 | GitHub Flavored Markdown |
| amazon-cognito-identity-js | ^6.3.12 | Cognito authentication |
| Zod | ^4.3.5 | Runtime validation (frontend) |
| TypeScript | ~5.9.3 | Type safety |
| Vitest | ^3.2.3 | Testing framework (frontend) |

### Pages

| Page | Route | Features |
|------|-------|----------|
| Login | `/login` | Cognito authentication |
| Dashboard | `/` | Charts, metrics, social feed, urgent issues |
| Feedback Detail | `/feedback/:id` | Single item with similar feedback |
| Categories | `/categories` | Category breakdown, feedback list (All/search/urgent), filters |
| Problem Analysis | `/problems` | Problem analysis dashboard |
| Prioritization | `/prioritization` | Issue prioritization |
| AI Chat | `/chat` | Full-width view of the unified AI assistant: conversation sidebar (open conversations, which can run at the same time, plus saved history) beside the chat; also a floating bubble on every protected page |
| Projects | `/projects` | Research projects list |
| Project Detail | `/projects/:id` | Personas, PRDs, PR/FAQs (the AI assistant is page-aware here) |
| Data Explorer | `/data-explorer` | S3 raw data and DynamoDB browser |
| Scrapers | `/scrapers` | CSS/JSON-LD selector config, templates |
| Feedback Forms | `/feedback-forms` | Embeddable form management |
| Settings | `/settings` | Brand config, integrations, user admin |

Note: Each page is organized in its own folder under `frontend/src/pages/` with an index.tsx entry point.

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
  project detail (`/projects/proj_1`), the Product tab (context, interview,
  docs upload, report jobs), user admin, scrapers, and feedback forms.
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
  changes a `fetchApi(...)` call, in the same change:
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
- **API Protection**: per-method API Gateway throttling (`lib/stacks/api-gateway.ts`); no WAF is deployed (cost decision) — a WAF is recommended for production
- **Encryption**: KMS at rest, TLS in transit
- **IAM**: Least-privilege per Lambda
- **Secrets**: Never hardcode; use Secrets Manager
- **DynamoDB**: On-demand billing, TTL for old data
- **S3**: Raw data archival, partitioned for cost-effective querying
- **Lambda**: ARM64 (Graviton), right-size memory, reserved concurrency
- **Bedrock**: resolve models via `shared/model_config.py` (never hardcode ids); batch when possible
