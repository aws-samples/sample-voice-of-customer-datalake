---
inclusion: conditional
triggers: ["code style", "coding standard", "naming convention", "best practice", "lint", "format", "error handling", "api design"]
---

# VoC Data Lake - Coding Standards

## General Principles

1. **Serverless First**: Always prefer managed serverless services over self-managed infrastructure
2. **Event-Driven**: Use async patterns (SQS, Streams) over synchronous calls where possible
3. **Idempotent**: All operations should be safe to retry
4. **Observable**: Include logging, tracing, and metrics in all Lambda functions
5. **Lambda IAM Policy Size Limit**: AWS has a 20KB limit on Lambda execution role policies - split Lambdas by concern to avoid hitting this limit

## Python (Lambda Functions)

### File Structure

```python
"""
Module docstring explaining purpose.
"""
import json
import os
import boto3
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Generator
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig

logger = Logger()
tracer = Tracer()
metrics = Metrics(namespace="VoC-Processor")

# AWS Clients (module-level for connection reuse)
dynamodb = boto3.resource('dynamodb')
s3 = boto3.client('s3')
bedrock_runtime = boto3.client('bedrock-runtime')

# Configuration from environment
TABLE_NAME = os.environ['TABLE_NAME']
RAW_DATA_BUCKET = os.environ.get('RAW_DATA_BUCKET', '')

# Helper functions with tracing
@tracer.capture_method
def helper_function():
    pass

# Main handler with all decorators
@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    pass
```

### API Lambda Pattern (using Powertools)

```python
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig

cors_config = CORSConfig(
    allow_origin="*",
    allow_headers=["Content-Type", "Authorization"],
    max_age=300,
    allow_credentials=False
)

app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)

@app.get("/feedback")
@tracer.capture_method
def list_feedback():
    params = app.current_event.query_string_parameters or {}
    # ... implementation
    return {'count': len(items), 'items': items}

@app.post("/chat")
@tracer.capture_method
def chat():
    body = app.current_event.json_body
    # ... implementation
    return {'response': response_text}

@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
```

### SQS Batch Processing Pattern

```python
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, batch_processor

processor = BatchProcessor(event_type=EventType.SQS)

def record_handler(record: SQSRecord) -> dict:
    raw_record = json.loads(record.body)
    # Process record...
    return {"status": "success"}

@batch_processor(record_handler=record_handler, processor=processor)
def lambda_handler(event: dict, context: Any) -> dict:
    return processor.response()
```

### Bedrock Invocation with Retry

```python
BEDROCK_MODEL_ID = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'

@tracer.capture_method
def invoke_bedrock_llm(prompt: str) -> dict:
    request_body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 800,
        "temperature": 0.1,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": prompt}]
    }
    
    response = bedrock_runtime.invoke_model(
        modelId=BEDROCK_MODEL_ID,
        body=json.dumps(request_body),
        contentType='application/json',
        accept='application/json'
    )
    
    response_body = json.loads(response['body'].read())
    return json.loads(response_body['content'][0]['text'])
```

### Lambda Domain Isolation Pattern (MANDATORY)

> **⚠️ CRITICAL**: This pattern is MANDATORY for all API Lambda development. Never create monolithic API handlers.

AWS Lambda execution roles have a **20KB policy size limit**. When a single Lambda needs permissions for many resources (DynamoDB tables, S3, Secrets Manager, Bedrock, EventBridge, etc.), the policy can exceed this limit and deployment will fail.

**Rules for Lambda API Development:**

1. **One domain per Lambda** - Each Lambda handles a single domain (e.g., metrics, chat, projects)
2. **Route-based isolation** - Group related routes in the same handler (e.g., `/feedback/*` and `/metrics/*` together)
3. **Minimal permissions** - Each Lambda only gets IAM permissions for resources it actually uses
4. **Naming convention** - Use `{domain}_handler.py` naming (e.g., `metrics_handler.py`, `chat_handler.py`)

