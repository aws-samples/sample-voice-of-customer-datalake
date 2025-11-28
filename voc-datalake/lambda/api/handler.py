"""
VoC Analytics API Lambda
Provides REST API endpoints for querying feedback and metrics from DynamoDB.
"""
import json
import os
import boto3
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Any
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.event_handler.exceptions import NotFoundError
from boto3.dynamodb.conditions import Key, Attr

logger = Logger()
tracer = Tracer()

# AWS Clients
dynamodb = boto3.resource('dynamodb')
secretsmanager = boto3.client('secretsmanager')

# Configuration
FEEDBACK_TABLE = os.environ['FEEDBACK_TABLE']
AGGREGATES_TABLE = os.environ['AGGREGATES_TABLE']
SECRETS_ARN = os.environ.get('SECRETS_ARN', '')
API_ENDPOINT = os.environ.get('API_ENDPOINT', '')
PIPELINES_TABLE = os.environ.get('PIPELINES_TABLE', '')
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')

feedback_table = dynamodb.Table(FEEDBACK_TABLE)
aggregates_table = dynamodb.Table(AGGREGATES_TABLE)
pipelines_table = dynamodb.Table(PIPELINES_TABLE) if PIPELINES_TABLE else None
projects_table = dynamodb.Table(PROJECTS_TABLE) if PROJECTS_TABLE else None

# Configure CORS - allow all origins for cross-origin requests
cors_config = CORSConfig(
    allow_origin="*",
    allow_headers=["Content-Type", "Authorization", "X-Requested-With", "X-Amz-Date", "X-Api-Key", "X-Amz-Security-Token"],
    expose_headers=["Content-Type"],
    max_age=300,
    allow_credentials=False  # Must be False when allow_origin is "*"
)

app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)


class DecimalEncoder(json.JSONEncoder):
    """Handle Decimal serialization."""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def json_response(data: dict, status_code: int = 200) -> dict:
    """Create JSON response."""
    return {
        'statusCode': status_code,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(data, cls=DecimalEncoder)
    }


def get_date_range(days: int = 30) -> tuple[str, str]:
    """Get date range for queries."""
    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=days)
    return start_date.strftime('%Y-%m-%d'), end_date.strftime('%Y-%m-%d')


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
    
    start_date, end_date = get_date_range(days)
    
    items = []
    
    if source:
        # Query by source
        response = feedback_table.query(
            KeyConditionExpression=Key('pk').eq(f'SOURCE#{source}'),
            Limit=limit,
            ScanIndexForward=False
        )
        items = response.get('Items', [])
    elif category:
        # Query by category using GSI2
        response = feedback_table.query(
            IndexName='gsi2-by-category',
            KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
            Limit=limit,
            ScanIndexForward=False
        )
        items = response.get('Items', [])
    else:
        # Query by date using GSI1
        current_date = datetime.now(timezone.utc)
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
    
    # Apply additional filters
    if sentiment:
        items = [i for i in items if i.get('sentiment_label') == sentiment]
    
    return {
        'count': len(items),
        'items': items[:limit]
    }


@app.get("/feedback/<feedback_id>")
@tracer.capture_method
def get_feedback(feedback_id: str):
    """Get a single feedback item by ID."""
    # Scan for the item with pagination to ensure we find it
    items = []
    last_key = None
    
    while True:
        scan_params = {
            'FilterExpression': Attr('feedback_id').eq(feedback_id),
        }
        if last_key:
            scan_params['ExclusiveStartKey'] = last_key
        
        response = feedback_table.scan(**scan_params)
        items.extend(response.get('Items', []))
        
        if items:
            break  # Found the item
        
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            break  # No more pages
    
    if not items:
        raise NotFoundError(f"Feedback {feedback_id} not found")
    
    return items[0]


@app.get("/feedback/<feedback_id>/similar")
@tracer.capture_method
def get_similar_feedback(feedback_id: str):
    """Get feedback items similar to the given one based on category and sentiment."""
    params = app.current_event.query_string_parameters or {}
    limit = min(int(params.get('limit', 8)), 50)
    
    # First, get the source feedback item
    source_item = None
    last_key = None
    
    while True:
        scan_params = {
            'FilterExpression': Attr('feedback_id').eq(feedback_id),
        }
        if last_key:
            scan_params['ExclusiveStartKey'] = last_key
        
        response = feedback_table.scan(**scan_params)
        items = response.get('Items', [])
        
        if items:
            source_item = items[0]
            break
        
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            break
    
    if not source_item:
        raise NotFoundError(f"Feedback {feedback_id} not found")
    
    # Find similar items by category
    category = source_item.get('category', 'other')
    similar_items = []
    
    # Query by category using GSI2
    response = feedback_table.query(
        IndexName='gsi2-by-category',
        KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
        Limit=limit + 10,  # Get extra to filter out source item
        ScanIndexForward=False
    )
    
    for item in response.get('Items', []):
        if item.get('feedback_id') != feedback_id:
            similar_items.append(item)
        if len(similar_items) >= limit:
            break
    
    return {
        'source_feedback_id': feedback_id,
        'count': len(similar_items),
        'items': similar_items[:limit]
    }


@app.get("/feedback/urgent")
@tracer.capture_method
def get_urgent_feedback():
    """Get high-urgency feedback items."""
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', 7))
    limit = min(int(params.get('limit', 50)), 100)
    
    # Query GSI to get urgent item keys
    response = feedback_table.query(
        IndexName='gsi3-by-urgency',
        KeyConditionExpression=Key('gsi3pk').eq('URGENCY#high'),
        Limit=limit,
        ScanIndexForward=False
    )
    
    # Fetch full items using the primary keys
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
    
    return {
        'count': len(items),
        'items': items[:limit]
    }


@app.get("/metrics/summary")
@tracer.capture_method
def get_summary():
    """Get dashboard summary metrics."""
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', 30))
    
    start_date, end_date = get_date_range(days)
    
    # Get daily totals
    totals = []
    current_date = datetime.now(timezone.utc)
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(
            Key={'pk': 'METRIC#daily_total', 'sk': date}
        )
        item = response.get('Item')
        if item:
            totals.append({'date': date, 'count': item.get('count', 0)})
    
    # Get sentiment averages
    sentiment_data = []
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(
            Key={'pk': 'METRIC#daily_sentiment_avg', 'sk': date}
        )
        item = response.get('Item')
        if item and item.get('count', 0) > 0:
            avg = float(item.get('sum', 0)) / float(item.get('count', 1))
            sentiment_data.append({'date': date, 'avg_sentiment': round(avg, 3), 'count': item.get('count')})
    
    # Get urgent count
    urgent_count = 0
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(
            Key={'pk': 'METRIC#urgent', 'sk': date}
        )
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
    
    sentiments = ['positive', 'neutral', 'negative', 'mixed']
    result = {}
    
    current_date = datetime.now(timezone.utc)
    for sentiment in sentiments:
        total = 0
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = aggregates_table.get_item(
                Key={'pk': f'METRIC#daily_sentiment#{sentiment}', 'sk': date}
            )
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
    
    categories = ['delivery', 'customer_support', 'product_quality', 'pricing', 
                  'website', 'app', 'billing', 'returns', 'communication', 'other']
    result = {}
    
    current_date = datetime.now(timezone.utc)
    for category in categories:
        total = 0
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = aggregates_table.get_item(
                Key={'pk': f'METRIC#daily_category#{category}', 'sk': date}
            )
            item = response.get('Item')
            if item:
                total += item.get('count', 0)
        if total > 0:
            result[category] = total
    
    # Sort by count
    sorted_result = dict(sorted(result.items(), key=lambda x: x[1], reverse=True))
    
    return {
        'period_days': days,
        'categories': sorted_result
    }


