# VoC Data Lake - Tech Stack & Best Practices

## Infrastructure (AWS CDK)

- **Language**: TypeScript
- **CDK Version**: 2.x (latest)
- **Runtime**: Node.js 18+
- **Entry Point**: `bin/voc-datalake.ts`

### AWS Services (All Serverless)

| Service | Purpose | Key Config |
|---------|---------|------------|
| **DynamoDB** | Processed data, streams | On-demand billing, KMS encryption, TTL |
| **S3** | Raw data lake | KMS encryption, partitioned by source/date |
| **Lambda** | Compute | Python 3.12, reserved concurrency, Powertools |
| **SQS** | Processing queue | DLQ, visibility timeout, batch processing |
| **API Gateway** | REST API | Throttling, CORS, stage deployment |
| **EventBridge** | Scheduled ingestion | Rate expressions (1-30 min) |
| **Secrets Manager** | API credentials | Auto-rotation capable |
| **KMS** | Encryption | Customer-managed key, key rotation |
| **Bedrock** | LLM inference | Claude Sonnet 4.5 (global inference profile) |
| **Comprehend** | NLP | Sentiment, language detection, key phrases |
| **Translate** | Multi-language | Auto language pair detection |
| **Step Functions** | Long-running jobs | Research workflows, persona generation |
| **CloudFront** | CDN | Frontend distribution |

## Data Sources

| Source | Type | Auth | Schedule |
|--------|------|------|----------|
| Trustpilot | API + Webhook | OAuth2 | 5 min + real-time |
| Google Reviews | API | API Key | 15 min |
| Twitter/X | API | Bearer Token | 1 min |
| Instagram | API | Meta Access Token | 5 min |
| Facebook | API | Meta Access Token | 5 min |
| Reddit | API | OAuth2 | 5 min |
| Tavily | API | API Key | 30 min |
| Apple App Store | RSS Feed | None | 15 min |
| Google Play Store | API | Service Account | 15 min |
| Huawei AppGallery | API | OAuth2 | 15 min |
| Yelp | API | API Key | 30 min |
| Web Scraper | HTTP | None | Configurable |

## Backend (Lambda - Python)

### Runtime & Libraries

- **Runtime**: Python 3.12
- **Core**: `aws-lambda-powertools` (logging, tracing, metrics, batch processing)
- **HTTP**: `requests`
- **Scraping**: `beautifulsoup4`, `lxml`
- **Pattern**: Base class inheritance for ingestors

### API Lambda Split (20KB IAM Policy Limit)

AWS Lambda execution roles have a **20KB policy size limit**. To stay under this limit, the API is split into focused, domain-specific Lambdas:

| Lambda | Handler | Routes | Permissions |
|--------|---------|--------|-------------|
| `voc-metrics-api` | `metrics_handler.py` | `/feedback/*`, `/metrics/*` | DynamoDB read (feedback, aggregates) |
| `voc-chat-api` | `chat_handler.py` | `/chat/*`, `/pipelines/*` | DynamoDB (feedback read, aggregates/pipelines/conversations RW), Bedrock |
| `voc-integrations-api` | `integrations_handler.py` | `/integrations/*`, `/sources/*` | Secrets Manager, EventBridge |
| `voc-scrapers-api` | `scrapers_handler.py` | `/scrapers/*` | Secrets Manager, Lambda invoke, Bedrock, DynamoDB (aggregates) |
| `voc-settings-api` | `settings_handler.py` | `/settings/*` | DynamoDB (aggregates), Bedrock |
| `voc-projects-api` | `projects_handler.py` | `/projects/*` | DynamoDB (projects, jobs, feedback), Step Functions, Bedrock |
| `voc-chat-stream` | `chat_stream_handler.py` | Function URL (streaming) | DynamoDB read, Bedrock streaming |
| `voc-s3-import-api` | `s3_import_handler.py` | `/s3-import/*` | S3 bucket only |
| `voc-webhook-trustpilot` | `handler.py` | `/webhooks/trustpilot` | DynamoDB, SQS |

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
| React | 19.2 | UI framework |
| Vite | 7.2 | Build tool |
| Tailwind CSS | 4.1 | Styling |
| Zustand | 5.0 | State management (persisted) |
| TanStack Query | 5.90 | Data fetching/caching |
| React Router | 7.9 | Routing |
| Recharts | 3.5 | Charts (Line, Bar, Pie) |
| Lucide React | 0.554 | Icons |
| date-fns | 4.1 | Date formatting |
| clsx | 2.1 | Conditional classes |
| react-markdown | 10.1 | Markdown rendering |
| jspdf + html2canvas | - | PDF export |

### Pages

| Page | Route | Features |
|------|-------|----------|
| Dashboard | `/` | Charts, metrics, social feed, urgent issues |
| Feedback | `/feedback` | Filterable list, search, pagination |
| Feedback Detail | `/feedback/:id` | Single item with similar feedback |
| Categories | `/categories` | Category breakdown and management |
| Problem Analysis | `/problems` | Problem analysis dashboard |
| AI Chat | `/chat` | Conversational data queries with streaming |
| Projects | `/projects` | Research projects list |
| Project Detail | `/projects/:id` | Personas, PRDs, PR/FAQs, project chat |
| Pipelines | `/pipelines` | Visual step builder, prompt editor |
| Scrapers | `/scrapers` | CSS/JSON-LD selector config, templates |
| Settings | `/settings` | API endpoint, brand config, integrations |

### Code Style

```typescript
import { useQuery } from '@tanstack/react-query'
import { api, getDaysFromRange } from '../api/client'
import { useConfigStore } from '../store/configStore'
import type { FeedbackItem } from '../api/client'

export default function Dashboard() {
  const { timeRange, customDateRange, config } = useConfigStore()
  const days = getDaysFromRange(timeRange, customDateRange)

  const { data, isLoading } = useQuery({
    queryKey: ['summary', days],
    queryFn: () => api.getSummary(days),
    enabled: !!config.apiEndpoint,
  })
  
  if (!config.apiEndpoint) return <ConfigurePrompt />
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

# Lambda Layers (before first deploy)
cd lambda/layers/ingestion-deps/python
pip install -r ../requirements.txt -t .

# Frontend
cd frontend
npm install
npm run dev    # Dev server at localhost:5173
npm run mock   # Mock API at localhost:3001
```

## Secrets Manager Structure

```json
{
  "trustpilot_api_key": "",
  "trustpilot_api_secret": "",
  "trustpilot_business_unit_id": "",
  "google_api_key": "",
  "twitter_bearer_token": "",
  "meta_access_token": "",
  "reddit_client_id": "",
  "reddit_client_secret": "",
  "tavily_api_key": "",
  "apple_app_id": "",
  "apple_country_codes": "us,gb,de",
  "google_play_package_name": "",
  "google_play_service_account": "",
  "huawei_client_id": "",
  "huawei_client_secret": "",
  "huawei_app_id": "",
  "webscraper_configs": "[]"
}
```

## Security & Cost Best Practices

- **Encryption**: KMS at rest, TLS in transit
- **IAM**: Least-privilege per Lambda
- **Secrets**: Never hardcode; use Secrets Manager
- **DynamoDB**: On-demand billing, TTL for old data
- **S3**: Raw data archival, partitioned for cost-effective querying
- **Lambda**: Right-size memory, reserved concurrency
- **Bedrock**: Use Claude Sonnet 4.5, batch when possible
