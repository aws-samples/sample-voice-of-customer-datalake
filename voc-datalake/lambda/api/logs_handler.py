"""
Logs API Lambda - Handles /logs/*
Provides access to validation failures and processing errors for user visibility.
"""

import os
import sys
from datetime import datetime, timezone, timedelta
from typing import Any

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource

from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from boto3.dynamodb.conditions import Key, Attr

dynamodb = get_dynamodb_resource()
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

# Configure CORS
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "http://localhost:5173")
cors_config = CORSConfig(
    allow_origin=ALLOWED_ORIGIN, allow_headers=["Content-Type", "Authorization"], max_age=300
)
app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)


@app.get("/logs/validation")
@tracer.capture_method
def get_validation_logs():
    """
    Get validation failure logs.
    
    Query params:
    - source: Filter by source platform (optional)
    - days: Number of days to look back (default: 7)
    - limit: Max number of logs to return (default: 100)
    """
    if not aggregates_table:
        return {'logs': [], 'error': 'Aggregates table not configured'}
    
    params = app.current_event.query_string_parameters or {}
    source = params.get('source')
    days = int(params.get('days', '7'))
    limit = min(int(params.get('limit', '100')), 500)
    
    try:
        logs = []
        
        if source:
            # Query specific source
            logs = _query_logs_for_source('validation', source, days, limit)
        else:
            # Query all sources - need to scan or query known sources
            known_sources = [
                'trustpilot', 'yelp', 'google_reviews', 'twitter', 'instagram',
                'facebook', 'reddit', 'webscraper', 'manual_import', 's3_import',
                'appstore_apple', 'appstore_google', 'youtube', 'tiktok', 'linkedin'
            ]
            for src in known_sources:
                src_logs = _query_logs_for_source('validation', src, days, limit // len(known_sources) + 1)
                logs.extend(src_logs)
            
            # Sort by timestamp descending and limit
            logs.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
            logs = logs[:limit]
        
        return {
            'logs': logs,
            'count': len(logs),
            'days': days,
        }
    except Exception as e:
        logger.exception(f"Failed to get validation logs: {e}")
        return {'logs': [], 'error': 'Failed to retrieve logs'}


@app.get("/logs/processing")
@tracer.capture_method
def get_processing_logs():
    """
    Get processing error logs.
    
    Query params:
    - source: Filter by source platform (optional)
    - days: Number of days to look back (default: 7)
    - limit: Max number of logs to return (default: 100)
    """
    if not aggregates_table:
        return {'logs': [], 'error': 'Aggregates table not configured'}
    
    params = app.current_event.query_string_parameters or {}
    source = params.get('source')
    days = int(params.get('days', '7'))
    limit = min(int(params.get('limit', '100')), 500)
    
    try:
        logs = []
        
        if source:
            logs = _query_logs_for_source('processing', source, days, limit)
        else:
            known_sources = [
                'trustpilot', 'yelp', 'google_reviews', 'twitter', 'instagram',
                'facebook', 'reddit', 'webscraper', 'manual_import', 's3_import',
                'appstore_apple', 'appstore_google', 'youtube', 'tiktok', 'linkedin'
            ]
            for src in known_sources:
                src_logs = _query_logs_for_source('processing', src, days, limit // len(known_sources) + 1)
                logs.extend(src_logs)
            
            logs.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
            logs = logs[:limit]
        
        return {
            'logs': logs,
            'count': len(logs),
            'days': days,
        }
    except Exception as e:
        logger.exception(f"Failed to get processing logs: {e}")
        return {'logs': [], 'error': 'Failed to retrieve logs'}


@app.get("/logs/scraper/<scraper_id>")
@tracer.capture_method
def get_scraper_logs(scraper_id: str):
    """
    Get logs for a specific scraper.
    
    Query params:
    - days: Number of days to look back (default: 7)
    - limit: Max number of logs to return (default: 50)
    """
    if not aggregates_table:
        return {'logs': [], 'error': 'Aggregates table not configured'}
    
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', '7'))
    limit = min(int(params.get('limit', '50')), 200)
    
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        
        response = aggregates_table.query(
            KeyConditionExpression=Key('pk').eq(f"SCRAPER#{scraper_id}") & Key('sk').begins_with("RUN#"),
            ScanIndexForward=False,
            Limit=limit,
        )
        
        logs = []
        for item in response.get('Items', []):
            logs.append({
                'run_id': item.get('sk', '').replace('RUN#', ''),
                'status': item.get('status'),
                'started_at': item.get('started_at'),
                'completed_at': item.get('completed_at'),
                'pages_scraped': item.get('pages_scraped', 0),
                'items_found': item.get('items_found', 0),
                'errors': item.get('errors', []),
            })
        
        return {
            'scraper_id': scraper_id,
            'logs': logs,
            'count': len(logs),
        }
    except Exception as e:
        logger.exception(f"Failed to get scraper logs: {e}")
        return {'logs': [], 'error': 'Failed to retrieve logs'}


@app.get("/logs/summary")
@tracer.capture_method
def get_logs_summary():
    """
    Get a summary of recent logs across all sources.
    
    Returns counts of validation failures and processing errors per source.
    """
    if not aggregates_table:
        return {'summary': {}, 'error': 'Aggregates table not configured'}
    
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', '7'))
    
    try:
        summary = {
            'validation_failures': {},
            'processing_errors': {},
            'total_validation_failures': 0,
            'total_processing_errors': 0,
        }
        
        known_sources = [
            'trustpilot', 'yelp', 'google_reviews', 'twitter', 'instagram',
            'facebook', 'reddit', 'webscraper', 'manual_import', 's3_import',
            'appstore_apple', 'appstore_google', 'youtube', 'tiktok', 'linkedin'
        ]
        
        for source in known_sources:
            val_logs = _query_logs_for_source('validation', source, days, 1000)
            proc_logs = _query_logs_for_source('processing', source, days, 1000)
            
            if val_logs:
                summary['validation_failures'][source] = len(val_logs)
                summary['total_validation_failures'] += len(val_logs)
            
            if proc_logs:
                summary['processing_errors'][source] = len(proc_logs)
                summary['total_processing_errors'] += len(proc_logs)
        
        return {
            'summary': summary,
            'days': days,
        }
    except Exception as e:
        logger.exception(f"Failed to get logs summary: {e}")
        return {'summary': {}, 'error': 'Failed to retrieve summary'}


@app.delete("/logs/validation/<source>")
@tracer.capture_method
def clear_validation_logs(source: str):
    """Clear validation logs for a specific source."""
    if not aggregates_table:
        return {'success': False, 'message': 'Aggregates table not configured'}
    
    try:
        # Query and delete logs
        response = aggregates_table.query(
            KeyConditionExpression=Key('pk').eq(f"LOGS#validation#{source}"),
            ProjectionExpression='pk, sk',
        )
        
        deleted = 0
        with aggregates_table.batch_writer() as batch:
            for item in response.get('Items', []):
                batch.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
                deleted += 1
        
        return {'success': True, 'deleted': deleted}
    except Exception as e:
        logger.exception(f"Failed to clear validation logs: {e}")
        return {'success': False, 'message': 'Failed to clear logs'}


def _query_logs_for_source(log_type: str, source: str, days: int, limit: int) -> list:
    """Query logs for a specific source and type."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    
    response = aggregates_table.query(
        KeyConditionExpression=Key('pk').eq(f"LOGS#{log_type}#{source}") & Key('sk').gte(cutoff),
        ScanIndexForward=False,
        Limit=limit,
    )
    
    logs = []
    for item in response.get('Items', []):
        log_entry = {
            'source_platform': item.get('source_platform'),
            'message_id': item.get('message_id'),
            'timestamp': item.get('timestamp'),
            'log_type': item.get('log_type'),
        }
        
        if log_type == 'validation':
            log_entry['errors'] = item.get('errors', [])
            log_entry['raw_preview'] = item.get('raw_preview')
        else:
            log_entry['error_type'] = item.get('error_type')
            log_entry['error_message'] = item.get('error_message')
        
        logs.append(log_entry)
    
    return logs


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
