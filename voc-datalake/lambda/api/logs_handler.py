"""
Logs API Lambda - Handles /logs/*
Provides access to validation failures and processing errors for user visibility.
"""

import os
import re
import sys
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from functools import cache
from typing import Any

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import boto3
from boto3.dynamodb.conditions import Key

from shared.api import (
    MAX_FEEDBACK_WINDOW_DAYS,
    api_handler,
    create_api_resolver,
    get_caller_subject,
    require_admin,
    validate_days,
    validate_limit,
)
from shared.concurrency import ordered_map
from shared.dynamo_paging import iter_query
from shared.enabled_sources import default_source_ids
from shared.exceptions import ConfigurationError, ServiceError
from shared.logging import logger, tracer
from shared.ops_alerts import AlertTargets, load_targets
from shared.ops_alerts_service import (
    add_recipient,
    alerts_status,
    remove_recipient,
    set_alerting,
    unconfigured_status,
)
from shared.processing_logs import PROCESSING_FAILED_MESSAGE, THROTTLED_MESSAGE
from shared.request_body import json_object_body
from shared.scraper_run_errors import ERROR_TYPE_SHAPE, MAX_RETURNED_ERRORS, redacted_scraper_errors
from shared.system_environment import environment as system_environment
from shared.system_logs import SearchRequest, parse_level, parse_query_ids
from shared.system_logs import search as search_system_logs
from shared.system_queues import failure_queues
from shared.system_request_log import lookup as lookup_request_lines
from shared.system_request_log import parse_lookup
from shared.tables import get_aggregates_table
from shared.warm_init import warm_at_init

# None when AGGREGATES_TABLE is unset; each route answers ConfigurationError then.
aggregates_table = get_aggregates_table()

app = create_api_resolver()

# Query-param bounds (#263). Read through the shared validators, never a raw
# `int()`: a non-numeric `?days=abc` used to raise ValueError outside any `try`
# and surface as a 500. Unreadable values fall back to the default; readable ones
# are clamped. `days` starts at 1 — a 0-day lookback puts the cutoff at "now" and
# can only ever return nothing, and a negative one puts it in the future.
DEFAULT_DAYS = 7
LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX = 100, 500
SCRAPER_LIMIT_DEFAULT, SCRAPER_LIMIT_MAX = 50, 200
# `/logs/summary` counts at most this many rows per (source, type) partition.
SUMMARY_COUNT_CAP = 1000


def _days_param(params: dict) -> int:
    return validate_days(params.get('days'), default=DEFAULT_DAYS, min_val=1, max_val=MAX_FEEDBACK_WINDOW_DAYS)


@app.get("/logs/validation")
@tracer.capture_method
def get_validation_logs():
    """Get validation failure logs; query params as `_list_logs`."""
    return _list_logs('validation')


@app.get("/logs/processing")
@tracer.capture_method
def get_processing_logs():
    """Get processing error logs; query params as `_list_logs`."""
    return _list_logs('processing')


def _list_logs(log_type: str) -> dict:
    """The listing both `/logs/validation` and `/logs/processing` answer.

    Query params:
    - source: Filter by source platform (optional; otherwise every known source,
      each asked for its share of `limit`, merged newest first)
    - days: Number of days to look back (default: 7)
    - limit: Max number of logs to return (default: 100, at most 500)
    """
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')

    params = app.current_event.query_string_parameters or {}
    source = params.get('source')
    days = _days_param(params)
    limit = validate_limit(params.get('limit'), default=LIST_LIMIT_DEFAULT, max_val=LIST_LIMIT_MAX)

    try:
        if source:
            logs = _query_logs_for_source(log_type, source, days, limit)
        else:
            # Every enabled plugin plus `manual_import` (issue #256).
            sources = default_source_ids()
            share = limit // len(sources) + 1
            logs = [
                log
                for source_logs in ordered_map(
                    lambda src: _query_logs_for_source(log_type, src, days, share), sources)
                for log in source_logs
            ]

            # Newest first, then cut to the limit. Every entry carries `timestamp`
            # (`_query_logs_for_source` sets it, None when the row has none).
            logs.sort(key=lambda x: x['timestamp'], reverse=True)
            logs = logs[:limit]

        return {
            'logs': logs,
            'count': len(logs),
            'days': days,
        }
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to get {log_type} logs: {e}")
        raise ServiceError('Failed to retrieve logs') from e


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
        raise ConfigurationError('Aggregates table not configured')

    params = app.current_event.query_string_parameters or {}
    days = _days_param(params)
    limit = validate_limit(params.get('limit'), default=SCRAPER_LIMIT_DEFAULT, max_val=SCRAPER_LIMIT_MAX)

    try:
        cutoff = (datetime.now(UTC) - timedelta(days=days)).isoformat()

        # Key format matches scrapers_handler: SCRAPER_RUN#{scraper_id}
        response = aggregates_table.query(
            KeyConditionExpression=Key('pk').eq(f"SCRAPER_RUN#{scraper_id}"),
            ScanIndexForward=False,
            Limit=limit,
        )

        logs = []
        for item in response.get('Items', []):
            # Filter by lookback window — items older than `cutoff` are skipped.
            # (`cutoff` was previously computed but never applied, making the
            # `days` query param a no-op.) Runs missing `started_at` are kept.
            started_at = item.get('started_at', '')
            if isinstance(started_at, str) and started_at and started_at < cutoff:
                continue
            logs.append({
                'run_id': item.get('sk', ''),
                'status': item.get('status'),
                'started_at': started_at,
                'completed_at': item.get('completed_at'),
                'pages_scraped': item.get('pages_scraped', 0),
                'items_found': item.get('items_found', 0),
                'errors': redacted_scraper_errors(item.get('errors')),
            })

        return {
            'scraper_id': scraper_id,
            'logs': logs,
            'count': len(logs),
        }
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to get scraper logs: {e}")
        raise ServiceError('Failed to retrieve logs') from e


