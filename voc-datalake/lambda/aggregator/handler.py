"""
VoC Aggregation Processor Lambda
Updates real-time aggregates in DynamoDB when new feedback arrives via Streams.
"""
import os
from datetime import datetime, timezone
from decimal import Decimal
from collections import defaultdict
from typing import Any
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType, batch_processor
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord

# Shared module imports
from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()

# Configuration
AGGREGATES_TABLE = os.environ['AGGREGATES_TABLE']
aggregates_table = dynamodb.Table(AGGREGATES_TABLE)

processor = BatchProcessor(event_type=EventType.DynamoDBStreams)


def get_metric_type(pk: str) -> str | None:
    """Extract metric type from pk for GSI indexing."""
    if pk.startswith('METRIC#daily_source#'):
        return 'source'
    elif pk.startswith('METRIC#persona#'):
        return 'persona'
    return None


def update_counter(pk: str, sk: str, field: str, increment: int = 1, ttl_days: int = 90):
    """Atomically update a counter in the aggregates table."""
    ttl = int(datetime.now(timezone.utc).timestamp() + ttl_days * 24 * 60 * 60)
    
    # Build update expression - include metric_type for GSI if applicable
    metric_type = get_metric_type(pk)
    update_expr = 'SET #field = if_not_exists(#field, :zero) + :inc, #ttl = :ttl, updated_at = :now'
    attr_names = {'#field': field, '#ttl': 'ttl'}
    attr_values = {
        ':inc': increment,
        ':zero': 0,
        ':ttl': ttl,
        ':now': datetime.now(timezone.utc).isoformat()
    }
    
    if metric_type:
        update_expr += ', metric_type = :metric_type'
        attr_values[':metric_type'] = metric_type
    
    aggregates_table.update_item(
        Key={'pk': pk, 'sk': sk},
        UpdateExpression=update_expr,
        ExpressionAttributeNames=attr_names,
        ExpressionAttributeValues=attr_values
    )


def update_average(pk: str, sk: str, value: Decimal, ttl_days: int = 90):
    """Update running average in aggregates table."""
    ttl = int(datetime.now(timezone.utc).timestamp() + ttl_days * 24 * 60 * 60)
    
    aggregates_table.update_item(
        Key={'pk': pk, 'sk': sk},
        UpdateExpression='''
            SET #sum = if_not_exists(#sum, :zero) + :val,
                #count = if_not_exists(#count, :zero) + :one,
                #ttl = :ttl,
                updated_at = :now
        ''',
        ExpressionAttributeNames={'#sum': 'sum', '#count': 'count', '#ttl': 'ttl'},
        ExpressionAttributeValues={
            ':val': value,
            ':one': 1,
            ':zero': Decimal('0'),
            ':ttl': ttl,
            ':now': datetime.now(timezone.utc).isoformat()
        }
    )


@tracer.capture_method
def process_new_feedback(item: dict):
    """Update aggregates for a new feedback item."""
    date = item.get('date', datetime.now(timezone.utc).strftime('%Y-%m-%d'))
    source_platform = item.get('source_platform', 'unknown')
    category = item.get('category', 'other')
    sentiment_label = item.get('sentiment_label', 'neutral')
    sentiment_score = item.get('sentiment_score', Decimal('0'))
    urgency = item.get('urgency', 'low')
    persona = item.get('persona_name', 'Unknown')
    
    # Daily totals
    update_counter('METRIC#daily_total', date, 'count')
    
    # Daily by source platform
    update_counter(f'METRIC#daily_source#{source_platform}', date, 'count')
    
    # Daily by category
    update_counter(f'METRIC#daily_category#{category}', date, 'count')
    
    # Daily by sentiment
    update_counter(f'METRIC#daily_sentiment#{sentiment_label}', date, 'count')
    
    # Daily sentiment score average
    if sentiment_score:
        update_average('METRIC#daily_sentiment_avg', date, sentiment_score)
    
    # Urgency counts (for alerts)
    if urgency == 'high':
        update_counter('METRIC#urgent', date, 'count')
    
    # Persona counts
    if persona:
        update_counter(f'METRIC#persona#{persona}', date, 'count')
    
    # Category + sentiment combo
    update_counter(f'METRIC#category_sentiment#{category}#{sentiment_label}', date, 'count')
    
    logger.info(f"Updated aggregates for date={date}, source={source_platform}, category={category}")


def record_handler(record: DynamoDBRecord) -> dict:
    """Process a single DynamoDB Stream record."""
    # event_name is an enum in Powertools, compare with .value or string representation
    event_name = str(record.event_name).split('.')[-1] if record.event_name else None
    logger.info(f"Processing record: event_name={event_name}")
    
    if event_name != 'INSERT':
        logger.info(f"Skipping non-INSERT event: {event_name}")
        return {"status": "skipped", "reason": "not an insert"}
    
    new_image = record.dynamodb.new_image if record.dynamodb else None
    if not new_image:
        logger.warning("No new_image in record")
        return {"status": "skipped", "reason": "no new image"}
    
    logger.info(f"new_image keys: {list(new_image.keys()) if new_image else 'None'}")
    
    # Convert DynamoDB format to regular dict
    # Powertools may already deserialize, check both formats
    item = {}
    for key, value in new_image.items():
        if isinstance(value, dict):
            # Raw DynamoDB format
            if 'S' in value:
                item[key] = value['S']
            elif 'N' in value:
                item[key] = Decimal(value['N'])
            elif 'M' in value:
                item[key] = value['M']
            elif 'L' in value:
                item[key] = value['L']
            elif 'BOOL' in value:
                item[key] = value['BOOL']
        else:
            # Already deserialized
            item[key] = value
    
    logger.info(f"Processing feedback: date={item.get('date')}, source={item.get('source_platform')}")
    process_new_feedback(item)
    metrics.add_metric(name="AggregatesUpdated", unit="Count", value=1)
    
    return {"status": "success"}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
@batch_processor(record_handler=record_handler, processor=processor)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler for DynamoDB Streams."""
    return processor.response()
