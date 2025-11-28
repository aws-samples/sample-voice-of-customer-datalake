"""
VoC Operations API Lambda
Handles CRUD and integration operations: /pipelines/*, /integrations/*, /sources/*, /scrapers/*, /chat/*
Split from main handler to reduce Lambda resource policy size.

This handler imports endpoints from the main handler module to avoid code duplication.
"""
import json
import os
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Any
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.event_handler.exceptions import NotFoundError
from boto3.dynamodb.conditions import Key, Attr
import boto3

logger = Logger()
tracer = Tracer()

# AWS Clients
dynamodb = boto3.resource('dynamodb')
secretsmanager = boto3.client('secretsmanager')
events_client = boto3.client('events')
lambda_client = boto3.client('lambda')

# Configuration
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')
PIPELINES_TABLE = os.environ.get('PIPELINES_TABLE', '')
CONVERSATIONS_TABLE = os.environ.get('CONVERSATIONS_TABLE', '')
SECRETS_ARN = os.environ.get('SECRETS_ARN', '')

feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None
pipelines_table = dynamodb.Table(PIPELINES_TABLE) if PIPELINES_TABLE else None
conversations_table = dynamodb.Table(CONVERSATIONS_TABLE) if CONVERSATIONS_TABLE else None

# Configure CORS
cors_config = CORSConfig(
    allow_origin="*",
    allow_headers=["Content-Type", "Authorization", "X-Requested-With", "X-Amz-Date", "X-Api-Key", "X-Amz-Security-Token"],
    expose_headers=["Content-Type"],
    max_age=300,
    allow_credentials=False
)

app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


# ============================================
# Chat Endpoint
# ============================================

@app.post("/chat")
@tracer.capture_method
def chat():
    """AI chat endpoint for querying feedback data using Bedrock."""
    body = app.current_event.json_body
    message = body.get('message', '')
    context_hint = body.get('context', '')
    
    params = app.current_event.query_string_parameters or {}
    days = int(params.get('days', 7))
    
    current_date = datetime.now(timezone.utc)
    
    # Get metrics
    total_feedback = 0
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(Key={'pk': 'METRIC#daily_total', 'sk': date})
        item = response.get('Item')
        if item:
            total_feedback += item.get('count', 0)
    
    sentiment_counts = {'positive': 0, 'negative': 0, 'neutral': 0, 'mixed': 0}
    for sentiment in sentiment_counts.keys():
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = aggregates_table.get_item(Key={'pk': f'METRIC#daily_sentiment#{sentiment}', 'sk': date})
            item = response.get('Item')
            if item:
                sentiment_counts[sentiment] += item.get('count', 0)
    
    category_counts = {}
    categories = ['delivery', 'customer_support', 'product_quality', 'pricing', 
                  'website', 'app', 'billing', 'returns', 'communication', 'other']
    for category in categories:
        total = 0
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = aggregates_table.get_item(Key={'pk': f'METRIC#daily_category#{category}', 'sk': date})
            item = response.get('Item')
            if item:
                total += item.get('count', 0)
        if total > 0:
            category_counts[category] = total
    
    urgent_count = 0
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(Key={'pk': 'METRIC#urgent', 'sk': date})
        item = response.get('Item')
        if item:
            urgent_count += item.get('count', 0)
    
    # Get recent feedback
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
    
    # Build context
    feedback_context = []
    for item in feedback_items[:20]:
        feedback_context.append({
            'source': item.get('source_platform', 'unknown'),
            'date': item.get('source_created_at', '')[:10] if item.get('source_created_at') else '',
            'text': item.get('original_text', '')[:500],
            'sentiment': item.get('sentiment_label', 'unknown'),
            'sentiment_score': float(item.get('sentiment_score', 0)),
            'category': item.get('category', 'other'),
            'urgency': item.get('urgency', 'low'),
            'rating': item.get('rating'),
            'problem_summary': item.get('problem_summary', ''),
        })
    
    system_prompt = """You are a Voice of the Customer (VoC) analytics assistant. You help analyze customer feedback data and provide actionable insights.
When answering questions:
1. Base your answers ONLY on the actual data provided
2. Be specific with numbers and percentages
3. Quote actual customer feedback when relevant
4. Highlight urgent issues
5. Provide actionable recommendations"""

    data_context = f"""## Data Summary (Last {days} days)
Total Feedback: {total_feedback}
Urgent Issues: {urgent_count}

Sentiment: Positive {sentiment_counts['positive']}, Neutral {sentiment_counts['neutral']}, Negative {sentiment_counts['negative']}, Mixed {sentiment_counts['mixed']}

Top Categories: {', '.join([f"{cat}: {count}" for cat, count in sorted(category_counts.items(), key=lambda x: x[1], reverse=True)[:5]])}

## Recent Feedback:
"""
    for i, fb in enumerate(feedback_context[:10], 1):
        data_context += f"\n{i}. [{fb['source']}|{fb['sentiment']}] {fb['text'][:200]}"

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
                'messages': [{'role': 'user', 'content': f"{data_context}\n\nQuestion: {message}"}]
            })
        )
        result = json.loads(bedrock_response['body'].read())
        response_text = result['content'][0]['text']
        
        return {
            'response': response_text,
            'sources': feedback_items[:3],
            'metadata': {'total_feedback': total_feedback, 'days_analyzed': days, 'urgent_count': urgent_count}
        }
    except Exception as e:
        logger.exception(f"Bedrock call failed: {e}")
        return {
            'response': f"Error connecting to AI service. Summary: {total_feedback} feedback items, {urgent_count} urgent.",
            'sources': feedback_items[:3],
            'error': str(e)
        }