@app.get("/metrics/sources")
@tracer.capture_method
def get_source_metrics():
    """Get source platform breakdown - dynamically discovers sources from aggregates."""
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', 30))
    
    # Scan for all source metrics to discover sources dynamically
    response = aggregates_table.scan(
        FilterExpression=Attr('pk').begins_with('METRIC#daily_source#')
    )
    
    # Aggregate by source
    source_totals = {}
    current_date = datetime.now(timezone.utc)
    date_range = set((current_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(days))
    
    for item in response.get('Items', []):
        if item.get('sk') in date_range:
            # Extract source name from pk (METRIC#daily_source#<source_name>)
            source = item['pk'].replace('METRIC#daily_source#', '')
            count = int(item.get('count', 0))
            source_totals[source] = source_totals.get(source, 0) + count
    
    # Sort by count descending
    sorted_sources = dict(sorted(source_totals.items(), key=lambda x: x[1], reverse=True))
    
    return {
        'period_days': days,
        'sources': sorted_sources
    }


@app.get("/metrics/personas")
@tracer.capture_method
def get_persona_metrics():
    """Get persona breakdown."""
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', 30))
    
    # Query all persona metrics
    response = aggregates_table.scan(
        FilterExpression=Attr('pk').begins_with('METRIC#persona#')
    )
    
    personas = {}
    for item in response.get('Items', []):
        persona_name = item['pk'].replace('METRIC#persona#', '')
        if persona_name not in personas:
            personas[persona_name] = 0
        personas[persona_name] += item.get('count', 0)
    
    sorted_personas = dict(sorted(personas.items(), key=lambda x: x[1], reverse=True))
    
    return {
        'period_days': days,
        'personas': sorted_personas
    }


@app.get("/feedback/entities")
@tracer.capture_method
def get_entities():
    """Get entity extraction for chat filters - keywords, categories, issues, personas, sources."""
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', 7))
    limit = min(int(params.get('limit', 100)), 200)
    
    current_date = datetime.now(timezone.utc)
    
    # Get categories from aggregates
    categories = ['delivery', 'customer_support', 'product_quality', 'pricing', 
                  'website', 'app', 'billing', 'returns', 'communication', 'other']
    category_counts = {}
    for category in categories:
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
    
    # Get sources from aggregates
    source_response = aggregates_table.scan(
        FilterExpression=Attr('pk').begins_with('METRIC#daily_source#')
    )
    source_totals = {}
    date_range = set((current_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(days))
    for item in source_response.get('Items', []):
        if item.get('sk') in date_range:
            source = item['pk'].replace('METRIC#daily_source#', '')
            count = int(item.get('count', 0))
            source_totals[source] = source_totals.get(source, 0) + count
    
    # Get personas from aggregates
    persona_response = aggregates_table.scan(
        FilterExpression=Attr('pk').begins_with('METRIC#persona#')
    )
    persona_counts = {}
    for item in persona_response.get('Items', []):
        persona_name = item['pk'].replace('METRIC#persona#', '')
        if persona_name not in persona_counts:
            persona_counts[persona_name] = 0
        persona_counts[persona_name] += int(item.get('count', 0))
    
    # Get feedback count
    feedback_count = 0
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(
            Key={'pk': 'METRIC#daily_total', 'sk': date}
        )
        item = response.get('Item')
        if item:
            feedback_count += int(item.get('count', 0))
    
    # Extract keywords/issues from recent feedback (sample)
    keywords = {}
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
    
    # Extract problem summaries as issues
    for item in feedback_items[:limit]:
        problem = item.get('problem_summary', '')
        if problem and len(problem) > 5:
            # Normalize and count
            problem_key = problem[:100].lower().strip()
            issues[problem_key] = issues.get(problem_key, 0) + 1
    
    # Sort and limit issues
    sorted_issues = dict(sorted(issues.items(), key=lambda x: x[1], reverse=True)[:20])
    
    return {
        'period_days': days,
        'feedback_count': feedback_count,
        'entities': {
            'keywords': {},  # Could be enhanced with NLP extraction
            'categories': dict(sorted(category_counts.items(), key=lambda x: x[1], reverse=True)),
            'issues': sorted_issues,
            'personas': dict(sorted(persona_counts.items(), key=lambda x: x[1], reverse=True)),
            'sources': dict(sorted(source_totals.items(), key=lambda x: x[1], reverse=True)),
        }
    }


@app.post("/chat")
@tracer.capture_method
def chat():
    """AI chat endpoint for querying feedback data using Bedrock with real feedback context."""
    body = app.current_event.json_body
    message = body.get('message', '')
    context_hint = body.get('context', '')
    
    # Get context from recent feedback
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', 7))
    
    # Fetch metrics summary
    current_date = datetime.now(timezone.utc)
    
    # Get daily totals
    total_feedback = 0
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(
            Key={'pk': 'METRIC#daily_total', 'sk': date}
        )
        item = response.get('Item')
        if item:
            total_feedback += item.get('count', 0)
    
    # Get sentiment breakdown
    sentiment_counts = {'positive': 0, 'negative': 0, 'neutral': 0, 'mixed': 0}
    for sentiment in sentiment_counts.keys():
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = aggregates_table.get_item(
                Key={'pk': f'METRIC#daily_sentiment#{sentiment}', 'sk': date}
            )
            item = response.get('Item')
            if item:
                sentiment_counts[sentiment] += item.get('count', 0)
    
    # Get category breakdown
    categories = ['delivery', 'customer_support', 'product_quality', 'pricing', 
                  'website', 'app', 'billing', 'returns', 'communication', 'other']
    category_counts = {}
    for category in categories:
        total = 0
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = aggregates_table.get_item(
                Key={'pk': f'METRIC#daily_category#{category}', 'sk': date}
            )
            item = response.get('Item')
            if item:
                total += item.get('count', 0)
        if total > 0:
            category_counts[category] = total
    
    # Get urgent items count
    urgent_count = 0
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(
            Key={'pk': 'METRIC#urgent', 'sk': date}
        )
        item = response.get('Item')
        if item:
            urgent_count += item.get('count', 0)
    
    # Fetch recent feedback items for context (up to 30 items)
    feedback_items = []
    for i in range(min(days, 7)):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = feedback_table.query(
            IndexName='gsi1-by-date',
            KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
            Limit=10,
            ScanIndexForward=False
        )
        feedback_items.extend(response.get('Items', []))
        if len(feedback_items) >= 30:
            break
    
    # Get urgent items specifically if question mentions urgent
    urgent_items = []
    if 'urgent' in message.lower() or 'attention' in message.lower():
        urgent_response = feedback_table.query(
            IndexName='gsi3-by-urgency',
            KeyConditionExpression=Key('gsi3pk').eq('URGENCY#high'),
            Limit=10,
            ScanIndexForward=False
        )
        urgent_items = urgent_response.get('Items', [])
    
    # Build context for Bedrock
    feedback_context = []
    for item in feedback_items[:20]:  # Limit to 20 for context window
        feedback_context.append({
            'source': item.get('source_platform', 'unknown'),
            'date': item.get('source_created_at', '')[:10] if item.get('source_created_at') else '',
            'text': item.get('original_text', '')[:500],  # Truncate long texts
            'sentiment': item.get('sentiment_label', 'unknown'),
            'sentiment_score': float(item.get('sentiment_score', 0)),
            'category': item.get('category', 'other'),
            'urgency': item.get('urgency', 'low'),
            'rating': item.get('rating'),
            'persona': item.get('persona_name', ''),
            'problem_summary': item.get('problem_summary', ''),
        })
    
    # Build the prompt for Bedrock
    system_prompt = """You are a Voice of the Customer (VoC) analytics assistant. You help analyze customer feedback data and provide actionable insights.

You have access to real customer feedback data from various sources including Trustpilot, Google Reviews, Twitter, Instagram, Facebook, Reddit, and app stores.

When answering questions:
1. Base your answers ONLY on the actual data provided in the context
2. Be specific with numbers and percentages from the data
3. Quote actual customer feedback when relevant
4. Highlight urgent issues that need attention
5. Provide actionable recommendations based on the data
6. If the data doesn't contain information to answer a question, say so honestly

Format your responses clearly with bullet points or numbered lists when appropriate."""

    data_context = f"""## Current Data Summary (Last {days} days)

**Total Feedback Items:** {total_feedback}
**Urgent Issues:** {urgent_count}

**Sentiment Breakdown:**
- Positive: {sentiment_counts['positive']} ({round(sentiment_counts['positive']/max(total_feedback,1)*100, 1)}%)
- Neutral: {sentiment_counts['neutral']} ({round(sentiment_counts['neutral']/max(total_feedback,1)*100, 1)}%)
- Negative: {sentiment_counts['negative']} ({round(sentiment_counts['negative']/max(total_feedback,1)*100, 1)}%)
- Mixed: {sentiment_counts['mixed']} ({round(sentiment_counts['mixed']/max(total_feedback,1)*100, 1)}%)

**Top Categories:**
{chr(10).join([f"- {cat}: {count}" for cat, count in sorted(category_counts.items(), key=lambda x: x[1], reverse=True)[:5]])}

## Recent Customer Feedback Samples:
"""
    
    for i, fb in enumerate(feedback_context[:15], 1):
        data_context += f"""
### Feedback #{i}
- Source: {fb['source']}
- Date: {fb['date']}
- Sentiment: {fb['sentiment']} ({fb['sentiment_score']:.2f})
- Category: {fb['category']}
- Urgency: {fb['urgency']}
- Rating: {fb['rating'] if fb['rating'] else 'N/A'}
- Text: "{fb['text']}"
{f"- Problem Summary: {fb['problem_summary']}" if fb['problem_summary'] else ''}
"""

    if urgent_items:
        data_context += "\n## Urgent Issues Requiring Attention:\n"
        for i, item in enumerate(urgent_items[:5], 1):
            data_context += f"""
### Urgent #{i}
- Source: {item.get('source_platform', 'unknown')}
- Text: "{item.get('original_text', '')[:300]}"
- Category: {item.get('category', 'other')}
"""

    # Call Bedrock with Claude Sonnet 4.5 via global inference profile
    try:
        bedrock = boto3.client('bedrock-runtime')
        
        bedrock_response = bedrock.invoke_model(
            modelId='global.anthropic.claude-sonnet-4-5-20250929-v1:0',
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 1500,
                'system': system_prompt,
                'messages': [
                    {
                        'role': 'user',
                        'content': f"{data_context}\n\n---\n\nUser Question: {message}"
                    }
                ]
            })
        )
        
        result = json.loads(bedrock_response['body'].read())
        response_text = result['content'][0]['text']
        
        # Return relevant source feedback items
        source_items = urgent_items[:3] if urgent_items else feedback_items[:3]
        
        return {
            'response': response_text,
            'sources': source_items,
            'metadata': {
                'total_feedback': total_feedback,
                'days_analyzed': days,
                'urgent_count': urgent_count
            }
        }
        
    except Exception as e:
        logger.exception(f"Bedrock call failed: {e}")
        # Fallback to basic response if Bedrock fails
        response_text = f"""I encountered an issue connecting to the AI service, but here's what I found in your data:

**Summary (Last {days} days):**
- Total feedback: {total_feedback} items
- Urgent issues: {urgent_count}
- Sentiment: {sentiment_counts['positive']} positive, {sentiment_counts['negative']} negative

**Top Categories:**
{chr(10).join([f"- {cat}: {count}" for cat, count in sorted(category_counts.items(), key=lambda x: x[1], reverse=True)[:3]])}

Please try your question again, or check the Bedrock service configuration."""
        
        return {
            'response': response_text,
            'sources': feedback_items[:3],
            'error': str(e)
        }