**Current API Lambda Structure (12 handlers):**

```
lambda/api/
├── metrics_handler.py       # /feedback/*, /metrics/* (read-only)
├── chat_handler.py          # /chat/*
├── chat_stream_handler.py   # Streaming chat (Lambda Function URL)
├── integrations_handler.py  # /integrations/*, /sources/*
├── scrapers_handler.py      # /scrapers/*
├── settings_handler.py      # /settings/*
├── projects_handler.py      # /projects/*
├── users_handler.py         # /users/* (Cognito admin)
├── feedback_form_handler.py # /feedback-form/*, /feedback-forms/*
├── s3_import_handler.py     # /s3-import/*
├── data_explorer_handler.py # /data-explorer/* (S3 raw data & DynamoDB browser)
└── projects.py              # Shared business logic for projects
```

**Domain-to-Permission Mapping (12 handlers):**

| Domain | Handler | AWS Permissions |
|--------|---------|-----------------|
| Metrics | `metrics_handler.py` | DynamoDB read (feedback, aggregates) |
| Chat | `chat_handler.py` | DynamoDB RW (conversations), Bedrock |
| Chat Stream | `chat_stream_handler.py` | DynamoDB read, Bedrock streaming |
| Integrations | `integrations_handler.py` | Secrets Manager, EventBridge |
| Scrapers | `scrapers_handler.py` | Secrets Manager, Lambda invoke, Bedrock |
| Settings | `settings_handler.py` | DynamoDB (aggregates), Bedrock |
| Projects | `projects_handler.py` | DynamoDB (projects, jobs), Step Functions, Bedrock, S3 |
| Users | `users_handler.py` | Cognito admin |
| Feedback Forms | `feedback_form_handler.py` | DynamoDB (aggregates), SQS |
| S3 Import | `s3_import_handler.py` | S3 bucket only |
| Data Explorer | `data_explorer_handler.py` | S3, DynamoDB (feedback) |
| Webhook | `webhooks/trustpilot/handler.py` | DynamoDB, SQS, Secrets Manager |

**When adding new API endpoints:**

1. Identify which domain the endpoint belongs to
2. Add the route to the appropriate existing handler
3. If creating a new domain, create a new `{domain}_handler.py` file
4. Update `analytics-stack.ts` to create the Lambda and wire API Gateway routes
5. Grant only the minimum required permissions

**Example - Adding a new endpoint to existing domain:**

```python
# In metrics_handler.py - adding a new metrics endpoint
@app.get("/metrics/trends")
@tracer.capture_method
def get_trends():
    # Uses same tables as other metrics endpoints
    # No new permissions needed
    ...
```

**Example - Creating a new domain:**

```python
# New file: reports_handler.py
"""Reports API Lambda - Handles /reports/*"""
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig

logger = Logger()
tracer = Tracer()

# Only import clients this Lambda needs
dynamodb = boto3.resource('dynamodb')
REPORTS_TABLE = os.environ.get('REPORTS_TABLE', '')

app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)

@app.get("/reports")
@tracer.capture_method
def list_reports():
    ...

@logger.inject_lambda_context
@tracer.capture_lambda_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
```

### Naming Conventions

- Files: `snake_case.py`
- Classes: `PascalCase`
- Functions/variables: `snake_case`
- Constants: `UPPER_SNAKE_CASE`

### Error Handling

```python
try:
    result = risky_operation()
except SpecificException as e:
    logger.warning(f"Expected error: {e}")
    # Handle gracefully
except Exception as e:
    logger.exception(f"Unexpected error: {e}")
    metrics.add_metric(name="Errors", unit="Count", value=1)
    raise  # Re-raise for DLQ handling
```

## TypeScript (CDK & Frontend)

### CDK Stack Structure

