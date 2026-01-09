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

# Default categories fallback
DEFAULT_CATEGORIES = ['delivery', 'customer_support', 'product_quality', 'pricing', 
                      'website', 'app', 'billing', 'returns', 'communication', 'other']

# Cache for configured categories
_categories_cache = None
_categories_cache_time = None
CATEGORIES_CACHE_TTL = 300  # 5 minutes


def get_configured_categories() -> list:
    """Fetch configured categories from DynamoDB settings with caching."""
    global _categories_cache, _categories_cache_time
    
    now = datetime.now(timezone.utc).timestamp()
    
    # Return cached if still valid
    if _categories_cache is not None and _categories_cache_time and (now - _categories_cache_time) < CATEGORIES_CACHE_TTL:
        return _categories_cache
    
    try:
        response = aggregates_table.get_item(Key={'pk': 'SETTINGS#categories', 'sk': 'config'})
        item = response.get('Item')
        if item and item.get('categories'):
            _categories_cache = [cat.get('name') for cat in item.get('categories', []) if cat.get('name')]
            _categories_cache_time = now
            logger.info(f"Loaded {len(_categories_cache)} categories from settings")
            return _categories_cache
    except Exception as e:
        logger.warning(f"Could not fetch categories from settings: {e}")
    
    # Fallback to defaults
    _categories_cache = DEFAULT_CATEGORIES
    _categories_cache_time = now
    return _categories_cache


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def validate_days(value: str | int | None, default: int = 7, min_val: int = 1, max_val: int = 365) -> int:
    """Validate and bound days parameter."""
    try:
        days = int(value) if value is not None else default
        return max(min_val, min(days, max_val))
    except (ValueError, TypeError):
        return default


def validate_limit(value: str | int | None, default: int = 50, min_val: int = 1, max_val: int = 100) -> int:
    """Validate and bound limit parameter."""
    try:
        limit = int(value) if value is not None else default
        return max(min_val, min(limit, max_val))
    except (ValueError, TypeError):
        return default


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
    
    days = validate_days(params.get('days'), default=7)
    source = params.get('source')
    category = params.get('category')
    sentiment = params.get('sentiment')
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    
    items = []
    current_date = datetime.now(timezone.utc)
    
    # Query by date using GSI1, then filter by source/category/sentiment in memory
    # This approach is consistent because source_platform field matches metrics aggregation
    if category and not source:
        # Category-only filter can use GSI2 efficiently
        response = feedback_table.query(
            IndexName='gsi2-by-category',
            KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
            Limit=limit * 2,  # Fetch extra for sentiment filtering
            ScanIndexForward=False
        )
        items = response.get('Items', [])
    else:
        # Query by date range, filter source/category in memory
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=500,  # Fetch more to allow filtering
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
            # Stop early if we have enough items (before filtering)
            if len(items) >= limit * 5:
                break
    
    # Apply source filter using source_platform field (matches metrics aggregation)
    if source:
        items = [i for i in items if i.get('source_platform') == source]
    
    # Apply category filter if not already filtered by GSI
    if category and source:
        items = [i for i in items if i.get('category') == category]
    
    # Apply sentiment filter
    if sentiment:
        items = [i for i in items if i.get('sentiment_label') == sentiment]
    
    return {'count': len(items), 'items': items[:limit]}


@app.get("/feedback/urgent")
@tracer.capture_method
def get_urgent_feedback():
    """Get high-urgency feedback items with optional filters."""
    params = app.current_event.query_string_parameters or {}
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    days = validate_days(params.get('days'), default=30)
    source_filter = params.get('source')
    sentiment_filter = params.get('sentiment')
    category_filter = params.get('category')
    
    current_date = datetime.now(timezone.utc)
    cutoff_date = (current_date - timedelta(days=days)).strftime('%Y-%m-%d')
    
    # Query urgent items - fetch more to allow for filtering
    fetch_limit = limit * 5 if (source_filter or sentiment_filter or category_filter) else limit
    
    response = feedback_table.query(
        IndexName='gsi3-by-urgency',
        KeyConditionExpression=Key('gsi3pk').eq('URGENCY#high'),
        Limit=fetch_limit,
        ScanIndexForward=False
    )
    
    items = []
    for gsi_item in response.get('Items', []):
        pk = gsi_item.get('pk')
        sk = gsi_item.get('sk')
        if pk and sk:
            full_item = feedback_table.get_item(Key={'pk': pk, 'sk': sk})
            item = full_item.get('Item')
            if not item:
                continue
            
            # Apply date filter
            item_date = item.get('date', '')
            if item_date < cutoff_date:
                continue
            
            # Apply source filter
            if source_filter and item.get('source_platform') != source_filter:
                continue
            
            # Apply sentiment filter
            if sentiment_filter and item.get('sentiment_label') != sentiment_filter:
                continue
            
            # Apply category filter
            if category_filter and item.get('category') != category_filter:
                continue
            
            items.append(item)
            if len(items) >= limit:
                break
    
    return {'count': len(items), 'items': items[:limit]}


