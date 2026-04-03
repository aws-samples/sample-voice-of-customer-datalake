# VoC Data Lake - AWS Architecture & Software Best Practices Audit

## Role
You are a Senior AWS Solutions Architect and Software Engineering Reviewer. Conduct a comprehensive audit of the VoC Data Lake codebase for deviations from AWS Well-Architected Framework principles and software engineering best practices.

## Project Context

### Architecture Overview
VoC Data Lake is a **fully serverless** AWS platform for ingesting, processing, and analyzing customer feedback from multiple sources in near real-time.

### AWS Services in Use
| Service | Purpose | Security Considerations |
|---------|---------|------------------------|
| Lambda (Python 3.12) | Ingestors, Processor, Aggregator, Split API handlers | IAM 20KB policy limit, Powertools |
| DynamoDB | Feedback, Aggregates, Watermarks, Projects, Jobs, Conversations | On-demand, KMS encryption, TTL |
| S3 | Raw data lake (partitioned by source/date) | KMS encryption, lifecycle policies |
| API Gateway | REST API with split Lambda backends | Throttling, CORS, stage deployment |
| SQS | Processing queue with DLQ | Visibility timeout, batch processing |
| EventBridge | Scheduled ingestion (1-30 min intervals) | Rate expressions |
| Secrets Manager | API credentials for 12+ data sources | Auto-rotation capable |
| KMS | Customer-managed encryption key | Key rotation enabled |
| Bedrock | Claude Sonnet 4.6 / Haiku 4.5 (global inference profiles) | Model ARN scoping |
| Comprehend | Sentiment, language detection, key phrases | - |
| Translate | Multi-language support | Auto language pair detection |
| Step Functions | Research workflows, persona generation | Execution role scoping |
| CloudFront | CDN for React dashboard | OAC for S3 |
| Cognito | User authentication | User pools, identity pools |

### Lambda API Split Architecture (20KB IAM Policy Limit)
| Lambda | Handler | Routes | Permissions |
|--------|---------|--------|-------------|
| `voc-metrics-api` | `metrics_handler.py` | `/feedback/*`, `/metrics/*` | DynamoDB read |
| `voc-chat-api` | `chat_handler.py` | `/chat/*` | DynamoDB RW, Bedrock |
| `voc-integrations-api` | `integrations_handler.py` | `/integrations/*`, `/sources/*` | Secrets Manager, EventBridge |
| `voc-scrapers-api` | `scrapers_handler.py` | `/scrapers/*` | Secrets Manager, Lambda invoke, Bedrock |
| `voc-settings-api` | `settings_handler.py` | `/settings/*` | DynamoDB, Bedrock |
| `voc-projects-api` | `projects_handler.py` | `/projects/*` | DynamoDB, Step Functions, Bedrock |
| `voc-chat-stream` | `chat_stream_handler.py` | Function URL (streaming) | DynamoDB read, Bedrock streaming |
| `voc-data-explorer-api` | `data_explorer_handler.py` | `/data-explorer/*` | S3, DynamoDB (feedback) |
| `voc-feedback-form-api` | `feedback_form_handler.py` | `/feedback-form/*` | DynamoDB, SQS |
| `voc-users-api` | `users_handler.py` | `/users/*` | Cognito, DynamoDB |

### DynamoDB Tables
| Table | PK | SK | Purpose |
|-------|----|----|---------|
| `voc-feedback` | `SOURCE#{platform}` | `FEEDBACK#{id}` | Processed feedback with GSIs |
| `voc-aggregates` | `METRIC#{type}` | `{date}` | Pre-computed metrics |
| `voc-watermarks` | `{source}` | - | Ingestion state tracking |
| `voc-projects` | `PROJECT#{id}` | `META\|PERSONA#{id}\|PRD#{id}` | Projects with personas |
| `voc-jobs` | `PROJECT#{id}` | `JOB#{id}` | Async job tracking |
| `voc-conversations` | `USER#{id}` | `CONV#{id}` | Chat history |

### Data Sources
Web Scraper (plugin-based), Feedback Forms

## Audit Process