# Scraper Management Endpoints
@app.get("/scrapers")
@tracer.capture_method
def list_scrapers():
    """List all scraper configurations."""
    if not SECRETS_ARN:
        return {'scrapers': []}
    
    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        configs = json.loads(secrets.get('webscraper_configs', '[]'))
        return {'scrapers': configs}
    except Exception as e:
        logger.warning(f"Could not read scraper configs: {e}")
        return {'scrapers': []}


@app.post("/scrapers")
@tracer.capture_method
def save_scraper():
    """Save a scraper configuration."""
    if not SECRETS_ARN:
        return {'success': False, 'message': 'Secrets Manager not configured'}
    
    body = app.current_event.json_body
    scraper = body.get('scraper')
    
    if not scraper:
        return {'success': False, 'message': 'No scraper config provided'}
    
    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        configs = json.loads(secrets.get('webscraper_configs', '[]'))
        
        # Update or add scraper
        existing_idx = next((i for i, c in enumerate(configs) if c.get('id') == scraper.get('id')), -1)
        if existing_idx >= 0:
            configs[existing_idx] = scraper
        else:
            configs.append(scraper)
        
        secrets['webscraper_configs'] = json.dumps(configs)
        secretsmanager.put_secret_value(SecretId=SECRETS_ARN, SecretString=json.dumps(secrets))
        
        return {'success': True, 'scraper': scraper}
    except Exception as e:
        logger.exception(f"Failed to save scraper: {e}")
        return {'success': False, 'message': str(e)}


@app.delete("/scrapers/<scraper_id>")
@tracer.capture_method
def delete_scraper(scraper_id: str):
    """Delete a scraper configuration."""
    if not SECRETS_ARN:
        return {'success': False, 'message': 'Secrets Manager not configured'}
    
    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        configs = json.loads(secrets.get('webscraper_configs', '[]'))
        
        configs = [c for c in configs if c.get('id') != scraper_id]
        secrets['webscraper_configs'] = json.dumps(configs)
        secretsmanager.put_secret_value(SecretId=SECRETS_ARN, SecretString=json.dumps(secrets))
        
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to delete scraper: {e}")
        return {'success': False, 'message': str(e)}


@app.get("/scrapers/templates")
@tracer.capture_method
def get_scraper_templates():
    """Get available scraper templates for common review sites."""
    templates = [
        {
            'id': 'trustpilot_jsonld',
            'name': 'Trustpilot (JSON-LD)',
            'description': 'Extract reviews from Trustpilot using JSON-LD structured data. Most reliable method.',
            'icon': '⭐',
            'extraction_method': 'jsonld',
            'url_pattern': 'https://www.trustpilot.com/review/{company_domain}',
            'url_placeholder': 'https://www.trustpilot.com/review/example.com',
            'supports_pagination': True,
            'pagination': {
                'enabled': True,
                'param': 'page',
                'start': 1,
                'max_pages': 10
            },
            'config': {
                'extraction_method': 'jsonld',
                'template': 'trustpilot',
            }
        },
        {
            'id': 'trustpilot_css',
            'name': 'Trustpilot (CSS Selectors)',
            'description': 'Extract reviews from Trustpilot using CSS selectors. Use if JSON-LD fails.',
            'icon': '⭐',
            'extraction_method': 'css',
            'url_pattern': 'https://www.trustpilot.com/review/{company_domain}',
            'url_placeholder': 'https://www.trustpilot.com/review/example.com',
            'supports_pagination': True,
            'pagination': {
                'enabled': True,
                'param': 'page',
                'start': 1,
                'max_pages': 10
            },
            'config': {
                'extraction_method': 'css',
                'container_selector': '[data-service-review-card-paper]',
                'text_selector': '[data-service-review-text-typography]',
                'title_selector': '[data-service-review-title-typography]',
                'rating_selector': '[data-service-review-rating]',
                'rating_attribute': 'data-service-review-rating',
                'author_selector': '[data-consumer-name-typography]',
                'date_selector': '[data-service-review-date-time-ago]',
            }
        },
        {
            'id': 'google_play',
            'name': 'Google Play Store',
            'description': 'Extract app reviews from Google Play Store.',
            'icon': '📱',
            'extraction_method': 'css',
            'url_pattern': 'https://play.google.com/store/apps/details?id={package_name}',
            'url_placeholder': 'https://play.google.com/store/apps/details?id=com.example.app',
            'supports_pagination': False,
            'config': {
                'extraction_method': 'css',
                'container_selector': '[data-review-id]',
                'text_selector': '[data-reviewid] span[jsname]',
                'rating_selector': '[role="img"][aria-label*="star"]',
                'author_selector': '[class*="reviewer"] span',
                'date_selector': '[class*="date"]',
            }
        },
        {
            'id': 'yelp',
            'name': 'Yelp ⚠️',
            'description': 'Extract business reviews from Yelp. Note: Yelp has aggressive bot detection - may require proxy or Yelp Fusion API.',
            'icon': '🍽️',
            'extraction_method': 'css',
            'url_pattern': 'https://www.yelp.com/biz/{business_slug}',
            'url_placeholder': 'https://www.yelp.com/biz/example-business-city',
            'supports_pagination': True,
            'pagination': {
                'enabled': True,
                'param': 'start',
                'start': 0,
                'max_pages': 5
            },
            'config': {
                'extraction_method': 'css',
                'container_selector': 'li[class*="margin-b5__"], [data-review-id], section[aria-label*="review"]',
                'text_selector': 'p[class*="comment__"], span[class*="raw__"], p[lang]',
                'rating_selector': '[aria-label*="star rating"], div[class*="i-stars"]',
                'author_selector': 'a[href*="/user_details"], [class*="user-passport"] a',
                'date_selector': 'span[class*="css-"], time',
            }
        },
        {
            'id': 'airlinequality',
            'name': 'Skytrax Airline Quality',
            'description': 'Extract airline reviews from airlinequality.com (Skytrax). Great for airline feedback.',
            'icon': '✈️',
            'extraction_method': 'css',
            'url_pattern': 'https://www.airlinequality.com/airline-reviews/{airline}/',
            'url_placeholder': 'https://www.airlinequality.com/airline-reviews/lufthansa/',
            'supports_pagination': True,
            'pagination': {
                'enabled': True,
                'param': 'page',
                'start': 1,
                'max_pages': 10
            },
            'config': {
                'extraction_method': 'css',
                'container_selector': 'article.comp_media-review-rated',
                'text_selector': '.text_content',
                'title_selector': '.text_header',
                'rating_selector': '.rating-10 span',
                'author_selector': '.text_sub_header span',
                'date_selector': 'time',
            }
        },
        {
            'id': 'consumeraffairs',
            'name': 'ConsumerAffairs',
            'description': 'Extract consumer reviews from ConsumerAffairs.com. Works for travel, products, and services.',
            'icon': '📋',
            'extraction_method': 'css',
            'url_pattern': 'https://www.consumeraffairs.com/travel/{company}.html',
            'url_placeholder': 'https://www.consumeraffairs.com/travel/lufthansa.html',
            'supports_pagination': True,
            'pagination': {
                'enabled': True,
                'param': 'page',
                'start': 1,
                'max_pages': 5
            },
            'config': {
                'extraction_method': 'css',
                'container_selector': '.js-rvw',
                'text_selector': '.rvw__top-text, .rvw__all-text',
                'rating_selector': '[itemprop="ratingValue"]',
                'author_selector': '.rvw__inf-nm',
                'date_selector': '.rvw__rvd-dt',
            }
        },
        {
            'id': 'reddit_thread',
            'name': 'Reddit Thread',
            'description': 'Extract comments from a Reddit thread. Uses old.reddit.com for reliable scraping.',
            'icon': '🤖',
            'extraction_method': 'css',
            'url_pattern': 'https://old.reddit.com/r/{subreddit}/comments/{thread_id}/{slug}/',
            'url_placeholder': 'https://old.reddit.com/r/travel/comments/abc123/review_thread/',
            'supports_pagination': False,
            'pagination': {
                'enabled': False,
                'param': 'page',
                'start': 1,
                'max_pages': 1
            },
            'config': {
                'extraction_method': 'css',
                'container_selector': '.comment',
                'text_selector': '.md',
                'author_selector': '.author',
                'date_selector': 'time',
            }
        },
        {
            'id': 'custom_jsonld',
            'name': 'Custom (JSON-LD)',
            'description': 'Extract reviews from any site using Schema.org JSON-LD structured data.',
            'icon': '🔧',
            'extraction_method': 'jsonld',
            'url_pattern': '',
            'url_placeholder': 'https://example.com/reviews',
            'supports_pagination': True,
            'pagination': {
                'enabled': False,
                'param': 'page',
                'start': 1,
                'max_pages': 5
            },
            'config': {
                'extraction_method': 'jsonld',
                'template': 'custom',
            }
        },
        {
            'id': 'custom_css',
            'name': 'Custom (CSS Selectors)',
            'description': 'Create a custom scraper with your own CSS selectors.',
            'icon': '🔧',
            'extraction_method': 'css',
            'url_pattern': '',
            'url_placeholder': 'https://example.com/reviews',
            'supports_pagination': True,
            'pagination': {
                'enabled': False,
                'param': 'page',
                'start': 1,
                'max_pages': 5
            },
            'config': {
                'extraction_method': 'css',
                'container_selector': '.review',
                'text_selector': '.review-text',
                'title_selector': '.review-title',
                'rating_selector': '.rating',
                'author_selector': '.author',
                'date_selector': '.date',
            }
        },
    ]
    return {'templates': templates}


