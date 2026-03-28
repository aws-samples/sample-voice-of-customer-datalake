---
inclusion: fileMatch
fileMatchPattern: "lambda/**/*.py"
---

# Lambda Function Patterns

This guide applies when working with Python Lambda functions in this project.

> **⚠️ IMPORTANT — Streaming Chat Handler (TypeScript)**
>
> The **chat and project chat** endpoints are implemented in **TypeScript** at `lambda/stream/` (Node.js 22).
> The Python `shared/project_chat.py` and `chat_stream_handler.py` have been **deleted** — they were fully ported to TypeScript.
> All new chat-related features (attachments, tool use, context building) MUST be implemented in `lambda/stream/`, NOT in Python.
> If an issue or doc references the old Python chat handlers, ignore that and implement in `lambda/stream/` instead.
>
> Key TypeScript files:
> - `lambda/stream/src/handler.ts` — Entry point, routes VoC chat vs project chat
> - `lambda/stream/src/schema.ts` — Zod request validation
> - `lambda/stream/src/context/project-context.ts` — Project chat context builder (replaces `shared/project_chat.py`)
> - `lambda/stream/src/context/voc-context.ts` — VoC chat context builder
> - `lambda/stream/src/bedrock/converse-stream.ts` — Bedrock ConverseStream wrapper
> - `lambda/stream/src/attachments.ts` — Attachment validation and Bedrock content block conversion

## Required Imports

All Lambda handlers MUST use AWS Lambda Powertools:

```python
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, batch_processor

logger = Logger()
tracer = Tracer()
metrics = Metrics()
```

## Handler Decorator Order

Always apply decorators in this order:

```python
@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    pass
```

## Ingestor Pattern

All ingestors inherit from `BaseIngestor`:

```python
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from base_ingestor import BaseIngestor, logger, tracer, metrics

class MyIngestor(BaseIngestor):
    def __init__(self):
        super().__init__()
        # Load source-specific credentials from self.secrets
        self.api_key = self.secrets.get('my_api_key', '')
    
    def fetch_new_items(self):
        """Generator that yields normalized items."""
        # Use self.get_watermark() for incremental fetching
        last_id = self.get_watermark('last_id')
        
        # Fetch from API
        for item in api_results:
            yield {
                'id': item['id'],
                'channel': 'review',
                'url': item['url'],
                'text': item['content'],
                'rating': item.get('stars'),
                'created_at': item['timestamp'],
                'brand_handles_matched': [self.brand_name]
            }
        
        # Update watermark
        self.set_watermark('last_id', newest_id)

@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    ingestor = MyIngestor()
    return ingestor.run()
```

## SQS Batch Processing

Use Powertools batch processor for SQS-triggered Lambdas:

```python
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, batch_processor
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord

processor = BatchProcessor(event_type=EventType.SQS)

def record_handler(record: SQSRecord) -> dict:
    """Process a single SQS record."""
    body = json.loads(record.body)
    # Process the record
    return {"status": "success"}

@batch_processor(record_handler=record_handler, processor=processor)
def lambda_handler(event, context):
    return processor.response()
```

## D
ynamoDB Streams Processing

```python
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, batch_processor
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord

processor = BatchProcessor(event_type=EventType.DynamoDBStreams)

def record_handler(record: DynamoDBRecord) -> dict:
    if record.event_name != 'INSERT':
        return {"status": "skipped"}
    
    new_image = record.dynamodb.new_image
    # Process the new item
    return {"status": "success"}

@batch_processor(record_handler=record_handler, processor=processor)
def lambda_handler(event, context):
    return processor.response()
```

## API Handler Pattern

Use Powertools API Gateway resolver:

```python
from aws_lambda_powertools.event_handler import APIGatewayRestResolver
from aws_lambda_powertools.event_handler.exceptions import NotFoundError

app = APIGatewayRestResolver()

@app.get("/items")
@tracer.capture_method
def list_items():
    params = app.current_event.query_string_parameters or {}
    # Query logic
    return {"items": [...]}

@app.get("/items/<item_id>")
@tracer.capture_method
def get_item(item_id: str):
    item = fetch_item(item_id)
    if not item:
        raise NotFoundError(f"Item {item_id} not found")
    return item

@app.post("/items")
@tracer.capture_method
def create_item():
    body = app.current_event.json_body
    # Create logic
    return {"id": new_id}

def lambda_handler(event, context):
    return app.resolve(event, context)
```

## Error Handling

```python
try:
    result = external_api_call()
except requests.RequestException as e:
    logger.warning(f"API call failed: {e}")
    metrics.add_metric(name="APIErrors", unit="Count", value=1)
    # Decide: retry, skip, or raise
except Exception as e:
    logger.exception(f"Unexpected error: {e}")
    raise  # Let it go to DLQ
```

## Environment Variables

Access via `os.environ` with defaults:

```python
TABLE_NAME = os.environ['TABLE_NAME']  # Required
LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO')  # Optional with default
```