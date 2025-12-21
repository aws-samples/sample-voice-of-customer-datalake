# VoC Data Lake - Project Structure

## Repository Layout

```
voc-datalake/
├── bin/
│   └── voc-datalake.ts           # CDK app entry point - defines all stacks
├── lib/stacks/                   # CDK stack definitions (TypeScript)
│   ├── storage-stack.ts          # DynamoDB tables, S3 raw data bucket, KMS
│   ├── auth-stack.ts             # Cognito User Pool, groups, client
│   ├── ingestion-stack.ts        # Ingestor Lambdas, EventBridge schedules, SQS, Secrets
│   ├── processing-stack.ts       # Processor Lambda, Bedrock/Comprehend integration
│   ├── analytics-stack.ts        # API Gateway, split API Lambdas (20KB policy limit), Webhooks, WAF
│   ├── research-stack.ts         # Step Functions for long-running research jobs
│   └── frontend-stack.ts         # S3 + CloudFront for React dashboard
├── lambda/                       # Python Lambda functions
│   ├── ingestors/
│   │   ├── base_ingestor.py      # Abstract base class - inherit for new sources
│   │   ├── trustpilot/handler.py
│   │   ├── twitter/handler.py
│   │   ├── google_reviews/handler.py
│   │   ├── instagram/handler.py
│   │   ├── facebook/handler.py
│   │   ├── reddit/handler.py
│   │   ├── linkedin/handler.py
│   │   ├── tiktok/handler.py
│   │   ├── youtube/handler.py
│   │   ├── tavily/handler.py
│   │   ├── appstore_apple/handler.py    # Apple App Store RSS
│   │   ├── appstore_google/handler.py   # Google Play Developer API
│   │   ├── appstore_huawei/handler.py   # Huawei AppGallery Connect API
│   │   ├── webscraper/handler.py        # Configurable web scraper
│   │   ├── yelp/handler.py              # Yelp Fusion API
│   │   └── s3_import/handler.py         # S3 bulk import
│   ├── webhooks/
│   │   └── trustpilot/handler.py # Trustpilot webhook receiver
│   ├── processor/handler.py      # SQS consumer - Bedrock/Comprehend enrichment
│   ├── aggregator/handler.py     # DynamoDB Streams consumer - real-time metrics
│   ├── research/
│   │   └── research_step_handler.py  # Step Functions task handler
│   ├── shared/                   # Shared utilities across Lambdas
│   │   ├── __init__.py
│   │   ├── aws.py                # AWS client helpers
│   │   ├── http.py               # HTTP utilities
│   │   ├── idempotency.py        # Idempotency helpers
│   │   └── logging.py            # Logging utilities
│   ├── api/                      # Split into domain-specific Lambdas (20KB IAM policy limit)
│   │   ├── metrics_handler.py        # /feedback/*, /metrics/* (read-only queries)
│   │   ├── chat_handler.py           # /chat/* (conversations)
│   │   ├── chat_stream_handler.py    # Streaming chat (Lambda Function URL)
│   │   ├── integrations_handler.py   # /integrations/*, /sources/* (credentials, schedules)
│   │   ├── scrapers_handler.py       # /scrapers/* (web scraper management)
│   │   ├── settings_handler.py       # /settings/* (brand, categories config)
│   │   ├── projects_handler.py       # /projects/* (research projects, personas)
│   │   ├── users_handler.py          # /users/* (Cognito user administration)
│   │   ├── feedback_form_handler.py  # /feedback-form/*, /feedback-forms/* (embeddable forms)
│   │   ├── s3_import_handler.py      # /s3-import/* (file explorer)
│   │   ├── data_explorer_handler.py  # /data-explorer/* (S3 raw data browser)
│   │   └── projects.py               # Projects business logic (shared)
│   └── layers/
│       ├── ingestion-deps/       # Layer: requests, aws-lambda-powertools, beautifulsoup4
│       └── processing-deps/      # Layer: aws-lambda-powertools
├── frontend/                     # React dashboard (Vite + Tailwind)
│   ├── src/
│   │   ├── api/client.ts         # API client, types, fetch helpers
│   │   ├── services/auth.ts      # Cognito authentication service
│   │   ├── components/
│   │   │   ├── Layout.tsx            # Main layout with sidebar navigation
│   │   │   ├── ProtectedRoute.tsx    # Auth-protected route wrapper
│   │   │   ├── FeedbackCard.tsx      # Feedback item display (normal + compact)
│   │   │   ├── FeedbackCarousel.tsx  # Carousel for feedback items
│   │   │   ├── SocialFeed.tsx        # Live social media feed with filtering
│   │   │   ├── MetricCard.tsx        # Dashboard metric card
│   │   │   ├── SentimentBadge.tsx
│   │   │   ├── TimeRangeSelector.tsx # Date range picker with custom dates
│   │   │   ├── Breadcrumbs.tsx       # Navigation breadcrumbs
│   │   │   ├── CategoriesManager.tsx # Category management UI
│   │   │   ├── ChatMessage.tsx       # Chat message component
│   │   │   ├── ChatSidebar.tsx       # Chat conversation sidebar
│   │   │   ├── ChatFilters.tsx       # Chat filter controls
│   │   │   ├── ChatExportMenu.tsx    # Export chat conversations
│   │   │   ├── DataSourceWizard.tsx  # Data source setup wizard
│   │   │   ├── DocumentExportMenu.tsx # Export documents
│   │   │   ├── PersonaExportMenu.tsx # Export personas
│   │   │   ├── FeedbackFormConfig.tsx # Feedback form configuration
│   │   │   ├── S3ImportExplorer.tsx  # S3 file browser
│   │   │   ├── UserAdmin.tsx         # User administration
│   │   │   ├── UserProfileModal.tsx  # User profile modal
│   │   │   └── ConfirmModal.tsx      # Confirmation dialog
│   │   ├── pages/
│   │   │   ├── Login.tsx         # Cognito login page
│   │   │   ├── Dashboard.tsx     # Overview with charts and social feed
│   │   │   ├── Feedback.tsx      # Filterable feedback list
│   │   │   ├── FeedbackDetail.tsx
│   │   │   ├── Categories.tsx    # Category breakdown and analysis
│   │   │   ├── ProblemAnalysis.tsx # Problem analysis dashboard
│   │   │   ├── Prioritization.tsx # Issue prioritization
│   │   │   ├── Chat.tsx          # AI chat interface
│   │   │   ├── DataExplorer.tsx  # S3 raw data and DynamoDB browser
│   │   │   ├── Scrapers.tsx      # Web scraper configuration
│   │   │   ├── FeedbackForms.tsx # Feedback form management
│   │   │   ├── Settings.tsx      # Configuration and integrations
│   │   │   ├── Projects.tsx      # Research projects list
│   │   │   └── ProjectDetail.tsx # Single project view
│   │   ├── store/
│   │   │   ├── configStore.ts    # Zustand state (config, time range, custom dates)
│   │   │   ├── chatStore.ts      # Chat conversation state
│   │   │   └── authStore.ts      # Authentication state
│   │   ├── constants/
│   │   │   └── filters.ts        # Filter constants and options
│   │   └── config.ts             # Runtime configuration
│   ├── package.json
│   └── vite.config.ts
├── schemas/
│   └── feedback-event.schema.json
├── prompts/
│   └── feedback-analysis-prompt.json
├── scripts/
│   ├── build-layers.sh           # Build Lambda layers with Docker (ARM64)
│   ├── deploy.sh                 # Full deployment script
│   ├── deploy-frontend.sh        # Frontend-only deployment
│   ├── test-api.sh               # API validation script
│   ├── backfill-aggregates.py    # Backfill aggregate metrics
│   ├── backfill-metric-type.py   # Backfill metric types
│   ├── backfill-scraper-sources.py # Backfill scraper sources
│   ├── clear-tables.py           # Clear DynamoDB tables
│   └── delete_scraper_feedback.py # Delete scraper feedback
├── docs/
│   └── default-scrapers.md       # Default scraper configurations
├── cdk.json
├── tsconfig.json
└── package.json
```