@app.post("/scrapers/analyze-url")
@tracer.capture_method
def analyze_url_for_selectors():
    """Fetch a URL and use LLM to auto-detect CSS selectors for reviews."""
    import urllib.request
    import urllib.error
    
    body = app.current_event.json_body
    url = body.get('url')
    
    if not url:
        return {'success': False, 'message': 'URL is required'}
    
    try:
        # Fetch the page HTML using urllib (built-in)
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as response:
            html_content = response.read().decode('utf-8', errors='ignore')
        
        # Truncate HTML to fit in context (keep first 80KB for better analysis)
        html_sample = html_content[:80000]
        
        # Use Bedrock with Claude Sonnet 4.5 via global inference profile
        bedrock = boto3.client('bedrock-runtime')
        
        prompt = f"""You are an expert web scraper analyzing HTML to extract CSS selectors for customer reviews.

CRITICAL: Modern websites like Trustpilot, Google Reviews, Yelp, and app stores use:
1. Dynamic CSS class names with hashes (e.g., "styles_reviewCard__Qwhpy") - these change between builds and are UNRELIABLE
2. Data attributes (e.g., "data-service-review-card-paper", "data-review-content") - these are STABLE and PREFERRED
3. Semantic HTML elements with ARIA attributes

SELECTOR PRIORITY (use in this order):
1. Data attributes: [data-review-content], [data-service-review-card-paper], [data-testid="review-card"]
2. ARIA attributes: [role="article"], [aria-label*="review"]
3. Semantic elements with stable classes: article.review, div[itemtype*="Review"]
4. Schema.org microdata: [itemtype="https://schema.org/Review"]
5. AVOID: Classes with hashes like "styles_xxx__abc123" or "css-abc123"

Analyze this HTML and identify the MOST STABLE CSS selectors for extracting reviews:

```html
{html_sample}
```

IMPORTANT INSTRUCTIONS:
1. Look for data-* attributes first - they are the most reliable
2. Check for Schema.org Review markup
3. Identify patterns that repeat for each review
4. For ratings, check if the value is in an attribute (e.g., data-rating="5") vs text content
5. Count how many review elements match your container selector

Return ONLY valid JSON in this exact format:
{{
  "container_selector": "most stable selector for review container (prefer data attributes)",
  "text_selector": "selector for review text RELATIVE to container",
  "rating_selector": "selector for rating RELATIVE to container, or null",
  "rating_attribute": "if rating is in an attribute like data-rating, specify it here, otherwise null",
  "author_selector": "selector for author RELATIVE to container, or null",
  "date_selector": "selector for date RELATIVE to container, or null",
  "title_selector": "selector for title RELATIVE to container, or null",
  "confidence": "high/medium/low",
  "detected_reviews_count": number,
  "notes": "explain the page structure and why you chose these selectors",
  "warnings": ["list any concerns about selector stability"]
}}"""

        # Use Claude Sonnet 4.5 via global cross-region inference profile
        bedrock_response = bedrock.invoke_model(
            modelId='global.anthropic.claude-sonnet-4-5-20250929-v1:0',
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 2048,
                'messages': [{'role': 'user', 'content': prompt}]
            })
        )
        
        result = json.loads(bedrock_response['body'].read())
        llm_response = result['content'][0]['text']
        
        # Parse the JSON from LLM response
        import re
        json_match = re.search(r'\{[\s\S]*\}', llm_response)
        if json_match:
            selectors = json.loads(json_match.group())
            return {
                'success': True,
                'selectors': selectors,
                'url': url
            }
        else:
            return {'success': False, 'message': 'Could not parse LLM response', 'raw': llm_response}
            
    except urllib.error.URLError as e:
        return {'success': False, 'message': f'Failed to fetch URL: {str(e)}'}
    except Exception as e:
        logger.exception(f"Failed to analyze URL: {e}")
        return {'success': False, 'message': str(e)}


@app.post("/scrapers/<scraper_id>/run")
@tracer.capture_method
def run_scraper(scraper_id: str):
    """Trigger a scraper run and return execution ID for tracking."""
    # Invoke the webscraper Lambda asynchronously
    lambda_client = boto3.client('lambda')
    
    execution_id = f"run_{scraper_id}_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    try:
        # Store run status in DynamoDB
        aggregates_table.put_item(Item={
            'pk': f'SCRAPER_RUN#{scraper_id}',
            'sk': execution_id,
            'status': 'running',
            'started_at': datetime.now(timezone.utc).isoformat(),
            'pages_scraped': 0,
            'items_found': 0,
            'errors': []
        })
        
        # Invoke webscraper Lambda
        lambda_client.invoke(
            FunctionName='voc-ingestor-webscraper',
            InvocationType='Event',  # Async
            Payload=json.dumps({
                'scraper_id': scraper_id,
                'execution_id': execution_id,
                'manual_run': True
            })
        )
        
        return {
            'success': True,
            'execution_id': execution_id,
            'status': 'running'
        }
    except Exception as e:
        logger.exception(f"Failed to run scraper: {e}")
        return {'success': False, 'message': str(e)}


@app.get("/scrapers/<scraper_id>/status")
@tracer.capture_method
def get_scraper_status(scraper_id: str):
    """Get the latest run status for a scraper."""
    try:
        # Get the most recent run
        response = aggregates_table.query(
            KeyConditionExpression=Key('pk').eq(f'SCRAPER_RUN#{scraper_id}'),
            ScanIndexForward=False,
            Limit=1
        )
        
        items = response.get('Items', [])
        if not items:
            return {'status': 'never_run', 'scraper_id': scraper_id}
        
        run = items[0]
        return {
            'scraper_id': scraper_id,
            'execution_id': run.get('sk'),
            'status': run.get('status', 'unknown'),
            'started_at': run.get('started_at'),
            'completed_at': run.get('completed_at'),
            'pages_scraped': run.get('pages_scraped', 0),
            'items_found': run.get('items_found', 0),
            'errors': run.get('errors', [])
        }
    except Exception as e:
        logger.warning(f"Could not get scraper status: {e}")
        return {'status': 'unknown', 'scraper_id': scraper_id}