```typescript
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface MyStackProps extends cdk.StackProps {
  // Typed props for cross-stack references
  someTable: dynamodb.Table;
}

export class MyStack extends cdk.Stack {
  // Public properties for cross-stack references
  public readonly outputResource: SomeResource;

  constructor(scope: Construct, id: string, props: MyStackProps) {
    super(scope, id, props);
    
    // Resource definitions
    
    // Outputs
    new cdk.CfnOutput(this, 'OutputName', { value: this.outputResource.arn });
  }
}
```

### CDK Lambda Domain Isolation (MANDATORY)

> **⚠️ CRITICAL**: Always create separate Lambdas per domain. Never create monolithic API Lambdas.

AWS Lambda execution roles have a **20KB policy size limit**. The CDK stack must create separate Lambdas for each domain with isolated permissions.

**Current Lambda Architecture in `analytics-stack.ts`:**

```typescript
// 1. Metrics Lambda - read-only feedback/metrics queries
const metricsLambda = new lambda.Function(this, 'MetricsApi', {
  handler: 'metrics_handler.lambda_handler',
  // ...
});
feedbackTable.grantReadData(metricsRole);
aggregatesTable.grantReadData(metricsRole);

// 2. Chat Lambda - chat conversations
const chatLambda = new lambda.Function(this, 'ChatApi', {
  handler: 'chat_handler.lambda_handler',
  // ...
});
conversationsTable.grantReadWriteData(chatRole);
// + Bedrock permissions

// 3. Integrations Lambda - credentials and source schedules
const integrationsLambda = new lambda.Function(this, 'IntegrationsApi', {
  handler: 'integrations_handler.lambda_handler',
  // ...
});
// Secrets Manager + EventBridge permissions only

// 4. Scrapers Lambda - web scraper management
const scrapersLambda = new lambda.Function(this, 'ScrapersApi', {
  handler: 'scrapers_handler.lambda_handler',
  // ...
});
// Secrets Manager + Lambda invoke + Bedrock

// 5. Settings Lambda - brand/category configuration
const settingsLambda = new lambda.Function(this, 'SettingsApi', {
  handler: 'settings_handler.lambda_handler',
  // ...
});
aggregatesTable.grantReadWriteData(settingsRole);
// + Bedrock for category generation

// 6. Projects Lambda - research projects
const projectsLambda = new lambda.Function(this, 'ProjectsApi', {
  handler: 'projects_handler.lambda_handler',
  // ...
});
projectsTable.grantReadWriteData(projectsRole);
jobsTable.grantReadWriteData(projectsRole);
// + Step Functions + Bedrock + S3 (avatars)

// 7. Users Lambda - Cognito user administration
const usersLambda = new lambda.Function(this, 'UsersApi', {
  handler: 'users_handler.lambda_handler',
  // ...
});
// Cognito admin permissions only

// 8. Feedback Form Lambda - embeddable forms
const feedbackFormLambda = new lambda.Function(this, 'FeedbackFormApi', {
  handler: 'feedback_form_handler.lambda_handler',
  // ...
});
aggregatesTable.grantReadWriteData(feedbackFormRole);
// + SQS for processing queue

// 9. S3 Import Lambda - file explorer
const s3ImportLambda = new lambda.Function(this, 'S3ImportApi', {
  handler: 's3_import_handler.lambda_handler',
  // ...
});
s3ImportBucket.grantReadWrite(s3ImportRole);
// S3 only - minimal permissions

// 10. Data Explorer Lambda - S3 raw data and DynamoDB browser
const dataExplorerLambda = new lambda.Function(this, 'DataExplorerApi', {
  handler: 'data_explorer_handler.lambda_handler',
  // ...
});
rawDataBucket.grantRead(dataExplorerRole);
feedbackTable.grantReadWriteData(dataExplorerRole);
// S3 + DynamoDB permissions
```

**API Gateway Route Mapping:**

