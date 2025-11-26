# VoC Data Lake - Project Structure

## Repository Layout

```
voc-datalake/
├── bin/
│   └── voc-datalake.ts           # CDK app entry point - defines all stacks
├── lib/stacks/                   # CDK stack definitions (TypeScript)
│   ├── storage-stack.ts          # DynamoDB tables (feedback, aggregates, watermarks, pipelines), KMS
│   ├── ingestion-stack.ts        # Ingestor Lambdas, EventBridge schedules, SQS, Secrets
│   ├── processing-stack.ts       # Processor Lambda, Bedrock/Comprehend integration
│   └── analytics-stack.ts        # API Gateway, API Lambda, Webhook Lambdas
├── lambda/                       # Python Lambda functions
│   ├── ingestors/
│   │   ├── base_ingestor.py      # Abstract base class - inherit for new sources
│   │   ├── trustpilot/handler.py
│   │   ├── twitter/handler.py
│   │   ├── google_reviews/handler.py
│   │   ├── instagram/handler.py
│   │   ├── facebook/handler.py
│   │   ├── reddit/handler.py
│   │   ├── tavily/handler.py
│   │   ├── appstore_apple/handler.py    # Apple App Store RSS
│   │   ├── appstore_google/handler.py   # Google Play Developer API
│   │   ├── appstore_huawei/handler.py   # Huawei AppGallery Connect API
│   │   └── webscraper/handler.py        # Configurable web scraper
│   ├── webhooks/
│   │   └── trustpilot/handler.py # Trustpilot webhook receiver
│   ├── processor/handler.py      # SQS consumer - Bedrock/Comprehend enrichment
│   ├── aggregator/handler.py     # DynamoDB Streams consumer - real-time metrics
│   ├── api/handler.py            # REST API endpoints (aws-lambda-powertools)
│   └── layers/
│       ├── ingestion-deps/       # Layer: requests, aws-lambda-powertools, beautifulsoup4
│       └── processing-deps/      # Layer: aws-lambda-powertools
├── frontend/                     # React dashboard (Vite + Tailwind)
│   ├── src/
│   │   ├── api/client.ts         # API client, types, fetch helpers
│   │   ├── components/
│   │   │   ├── Layout.tsx        # Main layout with sidebar navigation
│   │   │   ├── FeedbackCard.tsx  # Feedback item display (normal + compact)
│   │   │   ├── SocialFeed.tsx    # Live social media feed with filtering
│   │   │   ├── MetricCard.tsx    # Dashboard metric card
│   │   │   ├── SentimentBadge.tsx
│   │   │   └── TimeRangeSelector.tsx  # Date range picker with custom dates
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx     # Overview with charts and social feed
│   │   │   ├── Feedback.tsx      # Filterable feedback list
│   │   │   ├── FeedbackDetail.tsx
│   │   │   ├── Categories.tsx
│   │   │   ├── Chat.tsx          # AI chat interface
│   │   │   ├── Pipelines.tsx     # Visual pipeline builder
│   │   │   ├── Scrapers.tsx      # Web scraper configuration
│   │   │   ├── Integrations.tsx  # Webhook URLs and credentials
│   │   │   └── Settings.tsx      # Configuration
│   │   └── store/
│   │       └── configStore.ts    # Zustand state (config, time range, custom dates)
│   ├── package.json
│   └── vite.config.ts
├── schemas/
│   └── feedback-event.schema.json
├── prompts/
│   └── feedback-analysis-prompt.json
├── cdk.json
├── tsconfig.json
└── package.json
```


## DynamoDB Tables

| Table | PK | SK | Purpose |
|-------|----|----|---------|
| `voc-feedback` | `SOURCE#{platform}` | `FEEDBACK#{id}` | Main feedback storage with GSIs for date, category, urgency |
| `voc-aggregates` | `METRIC#{type}` | `{date}` | Pre-computed metrics |
| `voc-watermarks` | `{source}` | - | Ingestion state tracking |
| `voc-pipelines` | `{id}` | - | Pipeline configurations |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/feedback` | List feedback with filters (days, source, category, sentiment) |
| GET | `/feedback/{id}` | Get single feedback item |
| GET | `/feedback/urgent` | Get high-urgency items |
| GET | `/metrics/summary` | Dashboard summary metrics |
| GET | `/metrics/sentiment` | Sentiment breakdown |
| GET | `/metrics/categories` | Category breakdown |
| GET | `/metrics/sources` | Source breakdown |
| GET | `/metrics/personas` | Persona breakdown |
| POST | `/chat` | AI chat endpoint |
| GET | `/pipelines` | List pipelines |
| POST | `/pipelines` | Create pipeline |
| PUT | `/pipelines/{id}` | Update pipeline |
| DELETE | `/pipelines/{id}` | Delete pipeline |
| POST | `/pipelines/{id}/run` | Trigger pipeline |
| GET | `/integrations/status` | Integration status |
| PUT | `/integrations/{source}/credentials` | Update credentials |
| POST | `/integrations/{source}/test` | Test integration |
| POST | `/webhooks/trustpilot` | Trustpilot webhook receiver |

## Adding a New Data Source

1. Create `lambda/ingestors/{source}/handler.py`
2. Inherit from `BaseIngestor` in `base_ingestor.py`
3. Implement `fetch_new_items()` generator method
4. Add source config to `ingestion-stack.ts` (schedule, timeout)
5. Add credentials to Secrets Manager template
6. Update frontend Settings page with source fields

## CDK Stack Dependencies

```
VocStorageStack (DynamoDB tables, KMS)
       │
       ├──▶ VocIngestionStack (Ingestors, EventBridge, SQS, Secrets)
       │           │
       │           └──▶ VocProcessingStack (Processor, Aggregator)
       │
       └──▶ VocAnalyticsStack (API Gateway, API Lambda, Webhooks)
                    │
                    └── Depends on: processingQueue, secretsArn, pipelinesTable
```