@app.get("/scrapers/<scraper_id>/runs")
@tracer.capture_method
def get_scraper_runs(scraper_id: str):
    """Get run history for a scraper."""
    try:
        response = aggregates_table.query(
            KeyConditionExpression=Key('pk').eq(f'SCRAPER_RUN#{scraper_id}'),
            ScanIndexForward=False,
            Limit=10
        )
        return {'runs': response.get('Items', [])}
    except Exception as e:
        logger.warning(f"Could not get scraper runs: {e}")
        return {'runs': []}


@app.get("/integrations/status")
@tracer.capture_method
def get_integration_status():
    """Get status of all integrations."""
    result = {}
    
    # Get current secrets to check what's configured
    tp_credentials_set = []
    yelp_credentials_set = []
    if SECRETS_ARN:
        try:
            response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
            secrets = json.loads(response.get('SecretString', '{}'))
            
            # Check Trustpilot credentials
            tp_keys = ['trustpilot_api_key', 'trustpilot_api_secret', 'trustpilot_business_unit_id']
            tp_credentials_set = [k.replace('trustpilot_', '') for k in tp_keys if secrets.get(k)]
            
            # Check Yelp credentials
            if secrets.get('yelp_api_key'):
                yelp_credentials_set.append('api_key')
            if secrets.get('yelp_business_ids'):
                yelp_credentials_set.append('business_ids')
        except Exception as e:
            logger.warning(f"Could not read secrets: {e}")
    
    result['trustpilot'] = {
        'configured': len(tp_credentials_set) == 3,
        'webhook_url': f"{API_ENDPOINT}webhooks/trustpilot" if API_ENDPOINT else '',
        'credentials_set': tp_credentials_set,
    }
    
    result['yelp'] = {
        'configured': len(yelp_credentials_set) == 2,
        'credentials_set': yelp_credentials_set,
    }
    
    return result


@app.put("/integrations/<source>/credentials")
@tracer.capture_method
def update_integration_credentials(source: str):
    """Update credentials for an integration in Secrets Manager."""
    if not SECRETS_ARN:
        return {'success': False, 'message': 'Secrets Manager not configured'}
    
    body = app.current_event.json_body
    
    try:
        # Get current secrets
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        
        # Update with new credentials based on source
        if source == 'trustpilot':
            if body.get('api_key'):
                secrets['trustpilot_api_key'] = body['api_key']
            if body.get('api_secret'):
                secrets['trustpilot_api_secret'] = body['api_secret']
            if body.get('business_unit_id'):
                secrets['trustpilot_business_unit_id'] = body['business_unit_id']
        elif source == 'yelp':
            if body.get('api_key'):
                secrets['yelp_api_key'] = body['api_key']
            if body.get('business_ids'):
                secrets['yelp_business_ids'] = body['business_ids']
        else:
            return {'success': False, 'message': f'Unknown source: {source}'}
        
        # Save updated secrets
        secretsmanager.put_secret_value(
            SecretId=SECRETS_ARN,
            SecretString=json.dumps(secrets)
        )
        
        logger.info(f"Updated credentials for {source}")
        return {'success': True, 'message': f'Credentials updated for {source}'}
        
    except Exception as e:
        logger.exception(f"Failed to update credentials: {e}")
        return {'success': False, 'message': str(e)}


@app.get("/sources/status")
@tracer.capture_method
def get_sources_status():
    """Get enabled/disabled status of all data source EventBridge schedules."""
    events_client = boto3.client('events')
    
    sources = [
        'trustpilot', 'yelp', 'google_reviews', 'twitter', 'instagram', 'facebook',
        'reddit', 'tavily', 'appstore_apple', 'appstore_google', 'appstore_huawei', 'webscraper'
    ]
    
    result = {}
    for source in sources:
        rule_name = f'voc-ingest-{source}-schedule'
        try:
            response = events_client.describe_rule(Name=rule_name)
            result[source] = {
                'enabled': response.get('State') == 'ENABLED',
                'schedule': response.get('ScheduleExpression', ''),
                'rule_name': rule_name
            }
        except events_client.exceptions.ResourceNotFoundException:
            result[source] = {'enabled': False, 'exists': False}
        except Exception as e:
            logger.warning(f"Could not get status for {source}: {e}")
            result[source] = {'enabled': False, 'error': str(e)}
    
    return {'sources': result}


@app.put("/sources/<source>/enable")
@tracer.capture_method
def enable_source(source: str):
    """Enable an EventBridge schedule for a data source."""
    events_client = boto3.client('events')
    rule_name = f'voc-ingest-{source}-schedule'
    
    try:
        events_client.enable_rule(Name=rule_name)
        logger.info(f"Enabled EventBridge rule: {rule_name}")
        return {'success': True, 'source': source, 'enabled': True}
    except events_client.exceptions.ResourceNotFoundException:
        return {'success': False, 'message': f'Rule {rule_name} not found'}
    except Exception as e:
        logger.exception(f"Failed to enable rule {rule_name}: {e}")
        return {'success': False, 'message': str(e)}


@app.put("/sources/<source>/disable")
@tracer.capture_method
def disable_source(source: str):
    """Disable an EventBridge schedule for a data source."""
    events_client = boto3.client('events')
    rule_name = f'voc-ingest-{source}-schedule'
    
    try:
        events_client.disable_rule(Name=rule_name)
        logger.info(f"Disabled EventBridge rule: {rule_name}")
        return {'success': True, 'source': source, 'enabled': False}
    except events_client.exceptions.ResourceNotFoundException:
        return {'success': False, 'message': f'Rule {rule_name} not found'}
    except Exception as e:
        logger.exception(f"Failed to disable rule {rule_name}: {e}")
        return {'success': False, 'message': str(e)}


@app.post("/integrations/<source>/test")
@tracer.capture_method
def test_integration(source: str):
    """Test an integration connection."""
    if not SECRETS_ARN:
        return {'success': False, 'message': 'Secrets Manager not configured'}
    
    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        
        if source == 'trustpilot':
            import requests
            
            api_key = secrets.get('trustpilot_api_key', '')
            api_secret = secrets.get('trustpilot_api_secret', '')
            business_unit_id = secrets.get('trustpilot_business_unit_id', '')
            
            if not all([api_key, api_secret, business_unit_id]):
                return {'success': False, 'message': 'Missing required credentials'}
            
            # Get OAuth token
            token_response = requests.post(
                'https://api.trustpilot.com/v1/oauth/oauth-business-users-for-applications/accesstoken',
                data={
                    'grant_type': 'client_credentials',
                    'client_id': api_key,
                    'client_secret': api_secret
                },
                headers={'Content-Type': 'application/x-www-form-urlencoded'},
                timeout=10
            )
            
            if token_response.status_code != 200:
                return {'success': False, 'message': 'Invalid API credentials'}
            
            access_token = token_response.json().get('access_token')
            
            # Test business unit access
            bu_response = requests.get(
                f'https://api.trustpilot.com/v1/business-units/{business_unit_id}',
                headers={'Authorization': f'Bearer {access_token}'},
                timeout=10
            )
            
            if bu_response.status_code == 200:
                bu_data = bu_response.json()
                return {
                    'success': True,
                    'message': f"Connected to {bu_data.get('displayName', 'Trustpilot')}",
                    'details': {
                        'business_name': bu_data.get('displayName'),
                        'review_count': bu_data.get('numberOfReviews', {}).get('total', 0)
                    }
                }
            else:
                return {'success': False, 'message': 'Invalid Business Unit ID'}
        
        elif source == 'yelp':
            import requests
            
            api_key = secrets.get('yelp_api_key', '')
            business_ids = secrets.get('yelp_business_ids', '')
            
            if not api_key:
                return {'success': False, 'message': 'Missing Yelp API key'}
            
            if not business_ids:
                return {'success': False, 'message': 'Missing business IDs'}
            
            # Test with first business ID
            first_business = business_ids.split(',')[0].strip()
            
            test_response = requests.get(
                f'https://api.yelp.com/v3/businesses/{first_business}',
                headers={'Authorization': f'Bearer {api_key}'},
                timeout=10
            )
            
            if test_response.status_code == 200:
                biz_data = test_response.json()
                return {
                    'success': True,
                    'message': f"Connected to {biz_data.get('name', first_business)}",
                    'details': {
                        'business_name': biz_data.get('name'),
                        'review_count': biz_data.get('review_count', 0),
                        'rating': biz_data.get('rating'),
                        'location': biz_data.get('location', {}).get('city', '')
                    }
                }
            elif test_response.status_code == 401:
                return {'success': False, 'message': 'Invalid Yelp API key'}
            elif test_response.status_code == 404:
                return {'success': False, 'message': f'Business not found: {first_business}'}
            else:
                return {'success': False, 'message': f'Yelp API error: {test_response.status_code}'}
        
        return {'success': False, 'message': f'Unknown source: {source}'}
        
    except Exception as e:
        logger.exception(f"Test failed: {e}")
        return {'success': False, 'message': str(e)}