```typescript
// Each domain routes to its dedicated Lambda
const metricsIntegration = new apigateway.LambdaIntegration(metricsLambda);
const chatIntegration = new apigateway.LambdaIntegration(chatLambda);
const integrationsIntegration = new apigateway.LambdaIntegration(integrationsLambda);
const scrapersIntegration = new apigateway.LambdaIntegration(scrapersLambda);
const settingsIntegration = new apigateway.LambdaIntegration(settingsLambda);
const projectsIntegration = new apigateway.LambdaIntegration(projectsLambda);
const usersIntegration = new apigateway.LambdaIntegration(usersLambda);
const feedbackFormIntegration = new apigateway.LambdaIntegration(feedbackFormLambda);

// Route paths to appropriate Lambdas (with Cognito auth)
feedbackResource.addMethod('GET', metricsIntegration, authMethodOptions);
metricsResource.addMethod('GET', metricsIntegration, authMethodOptions);
chatResource.addMethod('POST', chatIntegration, authMethodOptions);
integrationsResource.addMethod('GET', integrationsIntegration, authMethodOptions);
scrapersResource.addMethod('GET', scrapersIntegration, authMethodOptions);
settingsResource.addMethod('GET', settingsIntegration, authMethodOptions);
projectsResource.addMethod('GET', projectsIntegration, authMethodOptions);
usersResource.addMethod('GET', usersIntegration, authMethodOptions);
// Feedback form public endpoints (no auth for form submission)
feedbackFormSubmitResource.addMethod('POST', feedbackFormIntegration);
```

**When adding a new domain:**

1. Create new IAM Role with minimal permissions
2. Create new Lambda Function with domain-specific handler
3. Create LambdaIntegration
4. Add API Gateway routes pointing to the new integration
5. Grant only required table/service permissions to the role

**Benefits:**
- Each Lambda stays under 20KB policy limit
- Faster cold starts (smaller deployment packages)
- Independent scaling per endpoint type
- Easier to reason about and audit permissions
- Isolated blast radius for errors

### React Component Structure

```typescript
import { useQuery } from '@tanstack/react-query'
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer } from 'recharts'
import { MessageSquare, TrendingUp } from 'lucide-react'
import { api, getDaysFromRange } from '../api/client'
import { useConfigStore } from '../store/configStore'
import type { FeedbackItem } from '../api/client'

export default function Dashboard() {
  const { timeRange, customDateRange, config } = useConfigStore()
  const days = getDaysFromRange(timeRange, customDateRange)
  const isConfigured = !!config.apiEndpoint

  const { data: summary, isLoading } = useQuery({
    queryKey: ['summary', days],
    queryFn: () => api.getSummary(days),
    enabled: isConfigured,
  })

  // Early returns for loading/error states
  if (!isConfigured) {
    return <div>Configure API endpoint in Settings</div>
  }
  if (isLoading) {
    return <div>Loading...</div>
  }

  return (
    <div className="space-y-6">
      {/* Metrics cards, charts, etc. */}
    </div>
  )
}
```

### API Client Pattern

```typescript
const getBaseUrl = () => {
  const { config } = useConfigStore.getState()
  return config.apiEndpoint || '/api'
}

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const baseUrl = getBaseUrl().replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!response.ok) throw new Error(`API Error: ${response.status}`)
  return response.json()
}

export const api = {
  getFeedback: (params) => fetchApi<{ count: number; items: FeedbackItem[] }>(`/feedback?${new URLSearchParams(params)}`),
  getSummary: (days: number) => fetchApi<MetricsSummary>(`/metrics/summary?days=${days}`),
  chat: (message: string) => fetchApi<{ response: string }>('/chat', {
    method: 'POST',
    body: JSON.stringify({ message })
  }),
}
```

### Zustand Store Pattern

```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ConfigState {
  config: { apiEndpoint: string; brandName: string }
  timeRange: '24h' | '48h' | '7d' | '30d' | 'custom'
  setConfig: (config: Partial<ConfigState['config']>) => void
  setTimeRange: (range: ConfigState['timeRange']) => void
}

export const useConfigStore = create<ConfigState>()(
  persist(
    (set) => ({
      config: { apiEndpoint: '', brandName: '' },
      timeRange: '7d',
      setConfig: (config) => set((state) => ({ config: { ...state.config, ...config } })),
      setTimeRange: (timeRange) => set({ timeRange }),
    }),
    { name: 'voc-config' }
  )
)
```