# ============================================
# Pipeline Endpoints
# ============================================

@app.get("/pipelines")
@tracer.capture_method
def list_pipelines():
    """List all pipelines."""
    if not pipelines_table:
        return {'pipelines': []}
    response = pipelines_table.scan()
    return {'pipelines': response.get('Items', [])}


@app.get("/pipelines/<pipeline_id>")
@tracer.capture_method
def get_pipeline(pipeline_id: str):
    """Get a single pipeline."""
    if not pipelines_table:
        raise NotFoundError("Pipelines not configured")
    response = pipelines_table.get_item(Key={'id': pipeline_id})
    item = response.get('Item')
    if not item:
        raise NotFoundError(f"Pipeline {pipeline_id} not found")
    return item


@app.post("/pipelines")
@tracer.capture_method
def create_pipeline():
    """Create a new pipeline."""
    if not pipelines_table:
        return {'success': False, 'message': 'Pipelines not configured'}
    
    body = app.current_event.json_body
    pipeline_id = body.get('id') or f"pipeline-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    
    item = {
        'id': pipeline_id,
        'name': body.get('name', 'New Pipeline'),
        'description': body.get('description', ''),
        'source': body.get('source', 'all'),
        'steps': body.get('steps', []),
        'enabled': body.get('enabled', True),
        'status': 'idle',
        'created_at': datetime.now(timezone.utc).isoformat(),
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }
    
    pipelines_table.put_item(Item=item)
    return {'success': True, 'pipeline': item}


@app.put("/pipelines/<pipeline_id>")
@tracer.capture_method
def update_pipeline(pipeline_id: str):
    """Update a pipeline."""
    if not pipelines_table:
        return {'success': False, 'message': 'Pipelines not configured'}
    
    body = app.current_event.json_body
    
    update_expr = "SET updated_at = :updated_at"
    expr_values = {':updated_at': datetime.now(timezone.utc).isoformat()}
    
    for field in ['name', 'description', 'source', 'steps', 'enabled', 'status']:
        if field in body:
            update_expr += f", #{field} = :{field}"
            expr_values[f':{field}'] = body[field]
    
    expr_names = {f'#{f}': f for f in ['name', 'description', 'source', 'steps', 'enabled', 'status'] if f in body}
    
    pipelines_table.update_item(
        Key={'id': pipeline_id},
        UpdateExpression=update_expr,
        ExpressionAttributeValues=expr_values,
        ExpressionAttributeNames=expr_names if expr_names else None
    )
    return {'success': True}


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
    return {'success': True, 'execution_id': f"exec-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"}


# ============================================
# Integration Endpoints
# ============================================

@app.get("/integrations/status")
@tracer.capture_method
def get_integration_status():
    """Get status of all integrations."""
    if not SECRETS_ARN:
        return {'error': 'Secrets not configured'}
    
    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        
        status = {}
        integrations = {
            'trustpilot': ['trustpilot_api_key', 'trustpilot_api_secret', 'trustpilot_business_unit_id'],
            'google_reviews': ['google_api_key'],
            'twitter': ['twitter_bearer_token'],
            'meta': ['meta_access_token'],
            'reddit': ['reddit_client_id', 'reddit_client_secret'],
            'tavily': ['tavily_api_key'],
        }
        
        for source, keys in integrations.items():
            configured_keys = [k for k in keys if secrets.get(k)]
            status[source] = {
                'configured': len(configured_keys) == len(keys),
                'credentials_set': configured_keys
            }
        
        return status
    except Exception as e:
        logger.exception(f"Failed to get integration status: {e}")
        return {'error': str(e)}