# Pipeline Management Endpoints
@app.get("/pipelines")
@tracer.capture_method
def list_pipelines():
    """List all pipelines."""
    if not pipelines_table:
        # Return default pipelines if table not configured
        return {'pipelines': get_default_pipelines()}
    
    response = pipelines_table.scan()
    return {'pipelines': response.get('Items', [])}


@app.get("/pipelines/<pipeline_id>")
@tracer.capture_method
def get_pipeline(pipeline_id: str):
    """Get a single pipeline."""
    if not pipelines_table:
        defaults = get_default_pipelines()
        pipeline = next((p for p in defaults if p['id'] == pipeline_id), None)
        if not pipeline:
            raise NotFoundError(f"Pipeline {pipeline_id} not found")
        return pipeline
    
    response = pipelines_table.get_item(Key={'id': pipeline_id})
    if 'Item' not in response:
        raise NotFoundError(f"Pipeline {pipeline_id} not found")
    return response['Item']


@app.post("/pipelines")
@tracer.capture_method
def create_pipeline():
    """Create or update a pipeline."""
    body = app.current_event.json_body
    pipeline_id = body.get('id') or f"pipeline_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    pipeline = {
        'id': pipeline_id,
        'source': body.get('source', ''),
        'name': body.get('name', 'New Pipeline'),
        'description': body.get('description', ''),
        'steps': body.get('steps', []),
        'enabled': body.get('enabled', True),
        'status': 'idle',
        'created_at': datetime.now(timezone.utc).isoformat(),
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }
    
    if pipelines_table:
        pipelines_table.put_item(Item=pipeline)
    
    return {'success': True, 'pipeline': pipeline}


@app.put("/pipelines/<pipeline_id>")
@tracer.capture_method
def update_pipeline(pipeline_id: str):
    """Update a pipeline."""
    body = app.current_event.json_body
    
    if pipelines_table:
        response = pipelines_table.get_item(Key={'id': pipeline_id})
        if 'Item' not in response:
            raise NotFoundError(f"Pipeline {pipeline_id} not found")
        
        pipeline = response['Item']
        pipeline.update({
            'name': body.get('name', pipeline.get('name')),
            'description': body.get('description', pipeline.get('description')),
            'steps': body.get('steps', pipeline.get('steps')),
            'enabled': body.get('enabled', pipeline.get('enabled')),
            'updated_at': datetime.now(timezone.utc).isoformat(),
        })
        
        pipelines_table.put_item(Item=pipeline)
        return {'success': True, 'pipeline': pipeline}
    
    return {'success': True, 'pipeline': body}


@app.delete("/pipelines/<pipeline_id>")
@tracer.capture_method
def delete_pipeline(pipeline_id: str):
    """Delete a pipeline."""
    if pipelines_table:
        pipelines_table.delete_item(Key={'id': pipeline_id})
    return {'success': True}


@app.post("/pipelines/<pipeline_id>/run")
@tracer.capture_method
def run_pipeline(pipeline_id: str):
    """Trigger a pipeline run."""
    execution_id = f"exec_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    # In production, this would trigger Step Functions or Lambda
    logger.info(f"Pipeline {pipeline_id} triggered, execution: {execution_id}")
    return {'success': True, 'execution_id': execution_id}


# Search and Discovery Endpoints
@app.get("/feedback/search")
@tracer.capture_method
def search_feedback():
    """Search feedback by keywords with entity extraction."""
    params = app.current_event.query_string_parameters or {}
    query = params.get('q', '').lower()
    days = int(params.get('days', 30))
    limit = min(int(params.get('limit', 50)), 100)
    
    if not query:
        return {'count': 0, 'items': [], 'entities': {}}
    
    # Get feedback from recent days
    current_date = datetime.now(timezone.utc)
    all_items = []
    
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = feedback_table.query(
            IndexName='gsi1-by-date',
            KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
            Limit=200,
            ScanIndexForward=False
        )
        all_items.extend(response.get('Items', []))
    
    # Search in text fields
    keywords = query.split()
    matching_items = []
    
    for item in all_items:
        text = (item.get('original_text', '') + ' ' + 
                item.get('problem_summary', '') + ' ' +
                item.get('direct_customer_quote', '')).lower()
        
        if all(kw in text for kw in keywords):
            matching_items.append(item)
    
    # Extract entities from results
    entities = extract_entities_from_items(matching_items[:limit])
    
    return {
        'count': len(matching_items),
        'items': matching_items[:limit],
        'entities': entities,
        'query': query
    }


@app.get("/feedback/<feedback_id>/similar")
@tracer.capture_method
def get_similar_feedback(feedback_id: str):
    """Find feedback similar to a given item based on category, keywords, and sentiment."""
    params = app.current_event.query_string_parameters or {}
    limit = min(int(params.get('limit', 10)), 50)
    
    # Get the source feedback
    source_item = None
    scan_params = {'FilterExpression': Attr('feedback_id').eq(feedback_id)}
    last_key = None
    
    while not source_item:
        if last_key:
            scan_params['ExclusiveStartKey'] = last_key
        response = feedback_table.scan(**scan_params)
        items = response.get('Items', [])
        if items:
            source_item = items[0]
            break
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            break
    
    if not source_item:
        raise NotFoundError(f"Feedback {feedback_id} not found")
    
    # Find similar by category
    category = source_item.get('category', 'other')
    response = feedback_table.query(
        IndexName='gsi2-by-category',
        KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
        Limit=limit * 3,
        ScanIndexForward=False
    )
    
    candidates = [i for i in response.get('Items', []) if i.get('feedback_id') != feedback_id]
    
    # Score similarity
    source_text = source_item.get('original_text', '').lower()
    source_words = set(source_text.split())
    
    scored = []
    for item in candidates:
        item_text = item.get('original_text', '').lower()
        item_words = set(item_text.split())
        
        # Jaccard similarity
        intersection = len(source_words & item_words)
        union = len(source_words | item_words)
        text_score = intersection / max(union, 1)
        
        # Category match bonus
        cat_score = 1.0 if item.get('category') == category else 0.0
        
        # Sentiment proximity
        sent_diff = abs(float(source_item.get('sentiment_score', 0)) - float(item.get('sentiment_score', 0)))
        sent_score = 1.0 - min(sent_diff, 1.0)
        
        total_score = (text_score * 0.5) + (cat_score * 0.3) + (sent_score * 0.2)
        scored.append((total_score, item))
    
    # Sort by score and return top matches
    scored.sort(key=lambda x: x[0], reverse=True)
    similar_items = [item for _, item in scored[:limit]]
    
    return {
        'source_feedback_id': feedback_id,
        'count': len(similar_items),
        'items': similar_items
    }


# Chat Conversations Endpoints
CONVERSATIONS_TABLE = os.environ.get('CONVERSATIONS_TABLE', '')
conversations_table = dynamodb.Table(CONVERSATIONS_TABLE) if CONVERSATIONS_TABLE else None


@app.get("/chat/conversations/<proxy+>")
@tracer.capture_method
def list_conversations(proxy: str = ""):
    """List all chat conversations or get one by ID."""
    if not conversations_table:
        return {'conversations': []}
    
    # If proxy is _list, list all conversations
    conversation_id = proxy.strip() if proxy and proxy != '_list' else None
    
    if conversation_id:
        # Get single conversation
        try:
            response = conversations_table.get_item(
                Key={'pk': 'USER#default', 'sk': f'CONV#{conversation_id}'}
            )
            item = response.get('Item')
            if not item:
                raise NotFoundError(f"Conversation {conversation_id} not found")
            return {
                'id': item.get('conversation_id'),
                'title': item.get('title', 'New Conversation'),
                'messages': item.get('messages', []),
                'filters': item.get('filters', {}),
                'createdAt': item.get('created_at'),
                'updatedAt': item.get('updated_at'),
            }
        except NotFoundError:
            raise
        except Exception as e:
            logger.exception(f"Failed to get conversation: {e}")
            raise NotFoundError(f"Conversation {conversation_id} not found")
    
    try:
        # Query all conversations for default user (no auth yet)
        response = conversations_table.query(
            KeyConditionExpression=Key('pk').eq('USER#default'),
            ScanIndexForward=False  # Most recent first
        )
        
        conversations = []
        for item in response.get('Items', []):
            conversations.append({
                'id': item.get('conversation_id'),
                'title': item.get('title', 'New Conversation'),
                'messages': item.get('messages', []),
                'filters': item.get('filters', {}),
                'createdAt': item.get('created_at'),
                'updatedAt': item.get('updated_at'),
            })
        
        return {'conversations': conversations}
    except Exception as e:
        logger.exception(f"Failed to list conversations: {e}")
        return {'conversations': [], 'error': str(e)}


