"""
Scrapers API Lambda - Handles /scrapers/*
Manages web scraper configurations and runs.
"""
import json
import os
import urllib.request
from datetime import datetime, timezone
from typing import Any
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.event_handler.exceptions import NotFoundError
from boto3.dynamodb.conditions import Key
import boto3

logger = Logger()
tracer = Tracer()

secretsmanager = boto3.client('secretsmanager')
lambda_client = boto3.client('lambda')
dynamodb = boto3.resource('dynamodb')

SECRETS_ARN = os.environ.get('SECRETS_ARN', '')
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

cors_config = CORSConfig(allow_origin="*", allow_headers=["Content-Type", "Authorization"], max_age=300)
app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)


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
def get_templates():
    """Get available scraper templates."""
    templates = [
        {'id': 'trustpilot_jsonld', 'name': 'Trustpilot (JSON-LD)', 'description': 'Extract reviews using JSON-LD.', 'icon': '⭐', 'extraction_method': 'jsonld', 'url_pattern': 'https://www.trustpilot.com/review/{company_domain}', 'supports_pagination': True, 'config': {'extraction_method': 'jsonld', 'template': 'trustpilot'}},
        {'id': 'custom_css', 'name': 'Custom (CSS Selectors)', 'description': 'Create a custom scraper with CSS selectors.', 'icon': '🔧', 'extraction_method': 'css', 'url_pattern': '', 'supports_pagination': True, 'config': {'extraction_method': 'css', 'container_selector': '.review', 'text_selector': '.review-text'}},
    ]
    return {'templates': templates}


@app.post("/scrapers/<scraper_id>/run")
@tracer.capture_method
def run_scraper(scraper_id: str):
    """Trigger a scraper run."""
    execution_id = f"run_{scraper_id}_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    try:
        if aggregates_table:
            aggregates_table.put_item(Item={
                'pk': f'SCRAPER_RUN#{scraper_id}', 'sk': execution_id, 'status': 'running',
                'started_at': datetime.now(timezone.utc).isoformat(), 'pages_scraped': 0, 'items_found': 0, 'errors': []
            })
        lambda_client.invoke(FunctionName='voc-ingestor-webscraper', InvocationType='Event',
                            Payload=json.dumps({'scraper_id': scraper_id, 'execution_id': execution_id, 'manual_run': True}))
        return {'success': True, 'execution_id': execution_id, 'status': 'running'}
    except Exception as e:
        logger.exception(f"Failed to run scraper: {e}")
        return {'success': False, 'message': str(e)}


@app.get("/scrapers/<scraper_id>/status")
@tracer.capture_method
def get_scraper_status(scraper_id: str):
    """Get the latest run status for a scraper."""
    if not aggregates_table:
        return {'scraper_id': scraper_id, 'status': 'unknown'}
    try:
        response = aggregates_table.query(KeyConditionExpression=Key('pk').eq(f'SCRAPER_RUN#{scraper_id}'), ScanIndexForward=False, Limit=1)
        items = response.get('Items', [])
        if not items:
            return {'scraper_id': scraper_id, 'status': 'never_run'}
        run = items[0]
        return {'scraper_id': scraper_id, 'execution_id': run.get('sk'), 'status': run.get('status', 'unknown'),
                'started_at': run.get('started_at'), 'completed_at': run.get('completed_at'),
                'pages_scraped': run.get('pages_scraped', 0), 'items_found': run.get('items_found', 0), 'errors': run.get('errors', [])}
    except Exception as e:
        return {'scraper_id': scraper_id, 'status': 'unknown', 'error': str(e)}


@app.get("/scrapers/<scraper_id>/runs")
@tracer.capture_method
def get_scraper_runs(scraper_id: str):
    """Get scraper run history."""
    if not aggregates_table:
        return {'runs': []}
    try:
        response = aggregates_table.query(KeyConditionExpression=Key('pk').eq(f'SCRAPER_RUN#{scraper_id}'), ScanIndexForward=False, Limit=10)
        return {'runs': response.get('Items', [])}
    except Exception as e:
        return {'runs': [], 'error': str(e)}


@app.post("/scrapers/analyze-url")
@tracer.capture_method
def analyze_url():
    """Use LLM to auto-detect CSS selectors for a URL."""
    body = app.current_event.json_body
    url = body.get('url')
    if not url:
        return {'success': False, 'message': 'URL is required'}
    
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/html,application/xhtml+xml'}
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as response:
            html_content = response.read().decode('utf-8', errors='ignore')
        
        html_sample = html_content[:50000]
        bedrock = boto3.client('bedrock-runtime')
        prompt = f"""Analyze this HTML and identify CSS selectors for extracting reviews:\n\n```html\n{html_sample}\n```\n\nReturn JSON with: container_selector, text_selector, rating_selector, author_selector, date_selector, confidence (high/medium/low), detected_reviews_count"""
        
        bedrock_response = bedrock.invoke_model(modelId='global.anthropic.claude-sonnet-4-5-20250929-v1:0', contentType='application/json', accept='application/json',
            body=json.dumps({'anthropic_version': 'bedrock-2023-05-31', 'max_tokens': 1000, 'messages': [{'role': 'user', 'content': prompt}]}))
        
        result = json.loads(bedrock_response['body'].read())
        response_text = result['content'][0]['text']
        
        import re
        json_match = re.search(r'\{[^{}]*\}', response_text, re.DOTALL)
        if json_match:
            selectors = json.loads(json_match.group())
            return {'success': True, 'selectors': selectors}
        return {'success': False, 'message': 'Could not parse selectors from response'}
    except Exception as e:
        logger.exception(f"Failed to analyze URL: {e}")
        return {'success': False, 'message': str(e)}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
