# Voice of the Customer (VoC) Data Lake - CDK Infrastructure

This directory contains the AWS CDK infrastructure code for the VoC Data Lake platform. For project overview and features, see the [root README](../README.md).

## What's in This Directory

This is the main CDK application that deploys all AWS infrastructure for the VoC Data Lake platform.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              INGESTION LAYER                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │Trustpilot│  │  Google  │  │ Twitter  │  │   Meta   │  │  Reddit  │          │
│  │   API    │  │ Reviews  │  │  API v2  │  │Graph API │  │Data API  │          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
│       │             │             │             │             │                  │
│       ▼             ▼             ▼             ▼             ▼                  │
│  ┌─────────────────────────────────────────────────────────────────────┐        │
│  │              Lambda Ingestors (EventBridge scheduled)                │        │
│  └─────────────────────────────────────────────────────────────────────┘        │
│                                    │                                             │
│                                    ▼                                             │
│                          ┌─────────────────┐                                     │
│                          │   SQS Queue     │                                     │
│                          └─────────────────┘                                     │
│                                                                                  │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                             PROCESSING LAYER                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐        │
│  │                    Feedback Processor Lambda                         │        │
│  │                    (Triggered by SQS)                               │        │
│  └─────────────────────────────────────────────────────────────────────┘        │
│                    │              │              │                                │
│                    ▼              ▼              ▼                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                              │
│  │  Amazon     │  │   Amazon    │  │   Amazon    │                              │
│  │  Bedrock    │  │ Comprehend  │  │  Translate  │                              │
│  │ (Claude 3)  │  │ (Sentiment) │  │ (Multi-lang)│                              │
│  └─────────────┘  └─────────────┘  └─────────────┘                              │
│                                                                                  │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              STORAGE LAYER                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐        │
│  │                         DynamoDB Tables                              │        │
│  │                                                                      │        │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │        │
│  │  │ voc-feedback    │  │ voc-aggregates  │  │ voc-watermarks  │      │        │
│  │  │ (main data)     │  │ (metrics)       │  │ (state)         │      │        │
│  │  │                 │  │                 │  │                 │      │        │
│  │  │ GSI1: by-date   │  │                 │  │                 │      │        │
│  │  │ GSI2: by-cat    │  │                 │  │                 │      │        │
│  │  │ GSI3: by-urgent │  │                 │  │                 │      │        │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘      │        │
│  │                                                                      │        │
│  └─────────────────────────────────────────────────────────────────────┘        │
│                          │                                                       │
│                          ▼ DynamoDB Streams                                      │
│              ┌─────────────────────────────┐                                     │
│              │  Aggregation Lambda         │                                     │
│              │  (Real-time metrics update) │                                     │
│              └─────────────────────────────┘                                     │
│                                                                                  │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                             ANALYTICS LAYER                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐        │
│  │                      API Gateway REST API                            │        │
│  │                                                                      │        │
│  │  GET /feedback          - List feedback with filters                 │        │
│  │  GET /feedback/{id}     - Get single feedback item                   │        │
│  │  GET /feedback/urgent   - Get urgent items                           │        │
│  │  GET /metrics/summary   - Dashboard summary                          │        │
│  │  GET /metrics/sentiment - Sentiment breakdown                        │        │
│  │  GET /metrics/categories - Category breakdown                        │        │
│  │  GET /metrics/sources   - Source breakdown                           │        │
│  │  GET /metrics/personas  - Persona analysis                           │        │
│  │                                                                      │        │
│  └─────────────────────────────────────────────────────────────────────┘        │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Features

- **Fully Serverless**: No servers to manage - Lambda, DynamoDB, SQS, API Gateway
- **Multi-source ingestion**: Trustpilot, Google Reviews, Twitter/X, Instagram, Facebook, Reddit, Tavily
- **Near real-time**: Sub-second latency from processing to queryable
- **LLM-powered insights**: Category classification, persona inference via Amazon Bedrock
- **Multi-language support**: Auto-detection and translation via Amazon Translate
- **Real-time aggregates**: DynamoDB Streams for instant metric updates
- **REST API**: Query feedback and metrics via API Gateway
- **Cost-optimized**: Pay-per-request DynamoDB, reserved Lambda concurrency