@app.post("/chat/conversations/<proxy+>")
@tracer.capture_method
def save_conversation(proxy: str = ""):
    """Create or update a chat conversation."""
    if not conversations_table:
        return {'success': False, 'message': 'Conversations table not configured'}
    
    body = app.current_event.json_body
    conversation = body.get('conversation')
    
    if not conversation or not conversation.get('id'):
        return {'success': False, 'message': 'Invalid conversation data'}
    
    try:
        now = datetime.now(timezone.utc).isoformat()
        
        item = {
            'pk': 'USER#default',
            'sk': f"CONV#{conversation['id']}",
            'conversation_id': conversation['id'],
            'title': conversation.get('title', 'New Conversation'),
            'messages': conversation.get('messages', []),
            'filters': conversation.get('filters', {}),
            'created_at': conversation.get('createdAt', now),
            'updated_at': now,
        }
        
        conversations_table.put_item(Item=item)
        
        return {'success': True, 'conversation': conversation}
    except Exception as e:
        logger.exception(f"Failed to save conversation: {e}")
        return {'success': False, 'message': str(e)}


@app.put("/chat/conversations/<proxy+>")
@tracer.capture_method
def update_conversation(proxy: str):
    """Update a conversation."""
    conversation_id = proxy.strip()
    if not conversations_table:
        return {'success': False, 'message': 'Conversations table not configured'}
    
    body = app.current_event.json_body
    
    try:
        now = datetime.now(timezone.utc).isoformat()
        
        update_expr = 'SET updated_at = :now'
        expr_values = {':now': now}
        
        if 'title' in body:
            update_expr += ', title = :title'
            expr_values[':title'] = body['title']
        
        if 'messages' in body:
            update_expr += ', messages = :messages'
            expr_values[':messages'] = body['messages']
        
        if 'filters' in body:
            update_expr += ', filters = :filters'
            expr_values[':filters'] = body['filters']
        
        conversations_table.update_item(
            Key={'pk': 'USER#default', 'sk': f'CONV#{conversation_id}'},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_values
        )
        
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to update conversation: {e}")
        return {'success': False, 'message': str(e)}


@app.delete("/chat/conversations/<proxy+>")
@tracer.capture_method
def delete_conversation(proxy: str):
    """Delete a conversation."""
    conversation_id = proxy.strip()
    if not conversations_table:
        return {'success': False, 'message': 'Conversations table not configured'}
    
    try:
        conversations_table.delete_item(
            Key={'pk': 'USER#default', 'sk': f'CONV#{conversation_id}'}
        )
        return {'success': True}
    except Exception as e:
        logger.exception(f"Failed to delete conversation: {e}")
        return {'success': False, 'message': str(e)}


def get_default_pipelines() -> list:
    """Return default pipeline configurations."""
    return [
        {
            'id': 'trustpilot-default',
            'source': 'trustpilot',
            'name': 'Trustpilot Reviews',
            'description': 'Process reviews from Trustpilot',
            'enabled': True,
            'status': 'idle',
            'steps': [
                {'id': '1', 'name': 'Fetch Reviews', 'type': 'extract', 'config': {}, 'enabled': True},
                {'id': '2', 'name': 'Normalize Data', 'type': 'transform', 'config': {}, 'enabled': True},
                {'id': '3', 'name': 'AI Analysis', 'type': 'enrich', 'config': {}, 'enabled': True,
                 'prompt': 'Analyze sentiment, category, urgency, and key phrases from: {text}'},
                {'id': '4', 'name': 'Store', 'type': 'output', 'config': {}, 'enabled': True},
            ]
        },
        {
            'id': 'appstore-apple-default',
            'source': 'appstore_apple',
            'name': 'Apple App Store',
            'description': 'Process iOS app reviews',
            'enabled': True,
            'status': 'idle',
            'steps': [
                {'id': '1', 'name': 'Fetch RSS', 'type': 'extract', 'config': {}, 'enabled': True},
                {'id': '2', 'name': 'Parse Reviews', 'type': 'transform', 'config': {}, 'enabled': True},
                {'id': '3', 'name': 'AI Analysis', 'type': 'enrich', 'config': {}, 'enabled': True,
                 'prompt': 'Analyze this app review for sentiment and issues: {text}'},
                {'id': '4', 'name': 'Store', 'type': 'output', 'config': {}, 'enabled': True},
            ]
        },
    ]


# Settings Endpoints - Brand Configuration persisted to DynamoDB
SETTINGS_PK = 'SETTINGS#brand'
SETTINGS_SK = 'config'


@app.get("/settings/brand")
@tracer.capture_method
def get_brand_settings():
    """Get brand configuration from DynamoDB."""
    try:
        response = aggregates_table.get_item(
            Key={'pk': SETTINGS_PK, 'sk': SETTINGS_SK}
        )
        item = response.get('Item')
        if not item:
            # Return defaults if not configured
            return {
                'brand_name': '',
                'brand_handles': [],
                'hashtags': [],
                'urls_to_track': [],
            }
        return {
            'brand_name': item.get('brand_name', ''),
            'brand_handles': item.get('brand_handles', []),
            'hashtags': item.get('hashtags', []),
            'urls_to_track': item.get('urls_to_track', []),
        }
    except Exception as e:
        logger.exception(f"Failed to get brand settings: {e}")
        return {'error': str(e)}


@app.put("/settings/brand")
@tracer.capture_method
def save_brand_settings():
    """Save brand configuration to DynamoDB."""
    body = app.current_event.json_body
    
    try:
        now = datetime.now(timezone.utc).isoformat()
        item = {
            'pk': SETTINGS_PK,
            'sk': SETTINGS_SK,
            'brand_name': body.get('brand_name', ''),
            'brand_handles': body.get('brand_handles', []),
            'hashtags': body.get('hashtags', []),
            'urls_to_track': body.get('urls_to_track', []),
            'updated_at': now,
        }
        
        aggregates_table.put_item(Item=item)
        logger.info(f"Saved brand settings: {item.get('brand_name')}")
        
        return {
            'success': True,
            'message': 'Brand settings saved',
            'settings': {
                'brand_name': item['brand_name'],
                'brand_handles': item['brand_handles'],
                'hashtags': item['hashtags'],
                'urls_to_track': item['urls_to_track'],
            }
        }
    except Exception as e:
        logger.exception(f"Failed to save brand settings: {e}")
        return {'success': False, 'message': str(e)}


# Brand Settings Endpoints
@app.get("/settings/brand")
@tracer.capture_method
def get_brand_settings():
    """Get brand settings from DynamoDB."""
    if not projects_table:
        return {'brand_name': '', 'brand_handles': [], 'hashtags': [], 'urls_to_track': []}
    
    try:
        response = projects_table.get_item(
            Key={'pk': 'SETTINGS', 'sk': 'BRAND'}
        )
        item = response.get('Item', {})
        return {
            'brand_name': item.get('brand_name', ''),
            'brand_handles': item.get('brand_handles', []),
            'hashtags': item.get('hashtags', []),
            'urls_to_track': item.get('urls_to_track', [])
        }
    except Exception as e:
        logger.exception(f"Failed to get brand settings: {e}")
        return {'brand_name': '', 'brand_handles': [], 'hashtags': [], 'urls_to_track': [], 'error': str(e)}