## Storage

### S3 Raw Data Lake

| Bucket | Structure | Purpose |
|--------|-----------|---------|
| `voc-raw-data-{account}-{region}` | `raw/{source}/{year}/{month}/{day}/{id}.json` | Raw scraped/ingested data archival |
| `voc-raw-data-{account}-{region}` | `avatars/{project_id}/{persona_id}.png` | AI-generated persona avatars |

### DynamoDB Tables

| Table | PK | SK | Purpose |
|-------|----|----|---------|
| `voc-feedback` | `SOURCE#{platform}` | `FEEDBACK#{id}` | Processed feedback with GSIs for date, category, urgency |
| `voc-aggregates` | `METRIC#{type}` | `{date}` | Pre-computed metrics, brand config, form configs |
| `voc-watermarks` | `{source}` | - | Ingestion state tracking |
| `voc-projects` | `PROJECT#{id}` | `META\|PERSONA#{id}\|PRD#{id}\|PRFAQ#{id}` | Projects with personas, PRDs, PR/FAQs |
| `voc-jobs` | `PROJECT#{id}` | `JOB#{id}` | Long-running async jobs (research, persona generation) |
| `voc-conversations` | `USER#{id}` | `CONV#{id}` | AI chat conversation history |

## API Endpoints

### Metrics (metrics_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/feedback` | List feedback with filters (days, source, category, sentiment) |
| GET | `/feedback/{id}` | Get single feedback item |
| GET | `/feedback/{id}/similar` | Get similar feedback items |
| GET | `/feedback/urgent` | Get high-urgency items |
| GET | `/feedback/entities` | Get keywords, categories, issues for filters |
| GET | `/metrics/summary` | Dashboard summary metrics |
| GET | `/metrics/sentiment` | Sentiment breakdown |
| GET | `/metrics/categories` | Category breakdown |
| GET | `/metrics/sources` | Source breakdown |
| GET | `/metrics/personas` | Persona breakdown |

