# VoC Data Lake - Product Overview

Voice of the Customer (VoC) Data Lake is a **fully serverless** AWS platform for ingesting, processing, and analyzing customer feedback from multiple sources in near real-time.

## Core Capabilities

- **Multi-source feedback ingestion**: 
  - Review platforms: Trustpilot, Google Reviews
  - Social media: Twitter/X, Instagram, Facebook, Reddit
  - App stores: Apple App Store, Google Play Store, Huawei AppGallery
  - Web search: Tavily
  - Custom web scrapers: Configurable scrapers for any website
- **Webhook support**: Real-time ingestion via webhooks (Trustpilot service reviews)
- **LLM-powered analysis**: Amazon Bedrock (Claude 3 Haiku) for categorization, sentiment, persona inference, and root cause hypothesis
- **Visual pipeline builder**: Configure data processing steps with custom AI prompts
- **Multi-language support**: Auto-detection via Comprehend, translation via Amazon Translate
- **Real-time aggregation**: DynamoDB Streams trigger instant metric updates
- **REST API**: Query feedback and analytics via API Gateway + Lambda
- **React dashboard**: Visualization, filtering, drill-down, AI chat, and live social feed

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Feedback Item** | Single piece of customer feedback with source metadata, text, sentiment, category, urgency, persona |
| **Watermark** | Tracks ingestion state per source for incremental fetching (stored in DynamoDB) |
| **Aggregates** | Pre-computed metrics updated in real-time (daily totals, sentiment averages, category counts) |
| **Persona** | LLM-inferred customer archetype (e.g., "Price-Sensitive Shopper", "Loyal Customer") |
| **Pipeline** | Configurable data processing workflow with extract, transform, enrich, filter, and output steps |
| **Scraper** | Custom web scraper configuration with CSS selectors and scheduling |


## Data Flow

```
┌─────────────────┐     ┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│  External APIs  │────▶│  Ingestor   │────▶│   SQS Queue     │────▶│  Processor  │
│  Webhooks       │     │  Lambdas    │     │                 │     │   Lambda    │
│  Web Scrapers   │     │             │     │                 │     │             │
└─────────────────┘     └─────────────┘     └─────────────────┘     └──────┬──────┘
                              │                                            │
                              ▼                                            ▼
                        ┌─────────────┐                           ┌─────────────┐
                        │  DynamoDB   │                           │  DynamoDB   │
                        │ Watermarks  │                           │  Feedback   │
                        └─────────────┘                           └──────┬──────┘
                                                                         │ Streams
                                                                         ▼
                                                                  ┌─────────────┐
                                                                  │ Aggregator  │
                                                                  │   Lambda    │
                                                                  └──────┬──────┘
                                                                         │
                                                                         ▼
┌─────────────────┐     ┌─────────────┐     ┌─────────────────┐  ┌─────────────┐
│  React Frontend │◀────│ API Gateway │◀────│   API Lambda    │◀─│  DynamoDB   │
│  (Dashboard)    │     │             │     │                 │  │ Aggregates  │
└─────────────────┘     └─────────────┘     └─────────────────┘  └─────────────┘
```

## Frontend Pages

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/` | Overview with charts, metrics, live social feed, urgent issues |
| Feedback | `/feedback` | Filterable list of all feedback items |
| Categories | `/categories` | Category breakdown and analysis |
| AI Chat | `/chat` | Conversational interface for querying data |
| Pipelines | `/pipelines` | Visual pipeline builder for data processing |
| Scrapers | `/scrapers` | Configure custom web scrapers |
| Integrations | `/integrations` | Webhook URLs and API credential management |
| Settings | `/settings` | API endpoint, brand config, source settings |

## Serverless Architecture Benefits

- **Zero servers to manage**: All compute is Lambda-based
- **Pay-per-use**: DynamoDB on-demand, Lambda per-invocation
- **Auto-scaling**: Handles traffic spikes automatically
- **High availability**: Multi-AZ by default
- **Security**: KMS encryption, IAM least-privilege, Secrets Manager

## Use Cases

1. **Customer Experience Monitoring**: Track sentiment trends across channels
2. **Issue Detection**: Identify urgent problems requiring immediate attention
3. **Product Feedback Analysis**: Categorize and prioritize feature requests/complaints
4. **App Store Monitoring**: Track iOS, Android, and Huawei app reviews
5. **Competitive Intelligence**: Monitor brand mentions via web scraping
6. **Support Team Enablement**: Provide suggested responses for common issues
