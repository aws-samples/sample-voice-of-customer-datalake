"""
VoC Metrics API Lambda
Handles read-only queries: /feedback/*, /metrics/*
Split from main handler to reduce Lambda resource policy size.
"""

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Any

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource

from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.event_handler.exceptions import NotFoundError
from boto3.dynamodb.conditions import Key

# AWS Clients
dynamodb = get_dynamodb_resource()

# Configuration
FEEDBACK_TABLE = os.environ.get("FEEDBACK_TABLE", "")
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")

feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

# Configure CORS - restrict to CloudFront domain in production
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "http://localhost:5173")
cors_config = CORSConfig(
    allow_origin=ALLOWED_ORIGIN,
    allow_headers=[
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "X-Amz-Date",
        "X-Api-Key",
        "X-Amz-Security-Token",
    ],
    expose_headers=["Content-Type"],
    max_age=300,
    allow_credentials=False,
)

app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def get_date_range(days: int = 30) -> tuple[str, str]:
    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=days)
    return start_date.strftime('%Y-%m-%d'), end_date.strftime('%Y-%m-%d')


# ============================================
# Feedback Endpoints
# ============================================

@app.get("/feedback")
@tracer.capture_method
def list_feedback():
    """List feedback with optional filters."""
    params = app.current_event.query_string_parameters or {}
    
    days = int(params.get('days', 7))
    source = params.get('source')
    category = params.get('category')
    sentiment = params.get('sentiment')
    limit = min(int(params.get('limit', 50)), 100)
    
    items = []
    current_date = datetime.now(timezone.utc)
    cutoff_date = (current_date - timedelta(days=days)).strftime('%Y-%m-%d')
    
    if source:
        # Query by source, then filter by category/sentiment/date in memory
        response = feedback_table.query(
            KeyConditionExpression=Key('pk').eq(f'SOURCE#{source}'),
            Limit=500,  # Fetch more to allow filtering
            ScanIndexForward=False
        )
        items = response.get('Items', [])
        # Filter by date range
        items = [i for i in items if i.get('date', '') >= cutoff_date]
        # Filter by category if specified
        if category:
            items = [i for i in items if i.get('category') == category]
    elif category:
        response = feedback_table.query(
            IndexName='gsi2-by-category',
            KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
            Limit=limit,
            ScanIndexForward=False
        )
        items = response.get('Items', [])
    else:
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=limit - len(items),
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
            if len(items) >= limit:
                break
    
    if sentiment:
        items = [i for i in items if i.get('sentiment_label') == sentiment]
    
    return {'count': len(items), 'items': items[:limit]}


@app.get("/feedback/urgent")
@tracer.capture_method
def get_urgent_feedback():
    """Get high-urgency feedback items."""
    params = app.current_event.query_string_parameters or {}
    limit = min(int(params.get('limit', 50)), 100)
    
    response = feedback_table.query(
        IndexName='gsi3-by-urgency',
        KeyConditionExpression=Key('gsi3pk').eq('URGENCY#high'),
        Limit=limit,
        ScanIndexForward=False
    )
    
    items = []
    for gsi_item in response.get('Items', []):
        pk = gsi_item.get('pk')
        sk = gsi_item.get('sk')
        if pk and sk:
            full_item = feedback_table.get_item(Key={'pk': pk, 'sk': sk})
            if full_item.get('Item'):
                items.append(full_item['Item'])
        if len(items) >= limit:
            break
    
    return {'count': len(items), 'items': items[:limit]}