@app.put("/integrations/<source>/credentials")
@tracer.capture_method
def update_integration_credentials(source: str):
    """Update credentials for an integration."""
    if not SECRETS_ARN:
        return {'success': False, 'message': 'Secrets not configured'}
    
    body = app.current_event.json_body
    
    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        
        for key, value in body.items():
            if value:
                secrets[key] = value
        
        secretsmanager.put_secret_value(SecretId=SECRETS_ARN, SecretString=json.dumps(secrets))
        return {'success': True, 'message': f'Credentials updated for {source}'}
    except Exception as e:
        logger.exception(f"Failed to update credentials: {e}")
        return {'success': False, 'message': str(e)}


@app.post("/integrations/<source>/test")
@tracer.capture_method
def test_integration(source: str):
    """Test an integration connection."""
    return {'success': True, 'message': f'Integration {source} test not implemented'}


# ============================================
# Data Source Schedule Endpoints
# ============================================

@app.get("/sources/status")
@tracer.capture_method
def get_sources_status():
    """Get status of all data source schedules."""
    sources = ['trustpilot', 'google_reviews', 'twitter', 'instagram', 'facebook', 
               'reddit', 'tavily', 'appstore_apple', 'appstore_google', 'webscraper']
    
    status = {}
    for source in sources:
        rule_name = f"voc-ingest-{source}-schedule"
        try:
            response = events_client.describe_rule(Name=rule_name)
            status[source] = {
                'enabled': response.get('State') == 'ENABLED',
                'schedule': response.get('ScheduleExpression'),
                'rule_name': rule_name,
                'exists': True
            }
        except events_client.exceptions.ResourceNotFoundException:
            status[source] = {'enabled': False, 'exists': False}
        except Exception as e:
            status[source] = {'enabled': False, 'error': str(e)}
    
    return {'sources': status}


@app.put("/sources/<source>/enable")
@tracer.capture_method
def enable_source(source: str):
    """Enable a data source schedule."""
    rule_name = f"voc-ingest-{source}-schedule"
    try:
        events_client.enable_rule(Name=rule_name)
        return {'success': True, 'source': source, 'enabled': True}
    except Exception as e:
        return {'success': False, 'message': str(e)}


@app.put("/sources/<source>/disable")
@tracer.capture_method
def disable_source(source: str):
    """Disable a data source schedule."""
    rule_name = f"voc-ingest-{source}-schedule"
    try:
        events_client.disable_rule(Name=rule_name)
        return {'success': True, 'source': source, 'enabled': False}
    except Exception as e:
        return {'success': False, 'message': str(e)}



# ============================================
# Scraper Endpoints
# ============================================

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
        return {'success': False, 'message': 'Secrets not configured'}
    
    body = app.current_event.json_body
    scraper = body.get('scraper')
    
    if not scraper:
        return {'success': False, 'message': 'No scraper config provided'}
    
    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        configs = json.loads(secrets.get('webscraper_configs', '[]'))
        
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
        return {'success': False, 'message': 'Secrets not configured'}
    
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
    """Get available scraper templates."""
    templates = [
        {
            'id': 'trustpilot_jsonld',
            'name': 'Trustpilot (JSON-LD)',
            'description': 'Extract reviews using JSON-LD structured data.',
            'icon': '⭐',
            'extraction_method': 'jsonld',
            'url_pattern': 'https://www.trustpilot.com/review/{company_domain}',
            'supports_pagination': True,
            'config': {'extraction_method': 'jsonld', 'template': 'trustpilot'}
        },
        {
            'id': 'custom_css',
            'name': 'Custom (CSS Selectors)',
            'description': 'Create a custom scraper with CSS selectors.',
            'icon': '🔧',
            'extraction_method': 'css',
            'url_pattern': '',
            'supports_pagination': True,
            'config': {
                'extraction_method': 'css',
                'container_selector': '.review',
                'text_selector': '.review-text',
            }
        },
    ]
    return {'templates': templates}


