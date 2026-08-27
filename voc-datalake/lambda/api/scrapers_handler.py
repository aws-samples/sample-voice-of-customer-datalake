"""
Scrapers API Lambda - Handles /scrapers/*
Manages web scraper configurations and runs.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, tracer
from shared.aws import get_secrets_client, put_secret_json
from shared.api import create_api_resolver, api_handler
from shared.http_utils import (
    OutboundUrlBlocked,
    assert_outbound_url_allowed,
    fetch_checked_with_retry,
)
# The write-time check lives in shared/ because `PUT /integrations/webscraper/
# credentials` writes the SAME `webscraper_configs` key from a different Lambda,
# and the two handlers cannot import each other (issue #244).
from shared.scraper_urls import validate_scraper_destinations
from shared.tables import get_aggregates_table
from shared.exceptions import ConfigurationError, ValidationError, ServiceError

from boto3.dynamodb.conditions import Key
import boto3

secretsmanager = get_secrets_client()
lambda_client = boto3.client("lambda")

SECRETS_ARN = os.environ.get("SECRETS_ARN", "")
WEBSCRAPER_FUNCTION_NAME = os.environ.get("WEBSCRAPER_FUNCTION_NAME", "")

def require_webscraper_function():
    """Validate WEBSCRAPER_FUNCTION_NAME is configured."""
    if not WEBSCRAPER_FUNCTION_NAME:
        raise ValueError("WEBSCRAPER_FUNCTION_NAME environment variable is required")
    return WEBSCRAPER_FUNCTION_NAME

app = create_api_resolver()

# Time budget for the analyze/preview fetch, which runs INSIDE an API Gateway
# request and so has ~29 s in total however long the Lambda's own timeout is.
# `fetch_checked_with_retry` may follow up to MAX_REDIRECT_HOPS hops, each with
# tenacity retries, so a per-request timeout alone bounds nothing useful here:
# before this budget existed, a chain of slow-but-valid hops overran the
# integration limit and surfaced as a 504 with no error message instead of the
# 400/500 this route means to return. The per-hop value stays lower than the
# total so a single stalled hop cannot consume the whole budget.
PREVIEW_FETCH_HOP_TIMEOUT_SECONDS = 10
PREVIEW_FETCH_TOTAL_TIMEOUT_SECONDS = 20


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
        raise ConfigurationError('Secrets not configured')
    
    body = app.current_event.json_body
    scraper = body.get('scraper')
    if not scraper:
        raise ValidationError('No scraper config provided')
    if not isinstance(scraper, dict):
        raise ValidationError('Scraper config must be an object')

    # BEFORE the try below, so its `except Exception -> ServiceError` cannot
    # flatten this actionable 400 into an opaque 500. This route serves both
    # create and update (there is no separate PUT), so one call covers both.
    validate_scraper_destinations(scraper)

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
        put_secret_json(secretsmanager, SECRETS_ARN, secrets)
        return {'success': True, 'scraper': scraper}
    except ValidationError:
        # put_secret_json refuses an over-limit secret. That is a 400 the user
        # can act on ("remove some scrapers"), so it must not be flattened into
        # the generic 500 below.
        raise
    except Exception as e:
        logger.exception(f"Failed to save scraper: {e}")
        raise ServiceError('Failed to save scraper configuration')


@app.delete("/scrapers/<scraper_id>")
@tracer.capture_method
def delete_scraper(scraper_id: str):
    """Delete a scraper configuration."""
    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')
    try:
        response = secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
        secrets = json.loads(response.get('SecretString', '{}'))
        configs = json.loads(secrets.get('webscraper_configs', '[]'))
        configs = [c for c in configs if c.get('id') != scraper_id]
        secrets['webscraper_configs'] = json.dumps(configs)
        put_secret_json(secretsmanager, SECRETS_ARN, secrets)
        return {'success': True}
    except ValidationError:
        # A delete only ever SHRINKS this key, so the size guard cannot fire on
        # what this route adds. It can still fire on a secret that was ALREADY
        # over the limit — written before the guard existed — and that is exactly
        # the caller who is deleting to get back under it. Flattening that into a
        # 500 would hide the one message telling them what to do.
        raise
    except Exception as e:
        logger.exception(f"Failed to delete scraper: {e}")
        raise ServiceError('Failed to delete scraper configuration')


@app.get("/scrapers/templates")
@tracer.capture_method
def get_templates():
    """Get available scraper templates."""
    templates = [
        {
            'id': 'review_jsonld',
            'name': 'Review JSON-LD',
            'description': 'Extract reviews using JSON-LD structured data.',
            'icon': '⭐',
            'extraction_method': 'jsonld',
            'url_pattern': '',
            'supports_pagination': True,
            'config': {
                'extraction_method': 'jsonld',
                'template': 'review_jsonld',
                'pagination': {'enabled': True, 'param': 'page', 'max_pages': 10, 'start': 1}
            }
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
                'pagination': {'enabled': False, 'param': 'page', 'max_pages': 10, 'start': 1}
            }
        },
    ]
    return {'templates': templates}


@app.post("/scrapers/<scraper_id>/run")
@tracer.capture_method
def run_scraper(scraper_id: str):
    """Trigger a scraper run."""
    execution_id = f"run_{scraper_id}_{datetime.now().strftime('%Y%m%d%H%M%S')}"
    try:
        table = get_aggregates_table()
        if table:
            table.put_item(Item={
                'pk': f'SCRAPER_RUN#{scraper_id}', 'sk': execution_id, 'status': 'running',
                'started_at': datetime.now(timezone.utc).isoformat(), 'pages_scraped': 0, 'items_found': 0, 'errors': []
            })
        function_name = require_webscraper_function()
        lambda_client.invoke(FunctionName=function_name, InvocationType='Event',
                            Payload=json.dumps({'scraper_id': scraper_id, 'execution_id': execution_id, 'manual_run': True}))
        return {'success': True, 'execution_id': execution_id, 'status': 'running'}
    except Exception as e:
        logger.exception(f"Failed to run scraper: {e}")
        raise ServiceError('Failed to start scraper run')


@app.get("/scrapers/<scraper_id>/status")
@tracer.capture_method
def get_scraper_status(scraper_id: str):
    """Get the latest run status for a scraper."""
    table = get_aggregates_table()
    if not table:
        return {'scraper_id': scraper_id, 'status': 'unknown'}
    try:
        response = table.query(KeyConditionExpression=Key('pk').eq(f'SCRAPER_RUN#{scraper_id}'), ScanIndexForward=False, Limit=1)
        items = response.get('Items', [])
        if not items:
            return {'scraper_id': scraper_id, 'status': 'never_run'}
        run = items[0]
        return {'scraper_id': scraper_id, 'execution_id': run.get('sk'), 'status': run.get('status', 'unknown'),
                'started_at': run.get('started_at'), 'completed_at': run.get('completed_at'),
                'pages_scraped': run.get('pages_scraped', 0), 'items_found': run.get('items_found', 0), 'errors': run.get('errors', [])}
    except Exception as e:
        logger.warning(f"Failed to get scraper status: {e}")
        return {'scraper_id': scraper_id, 'status': 'unknown', 'error': 'Failed to retrieve status'}


@app.get("/scrapers/<scraper_id>/runs")
@tracer.capture_method
def get_scraper_runs(scraper_id: str):
    """Get scraper run history."""
    table = get_aggregates_table()
    if not table:
        return {'runs': []}
    try:
        response = table.query(KeyConditionExpression=Key('pk').eq(f'SCRAPER_RUN#{scraper_id}'), ScanIndexForward=False, Limit=10)
        return {'runs': response.get('Items', [])}
    except Exception as e:
        logger.warning(f"Failed to get scraper runs: {e}")
        return {'runs': [], 'error': 'Failed to retrieve run history'}


@app.post("/scrapers/analyze-url")
@tracer.capture_method
def analyze_url():
    """Use LLM to auto-detect CSS selectors for a URL."""
    body = app.current_event.json_body
    url = body.get('url')

    # Cheap pre-check so a bad URL is a 400 before any request is attempted.
    # It is NOT what makes the fetch below safe — fetch_checked_with_retry
    # re-checks the URL and every redirect target it follows, which is what
    # closes the check-then-fetch gap in issue #244.
    try:
        assert_outbound_url_allowed(url)
    except OutboundUrlBlocked as e:
        raise ValidationError(str(e)) from e

    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/html,application/xhtml+xml'}
        response = fetch_checked_with_retry(
            url,
            headers=headers,
            timeout=PREVIEW_FETCH_HOP_TIMEOUT_SECONDS,
            total_timeout=PREVIEW_FETCH_TOTAL_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        html_content = response.text

        html_sample = html_content[:50000]
        from shared.converse import converse
        prompt = f"""Analyze this HTML and identify CSS selectors for extracting reviews:\n\n```html\n{html_sample}\n```\n\nReturn JSON with: container_selector, text_selector, rating_selector, author_selector, date_selector, confidence (high/medium/low), detected_reviews_count"""

        # 2048: strict-JSON output must fit ONE call (see the strict-JSON
        # doctrine in shared/converse.py).
        response_text = converse(prompt=prompt, max_tokens=2048, surface='utility')
        
        json_match = re.search(r'\{[^{}]*\}', response_text, re.DOTALL)
        if not json_match:
            raise ServiceError('Could not parse selectors from response')
        selectors = json.loads(json_match.group())
        return {'success': True, 'selectors': selectors}
    except OutboundUrlBlocked as e:
        # A redirect into an internal destination is the caller's URL being
        # refused, not a server fault: 400 with the reason, not an opaque 500.
        raise ValidationError(str(e)) from e
    except (ValidationError, ServiceError):
        raise
    except Exception as e:
        logger.exception(f"Failed to analyze URL: {e}")
        raise ServiceError('Failed to analyze URL')


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
