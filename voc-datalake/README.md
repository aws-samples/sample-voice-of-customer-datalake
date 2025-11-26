# Voice of the Customer (VoC) Data Lake

A fully serverless, near real-time AWS data lake for ingesting, processing, and analyzing customer feedback from multiple sources using DynamoDB, Lambda, and API Gateway.

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

## Cost Estimate (10K feedback/day)

| Service | Estimated Cost |
|---------|---------------|
| Lambda | ~$15-25/month |
| DynamoDB | ~$10-20/month |
| SQS | ~$1-2/month |
| API Gateway | ~$5-10/month |
| Bedrock (Claude Sonnect 4.5) | ~$150-200/month |
| Comprehend | ~$30-50/month |
| **Total** | **~$210-305/month** |

## Security

- All DynamoDB tables encrypted with customer-managed KMS key
- API credentials stored in Secrets Manager
- IAM roles follow least-privilege principle
- API Gateway with throttling enabled
- Lambda reserved concurrency to prevent runaway costs

## License

MIT License


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
