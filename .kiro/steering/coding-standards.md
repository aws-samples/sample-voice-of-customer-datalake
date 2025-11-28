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

### Lambda Split Pattern (20KB IAM Policy Limit)

AWS Lambda execution roles have a **20KB policy size limit**. When a single Lambda needs permissions for many resources (DynamoDB tables, S3, Secrets Manager, Bedrock, EventBridge, etc.), the policy can exceed this limit.

**Split handlers by domain** - each handler file focuses on a specific concern:

```
lambda/api/
├── handler.py              # Main API: feedback, scrapers, settings
├── metrics_handler.py      # Metrics endpoints only
├── projects_handler.py     # Projects, personas, documents
├── chat_stream_handler.py  # Streaming chat (Lambda Function URL)
└── ops_handler.py          # Source management, EventBridge rules
```

Each handler becomes a separate Lambda in CDK with only the permissions it needs:

```python
# metrics_handler.py - only needs read access to aggregates table
AGGREGATES_TABLE = os.environ['AGGREGATES_TABLE']
aggregates_table = dynamodb.Table(AGGREGATES_TABLE)

@app.get("/metrics/summary")
def get_summary():
    # Only reads from aggregates - minimal permissions needed
    ...
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

### Lambda IAM Policy Size Limit (20KB)

AWS Lambda execution roles have a **20KB policy size limit**. When a Lambda needs access to many resources (multiple DynamoDB tables, S3, Secrets Manager, Bedrock, etc.), the inline policy can exceed this limit.

**Solution: Split Lambdas by concern**

Instead of one monolithic API Lambda, split into focused handlers:

```typescript
// analytics-stack.ts - Split API into multiple Lambdas by domain

// Main API Lambda - feedback, metrics, scrapers
const apiLambda = new lambda.Function(this, 'ApiLambda', { ... });
feedbackTable.grantReadWriteData(apiLambda);
aggregatesTable.grantReadWriteData(apiLambda);

// Metrics Lambda - dedicated metrics endpoints
const metricsLambda = new lambda.Function(this, 'MetricsLambda', { ... });
aggregatesTable.grantReadData(metricsLambda);

// Projects Lambda - projects, personas, documents
const projectsLambda = new lambda.Function(this, 'ProjectsLambda', { ... });
projectsTable.grantReadWriteData(projectsLambda);
jobsTable.grantReadWriteData(projectsLambda);

// Chat Stream Lambda - streaming responses (Lambda Function URL)
const chatStreamLambda = new lambda.Function(this, 'ChatStreamLambda', { ... });
feedbackTable.grantReadData(chatStreamLambda);
// Bedrock permissions only

// Ops Lambda - source management, settings
const opsLambda = new lambda.Function(this, 'OpsLambda', { ... });
// EventBridge, Secrets Manager permissions
```

**API Gateway routing to multiple Lambdas:**

```typescript
// Route different paths to different Lambdas
api.root.addResource('feedback').addMethod('GET', new apigateway.LambdaIntegration(apiLambda));
api.root.addResource('metrics').addMethod('GET', new apigateway.LambdaIntegration(metricsLambda));
api.root.addResource('projects').addMethod('ANY', new apigateway.LambdaIntegration(projectsLambda));
```

**Benefits:**
- Each Lambda stays under 20KB policy limit
- Faster cold starts (smaller deployment packages)
- Independent scaling per endpoint type
- Easier to reason about permissions

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