@app.post("/scrapers/<scraper_id>/run")
@tracer.capture_method
def run_scraper(scraper_id: str):
    """Trigger a scraper run and return execution ID for tracking."""
    execution_id = f"run_{scraper_id}_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    
    try:
        # Store run status in DynamoDB BEFORE invoking Lambda
        aggregates_table.put_item(Item={
            'pk': f'SCRAPER_RUN#{scraper_id}',
            'sk': execution_id,
            'status': 'running',
            'started_at': datetime.now(timezone.utc).isoformat(),
            'pages_scraped': 0,
            'items_found': 0,
            'errors': []
        })
        
        # Invoke webscraper Lambda with execution_id for progress tracking
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
        response = aggregates_table.query(
            KeyConditionExpression=Key('pk').eq(f'SCRAPER_RUN#{scraper_id}'),
            ScanIndexForward=False,
            Limit=1
        )
        items = response.get('Items', [])
        if not items:
            return {'scraper_id': scraper_id, 'status': 'never_run'}
        
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
        return {'scraper_id': scraper_id, 'status': 'unknown', 'error': str(e)}


@app.get("/scrapers/<scraper_id>/runs")
@tracer.capture_method
def get_scraper_runs(scraper_id: str):
    """Get scraper run history."""
    try:
        response = aggregates_table.query(
            KeyConditionExpression=Key('pk').eq(f'SCRAPER_RUN#{scraper_id}'),
            ScanIndexForward=False,
            Limit=10
        )
        return {'runs': response.get('Items', [])}
    except Exception as e:
        return {'runs': [], 'error': str(e)}


@app.post("/scrapers/analyze-url")
@tracer.capture_method
def analyze_url_for_selectors():
    """Use LLM to auto-detect CSS selectors for a URL."""
    import urllib.request
    
    body = app.current_event.json_body
    url = body.get('url')
    
    if not url:
        return {'success': False, 'message': 'URL is required'}
    
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml',
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as response:
            html_content = response.read().decode('utf-8', errors='ignore')
        
        html_sample = html_content[:50000]
        
        bedrock = boto3.client('bedrock-runtime')
        prompt = f"""Analyze this HTML and identify CSS selectors for extracting reviews:

```html
{html_sample}
```

Return JSON with: container_selector, text_selector, rating_selector, author_selector, date_selector, confidence (high/medium/low), detected_reviews_count"""

        bedrock_response = bedrock.invoke_model(
            modelId='global.anthropic.claude-sonnet-4-5-20250929-v1:0',
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 1000,
                'messages': [{'role': 'user', 'content': prompt}]
            })
        )
        
        result = json.loads(bedrock_response['body'].read())
        response_text = result['content'][0]['text']
        
        # Try to parse JSON from response
        import re
        json_match = re.search(r'\{[^{}]*\}', response_text, re.DOTALL)
        if json_match:
            selectors = json.loads(json_match.group())
            return {'success': True, 'selectors': selectors}
        
        return {'success': False, 'message': 'Could not parse selectors from response'}
    except Exception as e:
        logger.exception(f"Failed to analyze URL: {e}")
        return {'success': False, 'message': str(e)}


# ============================================
# Chat Conversations Endpoints
# ============================================

@app.get("/chat/conversations/<proxy+>")
@tracer.capture_method
def get_conversations(proxy: str = ""):
    """List or get chat conversations."""
    if not conversations_table:
        return {'conversations': []}
    
    conversation_id = proxy.strip() if proxy and proxy != '_list' else None
    
    if conversation_id:
        try:
            response = conversations_table.get_item(Key={'pk': 'USER#default', 'sk': f'CONV#{conversation_id}'})
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
    
    response = conversations_table.query(
        KeyConditionExpression=Key('pk').eq('USER#default'),
        ScanIndexForward=False,
        Limit=50
    )
    
    conversations = []
    for item in response.get('Items', []):
        conversations.append({
            'id': item.get('conversation_id'),
            'title': item.get('title', 'New Conversation'),
            'messageCount': len(item.get('messages', [])),
            'createdAt': item.get('created_at'),
            'updatedAt': item.get('updated_at'),
        })
    
    return {'conversations': conversations}


@app.post("/chat/conversations/<proxy+>")
@tracer.capture_method
def save_conversation(proxy: str = ""):
    """Save a chat conversation."""
    if not conversations_table:
        return {'success': False, 'message': 'Conversations not configured'}
    
    body = app.current_event.json_body
    conversation_id = body.get('id') or f"conv-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}"
    
    item = {
        'pk': 'USER#default',
        'sk': f'CONV#{conversation_id}',
        'conversation_id': conversation_id,
        'title': body.get('title', 'New Conversation'),
        'messages': body.get('messages', []),
        'filters': body.get('filters', {}),
        'created_at': body.get('createdAt') or datetime.now(timezone.utc).isoformat(),
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }
    
    conversations_table.put_item(Item=item)
    return {'success': True, 'id': conversation_id}