### Chat (chat_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/chat` | AI chat endpoint |
| GET | `/chat/conversations` | List conversations |
| GET | `/chat/conversations/{id}` | Get conversation |
| DELETE | `/chat/conversations/{id}` | Delete conversation |

### Integrations (integrations_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/integrations/status` | Integration status |
| PUT | `/integrations/{source}/credentials` | Update credentials |
| POST | `/integrations/{source}/test` | Test integration |
| GET | `/sources/status` | Source schedule status |
| PUT | `/sources/{source}/enable` | Enable source |
| PUT | `/sources/{source}/disable` | Disable source |

### Scrapers (scrapers_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/scrapers` | List scraper configs |
| POST | `/scrapers` | Save scraper config |
| DELETE | `/scrapers/{id}` | Delete scraper |
| GET | `/scrapers/templates` | Get scraper templates |
| POST | `/scrapers/{id}/run` | Trigger scraper run |

### Settings (settings_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/settings/brand` | Get brand configuration |
| PUT | `/settings/brand` | Save brand configuration |
| GET | `/settings/categories` | Get category configuration |
| PUT | `/settings/categories` | Save category configuration |
| POST | `/settings/categories/generate` | AI-generate categories |

### Users (users_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/users` | List Cognito users |
| POST | `/users` | Create user |
| PUT | `/users/{username}` | Update user |
| DELETE | `/users/{username}` | Delete user |
| POST | `/users/{username}/reset-password` | Reset password |

### Feedback Forms (feedback_form_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/feedback-form/config` | Get form config (public) |
| PUT | `/feedback-form/config` | Update form config |
| POST | `/feedback-form/submit` | Submit feedback (public) |
| GET | `/feedback-form/embed` | Get embed code |
| GET | `/feedback-forms` | List all forms |
| POST | `/feedback-forms` | Create form |
| GET | `/feedback-forms/{id}` | Get form (public) |
| PUT | `/feedback-forms/{id}` | Update form |
| DELETE | `/feedback-forms/{id}` | Delete form |

### Projects (projects_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/projects` | List projects |
| POST | `/projects` | Create project |
| GET | `/projects/{id}` | Get project with personas/documents |
| PUT | `/projects/{id}` | Update project |
| DELETE | `/projects/{id}` | Delete project |
| POST | `/projects/{id}/personas/generate` | Generate personas from feedback |
| POST | `/projects/{id}/research` | Run research job (Step Functions) |
| POST | `/projects/{id}/chat` | Project-scoped chat |

### Webhooks
| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhooks/trustpilot` | Trustpilot webhook receiver (public) |

### S3 Import (s3_import_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/s3-import/files` | List files in S3 |
| GET | `/s3-import/sources` | List import sources |
| POST | `/s3-import/sources` | Create import source |
| POST | `/s3-import/upload-url` | Get presigned upload URL |
| DELETE | `/s3-import/file/{key}` | Delete file |

### Data Explorer (data_explorer_handler.py)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/data-explorer/s3` | Browse S3 raw data bucket with folder navigation |
| GET | `/data-explorer/s3/preview` | Preview JSON file content from S3 |
| PUT | `/data-explorer/s3` | Create or update S3 file (with optional DynamoDB sync) |
| DELETE | `/data-explorer/s3` | Delete S3 file |
| PUT | `/data-explorer/feedback` | Update DynamoDB feedback record (with optional S3 sync) |
| DELETE | `/data-explorer/feedback` | Delete DynamoDB feedback record |
| GET | `/data-explorer/stats` | Get data lake statistics |

## Adding a New Data Source

1. Create `lambda/ingestors/{source}/handler.py`
2. Inherit from `BaseIngestor` in `base_ingestor.py`
3. Implement `fetch_new_items()` generator method
4. Add source config to `ingestion-stack.ts` (schedule, timeout)
5. Add credentials to Secrets Manager template
6. Update frontend Settings page with source fields

## CDK Stack Dependencies

```
VocStorageStack (DynamoDB tables, S3 raw data bucket, KMS)
       │
       ├──▶ VocAuthStack (Cognito User Pool, groups, client)
       │
       ├──▶ VocIngestionStack (Ingestors, EventBridge, SQS, Secrets)
       │           │
       │           └──▶ VocProcessingStack (Processor, Aggregator)
       │
       ├──▶ VocResearchStack (Step Functions for research workflows)
       │
       ├──▶ VocAnalyticsStack (API Gateway, API Lambdas, Webhooks, WAF)
       │           │
       │           └── Depends on: processingQueue, secretsArn, researchStateMachine, userPool
       │
       └──▶ VocFrontendStack (S3, CloudFront)
                    │
                    └── Depends on: apiEndpoint, userPoolId, userPoolClientId
```