@app.get("/feedback/entities")
@tracer.capture_method
def get_entities():
    """Get entity extraction for chat filters."""
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', 7))
    limit = min(int(params.get('limit', 100)), 200)
    source = params.get('source')
    
    current_date = datetime.now(timezone.utc)
    cutoff_date = (current_date - timedelta(days=days)).strftime('%Y-%m-%d')
    
    # If source filter is provided, query feedback table directly
    if source:
        response = feedback_table.query(
            KeyConditionExpression=Key('pk').eq(f'SOURCE#{source}'),
            Limit=1000,
            ScanIndexForward=False
        )
        
        category_counts = {}
        issues = {}
        feedback_count = 0
        
        for item in response.get('Items', []):
            item_date = item.get('date', '')
            if item_date >= cutoff_date:
                feedback_count += 1
                category = item.get('category', 'other')
                category_counts[category] = category_counts.get(category, 0) + 1
                
                problem = item.get('problem_summary', '')
                if problem and len(problem) > 5:
                    problem_key = problem[:100].lower().strip()
                    issues[problem_key] = issues.get(problem_key, 0) + 1
        
        sorted_issues = dict(sorted(issues.items(), key=lambda x: x[1], reverse=True)[:20])
        
        return {
            'period_days': days,
            'feedback_count': feedback_count,
            'entities': {
                'keywords': {},
                'categories': dict(sorted(category_counts.items(), key=lambda x: x[1], reverse=True)),
                'issues': sorted_issues,
                'personas': {},
                'sources': {source: feedback_count} if feedback_count > 0 else {},
            }
        }
    
    # Get categories from aggregates
    categories_list = ['delivery', 'customer_support', 'product_quality', 'pricing', 
                       'website', 'app', 'billing', 'returns', 'communication', 'other']
    category_counts = {}
    for category in categories_list:
        total = 0
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = aggregates_table.get_item(
                Key={'pk': f'METRIC#daily_category#{category}', 'sk': date}
            )
            item = response.get('Item')
            if item:
                total += int(item.get('count', 0))
        if total > 0:
            category_counts[category] = total
    
    # Get sources from aggregates using GSI
    source_response = aggregates_table.query(
        IndexName='gsi1-by-metric-type',
        KeyConditionExpression=Key('metric_type').eq('source')
    )
    source_totals = {}
    date_range = set((current_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(days))
    for item in source_response.get('Items', []):
        if item.get('sk') in date_range:
            source = item['pk'].replace('METRIC#daily_source#', '')
            count = int(item.get('count', 0))
            source_totals[source] = source_totals.get(source, 0) + count
    
    # Get personas from aggregates using GSI
    persona_response = aggregates_table.query(
        IndexName='gsi1-by-metric-type',
        KeyConditionExpression=Key('metric_type').eq('persona')
    )
    persona_counts = {}
    for item in persona_response.get('Items', []):
        if item.get('sk') in date_range:
            persona_name = item['pk'].replace('METRIC#persona#', '')
            persona_counts[persona_name] = persona_counts.get(persona_name, 0) + int(item.get('count', 0))
    
    # Get feedback count
    feedback_count = 0
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(Key={'pk': 'METRIC#daily_total', 'sk': date})
        item = response.get('Item')
        if item:
            feedback_count += int(item.get('count', 0))
    
    # Extract issues from recent feedback
    issues = {}
    feedback_items = []
    for i in range(min(days, 7)):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = feedback_table.query(
            IndexName='gsi1-by-date',
            KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
            Limit=50,
            ScanIndexForward=False
        )
        feedback_items.extend(response.get('Items', []))
        if len(feedback_items) >= limit:
            break
    
    for item in feedback_items[:limit]:
        problem = item.get('problem_summary', '')
        if problem and len(problem) > 5:
            problem_key = problem[:100].lower().strip()
            issues[problem_key] = issues.get(problem_key, 0) + 1
    
    sorted_issues = dict(sorted(issues.items(), key=lambda x: x[1], reverse=True)[:20])
    
    return {
        'period_days': days,
        'feedback_count': feedback_count,
        'entities': {
            'keywords': {},
            'categories': dict(sorted(category_counts.items(), key=lambda x: x[1], reverse=True)),
            'issues': sorted_issues,
            'personas': dict(sorted(persona_counts.items(), key=lambda x: x[1], reverse=True)),
            'sources': dict(sorted(source_totals.items(), key=lambda x: x[1], reverse=True)),
        }
    }



@app.get("/feedback/<feedback_id>")
@tracer.capture_method
def get_feedback(feedback_id: str):
    """Get a single feedback item by ID."""
    # Use GSI4 to query by feedback_id instead of scanning
    response = feedback_table.query(
        IndexName='gsi4-by-feedback-id',
        KeyConditionExpression=Key('feedback_id').eq(feedback_id),
        Limit=1
    )
    
    items = response.get('Items', [])
    if not items:
        raise NotFoundError(f"Feedback {feedback_id} not found")
    
    return items[0]


@app.get("/feedback/<feedback_id>/similar")
@tracer.capture_method
def get_similar_feedback(feedback_id: str):
    """Get feedback items similar to the given one."""
    params = app.current_event.query_string_parameters or {}
    limit = min(int(params.get('limit', 8)), 50)
    
    # Use GSI4 to query by feedback_id instead of scanning
    response = feedback_table.query(
        IndexName='gsi4-by-feedback-id',
        KeyConditionExpression=Key('feedback_id').eq(feedback_id),
        Limit=1
    )
    
    items = response.get('Items', [])
    if not items:
        raise NotFoundError(f"Feedback {feedback_id} not found")
    
    source_item = items[0]
    
    # Find similar by category
    category = source_item.get('category', 'other')
    response = feedback_table.query(
        IndexName='gsi2-by-category',
        KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
        Limit=limit + 10,
        ScanIndexForward=False
    )
    
    similar_items = [item for item in response.get('Items', []) if item.get('feedback_id') != feedback_id][:limit]
    
    return {
        'source_feedback_id': feedback_id,
        'count': len(similar_items),
        'items': similar_items
    }


# ============================================
# Metrics Endpoints
# ============================================

@app.get("/metrics/summary")
@tracer.capture_method
def get_summary():
    """Get dashboard summary metrics."""
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', 30))
    
    current_date = datetime.now(timezone.utc)
    
    totals = []
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(Key={'pk': 'METRIC#daily_total', 'sk': date})
        item = response.get('Item')
        if item:
            totals.append({'date': date, 'count': item.get('count', 0)})
    
    sentiment_data = []
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(Key={'pk': 'METRIC#daily_sentiment_avg', 'sk': date})
        item = response.get('Item')
        if item and item.get('count', 0) > 0:
            avg = float(item.get('sum', 0)) / float(item.get('count', 1))
            sentiment_data.append({'date': date, 'avg_sentiment': round(avg, 3), 'count': item.get('count')})
    
    urgent_count = 0
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(Key={'pk': 'METRIC#urgent', 'sk': date})
        item = response.get('Item')
        if item:
            urgent_count += item.get('count', 0)
    
    total_feedback = sum(int(t.get('count', 0)) for t in totals)
    avg_sentiment = sum(float(s.get('avg_sentiment', 0)) * int(s.get('count', 0)) for s in sentiment_data) / max(total_feedback, 1)
    
    return {
        'period_days': days,
        'total_feedback': total_feedback,
        'avg_sentiment': round(avg_sentiment, 3),
        'urgent_count': urgent_count,
        'daily_totals': totals,
        'daily_sentiment': sentiment_data
    }


@app.get("/metrics/sentiment")
@tracer.capture_method
def get_sentiment_metrics():
    """Get sentiment breakdown."""
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', 30))
    source = params.get('source')
    
    sentiments = ['positive', 'neutral', 'negative', 'mixed']
    result = {s: 0 for s in sentiments}
    current_date = datetime.now(timezone.utc)
    
    if source:
        # Query feedback table directly for source-specific data
        response = feedback_table.query(
            KeyConditionExpression=Key('pk').eq(f'SOURCE#{source}'),
            Limit=1000,
            ScanIndexForward=False
        )
        cutoff_date = (current_date - timedelta(days=days)).strftime('%Y-%m-%d')
        for item in response.get('Items', []):
            item_date = item.get('date', '')
            if item_date >= cutoff_date:
                sentiment = item.get('sentiment_label', 'neutral')
                if sentiment in result:
                    result[sentiment] += 1
    else:
        # Use pre-aggregated data
        for sentiment in sentiments:
            total = 0
            for i in range(days):
                date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
                response = aggregates_table.get_item(Key={'pk': f'METRIC#daily_sentiment#{sentiment}', 'sk': date})
                item = response.get('Item')
                if item:
                    total += int(item.get('count', 0))
            result[sentiment] = total
    
    total = sum(result.values())
    return {
        'period_days': days,
        'total': total,
        'breakdown': result,
        'percentages': {k: round(v / max(total, 1) * 100, 1) for k, v in result.items()}
    }


@app.get("/metrics/categories")
@tracer.capture_method
def get_category_metrics():
    """Get category breakdown."""
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', 30))
    source = params.get('source')
    
    categories = ['delivery', 'customer_support', 'product_quality', 'pricing', 
                  'website', 'app', 'billing', 'returns', 'communication', 'other']
    result = {}
    current_date = datetime.now(timezone.utc)
    
    if source:
        # Query feedback table directly for source-specific data
        response = feedback_table.query(
            KeyConditionExpression=Key('pk').eq(f'SOURCE#{source}'),
            Limit=1000,
            ScanIndexForward=False
        )
        cutoff_date = (current_date - timedelta(days=days)).strftime('%Y-%m-%d')
        for item in response.get('Items', []):
            item_date = item.get('date', '')
            if item_date >= cutoff_date:
                category = item.get('category', 'other')
                result[category] = result.get(category, 0) + 1
    else:
        # Use pre-aggregated data
        for category in categories:
            total = 0
            for i in range(days):
                date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
                response = aggregates_table.get_item(Key={'pk': f'METRIC#daily_category#{category}', 'sk': date})
                item = response.get('Item')
                if item:
                    total += item.get('count', 0)
            if total > 0:
                result[category] = total
    
    return {
        'period_days': days,
        'categories': dict(sorted(result.items(), key=lambda x: x[1], reverse=True))
    }


@app.get("/metrics/sources")
@tracer.capture_method
def get_source_metrics():
    """Get source platform breakdown."""
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', 30))
    
    # Use GSI to query by metric_type instead of scanning
    response = aggregates_table.query(
        IndexName='gsi1-by-metric-type',
        KeyConditionExpression=Key('metric_type').eq('source')
    )
    
    source_totals = {}
    current_date = datetime.now(timezone.utc)
    date_range = set((current_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(days))
    
    for item in response.get('Items', []):
        if item.get('sk') in date_range:
            source = item['pk'].replace('METRIC#daily_source#', '')
            count = int(item.get('count', 0))
            source_totals[source] = source_totals.get(source, 0) + count
    
    return {
        'period_days': days,
        'sources': dict(sorted(source_totals.items(), key=lambda x: x[1], reverse=True))
    }


@app.get("/metrics/personas")
@tracer.capture_method
def get_persona_metrics():
    """Get persona breakdown."""
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', 30))
    
    # Use GSI to query by metric_type instead of scanning
    response = aggregates_table.query(
        IndexName='gsi1-by-metric-type',
        KeyConditionExpression=Key('metric_type').eq('persona')
    )
    
    personas = {}
    current_date = datetime.now(timezone.utc)
    date_range = set((current_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(days))
    
    for item in response.get('Items', []):
        if item.get('sk') in date_range:
            persona_name = item['pk'].replace('METRIC#persona#', '')
            personas[persona_name] = personas.get(persona_name, 0) + int(item.get('count', 0))
    
    return {
        'period_days': days,
        'personas': dict(sorted(personas.items(), key=lambda x: x[1], reverse=True))
    }


# ============================================
# Lambda Handler
# ============================================

@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