### Naming Conventions

- Files: `PascalCase.tsx` for components, `camelCase.ts` for utilities
- Components: `PascalCase`
- Functions/variables: `camelCase`
- Types/Interfaces: `PascalCase`
- Constants: `UPPER_SNAKE_CASE` or `camelCase`

## DynamoDB Patterns

### Key Design

```
# Single-table design with composite keys
PK: TYPE#identifier
SK: SUBTYPE#identifier

# Examples:
PK: SOURCE#twitter       SK: FEEDBACK#abc123
PK: DATE#2024-01-15      SK: 1705312800#abc123
PK: CATEGORY#delivery    SK: -0.75#1705312800
PK: METRIC#daily_total   SK: 2024-01-15
```

### GSI Strategy

- GSI1: Query by date (time-series)
- GSI2: Query by category (issue analysis)
- GSI3: Query by urgency (alerts)

## S3 Raw Data Lake Patterns

### Partitioned Key Structure

```
raw/{source}/{year}/{month}/{day}/{id}.json

# Examples:
raw/trustpilot/2025/11/28/abc123.json
raw/webscraper/2025/11/28/def456.json
```

### Storing Raw Data

```python
def store_raw_to_s3(item: dict, raw_content: str = None) -> str | None:
    """Store raw data to S3 with partitioned structure."""
    now = datetime.now(timezone.utc)
    s3_key = f"raw/{source}/{now.year}/{now.month:02d}/{now.day:02d}/{item_id}.json"
    
    s3.put_object(
        Bucket=RAW_DATA_BUCKET,
        Key=s3_key,
        Body=json.dumps(payload, default=str),
        ContentType='application/json'
    )
    return f"s3://{RAW_DATA_BUCKET}/{s3_key}"
```

### SQS Message with S3 Reference

```python
# Normalized item includes s3_raw_uri for processor to fetch raw data if needed
{
    'id': 'abc123',
    'source_platform': 'trustpilot',
    'text': 'Review text...',
    's3_raw_uri': 's3://voc-raw-data-123456789-us-east-1/raw/trustpilot/2025/11/28/abc123.json',
    'raw_data': None  # Only populated if S3 storage failed
}
```

### Write Patterns

```python
# Use conditional writes for idempotency
table.put_item(
    Item=item,
    ConditionExpression='attribute_not_exists(pk)'
)

# Use atomic counters for aggregates
table.update_item(
    Key={'pk': pk, 'sk': sk},
    UpdateExpression='SET #count = if_not_exists(#count, :zero) + :inc',
    ExpressionAttributeNames={'#count': 'count'},
    ExpressionAttributeValues={':inc': 1, ':zero': 0}
)
```

## API Design

### REST Endpoints

```
# Feedback
GET  /feedback                    # List with filters (?days=7&source=twitter&category=delivery)
GET  /feedback/{id}               # Single item
GET  /feedback/{id}/similar       # Similar feedback items
GET  /feedback/urgent             # Urgent items only
GET  /feedback/search             # Search with ?q=query
GET  /feedback/entities           # Get keywords, categories, issues for filters

# Metrics
GET  /metrics/summary             # Dashboard summary
GET  /metrics/sentiment           # Sentiment breakdown
GET  /metrics/categories          # Category breakdown
GET  /metrics/sources             # Source breakdown
GET  /metrics/personas            # Persona breakdown

# Chat
POST /chat                        # AI chat endpoint
POST /chat/stream                 # Streaming chat (via Lambda Function URL)

# Scrapers
GET  /scrapers                    # List scraper configs
POST /scrapers                    # Save scraper config
DELETE /scrapers/{id}             # Delete scraper
GET  /scrapers/templates          # Get scraper templates
POST /scrapers/{id}/run           # Trigger scraper run
GET  /scrapers/{id}/status        # Get run status

# Projects
GET  /projects                    # List projects
POST /projects                    # Create project
GET  /projects/{id}               # Get project with personas/documents
POST /projects/{id}/personas/generate  # Generate personas from feedback
POST /projects/{id}/research      # Run research job (Step Functions)
POST /projects/{id}/chat          # Project-scoped chat
```