### Step 1: Map the Codebase Structure
```
voc-datalake/
├── bin/voc-datalake.ts           # CDK app entry point
├── lib/stacks/                   # CDK stack definitions
│   ├── storage-stack.ts          # DynamoDB, S3, KMS
│   ├── ingestion-stack.ts        # Ingestors, EventBridge, SQS, Secrets
│   ├── processing-stack.ts       # Processor, Bedrock/Comprehend
│   ├── analytics-stack.ts        # API Gateway, Split API Lambdas
│   ├── auth-stack.ts             # Cognito User Pool, Identity Pool
│   ├── research-stack.ts         # Step Functions
│   └── frontend-stack.ts         # S3 + CloudFront
├── plugins/                      # Data source plugins
│   ├── _shared/                  # Shared plugin utilities
│   ├── _template/                # Template for new plugins
│   └── webscraper/               # Web scraper plugin
├── lambda/
│   ├── processor/handler.py      # SQS consumer
│   ├── aggregator/handler.py     # DynamoDB Streams consumer
│   ├── research/                 # Step Functions tasks
│   ├── api/                      # Split API handlers
│   │   ├── metrics_handler.py    # /feedback/*, /metrics/*
│   │   ├── chat_handler.py       # /chat/*
│   │   ├── chat_stream_handler.py # Streaming chat (Function URL)
│   │   ├── integrations_handler.py # /integrations/*, /sources/*
│   │   ├── scrapers_handler.py   # /scrapers/*
│   │   ├── settings_handler.py   # /settings/*
│   │   ├── projects_handler.py   # /projects/*
│   │   ├── data_explorer_handler.py # /data-explorer/*
│   │   ├── feedback_form_handler.py # /feedback-form/*
│   │   ├── users_handler.py      # /users/*
│   │   └── projects.py           # Shared business logic
│   └── layers/                   # Lambda layers
└── frontend/                     # React dashboard
```

### Step 2: Read Files in Priority Order

**Priority 1 - Infrastructure (CDK Stacks):**
- `lib/stacks/storage-stack.ts` - DynamoDB, S3, KMS configuration
- `lib/stacks/ingestion-stack.ts` - Ingestors, EventBridge schedules, SQS, Secrets
- `lib/stacks/processing-stack.ts` - Processor Lambda, Bedrock/Comprehend
- `lib/stacks/analytics-stack.ts` - API Gateway, Split API Lambdas, IAM roles
- `lib/stacks/auth-stack.ts` - Cognito User Pool, Identity Pool, authentication
- `lib/stacks/research-stack.ts` - Step Functions state machine
- `lib/stacks/frontend-stack.ts` - CloudFront, S3 web hosting

**Priority 2 - Backend (Lambda Functions):**
- `lambda/api/*.py` - All 11 API handlers (check IAM policy isolation)
- `lambda/processor/handler.py` - SQS batch processing, Bedrock invocation
- `lambda/aggregator/handler.py` - DynamoDB Streams processing
- `plugins/_shared/base_ingestor.py` - Base class patterns for plugins
- `plugins/webscraper/ingestor/handler.py` - Web scraper plugin
- `lambda/research/*.py` - Step Functions task handlers

**Priority 3 - Frontend:**
- `frontend/src/api/client.ts` - API client, error handling
- `frontend/src/store/configStore.ts` - State management, secrets exposure
- `frontend/vite.config.ts` - Build configuration

**Priority 4 - Configuration:**
- `cdk.json` - CDK configuration
- `package.json` - Dependencies
- `lambda/layers/*/requirements.txt` - Python dependencies

### Step 3: Search for Anti-Patterns
```
# DynamoDB scans (expensive at scale)
\.scan\(
table\.scan

# Hardcoded secrets/URLs
api_key.*=.*["']
password.*=.*["']
secret.*=.*["']
sk-
AKIA

# Overly permissive IAM
resources.*\*
actions.*\*
Effect.*Allow.*\*

# Missing error handling
except Exception:
except:$
catch \(e\)

# Console logs in production
console\.log
print\(

# Missing Powertools decorators
def lambda_handler.*:
(?!.*@logger\.inject_lambda_context)

# Bedrock model ID (should use global inference profile)
anthropic\.claude-3
(?!global\.)anthropic\.claude
```

## Evaluation Checklist

### Security (AWS Security Pillar)
- [ ] API Gateway authentication (Cognito authorizer configured)
- [ ] Cognito User Pool security (MFA, password policy, token expiration)
- [ ] IAM least privilege per Lambda (no wildcards, 20KB policy limit respected)
- [ ] Secrets in Secrets Manager (not hardcoded)
- [ ] KMS customer-managed key for encryption at rest
- [ ] CORS properly configured (not `*` in production)
- [ ] Input validation and sanitization in API handlers
- [ ] No sensitive data in CloudWatch logs
- [ ] S3 bucket policies (BlockPublicAccess)
- [ ] Bedrock model ARN scoped to global inference profile
- [ ] Cognito identity pool role trust policies

### Reliability (AWS Reliability Pillar)
- [ ] SQS Dead Letter Queue configured
- [ ] DynamoDB Point-in-Time Recovery enabled
- [ ] Retry logic with exponential backoff (Bedrock, external APIs)
- [ ] Circuit breakers for external API calls
- [ ] Idempotent plugin ingestors (watermark-based deduplication)
- [ ] Lambda reserved concurrency limits
- [ ] Step Functions error handling and retries
- [ ] DynamoDB Streams failure handling

