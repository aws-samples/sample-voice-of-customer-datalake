# VoC Data Lake - Product Overview

Voice of the Customer (VoC) Data Lake is a **fully serverless** AWS platform for ingesting, processing, and analyzing customer feedback from multiple sources in near real-time.

## Core Capabilities

- **Multi-source feedback ingestion**: 
  - Custom web scrapers: Configurable scrapers for any website
  - Chrome Extension: Browser extension for scraping reviews from any page
  - Mobile App Reviews: Android (Google Play) and iOS (App Store) review ingestion
  - Manual Import: Direct data import via UI
  - S3 Import: Upload CSV/JSON/JSONL files to S3 for ingestion
  - Feedback Forms: Embeddable forms for direct customer feedback
- **Plugin architecture**: Modular data source connectors with manifest-based configuration and enable/disable via `cdk.context.json`
- **Menu configuration**: Enable/disable dashboard menu items via `cdk.context.json`
- **Webhook support**: Real-time ingestion via webhooks for plugins that support it
- **LLM-powered analysis**: Amazon Bedrock (Claude Sonnet 4.6 for quality, Haiku 4.5 for high-volume processing) for categorization, sentiment, persona inference, and root cause hypothesis
- **Multi-language support**: Auto-detection via Comprehend, translation via Amazon Translate
- **Real-time aggregation**: DynamoDB Streams trigger instant metric updates
- **REST API**: Query feedback and analytics via API Gateway + Lambda
- **React dashboard**: Visualization, filtering, drill-down, AI chat, and live social feed
- **Cognito authentication**: Secure user authentication with admin/viewer roles
- **Embeddable feedback forms**: Collect feedback directly from customers via configurable forms
- **MCP Server**: Model Context Protocol endpoint for tool-based access to feedback data
- **Multi-language UI**: Internationalized dashboard with i18next (English, German, Spanish, French)

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Feedback Item** | Single piece of customer feedback with source metadata, text, sentiment, category, urgency, persona |
| **Watermark** | Tracks ingestion state per source for incremental fetching (stored in DynamoDB) |
| **Aggregates** | Pre-computed metrics updated in real-time (daily totals, sentiment averages, category counts) |
| **Persona** | LLM-inferred customer archetype (e.g., "Price-Sensitive Shopper", "Loyal Customer") |
| **Scraper** | Custom web scraper configuration with CSS selectors and scheduling |
| **Raw Data** | Original ingested content stored in S3 with `s3_raw_uri` reference |
| **Project** | Research project containing personas, PRDs, and PR/FAQs generated from feedback |
| **Job** | Long-running async task (research, persona generation) tracked via Step Functions |
| **Conversation** | AI chat conversation history with messages and context |
| **Chrome Extension** | Browser extension for scraping and submitting reviews from any webpage |
| **MCP Server** | Model Context Protocol endpoint exposing feedback tools for AI assistants |
| **Feedback Form** | Embeddable form for collecting customer feedback directly |
| **Plugin** | Modular data source connector with manifest and handler |
| **Plugin Status** | Enable/disable plugins via `pluginStatus` in `cdk.context.json` |
| **Menu Status** | Enable/disable menu items via `menuStatus` in `cdk.context.json` |

## Data Flow

```
┌─────────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│  External APIs  │────▶│  Ingestor   │────▶│  S3 Raw     │────▶│   SQS Queue     │────▶│  Processor  │
│  Webhooks       │     │  Lambdas    │     │  Data Lake  │     │ (with S3 ref)   │     │   Lambda    │
│  Web Scrapers   │     │             │     │             │     │                 │     │             │
│  Feedback Forms │     │             │     │             │     │                 │     │             │
│  Chrome Ext.    │     │             │     │             │     │                 │     │             │
│  App Reviews    │     │             │     │             │     │                 │     │             │
└─────────────────┘     └─────────────┘     └─────────────┘     └─────────────────┘     └──────┬──────┘
                              │                                                                │
                              ▼                                                                ▼
                        ┌─────────────┐                                               ┌─────────────┐
                        │  DynamoDB   │                                               │  DynamoDB   │
                        │ Watermarks  │                                               │  Feedback   │
                        └─────────────┘                                               └──────┬──────┘
                                                                                             │ Streams
                                                                                             ▼
                                                                                      ┌─────────────┐
                                                                                      │ Aggregator  │
                                                                                      │   Lambda    │
                                                                                      └──────┬──────┘
                                                                                             │
                                                                                             ▼
┌─────────────────┐     ┌─────────────┐     ┌─────────────────┐                      ┌─────────────┐
│  React Frontend │◀────│ API Gateway │◀────│   API Lambdas   │◀─────────────────────│  DynamoDB   │
│  (Dashboard)    │     │ + Cognito   │     │  (domain-split) │                      │ Aggregates  │
└─────────────────┘     └─────────────┘     └─────────────────┘                      └─────────────┘
```

## Frontend Pages

| Page | Path | Description |
|------|------|-------------|
| Login | `/login` | Cognito authentication |
| Dashboard | `/` | Overview with charts, metrics, live social feed, urgent issues |
| Feedback | `/feedback` | Filterable list of all feedback items |
| Feedback Detail | `/feedback/:id` | Single feedback item with full details |
| Categories | `/categories` | Category breakdown and analysis |
| Problem Analysis | `/problems` | Problem analysis dashboard |
| Prioritization | `/prioritization` | Issue prioritization dashboard |
| AI Chat | `/chat` | Conversational interface for querying data |
| Projects | `/projects` | Research projects list |
| Project Detail | `/projects/:id` | Single project view with personas, PRDs, PR/FAQs |
| Data Explorer | `/data-explorer` | Browse S3 raw data and DynamoDB processed records |
| Scrapers | `/scrapers` | Configure custom web scrapers |
| Feedback Forms | `/feedback-forms` | Manage embeddable feedback forms |
| Settings | `/settings` | Brand config, integrations, user management |

Note: Each page is organized in its own folder under `frontend/src/pages/` with component files and tests.

## Serverless Architecture Benefits

- **Zero servers to manage**: All compute is Lambda-based
- **Pay-per-use**: DynamoDB on-demand, S3 storage, Lambda per-invocation
- **Auto-scaling**: Handles traffic spikes automatically
- **High availability**: Multi-AZ by default
- **Security**: KMS encryption, IAM least-privilege, Secrets Manager, Cognito auth, WAF protection
- **Data Lake**: S3 raw data archival with partitioned structure for analytics

## Use Cases

1. **Customer Experience Monitoring**: Track sentiment trends across channels
2. **Issue Detection**: Identify urgent problems requiring immediate attention
3. **Product Feedback Analysis**: Categorize and prioritize feature requests/complaints
4. **Web Scraping**: Monitor reviews and feedback from any website
5. **Support Team Enablement**: Provide suggested responses for common issues
6. **Direct Feedback Collection**: Embed forms in websites/apps to collect customer feedback
7. **Mobile App Review Monitoring**: Track Android and iOS app store reviews
8. **AI Assistant Integration**: Expose feedback data via MCP for AI-powered workflows