### Response Format

```json
{
  "count": 42,
  "items": [...],
  "next_token": "..."
}
```

### Error Response

```json
{
  "success": false,
  "message": "Error description"
}
```

## Testing Guidelines

1. **Unit Tests**: Test business logic in isolation
2. **Integration Tests**: Test Lambda handlers with mocked AWS services
3. **E2E Tests**: Test full flow with deployed infrastructure
4. **Local Development**: Use mock server for frontend development

## Deployment & Validation

### Lambda Layer Building

Lambda layers with native dependencies (pydantic, etc.) must be built using Docker for Linux ARM64 compatibility:

```bash
# Build layers using Docker (ARM64/Graviton)
./scripts/build-layers.sh
```

All Lambdas use ARM64 (Graviton) architecture for better price/performance.

### Post-Deployment API Validation

**ALWAYS validate API endpoints after deployment** using the test script:

```bash
# Run full API validation (includes streaming API)
./scripts/test-api.sh

# Or with custom endpoints
./scripts/test-api.sh "https://your-api.execute-api.us-west-2.amazonaws.com/v1" "https://your-stream.lambda-url.us-west-2.on.aws"
```

### Bash Scripting - Special Character Escaping

> **⚠️ IMPORTANT**: When using passwords or strings containing `!` in bash, use **single quotes** to prevent history expansion.

```bash
# ❌ WRONG - bash will try to expand !2025 as history reference
PASSWORD="DeployTest!2025"

# ✅ CORRECT - single quotes prevent expansion
PASSWORD='DeployTest!2025'

# ✅ CORRECT - for AWS CLI auth-parameters with special chars
aws cognito-idp initiate-auth \
  --auth-parameters 'USERNAME=user,PASSWORD=Pass!word123'
```

### Manual Streaming API Test

The streaming chat API uses a Lambda Function URL to bypass API Gateway's 29-second timeout:

```bash
# Get endpoints from CloudFormation
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name VocCoreStack \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolClientId`].OutputValue' --output text)
STREAM_URL=$(aws cloudformation describe-stacks --stack-name VocApiStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ChatStreamUrl`].OutputValue' --output text)

# Get Cognito token (use single quotes for password with !)
# Note: Create test user first with aws cognito-idp admin-create-user
TOKEN=$(aws cognito-idp initiate-auth \
  --client-id "$CLIENT_ID" \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters 'USERNAME=deployment-test,PASSWORD=DeployTest!2025' \
  --query 'AuthenticationResult.IdToken' \
  --output text)

# Test streaming API
curl -X POST "$STREAM_URL/chat/stream" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"message":"hello"}'
```

### Deployment Checklist

1. Build Lambda layers with Docker: `./scripts/build-layers.sh`
2. Deploy stacks: `npx cdk deploy --all --context frontendDomain=<domain>`
3. Validate API endpoints: `./scripts/test-api.sh <api_url> "Bearer <token>"`
4. Check Lambda logs if any endpoint fails: `aws logs tail /aws/lambda/<function-name> --since 5m`

### Common Deployment Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| `No module named 'pydantic_core._pydantic_core'` | Layer built for wrong architecture | Rebuild with `./scripts/build-layers.sh` (uses ARM64) |
| `No module named 'shared'` | Lambda code bundling issue | Check `apiCodeWithShared` bundling in analytics-stack.ts |
| 502 errors | Lambda import/runtime error | Check CloudWatch logs for specific error |
| CORS errors on 4XX/5XX | Missing gateway responses | Ensure `addGatewayResponse` for DEFAULT_4XX/5XX |
