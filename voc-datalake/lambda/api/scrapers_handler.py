"""
Scrapers API Lambda - Handles /scrapers/*
Manages web scraper configurations and runs.

Read/write split, matching `integrations_handler`: the three routes that MUTATE
are admin-gated, the reads are not. `POST /scrapers` and
`DELETE /scrapers/<scraper_id>` both `put_secret_json` the SAME shared
API-credentials secret that `integrations_handler` writes — they rewrite
`webscraper_configs`, a key the webscraper ingestor consumes, so an unprivileged
write steers which URLs get fetched. `POST /scrapers/<scraper_id>/run` invokes
that ingestor: a billed third-party fetch against whatever rate limit the target
grants, callable in a loop.

Gating only the `integrations_handler` half of that secret would have made the
boundary depend on which handler a write arrived through rather than on what it
changed, which is the same asymmetry issue #251's fix closed one file over. The
`GET` routes and `POST /scrapers/analyze-url` stay open: they return a scraper's
own configuration and run history to an authenticated user, which the Scrapers
page renders for everyone. Pinned by
`test/test_scrapers_security.py::TestEveryScraperWriteIsAdminGated`, which parses
the decorators so a route added later cannot quietly arrive ungated.
"""

import ipaddress
import json
import os
import re
import socket
import sys
import urllib.request
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, tracer
from shared.aws import get_secrets_client, put_secret_json
from shared.api import create_api_resolver, api_handler, require_admin
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

# Blocked hostnames and IP ranges for SSRF protection
BLOCKED_HOSTNAMES = {'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'}
BLOCKED_IP_RANGES = [
    ipaddress.ip_network('127.0.0.0/8'),       # Loopback
    ipaddress.ip_network('10.0.0.0/8'),        # Private Class A
    ipaddress.ip_network('172.16.0.0/12'),     # Private Class B
    ipaddress.ip_network('192.168.0.0/16'),    # Private Class C
    ipaddress.ip_network('169.254.0.0/16'),    # Link-local (AWS metadata)
    ipaddress.ip_network('::1/128'),           # IPv6 loopback
    ipaddress.ip_network('fc00::/7'),          # IPv6 private
    ipaddress.ip_network('fe80::/10'),         # IPv6 link-local
]


def validate_url(url: str) -> tuple[bool, str]:
    """
    Validate URL to prevent SSRF attacks.
    Returns (is_valid, error_message).
    """
    if not url or not isinstance(url, str):
        return False, 'URL is required'
    
    # Parse URL
    try:
        parsed = urlparse(url)
    except Exception:
        return False, 'Invalid URL format'
    
    # Only allow http/https schemes
    if parsed.scheme not in ('http', 'https'):
        return False, 'Only http and https URLs are allowed'
    
    # Must have a hostname
    hostname = parsed.hostname
    if not hostname:
        return False, 'URL must have a valid hostname'
    
    # Block known dangerous hostnames
    hostname_lower = hostname.lower()
    if hostname_lower in BLOCKED_HOSTNAMES:
        return False, 'Access to localhost is not allowed'
    
    # Resolve hostname to IP and check against blocked ranges
    try:
        ip_addresses = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        for family, _, _, _, sockaddr in ip_addresses:
            ip_str = sockaddr[0]
            try:
                ip = ipaddress.ip_address(ip_str)
                for blocked_range in BLOCKED_IP_RANGES:
                    if ip in blocked_range:
                        return False, 'Access to internal/private IP addresses is not allowed'
            except ValueError:
                continue
    except socket.gaierror:
        return False, 'Could not resolve hostname'
    except Exception as e:
        logger.warning(f"URL validation error: {e}")
        return False, 'URL validation failed'
    
    return True, ''


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
    """Save a scraper configuration.

    Admin-gated: `put_secret_json` on the shared API-credentials secret, with
    content the caller supplied. `webscraper_configs` holds the URLs the
    webscraper ingestor fetches, so an unprivileged write both mutates the same
    secret `integrations_handler`'s credentials routes protect and steers what
    gets scraped. Measured ungated as a `users`-group caller: 200, one
    `put_secret_json`.
    """
    require_admin(app.current_event.raw_event)
    if not SECRETS_ARN:
        raise ConfigurationError('Secrets not configured')
    
    body = app.current_event.json_body
    scraper = body.get('scraper')
    if not scraper:
        raise ValidationError('No scraper config provided')

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
    """Delete a scraper configuration.

    Admin-gated for the same reason as the POST above — it writes the shared
    secret — and additionally because it is destructive: it rewrites
    `webscraper_configs` with one entry removed, which stops that site being
    scraped and cannot be undone from the run history.
    """
    require_admin(app.current_event.raw_event)
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
    """Trigger a scraper run.

    Admin-gated for the reason `integrations_handler.run_source` is: this invokes
    the webscraper Lambda, so every call is a billed fetch against a third party's
    rate limit, and ungated it was callable in a loop by anyone with an account —
    measured, 200 with a real `lambda:Invoke` and a `SCRAPER_RUN#` row written.

    `scraper_id` is NOT validated against an allowlist, unlike `<source>` in
    `integrations_handler`: it is not a plugin id and never becomes a secret key
    or a function name. It reaches one `SCRAPER_RUN#` partition and the invoke
    PAYLOAD, where the webscraper resolves it against its own configured list, so
    an unknown id is a run that finds nothing rather than a namespace a caller
    chose. The admin gate is what bounds who can write those partitions.
    """
    require_admin(app.current_event.raw_event)
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
    
    # Validate URL to prevent SSRF
    is_valid, error_message = validate_url(url)
    if not is_valid:
        raise ValidationError(error_message)
    
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/html,application/xhtml+xml'}
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as response:
            html_content = response.read().decode('utf-8', errors='ignore')
        
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
    except (ValidationError, ServiceError):
        raise
    except Exception as e:
        logger.exception(f"Failed to analyze URL: {e}")
        raise ServiceError('Failed to analyze URL')


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