## Quick Start

### Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 18+ and npm
- Python 3.12+ (for Lambda development)
- AWS CDK CLI (`npm install -g aws-cdk`)

### Installation

```bash
cd voc-datalake
npm install

# Build Lambda layers
cd lambda/layers/ingestion-deps/python
pip install -r ../requirements.txt -t .
cd ../../../processing-deps/python
pip install -r ../requirements.txt -t .
cd ../../../../
```

### Deployment

```bash
# Bootstrap CDK (first time only)
cdk bootstrap

# Deploy all stacks
cdk deploy --all \
  --context brandName="YourBrand" \
  --context brandHandles='["@yourbrand"]' \
  --context primaryLanguage="en"
```

### Configure API Credentials

After deployment, update the secrets in AWS Secrets Manager:

```bash
aws secretsmanager put-secret-value \
  --secret-id voc-datalake/api-credentials \
  --secret-string '{
    "trustpilot_api_key": "your-key",
    "trustpilot_api_secret": "your-secret",
    "trustpilot_business_unit_id": "your-bu-id",
    "google_api_key": "your-google-api-key",
    "google_location_ids": "loc1,loc2",
    "twitter_bearer_token": "your-bearer-token",
    "meta_access_token": "your-meta-token",
    "meta_page_id": "your-page-id",
    "meta_instagram_account_id": "your-ig-id",
    "reddit_client_id": "your-reddit-id",
    "reddit_client_secret": "your-reddit-secret",
    "tavily_api_key": "your-tavily-key"
  }'
```

## API Usage

### List Feedback
```bash
# Get recent feedback
curl "https://{api-id}.execute-api.{region}.amazonaws.com/v1/feedback?days=7"

# Filter by source
curl "https://{api-id}.execute-api.{region}.amazonaws.com/v1/feedback?source=twitter"

# Filter by category
curl "https://{api-id}.execute-api.{region}.amazonaws.com/v1/feedback?category=delivery"
```

### Get Urgent Items
```bash
curl "https://{api-id}.execute-api.{region}.amazonaws.com/v1/feedback/urgent"
```

### Get Metrics
```bash
# Dashboard summary
curl "https://{api-id}.execute-api.{region}.amazonaws.com/v1/metrics/summary?days=30"

# Sentiment breakdown
curl "https://{api-id}.execute-api.{region}.amazonaws.com/v1/metrics/sentiment?days=30"

# Category breakdown
curl "https://{api-id}.execute-api.{region}.amazonaws.com/v1/metrics/categories?days=30"

# Source breakdown
curl "https://{api-id}.execute-api.{region}.amazonaws.com/v1/metrics/sources?days=30"

# Persona analysis
curl "https://{api-id}.execute-api.{region}.amazonaws.com/v1/metrics/personas?days=30"
```

## DynamoDB Schema

### Feedback Table (voc-feedback)

| Key | Pattern | Description |
|-----|---------|-------------|
| PK | `SOURCE#{platform}` | Partition by source |
| SK | `FEEDBACK#{id}` | Unique feedback ID |
| GSI1PK | `DATE#{yyyy-mm-dd}` | Query by date |
| GSI1SK | `{timestamp}#{id}` | Sort by time |
| GSI2PK | `CATEGORY#{category}` | Query by category |
| GSI2SK | `{sentiment_score}#{timestamp}` | Sort by sentiment |
| GSI3PK | `URGENCY#{level}` | Query urgent items |
| GSI3SK | `{timestamp}` | Sort by time |

### Aggregates Table (voc-aggregates)

| Key | Pattern | Description |
|-----|---------|-------------|
| PK | `METRIC#{type}` | Metric type |
| SK | `{date}` | Date partition |