@app.delete("/chat/conversations/<proxy+>")
@tracer.capture_method
def delete_conversation(proxy: str):
    """Delete a chat conversation."""
    if not conversations_table or not proxy:
        return {'success': False}
    
    conversations_table.delete_item(Key={'pk': 'USER#default', 'sk': f'CONV#{proxy}'})
    return {'success': True}


# ============================================
# Settings Endpoints - Brand Configuration
# ============================================
SETTINGS_PK = 'SETTINGS#brand'
SETTINGS_SK = 'config'


@app.get("/settings/brand")
@tracer.capture_method
def get_brand_settings():
    """Get brand configuration from DynamoDB."""
    if not aggregates_table:
        return {'error': 'Aggregates table not configured'}
    
    try:
        response = aggregates_table.get_item(
            Key={'pk': SETTINGS_PK, 'sk': SETTINGS_SK}
        )
        item = response.get('Item')
        if not item:
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
    if not aggregates_table:
        return {'success': False, 'message': 'Aggregates table not configured'}
    
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


# ============================================
# Settings Endpoints - Categories Configuration
# ============================================
CATEGORIES_PK = 'SETTINGS#categories'
CATEGORIES_SK = 'config'


@app.get("/settings/categories")
@tracer.capture_method
def get_categories_config():
    """Get categories configuration from DynamoDB."""
    if not aggregates_table:
        return {'categories': [], 'error': 'Aggregates table not configured'}
    
    try:
        response = aggregates_table.get_item(
            Key={'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK}
        )
        item = response.get('Item')
        if not item:
            return {'categories': [], 'updated_at': None}
        return {
            'categories': item.get('categories', []),
            'updated_at': item.get('updated_at'),
        }
    except Exception as e:
        logger.exception(f"Failed to get categories config: {e}")
        return {'categories': [], 'error': str(e)}


@app.put("/settings/categories")
@tracer.capture_method
def save_categories_config():
    """Save categories configuration to DynamoDB."""
    if not aggregates_table:
        return {'success': False, 'message': 'Aggregates table not configured'}
    
    body = app.current_event.json_body
    categories = body.get('categories', [])
    
    try:
        now = datetime.now(timezone.utc).isoformat()
        item = {
            'pk': CATEGORIES_PK,
            'sk': CATEGORIES_SK,
            'categories': categories,
            'updated_at': now,
        }
        
        aggregates_table.put_item(Item=item)
        logger.info(f"Saved categories config: {len(categories)} categories")
        
        return {
            'success': True,
            'message': f'Saved {len(categories)} categories',
        }
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
        
        prompt = f"""Based on the following company/product description, generate a comprehensive list of feedback categories and subcategories that would be useful for analyzing customer feedback.

Company Description:
{company_description}

Generate 6-10 main categories, each with 3-5 relevant subcategories. Categories should cover common customer feedback themes like product quality, service, pricing, etc., but tailored to this specific business.

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{{
  "categories": [
    {{
      "id": "category_id_snake_case",
      "name": "category_id_snake_case",
      "description": "Human Readable Category Name",
      "subcategories": [
        {{
          "id": "subcategory_id_snake_case",
          "name": "subcategory_id_snake_case",
          "description": "Human Readable Subcategory Name"
        }}
      ]
    }}
  ]
}}"""

        bedrock_response = bedrock.invoke_model(
            modelId='global.anthropic.claude-sonnet-4-5-20250929-v1:0',
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 2000,
                'temperature': 0.3,
                'messages': [{'role': 'user', 'content': prompt}]
            })
        )
        
        result = json.loads(bedrock_response['body'].read())
        response_text = result['content'][0]['text']
        
        # Parse JSON from response
        import re
        json_match = re.search(r'\{[\s\S]*\}', response_text)
        if json_match:
            parsed = json.loads(json_match.group())
            categories = parsed.get('categories', [])
            
            logger.info(f"Generated {len(categories)} categories")
            return {
                'success': True,
                'categories': categories,
            }
        
        return {'success': False, 'message': 'Could not parse categories from response'}
    except Exception as e:
        logger.exception(f"Failed to generate categories: {e}")
        return {'success': False, 'message': str(e)}


# ============================================
# Lambda Handler
# ============================================

@logger.inject_lambda_context
@tracer.capture_lambda_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