@app.get("/feedback/entities")
@tracer.capture_method
def get_entities():
    """Get entity extraction for chat filters."""
    params = app.current_event.query_string_parameters or {}
    days = validate_days(params.get('days'), default=7)
    limit = validate_limit(params.get('limit'), default=100, max_val=200)
    source = params.get('source')
    
    current_date = datetime.now(timezone.utc)
    
    # If source filter is provided, query by date and filter by source_platform
    if source:
        items = []
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=500,
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
            if len(items) >= 1000:
                break
        
        # Filter by source_platform field
        items = [i for i in items if i.get('source_platform') == source]
        
        category_counts = {}
        issues = {}
        feedback_count = len(items)
        
        for item in items:
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
    
    # Get categories from aggregates (use configured categories)
    categories_list = get_configured_categories()
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



@app.get("/feedback/search")
@tracer.capture_method
def search_feedback():
    """Search feedback by text query with optional filters.
    
    Searches in original_text and title fields.
    Supports filtering by source, sentiment, category.
    """
    params = app.current_event.query_string_parameters or {}
    
    query = params.get('q', '').strip().lower()
    if not query or len(query) < 2:
        return {'count': 0, 'items': [], 'entities': {}, 'query': query}
    
    days = validate_days(params.get('days'), default=30)
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    source_filter = params.get('source')
    sentiment_filter = params.get('sentiment')
    category_filter = params.get('category')
    
    current_date = datetime.now(timezone.utc)
    cutoff_date = (current_date - timedelta(days=days)).strftime('%Y-%m-%d')
    
    items = []
    
    # Query recent feedback by date, then filter by source_platform in memory
    candidates = []
    for i in range(min(days, 30)):  # Cap at 30 days for performance
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = feedback_table.query(
            IndexName='gsi1-by-date',
            KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
            Limit=300,
            ScanIndexForward=False
        )
        candidates.extend(response.get('Items', []))
        if len(candidates) >= 1000:
            break
    
    # Filter candidates by search query and other filters
    for item in candidates:
        # Date filter
        item_date = item.get('date', '')
        if item_date < cutoff_date:
            continue
        
        # Source filter using source_platform field
        if source_filter and item.get('source_platform') != source_filter:
            continue
        
        # Sentiment filter
        if sentiment_filter and item.get('sentiment_label') != sentiment_filter:
            continue
        
        # Category filter
        if category_filter and item.get('category') != category_filter:
            continue
        
        # Text search in original_text and title
        original_text = (item.get('original_text') or '').lower()
        title = (item.get('title') or '').lower()
        problem_summary = (item.get('problem_summary') or '').lower()
        
        if query in original_text or query in title or query in problem_summary:
            items.append(item)
            if len(items) >= limit:
                break
    
    # Build entities summary from results
    category_counts = {}
    source_counts = {}
    sentiment_counts = {}
    
    for item in items:
        cat = item.get('category', 'other')
        category_counts[cat] = category_counts.get(cat, 0) + 1
        
        src = item.get('source_platform', 'unknown')
        source_counts[src] = source_counts.get(src, 0) + 1
        
        sent = item.get('sentiment_label', 'neutral')
        sentiment_counts[sent] = sentiment_counts.get(sent, 0) + 1
    
    return {
        'count': len(items),
        'items': items,
        'entities': {
            'categories': dict(sorted(category_counts.items(), key=lambda x: x[1], reverse=True)),
            'sources': dict(sorted(source_counts.items(), key=lambda x: x[1], reverse=True)),
            'sentiments': dict(sorted(sentiment_counts.items(), key=lambda x: x[1], reverse=True)),
        },
        'query': query
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
    limit = validate_limit(params.get('limit'), default=8, max_val=50)
    
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
    days = validate_days(params.get('days'), default=30)
    
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
    days = validate_days(params.get('days'), default=30)
    source = params.get('source')
    
    sentiments = ['positive', 'neutral', 'negative', 'mixed']
    result = {s: 0 for s in sentiments}
    current_date = datetime.now(timezone.utc)
    
    if source:
        # Query by date and filter by source_platform field
        items = []
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=500,
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
            if len(items) >= 1000:
                break
        
        # Filter by source_platform field
        for item in items:
            if item.get('source_platform') == source:
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
    days = validate_days(params.get('days'), default=30)
    source = params.get('source')
    
    # Fetch configured categories from settings (dynamic, not hardcoded)
    categories = []
    try:
        response = aggregates_table.get_item(Key={'pk': 'SETTINGS#categories', 'sk': 'config'})
        item = response.get('Item')
        if item and item.get('categories'):
            categories = [cat.get('name') for cat in item.get('categories', []) if cat.get('name')]
            logger.info(f"Loaded {len(categories)} categories from settings: {categories}")
    except Exception as e:
        logger.warning(f"Could not fetch categories from settings: {e}")
    
    # Fallback to defaults if no categories configured
    if not categories:
        categories = DEFAULT_CATEGORIES
    
    result = {}
    current_date = datetime.now(timezone.utc)
    
    if source:
        # Query by date and filter by source_platform field
        items = []
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=500,
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
            if len(items) >= 1000:
                break
        
        # Filter by source_platform field
        for item in items:
            if item.get('source_platform') == source:
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
    days = validate_days(params.get('days'), default=30)
    
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
    days = validate_days(params.get('days'), default=30)
    
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