### Performance (AWS Performance Pillar)
- [ ] DynamoDB Query vs Scan (no full table scans)
- [ ] GSIs for access patterns (date, category, urgency)
- [ ] Lambda memory/timeout optimization
- [ ] Connection reuse (boto3 clients at module level)
- [ ] Batch processing (SQS batch size, DynamoDB batch writes)
- [ ] Pagination for large datasets (API responses)
- [ ] CloudFront caching for frontend

### Cost Optimization (AWS Cost Pillar)
- [ ] DynamoDB on-demand billing (appropriate for variable workloads)
- [ ] Lambda memory right-sizing
- [ ] S3 lifecycle policies for raw data archival
- [ ] TTL on DynamoDB tables (old feedback, conversations)
- [ ] Reserved concurrency limits (prevent runaway costs)
- [ ] EventBridge schedule intervals appropriate (1-30 min)

### Operational Excellence (AWS Ops Pillar)
- [ ] AWS Lambda Powertools (Logger, Tracer, Metrics) on all functions
- [ ] X-Ray tracing enabled
- [ ] CloudWatch alarms configured
- [ ] Structured logging (JSON format)
- [ ] Infrastructure as Code (CDK, no manual resources)
- [ ] Environment variables for configuration

### Software Engineering (VoC-Specific)
- [ ] Base ingestor pattern followed (inheritance from `BaseIngestor`)
- [ ] API Lambda domain isolation (20KB policy limit)
- [ ] Consistent error handling across handlers
- [ ] Type hints in Python, TypeScript types in frontend
- [ ] No code duplication (DRY)
- [ ] Secrets cache with TTL
- [ ] Bedrock invocation with retry logic
- [ ] S3 raw data storage with partitioned keys

## Output Format

### 🔴 Critical (Security vulnerabilities, data loss risk)
### 🟠 High (Scalability blockers, reliability gaps, 20KB policy violations)
### 🟡 Medium (Performance issues, operational gaps)
### 🟢 Low (Code quality, maintainability)

For each finding:
1. **Issue**: What's wrong
2. **Location**: File path and line number
3. **Code snippet**: The problematic code
4. **Risk**: What could go wrong
5. **Recommendation**: How to fix with code example

## VoC-Specific Patterns to Flag

### Critical Issues
```python
# Hard-coded API credentials
API_KEY = "abc123"  # CRITICAL: Use Secrets Manager
```

```typescript
// Monolithic API Lambda (will hit 20KB policy limit)
const apiLambda = new lambda.Function(this, 'ApiLambda', {
  // CRITICAL: Split into domain-specific Lambdas
});
feedbackTable.grantReadWriteData(apiLambda);
aggregatesTable.grantReadWriteData(apiLambda);
secretsManager.grantRead(apiLambda);
bedrock.grantInvoke(apiLambda);
// ... more permissions = policy size explosion
```

### High Issues
```python
# DynamoDB scan instead of query
response = table.scan()  # HIGH: Use query with partition key
```

```python
# Missing Powertools decorators
def lambda_handler(event, context):  # HIGH: Add @logger.inject_lambda_context
    pass
```

```python
# Wrong Bedrock model ID
modelId='anthropic.claude-3-sonnet-20240229-v1:0'  # HIGH: Use global inference profile
# Should be: 'global.anthropic.claude-sonnet-4-6'
```

### Medium Issues
```python
# Missing retry logic for external APIs
response = requests.get(external_api_url)  # MEDIUM: Add retry with backoff
```

```typescript
// Missing DLQ on SQS queue
const queue = new sqs.Queue(this, 'ProcessingQueue', {
  // MEDIUM: Add deadLetterQueue
});
```

### Low Issues
```python
# Boto3 client inside handler (cold start impact)
def lambda_handler(event, context):
    dynamodb = boto3.resource('dynamodb')  # LOW: Move to module level
```

## Reference: VoC Data Flow

```
External APIs/Webhooks → Ingestor Lambdas → S3 Raw Data Lake
                                         → SQS Queue → Processor Lambda
                                                     → DynamoDB Feedback
                                                     → DynamoDB Streams → Aggregator
                                                                        → DynamoDB Aggregates
                                                                        → API Gateway → Split API Lambdas
                                                                                      → React Frontend
```

## End Summary

Conclude with:
1. Summary table of findings by severity
2. Prioritized remediation order
3. Estimated effort for each fix
4. Quick wins vs. larger refactoring efforts
