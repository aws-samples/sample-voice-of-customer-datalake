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

SCOPE — the split above is THIS MODULE's, not the `/scrapers/*` URL prefix's. Five
more routes under that prefix live in `manual_import_handler.py`
(`/scrapers/manual/parse`, `.../parse/<job_id>`, `.../confirm`, `.../csv-upload`,
`.../json-upload`) and none of them calls `require_admin`. That is a DIFFERENT
question rather than the same gap: those routes write feedback CONTENT into the
pipeline (S3 plus the enrichment queue) and touch neither the shared secret nor
any plugin resource, which is why they were not folded into this change — see
`test/test_scrapers_security.py`, whose inventory case asserts that boundary so a
reader is not told the prefix is fully covered when only this handler is. The
`ast` pass cannot see across module boundaries, so nothing else would say so.
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
from shared.api import create_api_resolver, api_handler, require_admin
from shared.http_utils import (
    OutboundUrlBlocked,
    assert_outbound_url_allowed,
    fetch_checked_with_retry,
)
# The write-time check lives in shared/ because `PUT /integrations/webscraper/
# credentials` writes the SAME `webscraper_configs` key from a different Lambda,
# and the two handlers cannot import each other (issue #244).
from shared.scraper_urls import validate_scraper_config_write
from shared.tables import get_aggregates_table
from shared.exceptions import ConfigurationError, ValidationError, ServiceError

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
import boto3
# For `TooManyRedirects` only: this route does not make requests itself, it goes
# through `fetch_checked_with_retry`, which raises that transport error for an
# over-long chain.
import requests

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
#
# This is the FETCH share of the ~29 s, not the whole route: `converse` runs
# afterwards on the same clock and is not budgeted here. `get_bedrock_client` in
# shared/aws.py uses read_timeout=300, and shared/converse.py retries throttling
# with `time.sleep` backoff, so the remainder is not free — a 20 s fetch plus a
# throttled model call still produced the message-less 504 this budget exists to
# prevent. Whoever changes either number is changing a split, not a ceiling: the
# two must leave room for the model call, and the per-hop value must stay at or
# below the total.
PREVIEW_FETCH_HOP_TIMEOUT_SECONDS = 8
PREVIEW_FETCH_TOTAL_TIMEOUT_SECONDS = 12


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
    if not isinstance(scraper, dict):
        raise ValidationError('Scraper config must be an object')

    # Read BEFORE checking, so the URL-count cap can tell a `urls` list this
    # write created from one it is carrying forward untouched. Without the stored
    # value, a pre-existing over-cap config was refused on every save through
    # this route — including a change to an unrelated field — and trimming it
    # needed a save, so deleting the config was the only way out.
    #
    # Best-effort: a secret this route cannot read yields no exemption, never a
    # failed write. The read is repeated inside the try below because that is the
    # read-modify-write, and this one must not be able to 500 the route. The
    # exceptions are named rather than caught broadly so a genuine bug here still
    # surfaces: a missing/denied secret (ClientError), a secret that is not JSON,
    # and a JSON secret that is not an object are the three shapes this can take.
    stored_configs = None
    try:
        stored_configs = json.loads(
            secretsmanager.get_secret_value(SecretId=SECRETS_ARN)
            .get('SecretString', '{}')
        ).get('webscraper_configs')
    except (ClientError, ValueError, AttributeError, TypeError, KeyError) as e:
        logger.warning(f"Could not read stored scraper configs: {e}")

    # BEFORE the try below, so its `except Exception -> ServiceError` cannot
    # flatten this actionable 400 into an opaque 500. This route serves both
    # create and update (there is no separate PUT), so one call covers both.
    validate_scraper_config_write(scraper, stored=stored_configs)

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
        # Compared as a STRING because a stored id may not be one —
        # `_stored_urls_by_id` in shared/scraper_urls.py guards
        # `isinstance(..., str)` for the same reason — while a path parameter always
        # is. A config stored with `id: 7` could not be matched at all, so `DELETE
        # /scrapers/7` reported success and deleted nothing: measured, all configs
        # remained. That made it the one shape with no in-app remedy, since an edit
        # is keyed on the same id.
        #
        # An id-less config is deliberately NOT matchable: `str(None)` is 'None', so
        # comparing it would let `DELETE /scrapers/None` remove a config the caller
        # never named — and would take a config genuinely stored as the STRING
        # 'None' with it. Such a config is repaired through the array route instead,
        # which no longer refuses it (see `_unusable_stored_ids`).
        configs = [
            c for c in configs
            if c.get('id') is None or str(c.get('id')) != scraper_id
        ]
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
    except requests.exceptions.TooManyRedirects as e:
        # Caught beside the refusal above, not left to the generic handler, so an
        # over-long chain stays a 400 naming the limit. It is a `RequestException`
        # — deliberately, since every hop was CLEARED and it is not a security
        # event — and would otherwise have become an opaque 500 telling the user
        # nothing about their URL.
        raise ValidationError(str(e)) from e
    except (ValidationError, ServiceError):
        raise
    except Exception as e:
        logger.exception(f"Failed to analyze URL: {e}")
        raise ServiceError('Failed to analyze URL')


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