Metric types:
- `METRIC#daily_total` - Total feedback per day
- `METRIC#daily_source#{source}` - Feedback by source
- `METRIC#daily_category#{category}` - Feedback by category
- `METRIC#daily_sentiment#{label}` - Feedback by sentiment
- `METRIC#daily_sentiment_avg` - Running sentiment average
- `METRIC#urgent` - Urgent item count
- `METRIC#persona#{name}` - Feedback by persona

## Project Structure

```
voc-datalake/
├── bin/voc-datalake.ts           # CDK app entry point
├── lib/stacks/
│   ├── storage-stack.ts          # DynamoDB tables, KMS
│   ├── ingestion-stack.ts        # Lambda ingestors, EventBridge, SQS
│   ├── processing-stack.ts       # Processor Lambda, Bedrock
│   └── analytics-stack.ts        # API Gateway, API Lambda
├── lambda/
│   ├── ingestors/
│   │   ├── base_ingestor.py      # Common ingestion logic
│   │   ├── trustpilot/
│   │   ├── google_reviews/
│   │   ├── twitter/
│   │   ├── instagram/
│   │   ├── facebook/
│   │   ├── reddit/
│   │   └── tavily/
│   ├── processor/handler.py      # Main feedback processor
│   ├── aggregator/handler.py     # Real-time aggregation
│   ├── api/handler.py            # Analytics API
│   └── layers/
├── schemas/
│   └── feedback-event.schema.json
└── prompts/
    └── feedback-analysis-prompt.json
```

## CDK Stacks

The infrastructure is organized into multiple stacks for modularity:

### VocStorageStack
- **DynamoDB Tables**: feedback, aggregates, watermarks, pipelines, projects, jobs, conversations
- **KMS Key**: Customer-managed encryption key with rotation enabled
- **Indexes**: GSI1 (by-date), GSI2 (by-category), GSI3 (by-urgency)
- **Streams**: Enabled on feedback table for real-time aggregation

### VocIngestionStack
- **Lambda Ingestors**: 12 data source ingestors (Trustpilot, Yelp, Google Reviews, Twitter, Instagram, Facebook, Reddit, Tavily, Apple App Store, Google Play, Huawei AppGallery, Web Scraper)
- **EventBridge Rules**: Scheduled ingestion (1-30 min intervals)
- **SQS Queue**: Processing queue with DLQ for failed messages
- **Secrets Manager**: API credentials storage with rotation capability
- **Lambda Layers**: Shared dependencies (requests, beautifulsoup4, aws-lambda-powertools)

### VocProcessingStack
- **Processor Lambda**: Bedrock/Comprehend enrichment (1024 MB, 5 min timeout)
- **Aggregator Lambda**: DynamoDB Streams consumer for real-time metrics
- **IAM Permissions**: Bedrock InvokeModel, Comprehend DetectSentiment, Translate TranslateText

