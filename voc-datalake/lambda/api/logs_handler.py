"""
Logs API Lambda - Handles /logs/*
Provides access to validation failures and processing errors for user visibility.
"""

import os
import re
import sys
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from boto3.dynamodb.conditions import Key

from shared.api import (
    MAX_FEEDBACK_WINDOW_DAYS,
    api_handler,
    create_api_resolver,
    require_admin,
    validate_days,
    validate_limit,
)
from shared.concurrency import ordered_map
from shared.enabled_sources import default_source_ids
from shared.exceptions import ConfigurationError, ServiceError
from shared.logging import logger, tracer
from shared.scraper_run_errors import ERROR_TYPE_SHAPE, MAX_RETURNED_ERRORS, redacted_scraper_errors
from shared.tables import get_aggregates_table

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

        # Two independent partition reads per source, all run concurrently
        # (results in (source, type) order, so the summary is built as before).
        sources = default_source_ids()
        pairs = [(source, log_type) for source in sources for log_type in ('validation', 'processing')]
        results = ordered_map(lambda pair: _query_logs_for_source(pair[1], pair[0], days, 1000), pairs)
        by_pair = dict(zip(pairs, results, strict=True))
        for source in sources:
            val_logs = by_pair[(source, 'validation')]
            proc_logs = by_pair[(source, 'processing')]

            if val_logs:
                summary['validation_failures'][source] = len(val_logs)
                summary['total_validation_failures'] += len(val_logs)

            if proc_logs:
                summary['processing_errors'][source] = len(proc_logs)
                summary['total_processing_errors'] += len(proc_logs)
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
    while True:
        response = aggregates_table.query(**query)
        yield from response.get('Items', [])
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return
        query['ExclusiveStartKey'] = last_key


def _query_logs_for_source(log_type: str, source: str, days: int, limit: int) -> list:
    """Query logs for a specific source and type."""
    if aggregates_table is None:
        raise ConfigurationError('Aggregates table not configured')
    cutoff = (datetime.now(UTC) - timedelta(days=days)).isoformat()

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
_SAFE_SEGMENT = re.compile(r'^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|\d{1,6}|\*)$')
_ERROR_CODE = re.compile(r'^[a-z][a-z_]{0,63}$')
MASKED_SEGMENT = '*'
MAX_RETURNED_KEYS = 50
VALIDATION_ERROR_WITHHELD = 'Validation failed (details withheld)'
UNKNOWN_ERROR_TYPE = 'UnknownError'
PROCESSING_FAILED_MESSAGE = 'Processing failed; details are in the processor CloudWatch logs'
THROTTLED_MESSAGE = 'Bedrock throttled the request; SQS will retry the message'
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


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return app.resolve(event, context)