@app.get("/logs/summary")
@tracer.capture_method
def get_logs_summary():
    """
    Get a summary of recent logs across all sources.

    Returns counts of validation failures and processing errors per source.
    """
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')

    params = app.current_event.query_string_parameters or {}
    days = _days_param(params)

    try:
        summary = {
            'validation_failures': {},
            'processing_errors': {},
            'total_validation_failures': 0,
            'total_processing_errors': 0,
        }

        # Two independent partition counts per source, all run concurrently
        # (results in (source, type) order, so the summary is built as before).
        sources = default_source_ids()
        pairs = [(source, log_type) for source in sources for log_type in ('validation', 'processing')]
        results = ordered_map(lambda pair: _count_logs_for_source(pair[1], pair[0], days, SUMMARY_COUNT_CAP), pairs)
        by_pair = dict(zip(pairs, results, strict=True))
        for source in sources:
            val_count = by_pair[(source, 'validation')]
            proc_count = by_pair[(source, 'processing')]

            if val_count:
                summary['validation_failures'][source] = val_count
                summary['total_validation_failures'] += val_count

            if proc_count:
                summary['processing_errors'][source] = proc_count
                summary['total_processing_errors'] += proc_count
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to get logs summary: {e}")
        raise ServiceError('Failed to retrieve summary') from e
    return {
        'summary': summary,
        'days': days,
    }


@app.delete("/logs/validation/<source>")
@tracer.capture_method
def clear_validation_logs(source: str):
    """Clear validation logs for a specific source.

    Access decision (owner, 2026-10-04): every `/logs/*` READ is open to any
    signed-in user — rows are PII-free by construction and re-redacted on read —
    but a DELETE erases the shared operational trail for everyone, so it is
    admin-only. This is the only DELETE route this handler serves (the API Gateway
    `/logs/{proxy+}` forwards any method, so a new one must gate itself too).
    """
    require_admin(app.current_event.raw_event)
    if not aggregates_table:
        raise ConfigurationError('Aggregates table not configured')

    try:
        deleted = 0
        with aggregates_table.batch_writer() as batch:
            for item in _validation_log_keys(source):
                batch.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
                deleted += 1
    except ConfigurationError:
        raise
    except Exception as e:
        logger.exception(f"Failed to clear validation logs: {e}")
        raise ServiceError('Failed to clear logs') from e
    return {'success': True, 'deleted': deleted}


def _validation_log_keys(source: str):
    """Every `{pk, sk}` under `LOGS#validation#{source}`, following `LastEvaluatedKey`.

    A single query stops at 1 MB, so without paging a large backlog was only
    partly cleared while the response's `deleted` count looked complete (#263).
    """
    if aggregates_table is None:
        raise ConfigurationError('Aggregates table not configured')
    query = {
        'KeyConditionExpression': Key('pk').eq(f"LOGS#validation#{source}"),
        'ProjectionExpression': 'pk, sk',
    }
    yield from iter_query(aggregates_table, query)


def _log_partition_condition(log_type: str, source: str, days: int) -> Any:
    """``LOGS#{log_type}#{source}`` rows written within the last ``days`` days."""
    cutoff = (datetime.now(UTC) - timedelta(days=days)).isoformat()
    return Key('pk').eq(f"LOGS#{log_type}#{source}") & Key('sk').gte(cutoff)