### VocAnalyticsStack
- **API Gateway**: REST API with CORS, throttling (100 req/s, 200 burst)
- **Metrics Lambda**: Read-only queries (/feedback/*, /metrics/*)
- **Ops Lambda**: CRUD operations (/pipelines/*, /integrations/*, /sources/*, /scrapers/*, /chat/*, /settings/*)
- **Projects Lambda**: Project management (/projects/*)
- **Chat Stream Lambda**: Function URL for streaming responses (bypasses API Gateway 29s timeout)
- **Webhook Lambda**: Trustpilot webhook receiver

### VocResearchStack
- **Step Functions**: Multi-step research workflow orchestration
- **Research Lambda**: Individual research steps (data gathering, analysis, synthesis)
- **IAM Permissions**: Bedrock streaming, DynamoDB read/write

### VocFrontendStack
- **S3 Bucket**: Static website hosting with versioning
- **CloudFront Distribution**: CDN with HTTPS, custom domain support
- **OAI**: Origin Access Identity for secure S3 access

## Cost Estimate (10K feedback/day)

| Service | Estimated Cost |
|---------|---------------|
| Lambda | ~$15-25/month |
| DynamoDB | ~$10-20/month |
| SQS | ~$1-2/month |
| API Gateway | ~$5-10/month |
| Bedrock (Claude Sonnet 4.5) | ~$150-200/month |
| Comprehend | ~$30-50/month |
| CloudFront | ~$5-10/month |
| S3 | ~$1-2/month |
| **Total** | **~$215-320/month** |

## Security Best Practices

- **Encryption at Rest**: All DynamoDB tables use customer-managed KMS key
- **Encryption in Transit**: TLS 1.2+ for all API calls
- **IAM Least Privilege**: Each Lambda has minimal required permissions
- **Secrets Management**: API credentials in Secrets Manager, never hardcoded
- **API Throttling**: Rate limiting on API Gateway (100 req/s)
- **Reserved Concurrency**: Lambda concurrency limits to prevent runaway costs
- **CloudWatch Logs**: 2-week retention for all Lambda functions
- **X-Ray Tracing**: Distributed tracing via Powertools

## Monitoring & Observability

### CloudWatch Dashboards
- Lambda invocations, errors, duration
- DynamoDB read/write capacity, throttles
- SQS queue depth, message age
- API Gateway requests, latency, errors

### Custom Metrics (via Powertools)
- Feedback items processed per source
- Bedrock API latency and errors
- Aggregation lag time
- Urgent items detected

### Alarms
- Lambda error rate > 5%
- DynamoDB throttling
- SQS DLQ messages > 0
- API Gateway 5xx errors > 1%

## Useful CDK Commands

```bash
# Synthesize CloudFormation templates
npm run build && cdk synth

# Show differences between deployed and local
cdk diff

# Deploy specific stack
cdk deploy VocStorageStack

# Deploy all stacks
cdk deploy --all

# Destroy all stacks (careful!)
cdk destroy --all

# List all stacks
cdk list
```

## Troubleshooting

### Lambda Layer Issues
If Lambda functions fail with import errors:
```bash
cd lambda/layers/ingestion-deps/python
pip install -r ../requirements.txt -t . --upgrade
```

### DynamoDB Throttling
If you see throttling errors, consider:
- Switching to provisioned capacity for predictable workloads
- Increasing on-demand capacity (auto-scales but has limits)
- Adding exponential backoff in Lambda code

### Bedrock Quota Limits
If Bedrock calls fail with throttling:
- Request quota increase in AWS Service Quotas
- Implement exponential backoff
- Consider batching requests

### API Gateway CORS Issues
If frontend can't call API:
- Verify CORS configuration in analytics-stack.ts
- Check CloudFront origin matches API Gateway URL
- Ensure OPTIONS preflight requests are handled

## License

Proprietary - All rights reserved


## Frontend Dashboard

A React-based dashboard for viewing and analyzing customer feedback.

### Features

- **Dashboard**: Overview with metrics, charts, and trends
- **Feedback Browser**: Filter and search through all feedback
- **Feedback Detail**: Deep dive into individual feedback with suggested responses
- **Categories**: Visual breakdown of issue categories with drill-down
- **AI Chat**: Natural language interface to query your data
- **Settings**: Configure API endpoint, brand info, and data sources

### Running the Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

### Building for Production

```bash
cd frontend
npm run build
```

The built files will be in `frontend/dist/`. You can deploy these to:
- Amazon S3 + CloudFront
- AWS Amplify
- Any static hosting service

### Configuration

1. Go to Settings in the dashboard
2. Enter your API Gateway endpoint URL
3. Configure your brand name and handles
4. Enable and configure data sources

### Screenshots

**Dashboard**
- Real-time metrics (total feedback, sentiment, urgent issues)
- Trend charts for volume and sentiment
- Category and source breakdowns
- Urgent issues requiring attention

**Feedback Browser**
- Filter by source, sentiment, category
- Search through feedback text
- Toggle urgent-only view
- Click to view details

**AI Chat**
- Ask questions in natural language
- Get insights about complaints, trends, sentiment
- View related feedback items
