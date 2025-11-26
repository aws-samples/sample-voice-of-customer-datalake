"""
Trustpilot Webhook Handler - Receives real-time review notifications.
Handles service-review-created, service-review-updated, and service-review-deleted events.
"""
import json
import os
import boto3
from datetime import datetime, timezone
from typing import Any
from aws_lambda_powertools import Logger, Tracer, Metrics

logger = Logger()
tracer = Tracer()
metrics = Metrics()

# AWS Clients
sqs = boto3.client('sqs')
dynamodb = boto3.resource('dynamodb')
from boto3.dynamodb.conditions import Key, Attr

# Configuration
PROCESSING_QUEUE_URL = os.environ['PROCESSING_QUEUE_URL']
FEEDBACK_TABLE = os.environ['FEEDBACK_TABLE']
BRAND_NAME = os.environ.get('BRAND_NAME', 'Unknown')
SOURCE_PLATFORM = 'trustpilot'

feedback_table = dynamodb.Table(FEEDBACK_TABLE)


@tracer.capture_method
def normalize_review(event_data: dict) -> dict:
    """Normalize Trustpilot review to standard format."""
    return {
        'id': event_data['id'],
        'source_platform': SOURCE_PLATFORM,
        'channel': 'review',
        'url': event_data.get('link', ''),
        'text': event_data.get('text', ''),
        'title': event_data.get('title', ''),
        'rating': event_data.get('stars'),
        'language': event_data.get('language', 'en'),
        'created_at': event_data.get('createdAt'),
        'is_verified': event_data.get('isVerified', False),
        'location_id': event_data.get('locationId'),
        'reference_id': event_data.get('referenceId'),
        'consumer': {
            'id': event_data.get('consumer', {}).get('id'),
            'name': event_data.get('consumer', {}).get('name'),
        },
        'tags': event_data.get('tags', []),
        'brand_handles_matched': [BRAND_NAME],
    }


@tracer.capture_method
def handle_review_created(event_data: dict) -> dict:
    """Handle new review creation."""
    normalized = normalize_review(event_data)
    
    sqs.send_message(
        QueueUrl=PROCESSING_QUEUE_URL,
        MessageBody=json.dumps(normalized),
        MessageAttributes={
            'source': {'DataType': 'String', 'StringValue': SOURCE_PLATFORM},
            'event_type': {'DataType': 'String', 'StringValue': 'created'},
        }
    )
    
    metrics.add_metric(name="ReviewsCreated", unit="Count", value=1)
    logger.info(f"Queued new review: {event_data['id']}")
    return {'status': 'queued', 'review_id': event_data['id']}


@tracer.capture_method
def handle_review_updated(event_data: dict) -> dict:
    """Handle review update - reprocess with updated content."""
    normalized = normalize_review(event_data)
    normalized['is_update'] = True
    
    sqs.send_message(
        QueueUrl=PROCESSING_QUEUE_URL,
        MessageBody=json.dumps(normalized),
        MessageAttributes={
            'source': {'DataType': 'String', 'StringValue': SOURCE_PLATFORM},
            'event_type': {'DataType': 'String', 'StringValue': 'updated'},
        }
    )
    
    metrics.add_metric(name="ReviewsUpdated", unit="Count", value=1)
    logger.info(f"Queued updated review: {event_data['id']}")
    return {'status': 'queued', 'review_id': event_data['id']}


@tracer.capture_method
def handle_review_deleted(event_data: dict) -> dict:
    """Handle review deletion - mark as deleted in DynamoDB."""
    review_id = event_data['id']
    
    # Find and soft-delete the item
    try:
        response = feedback_table.query(
            KeyConditionExpression=Key('pk').eq(f'SOURCE#{SOURCE_PLATFORM}'),
            FilterExpression=Attr('feedback_id').eq(review_id)
        )
        
        for item in response.get('Items', []):
            feedback_table.update_item(
                Key={'pk': item['pk'], 'sk': item['sk']},
                UpdateExpression='SET deleted = :d, deleted_at = :t',
                ExpressionAttributeValues={
                    ':d': True,
                    ':t': datetime.now(timezone.utc).isoformat()
                }
            )
            logger.info(f"Marked review as deleted: {review_id}")
        
        metrics.add_metric(name="ReviewsDeleted", unit="Count", value=1)
        return {'status': 'deleted', 'review_id': review_id}
        
    except Exception as e:
        logger.error(f"Failed to delete review {review_id}: {e}")
        raise



EVENT_HANDLERS = {
    'service-review-created': handle_review_created,
    'service-review-updated': handle_review_updated,
    'service-review-deleted': handle_review_deleted,
}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler for Trustpilot webhooks."""
    logger.info(f"Received webhook event")
    
    # Parse body from API Gateway
    body = event.get('body', '{}')
    if isinstance(body, str):
        body = json.loads(body)
    
    events_list = body.get('events', [])
    results = []
    
    for evt in events_list:
        event_name = evt.get('eventName')
        event_data = evt.get('eventData', {})
        
        handler = EVENT_HANDLERS.get(event_name)
        if handler:
            try:
                result = handler(event_data)
                results.append(result)
            except Exception as e:
                logger.exception(f"Error handling {event_name}: {e}")
                results.append({'status': 'error', 'event': event_name, 'error': str(e)})
        else:
            logger.warning(f"Unknown event type: {event_name}")
            results.append({'status': 'skipped', 'event': event_name})
    
    metrics.add_metric(name="WebhookEventsProcessed", unit="Count", value=len(events_list))
    
    return {
        'statusCode': 200,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps({'processed': len(results), 'results': results})
    }
