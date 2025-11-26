# VoC Data Lake - Coding Standards

## General Principles

1. **Serverless First**: Always prefer managed serverless services over self-managed infrastructure
2. **Event-Driven**: Use async patterns (SQS, Streams) over synchronous calls where possible
3. **Idempotent**: All operations should be safe to retry
4. **Observable**: Include logging, tracing, and metrics in all Lambda functions

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
from typing import Any, Generator
from aws_lambda_powertools import Logger, Tracer, Metrics

logger = Logger()
tracer = Tracer()
metrics = Metrics()

# AWS Clients (module-level for connection reuse)
dynamodb = boto3.resource('dynamodb')

# Configuration from environment
TABLE_NAME = os.environ['TABLE_NAME']

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

### React Component Structure

```typescript
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { FeedbackItem } from '../api/client'  // type-only import

interface Props {
  feedback: FeedbackItem
  onAction?: () => void
}

export default function MyComponent({ feedback, onAction }: Props) {
  const [state, setState] = useState<string>('')
  
  // Hooks first
  const { data, isLoading } = useQuery({ ... })
  
  // Event handlers
  const handleClick = () => { ... }
  
  // Early returns for loading/error states
  if (isLoading) return <Loading />
  
  // Main render
  return (
    <div className="...">
      {/* JSX */}
    </div>
  )
}
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
GET  /feedback              # List with filters (?days=7&source=twitter)
GET  /feedback/{id}         # Single item
GET  /feedback/urgent       # Urgent items only
GET  /metrics/summary       # Dashboard summary
GET  /metrics/sentiment     # Sentiment breakdown
GET  /metrics/categories    # Category breakdown
GET  /metrics/sources       # Source breakdown
POST /chat                  # AI chat endpoint
```

### Response Format

```json
{
  "count": 42,
  "items": [...],
  "next_token": "..."  // For pagination
}
```

## Testing Guidelines

1. **Unit Tests**: Test business logic in isolation
2. **Integration Tests**: Test Lambda handlers with mocked AWS services
3. **E2E Tests**: Test full flow with deployed infrastructure
4. **Local Development**: Use mock server for frontend development
