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
| **WAF** | API protection | Rate limiting, SQL injection, XSS protection |
| **EventBridge** | Scheduled ingestion | Rate expressions (1-30 min) |
| **Secrets Manager** | API credentials | Auto-rotation capable |
| **KMS** | Encryption | Customer-managed key, key rotation |
| **Bedrock** | LLM inference | Per-surface model picker (default Claude Sonnet 5; allowlist in `lib/utils/model-allowlist.ts`, resolution via `shared/model_config.py`) |
| **Comprehend** | NLP | Sentiment, language detection, key phrases |
| **Translate** | Multi-language | Auto language pair detection |
| **Step Functions** | Long-running jobs | Research workflows, persona generation |
| **CloudFront** | CDN | Frontend distribution, avatar images |

## Data Sources

| Source | Type | Auth | Schedule |
|--------|------|------|----------|
| Web Scraper | HTTP | None | Configurable |
| Feedback Forms | API | None (public) | Real-time |

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
| `voc-settings-api` | `settings_handler.py` | `/settings/*` | DynamoDB (aggregates), Bedrock |
| `voc-projects-api` | `projects_handler.py` | `/projects/*` | DynamoDB (projects, jobs, feedback), Step Functions, Bedrock, S3 |
| `voc-users-api` | `users_handler.py` | `/users/*` | Cognito admin |
| `voc-feedback-form-api` | `feedback_form_handler.py` | `/feedback-form/*`, `/feedback-forms/*` | DynamoDB (aggregates), SQS |
| `voc-chat-stream` | `lambda/stream` (TypeScript, esbuild-bundled) | `/chat/stream` SSE via API Gateway | DynamoDB read, Bedrock streaming |
| `voc-data-explorer-api` | `data_explorer_handler.py` | `/data-explorer/*` | S3, DynamoDB (feedback) |
| `voc-logs-api` | `logs_handler.py` | `/logs/*` | CloudWatch Logs read |
| `voc-manual-import-api` | `manual_import_handler.py` | `/manual-import/*` | DynamoDB, SQS, S3 |

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
| Feedback | `/feedback` | Filterable list, search, pagination |
| Feedback Detail | `/feedback/:id` | Single item with similar feedback |
| Categories | `/categories` | Category breakdown and management |
| Problem Analysis | `/problems` | Problem analysis dashboard |
| Prioritization | `/prioritization` | Issue prioritization |
| AI Chat | `/chat` | Conversational data queries with streaming |
| Projects | `/projects` | Research projects list |
| Project Detail | `/projects/:id` | Personas, PRDs, PR/FAQs, project chat |
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

## Secrets Manager Structure

```json
{
  "webscraper_configs": "[]"
}
```

## Security & Cost Best Practices

- **Authentication**: Cognito User Pool with admins/users groups
- **API Protection**: WAF with rate limiting, SQL injection, XSS protection
- **Encryption**: KMS at rest, TLS in transit
- **IAM**: Least-privilege per Lambda
- **Secrets**: Never hardcode; use Secrets Manager
- **DynamoDB**: On-demand billing, TTL for old data
- **S3**: Raw data archival, partitioned for cost-effective querying
- **Lambda**: ARM64 (Graviton), right-size memory, reserved concurrency
- **Bedrock**: resolve models via `shared/model_config.py` (never hardcode ids); batch when possible