@app.put("/settings/brand")
@tracer.capture_method
def save_brand_settings():
    """Save brand settings to DynamoDB."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    body = app.current_event.json_body
    now = datetime.now(timezone.utc).isoformat()
    
    item = {
        'pk': 'SETTINGS',
        'sk': 'BRAND',
        'brand_name': body.get('brand_name', ''),
        'brand_handles': body.get('brand_handles', []),
        'hashtags': body.get('hashtags', []),
        'urls_to_track': body.get('urls_to_track', []),
        'updated_at': now
    }
    
    try:
        projects_table.put_item(Item=item)
        return {'success': True, 'message': 'Brand settings saved', 'settings': item}
    except Exception as e:
        logger.exception(f"Failed to save brand settings: {e}")
        return {'success': False, 'message': str(e)}


# Categories Configuration Endpoints
@app.get("/settings/categories")
@tracer.capture_method
def get_categories_config():
    """Get categories configuration from DynamoDB."""
    if not projects_table:
        return {'categories': get_default_categories()}
    
    try:
        response = projects_table.get_item(
            Key={'pk': 'SETTINGS', 'sk': 'CATEGORIES'}
        )
        item = response.get('Item')
        if not item or not item.get('categories'):
            return {'categories': get_default_categories()}
        return {
            'categories': item.get('categories', []),
            'updated_at': item.get('updated_at')
        }
    except Exception as e:
        logger.exception(f"Failed to get categories config: {e}")
        return {'categories': get_default_categories(), 'error': str(e)}


@app.put("/settings/categories")
@tracer.capture_method
def save_categories_config():
    """Save categories configuration to DynamoDB."""
    if not projects_table:
        return {'success': False, 'message': 'Projects table not configured'}
    
    body = app.current_event.json_body
    now = datetime.now(timezone.utc).isoformat()
    
    categories = body.get('categories', [])
    
    item = {
        'pk': 'SETTINGS',
        'sk': 'CATEGORIES',
        'categories': categories,
        'updated_at': now
    }
    
    try:
        projects_table.put_item(Item=item)
        logger.info(f"Saved {len(categories)} categories")
        return {'success': True, 'message': f'Saved {len(categories)} categories'}
    except Exception as e:
        logger.exception(f"Failed to save categories config: {e}")
        return {'success': False, 'message': str(e)}


@app.post("/settings/categories/generate")
@tracer.capture_method
def generate_categories():
    """Use LLM to generate category suggestions based on company description."""
    body = app.current_event.json_body
    company_description = body.get('company_description', '')
    
    if not company_description:
        return {'success': False, 'message': 'Company description is required'}
    
    try:
        bedrock = boto3.client('bedrock-runtime')
        
        prompt = f"""You are an expert in customer experience and feedback categorization.

Based on the following company/product description, generate a comprehensive list of feedback categories and subcategories that would be relevant for analyzing customer feedback.

Company/Product Description:
{company_description}

Generate categories that cover:
1. Product/service quality issues
2. Customer support experiences
3. Pricing and billing concerns
4. User experience and usability
5. Delivery/fulfillment (if applicable)
6. Communication and transparency
7. Any industry-specific categories

Return ONLY valid JSON in this exact format:
{{
  "categories": [
    {{
      "id": "cat_unique_id",
      "name": "category_name_snake_case",
      "description": "Human readable category name",
      "subcategories": [
        {{
          "id": "sub_unique_id",
          "name": "subcategory_name_snake_case",
          "description": "Human readable subcategory name"
        }}
      ]
    }}
  ]
}}

Generate 8-12 main categories with 3-6 subcategories each. Use snake_case for names and provide clear descriptions."""

        # Use Claude Sonnet 4.5 via global cross-region inference profile
        bedrock_response = bedrock.invoke_model(
            modelId='global.anthropic.claude-sonnet-4-5-20250929-v1:0',
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 4096,
                'temperature': 0.7,
                'messages': [{'role': 'user', 'content': prompt}]
            })
        )
        
        result = json.loads(bedrock_response['body'].read())
        llm_response = result['content'][0]['text']
        
        # Parse JSON from response
        import re
        json_match = re.search(r'\{[\s\S]*\}', llm_response)
        if json_match:
            parsed = json.loads(json_match.group())
            categories = parsed.get('categories', [])
            
            # Ensure unique IDs
            for i, cat in enumerate(categories):
                if not cat.get('id'):
                    cat['id'] = f"cat_{i}_{datetime.now().strftime('%H%M%S')}"
                for j, sub in enumerate(cat.get('subcategories', [])):
                    if not sub.get('id'):
                        sub['id'] = f"sub_{i}_{j}_{datetime.now().strftime('%H%M%S')}"
            
            return {'success': True, 'categories': categories}
        else:
            return {'success': False, 'message': 'Could not parse LLM response'}
            
    except Exception as e:
        logger.exception(f"Failed to generate categories: {e}")
        return {'success': False, 'message': str(e)}


def get_default_categories():
    """Return default feedback categories."""
    return [
        {
            'id': 'cat_delivery',
            'name': 'delivery',
            'description': 'Delivery & Shipping',
            'subcategories': [
                {'id': 'sub_late', 'name': 'late_delivery', 'description': 'Late Delivery'},
                {'id': 'sub_damaged', 'name': 'damaged_package', 'description': 'Damaged Package'},
                {'id': 'sub_wrong', 'name': 'wrong_item', 'description': 'Wrong Item'},
                {'id': 'sub_missing', 'name': 'missing_item', 'description': 'Missing Item'},
            ]
        },
        {
            'id': 'cat_support',
            'name': 'customer_support',
            'description': 'Customer Support',
            'subcategories': [
                {'id': 'sub_rude', 'name': 'rude_agent', 'description': 'Rude Agent'},
                {'id': 'sub_wait', 'name': 'long_wait', 'description': 'Long Wait Time'},
                {'id': 'sub_unresolved', 'name': 'unresolved_issue', 'description': 'Unresolved Issue'},
                {'id': 'sub_helpful', 'name': 'helpful_agent', 'description': 'Helpful Agent'},
            ]
        },
        {
            'id': 'cat_quality',
            'name': 'product_quality',
            'description': 'Product Quality',
            'subcategories': [
                {'id': 'sub_defective', 'name': 'defective', 'description': 'Defective Product'},
                {'id': 'sub_not_described', 'name': 'not_as_described', 'description': 'Not As Described'},
                {'id': 'sub_poor_materials', 'name': 'poor_materials', 'description': 'Poor Materials'},
                {'id': 'sub_excellent', 'name': 'excellent_quality', 'description': 'Excellent Quality'},
            ]
        },
        {
            'id': 'cat_pricing',
            'name': 'pricing',
            'description': 'Pricing & Value',
            'subcategories': [
                {'id': 'sub_overcharged', 'name': 'overcharged', 'description': 'Overcharged'},
                {'id': 'sub_hidden', 'name': 'hidden_fees', 'description': 'Hidden Fees'},
                {'id': 'sub_value', 'name': 'good_value', 'description': 'Good Value'},
                {'id': 'sub_expensive', 'name': 'expensive', 'description': 'Too Expensive'},
            ]
        },
        {
            'id': 'cat_website',
            'name': 'website',
            'description': 'Website Experience',
            'subcategories': [
                {'id': 'sub_navigation', 'name': 'navigation', 'description': 'Navigation Issues'},
                {'id': 'sub_checkout', 'name': 'checkout', 'description': 'Checkout Problems'},
                {'id': 'sub_search', 'name': 'search', 'description': 'Search Issues'},
            ]
        },
        {
            'id': 'cat_app',
            'name': 'app',
            'description': 'Mobile App',
            'subcategories': [
                {'id': 'sub_crash', 'name': 'crashes', 'description': 'App Crashes'},
                {'id': 'sub_slow', 'name': 'slow_performance', 'description': 'Slow Performance'},
                {'id': 'sub_bugs', 'name': 'bugs', 'description': 'Bugs & Glitches'},
            ]
        },
        {
            'id': 'cat_billing',
            'name': 'billing',
            'description': 'Billing & Payments',
            'subcategories': [
                {'id': 'sub_incorrect', 'name': 'incorrect_charge', 'description': 'Incorrect Charge'},
                {'id': 'sub_refund', 'name': 'refund_issue', 'description': 'Refund Issue'},
                {'id': 'sub_payment', 'name': 'payment_failed', 'description': 'Payment Failed'},
            ]
        },
        {
            'id': 'cat_returns',
            'name': 'returns',
            'description': 'Returns & Refunds',
            'subcategories': [
                {'id': 'sub_difficult', 'name': 'difficult_process', 'description': 'Difficult Process'},
                {'id': 'sub_slow_refund', 'name': 'slow_refund', 'description': 'Slow Refund'},
                {'id': 'sub_easy', 'name': 'easy_return', 'description': 'Easy Return'},
            ]
        },
        {
            'id': 'cat_communication',
            'name': 'communication',
            'description': 'Communication',
            'subcategories': [
                {'id': 'sub_no_updates', 'name': 'no_updates', 'description': 'No Updates'},
                {'id': 'sub_spam', 'name': 'too_many_emails', 'description': 'Too Many Emails'},
                {'id': 'sub_clear', 'name': 'clear_communication', 'description': 'Clear Communication'},
            ]
        },
        {
            'id': 'cat_other',
            'name': 'other',
            'description': 'Other',
            'subcategories': []
        },
    ]


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    try:
        logger.info(f"Received event path: {event.get('path', 'unknown')}")
        result = app.resolve(event, context)
        return result
    except Exception as e:
        logger.exception(f"Lambda handler error: {e}")
        # Return proper error response with CORS headers
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With,X-Amz-Date,X-Api-Key,X-Amz-Security-Token',
                'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
            },
            'body': json.dumps({'error': str(e), 'message': 'Internal server error'})
        }
