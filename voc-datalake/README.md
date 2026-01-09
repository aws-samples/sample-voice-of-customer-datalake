# Voice of the Customer (VoC) Data Lake - CDK Infrastructure

This directory contains the AWS CDK infrastructure code for the VoC Data Lake platform. For project overview and features, see the [root README](../README.md).

## What's in This Directory

This is the main CDK application that deploys all AWS infrastructure for the VoC Data Lake platform.

## Architecture Overview

For a complete architecture diagram, see the [root README](../README.md#-architecture).

### Data Flow

1. **Ingestion**: 16 Lambda ingestors fetch data from external APIs on EventBridge schedules (1-30 min)
2. **Queueing**: Raw feedback sent to SQS queue for decoupling and reliability
3. **Processing**: Processor Lambda enriches with Bedrock (Claude Sonnet 4.5), Comprehend, and Translate
4. **Storage**: Enriched feedback stored in DynamoDB with GSIs for efficient querying
5. **Aggregation**: DynamoDB Streams trigger Aggregator Lambda for real-time metrics
6. **Analytics**: API Gateway + Lambda provide REST API for querying data (Cognito authenticated)
7. **Presentation**: React SPA hosted on CloudFront + S3

## Features

- **Fully Serverless**: No servers to manage - Lambda, DynamoDB, SQS, API Gateway
- **Multi-source ingestion**: Trustpilot, Yelp, Google Reviews, Twitter/X, Instagram, Facebook, Reddit, LinkedIn, TikTok, YouTube, Tavily, App Stores, Web Scrapers
- **Near real-time**: Sub-second latency from processing to queryable
- **LLM-powered insights**: Category classification, persona inference via Amazon Bedrock
- **Multi-language support**: Auto-detection and translation via Amazon Translate
- **Real-time aggregates**: DynamoDB Streams for instant metric updates
- **REST API**: Query feedback and metrics via API Gateway (Cognito authenticated)
- **Secure**: Cognito authentication, WAF protection, KMS encryption
- **Cost-optimized**: Pay-per-request DynamoDB, ARM64 Lambda, reserved concurrency

## Quick Start

### Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 18+ and npm
- Python 3.12+ (for Lambda development)
- Docker (for building Lambda layers)
- AWS CDK CLI (`npm install -g aws-cdk`)

### Installation

```bash
cd voc-datalake
npm install

# Build Lambda layers (requires Docker for ARM64 compatibility)
./scripts/build-layers.sh
```

### Deployment

```bash
# Bootstrap CDK (first time only)
cdk bootstrap

# Deploy all stacks
cdk deploy --all \
  --context brandName="YourBrand" \
  --context frontendDomain="d1234567890.cloudfront.net"
```

### Create Initial Admin User

After deployment, create an admin user in Cognito:

```bash
# Get User Pool ID from CDK outputs
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name VocAuthStack \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' \
  --output text)

# Create admin user
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username admin@example.com \
  --user-attributes Name=email,Value=admin@example.com \
  --temporary-password 'TempPass123!'

# Add to admins group
aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username admin@example.com \
  --group-name admins
```

### Configure API Credentials

After deployment, update the secrets in AWS Secrets Manager. The secret name includes a deployment hash based on your account and region:

```bash
# Get the secret name from CloudFormation outputs
SECRET_NAME=$(aws cloudformation describe-stacks \
  --stack-name VocIngestionStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiSecretsArn`].OutputValue' \
  --output text | sed 's/.*secret://' | sed 's/-.*//')

# Or use the pattern: voc-datalake/api-credentials-{hash}
# where {hash} is derived from your AWS account ID and region

aws secretsmanager put-secret-value \
  --secret-id "${SECRET_NAME}" \
  --secret-string '{
    "trustpilot_api_key": "your-key",
    "trustpilot_api_secret": "your-secret",
    "trustpilot_business_unit_id": "your-bu-id",
    "google_api_key": "your-google-api-key",
    "twitter_bearer_token": "your-bearer-token",
    "meta_access_token": "your-meta-token",
    "reddit_client_id": "your-reddit-id",
    "reddit_client_secret": "your-reddit-secret",
    "linkedin_access_token": "your-linkedin-token",
    "tiktok_access_token": "your-tiktok-token",
    "youtube_api_key": "your-youtube-key",
    "tavily_api_key": "your-tavily-key",
    "yelp_api_key": "your-yelp-key"
  }'