def _count_logs_for_source(log_type: str, source: str, days: int, limit: int) -> int:
    """How many rows ``_query_logs_for_source`` would return, without reading them back.

    ``Select=COUNT`` with the same key condition and ``Limit`` (no filter, one page),
    so the count is exactly the length of that listing: the summary only ever used
    ``len()`` of it, and parsing and redacting up to ``limit`` rows per partition to
    count them was most of the route's CPU during an incident.
    """
    if aggregates_table is None:
        raise ConfigurationError('Aggregates table not configured')
    response = aggregates_table.query(
        KeyConditionExpression=_log_partition_condition(log_type, source, days),
        ScanIndexForward=False,
        Limit=limit,
        Select='COUNT',
    )
    count = response.get('Count', 0)
    return count if isinstance(count, int) else 0


def _query_logs_for_source(log_type: str, source: str, days: int, limit: int) -> list:
    """Query logs for a specific source and type."""
    if aggregates_table is None:
        raise ConfigurationError('Aggregates table not configured')

    response = aggregates_table.query(
        KeyConditionExpression=_log_partition_condition(log_type, source, days),
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
            log_entry.update(_redacted_validation_fields(item))
        else:
            log_entry.update(_redacted_processing_fields(item))

        logs.append(log_entry)

    return logs


# ============================================
# Read-time redaction
# ============================================
# `/logs/*` reads are open to every signed-in user, and rows written before the
# processor stopped storing them carry a 500-char `raw_preview` of the record
# (submitter email/name, review text), a raw `str(e)` in `error_message`, and
# pydantic messages that embed the rejected input. Rows age out after 7 days, but
# until then — and against any future writer regression — a response is built
# from an allowlist: `raw_preview` is never read, `error_message` is never echoed,
# and every free-text field is either a fixed string or matched against a strict
# shape. (Mirrors `lambda/processor/handler.py`'s writers, a different bundle.)

# A location segment / record key that is schema, not data. Anything else — a
# producer-chosen dict key, possibly an email — is masked.
_SAFE_SEGMENT = re.compile(r'^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|\d{1,6}|\*)\Z')
_ERROR_CODE = re.compile(r'^[a-z][a-z_]{0,63}\Z')
MASKED_SEGMENT = '*'
MAX_RETURNED_KEYS = 50
VALIDATION_ERROR_WITHHELD = 'Validation failed (details withheld)'
UNKNOWN_ERROR_TYPE = 'UnknownError'
_THROTTLING_ERROR_TYPES = frozenset({'BedrockThrottlingError', 'bedrock_throttling'})
# Scraper run errors: shared/scraper_run_errors.py (also used by scrapers_handler).


def _safe_path(raw: str) -> str | None:
    """A dotted field path whose every segment is schema-shaped; None otherwise.

    All-or-nothing: masking one segment would still leak its neighbours
    (`jane.doe@example.com` splits into `jane`, `doe@example`, `com`).
    """
    path = raw.strip()
    segments = path.split('.')
    if not path or not all(_SAFE_SEGMENT.fullmatch(s) for s in segments):
        return None
    return path


def _redact_validation_error(error: object) -> str:
    """`<path>: <code>` as written now; a legacy `<loc>: <pydantic msg>` keeps its path only."""
    if not isinstance(error, str) or ': ' not in error:
        return VALIDATION_ERROR_WITHHELD
    raw_path, detail = error.split(': ', 1)
    path = _safe_path(raw_path)
    if path is None:
        return VALIDATION_ERROR_WITHHELD
    return f"{path}: {detail if _ERROR_CODE.fullmatch(detail) else 'invalid'}"


def _redacted_validation_fields(item: dict) -> dict:
    errors = item.get('errors')
    fields: dict = {
        'errors': [_redact_validation_error(e) for e in errors[:MAX_RETURNED_ERRORS]]
        if isinstance(errors, list) else [],
    }
    keys = item.get('record_keys')
    if isinstance(keys, list):
        fields['record_keys'] = [
            k if isinstance(k, str) and _SAFE_SEGMENT.fullmatch(k) else MASKED_SEGMENT
            for k in keys[:MAX_RETURNED_KEYS]
        ]
    text_length = item.get('text_length')
    # DynamoDB hands numbers back as Decimal.
    if isinstance(text_length, int | Decimal) and not isinstance(text_length, bool):
        fields['text_length'] = int(text_length)
    return fields


def _redacted_processing_fields(item: dict) -> dict:
    raw_type = item.get('error_type')
    error_type = raw_type if isinstance(raw_type, str) and ERROR_TYPE_SHAPE.fullmatch(raw_type) else UNKNOWN_ERROR_TYPE
    return {
        'error_type': error_type,
        # Derived from the type alone: the stored `error_message` is never echoed.
        'error_message': THROTTLED_MESSAGE if error_type in _THROTTLING_ERROR_TYPES else PROCESSING_FAILED_MESSAGE,
    }


# ============================================
# Alerts (Settings → Logs → Alerts): admin-only, every route
# ============================================
# Runtime CloudWatch alarms + SNS email recipients (shared/ops_alerts*.py). The
# `/logs/{proxy+}` resource already forwards these paths, so no API Gateway
# resource is added for them.

@cache
def _alert_clients() -> tuple[Any, Any]:
    return boto3.client('cloudwatch'), boto3.client('sns')


def _alerts_context() -> tuple[Any, AlertTargets]:
    """The table and targets every alert write needs (the route has already gated on admin)."""
    targets = load_targets()
    if not aggregates_table or targets is None:
        raise ConfigurationError('Alerting is not configured on this deployment')
    return aggregates_table, targets


def _actor() -> str:
    """Who turned alerting on or off: the admin's email claim, else their Cognito sub."""
    event = app.current_event.raw_event
    claims = (event.get('requestContext') or {}).get('authorizer', {}).get('claims') or {}
    email = claims.get('email') if isinstance(claims, dict) else None
    return email if isinstance(email, str) and email else get_caller_subject(event)


@app.get("/logs/alerts")
@tracer.capture_method
def get_alerts():
    require_admin(app.current_event.raw_event)
    targets = load_targets()
    if not aggregates_table or targets is None:
        return unconfigured_status()
    cloudwatch, sns = _alert_clients()
    return alerts_status(aggregates_table, cloudwatch, sns, targets)


@app.put("/logs/alerts")
@tracer.capture_method
def put_alerts():
    require_admin(app.current_event.raw_event)
    table, targets = _alerts_context()
    return set_alerting(table, _alert_clients()[0], targets, json_object_body(app), _actor())


@app.post("/logs/alerts/recipients")
@tracer.capture_method
def post_alert_recipient():
    require_admin(app.current_event.raw_event)
    table, targets = _alerts_context()
    return add_recipient(table, _alert_clients()[1], targets, json_object_body(app))


@app.post("/logs/alerts/recipients/remove")
@tracer.capture_method
def remove_alert_recipient():
    require_admin(app.current_event.raw_event)
    table, targets = _alerts_context()
    return remove_recipient(table, _alert_clients()[1], targets, json_object_body(app))


# ============================================
# System errors (Administration → System → Logs): admin-only
# ============================================
# Every ERROR / CRITICAL (optionally WARNING) line of this deployment's Lambdas, read
# with CloudWatch Logs Insights and grouped (shared/system_logs.py). Admin-only: the
# lines are raw handler output (redacted on the way out, but still operational detail).
SYSTEM_DAYS_DEFAULT, SYSTEM_DAYS_MAX = 1, 30


@cache
def _logs_client() -> Any:
    return boto3.client('logs')


@app.get("/logs/system")
@tracer.capture_method
def get_system_logs():
    require_admin(app.current_event.raw_event)
    params = app.current_event.query_string_parameters or {}
    request = SearchRequest(
        days=validate_days(params.get('days'), default=SYSTEM_DAYS_DEFAULT, min_val=1, max_val=SYSTEM_DAYS_MAX),
        level=parse_level(params.get('level')),
        query_ids=parse_query_ids(params.get('query_id')),
    )
    return search_system_logs(_logs_client(), request)


@app.get("/logs/system/request")
@tracer.capture_method
def get_system_request_lines():
    """Every line of one invocation of a System errors group (shared/system_request_log.py)."""
    require_admin(app.current_event.raw_event)
    lookup = parse_lookup(app.current_event.query_string_parameters or {})
    return lookup_request_lines(_logs_client(), lookup)


@cache
def _queue_clients() -> tuple[Any, Any]:
    return boto3.client('sqs'), boto3.client('cloudwatch')


@app.get("/logs/system/queues")
@tracer.capture_method
def get_system_queues():
    """The dead-letter / failure queues, with up to three redacted bodies each (shared/system_queues.py)."""
    require_admin(app.current_event.raw_event)
    sqs, cloudwatch = _queue_clients()
    return failure_queues(sqs, cloudwatch)


@app.get("/logs/system/environment")
@tracer.capture_method
def get_system_environment():
    """Region, models, alerting, open circuits… nothing secret (shared/system_environment.py)."""
    require_admin(app.current_event.raw_event)
    function_arn = getattr(app.lambda_context, 'invoked_function_arn', '') or ''
    return system_environment(aggregates_table, _alert_clients()[0], str(function_arn))


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(_alert_clients, _logs_client, _queue_clients)


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