```

## CDK Stacks

The infrastructure is organized into multiple stacks for modularity:

### VocStorageStack
- **DynamoDB Tables**: feedback, aggregates, watermarks, projects, jobs, conversations
- **S3 Bucket**: Raw data lake and persona avatars
- **KMS Key**: Customer-managed encryption key with rotation enabled
- **Indexes**: GSI1 (by-date), GSI2 (by-category), GSI3 (by-urgency)
- **Streams**: Enabled on feedback table for real-time aggregation

### VocAuthStack
- **Cognito User Pool**: User authentication
- **User Pool Client**: Frontend authentication
- **Groups**: admins, viewers
- **Custom Message Lambda**: Branded email templates

### VocIngestionStack
- **Lambda Ingestors**: 16 data source ingestors (Trustpilot, Yelp, Google Reviews, Twitter, Instagram, Facebook, Reddit, LinkedIn, TikTok, YouTube, Tavily, Apple App Store, Google Play, Huawei AppGallery, Web Scraper, S3 Import)
- **EventBridge Rules**: Scheduled ingestion (1-30 min intervals)
- **SQS Queue**: Processing queue with DLQ for failed messages
- **Secrets Manager**: API credentials storage with rotation capability
- **Lambda Layers**: Shared dependencies (requests, beautifulsoup4, aws-lambda-powertools)

### VocProcessingStack
- **Processor Lambda**: Bedrock/Comprehend enrichment (1024 MB, 5 min timeout)
- **Aggregator Lambda**: DynamoDB Streams consumer for real-time metrics
- **IAM Permissions**: Bedrock InvokeModel, Comprehend DetectSentiment, Translate TranslateText

### VocAnalyticsStack
- **API Gateway**: REST API with Cognito auth, CORS, throttling (100 req/s, 200 burst)
- **WAF WebACL**: Rate limiting, SQL injection, XSS protection
- **Domain-Isolated Lambdas** (12 total):
  - Metrics Lambda: `/feedback/*`, `/metrics/*`
  - Chat Lambda: `/chat/*`
  - Chat Stream Lambda: Function URL for streaming
  - Integrations Lambda: `/integrations/*`, `/sources/*`
  - Scrapers Lambda: `/scrapers/*`
  - Settings Lambda: `/settings/*`
  - Projects Lambda: `/projects/*`
  - Users Lambda: `/users/*`
  - Feedback Form Lambda: `/feedback-form/*`, `/feedback-forms/*`
  - S3 Import Lambda: `/s3-import/*`
  - Data Explorer Lambda: `/data-explorer/*`
- **Webhook Lambda**: Trustpilot webhook receiver

### VocResearchStack
- **Step Functions**: Multi-step research workflow orchestration
- **Research Lambda**: Individual research steps (data gathering, analysis, synthesis)
- **IAM Permissions**: Bedrock streaming, DynamoDB read/write

### VocFrontendStack
- **S3 Bucket**: Static website hosting with versioning
- **CloudFront Distribution**: CDN with HTTPS, custom domain support
- **OAI**: Origin Access Identity for secure S3 access

## Project Structure

```
voc-datalake/
├── bin/voc-datalake.ts           # CDK app entry point
├── lib/stacks/
│   ├── storage-stack.ts          # DynamoDB tables, S3, KMS
│   ├── auth-stack.ts             # Cognito User Pool
│   ├── ingestion-stack.ts        # Lambda ingestors, EventBridge, SQS
│   ├── processing-stack.ts       # Processor Lambda, Bedrock
│   ├── analytics-stack.ts        # API Gateway, API Lambdas, WAF
│   ├── research-stack.ts         # Step Functions
│   └── frontend-stack.ts         # CloudFront, S3
├── lambda/
│   ├── ingestors/
│   │   ├── base_ingestor.py      # Common ingestion logic
│   │   ├── trustpilot/
│   │   ├── yelp/
│   │   ├── google_reviews/
│   │   ├── twitter/
│   │   ├── instagram/
│   │   ├── facebook/
│   │   ├── reddit/
│   │   ├── linkedin/
│   │   ├── tiktok/
│   │   ├── youtube/
│   │   ├── tavily/
│   │   ├── appstore_apple/
│   │   ├── appstore_google/
│   │   ├── appstore_huawei/
│   │   ├── webscraper/
│   │   └── s3_import/
│   ├── processor/handler.py      # Main feedback processor
│   ├── aggregator/handler.py     # Real-time aggregation
│   ├── api/
│   │   ├── metrics_handler.py
│   │   ├── chat_handler.py
│   │   ├── chat_stream_handler.py
│   │   ├── integrations_handler.py
│   │   ├── scrapers_handler.py
│   │   ├── settings_handler.py
│   │   ├── projects_handler.py
│   │   ├── users_handler.py
│   │   ├── feedback_form_handler.py
│   │   ├── s3_import_handler.py
│   │   ├── data_explorer_handler.py
│   │   └── projects.py           # Shared business logic
│   ├── webhooks/trustpilot/
│   ├── research/
│   ├── shared/
│   │   ├── __init__.py
│   │   ├── aws.py
│   │   ├── http.py
│   │   ├── idempotency.py
│   │   └── logging.py
│   └── layers/
├── frontend/                     # React dashboard
├── schemas/
├── prompts/
├── docs/
│   └── default-scrapers.md       # Default scraper configurations
└── scripts/
    ├── build-layers.sh           # Build Lambda layers (Docker)
    ├── deploy.sh                 # Full deployment
    ├── deploy-frontend.sh        # Frontend only
    ├── test-api.sh               # API validation
    ├── backfill-aggregates.py    # Backfill aggregate metrics
    ├── backfill-metric-type.py   # Backfill metric types
    ├── clear-tables.py           # Clear DynamoDB tables
    └── delete_scraper_feedback.py # Delete scraper feedback
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

## Security Best Practices

- **Authentication**: Cognito User Pool with admin/viewer groups
- **API Protection**: WAF with rate limiting, SQL injection, XSS protection
- **Encryption at Rest**: All DynamoDB tables use customer-managed KMS key
- **Encryption in Transit**: TLS 1.2+ for all API calls
- **IAM Least Privilege**: Each Lambda has minimal required permissions (domain-isolated)
- **Secrets Management**: API credentials in Secrets Manager, never hardcoded
- **API Throttling**: Rate limiting on API Gateway (100 req/s)
- **Reserved Concurrency**: Lambda concurrency limits to prevent runaway costs
- **CloudWatch Logs**: 2-week retention for all Lambda functions
- **X-Ray Tracing**: Distributed tracing via Powertools

## Cost Estimate (10K feedback/day)

| Service | Estimated Cost |
|---------|---------------|
| Lambda | ~$15-25/month |
| DynamoDB | ~$10-20/month |
| SQS | ~$1-2/month |
| API Gateway | ~$5-10/month |
| Cognito | ~$5/month |
| WAF | ~$10/month |
| Bedrock (Claude Sonnet 4.5) | ~$150-200/month |
| Comprehend | ~$30-50/month |
| CloudFront | ~$5-10/month |
| S3 | ~$1-2/month |
| **Total** | **~$230-335/month** |

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
If Lambda functions fail with import errors, rebuild layers with Docker:
```bash
./scripts/build-layers.sh
```

### Cognito Authentication Issues
- Verify User Pool ID and Client ID in frontend config
- Check user is in correct group (admins/viewers)
- Ensure tokens are not expired

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
- Check Gateway Responses for 4XX/5XX include CORS headers

## Frontend Dashboard

A React-based dashboard for viewing and analyzing customer feedback.

### Features

- **Login**: Cognito authentication
- **Dashboard**: Overview with metrics, charts, and trends
- **Feedback Browser**: Filter and search through all feedback
- **Feedback Detail**: Deep dive into individual feedback with suggested responses
- **Categories**: Visual breakdown of issue categories with drill-down
- **Problem Analysis**: Problem analysis dashboard
- **Prioritization**: Issue prioritization
- **AI Chat**: Natural language interface to query your data (with streaming)
- **Projects**: Research projects with personas, PRDs, PR/FAQs
- **Scrapers**: Configure custom web scrapers
- **Feedback Forms**: Manage embeddable feedback forms
- **Settings**: Configure brand info, data sources, user management

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

The built files will be in `frontend/dist/` and are automatically deployed via CDK FrontendStack.

## License

Proprietary - All rights reserved
