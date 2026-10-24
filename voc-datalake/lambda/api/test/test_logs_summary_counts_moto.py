"""`/logs/summary` counts with ``Select=COUNT`` and answers what reading the rows answered (moto).

The summary used to read up to 1,000 rows per (source, type) partition, redact each
and take ``len()``. It now asks DynamoDB for the count. Pins, against a real table:
every count equals the length of the per-source listing the old code built
(``_query_logs_for_source`` with the same window and limit), the 1,000 cap and the
``days`` cutoff still apply, and empty partitions stay out of the per-source maps.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

import logs_handler

SOURCES = ('webscraper', 'manual_import')


@pytest.fixture
def table(monkeypatch) -> Iterator[Any]:
    monkeypatch.setenv('ENABLED_SOURCES', '["webscraper"]')
    with mock_aws():
        aggregates = pk_sk_table('logs-summary-aggregates')
        with patch.object(logs_handler, 'aggregates_table', aggregates):
            yield aggregates


def _rows(table: Any, log_type: str, source: str, ages_hours: list[int]) -> None:
    now = datetime.now(UTC)
    with table.batch_writer() as batch:
        for n, hours in enumerate(ages_hours):
            at = (now - timedelta(hours=hours)).isoformat()
            batch.put_item(Item={'pk': f'LOGS#{log_type}#{source}', 'sk': f'{at}#m{n:05d}',
                                 'source_platform': source, 'message_id': f'm{n}', 'timestamp': at,
                                 'errors': ['text: string_too_short'], 'error_type': 'BedrockThrottlingError'})


def _summary(api_gateway_event, lambda_context, days: int) -> dict:
    event = api_gateway_event(method='GET', path='/logs/summary', query_params={'days': str(days)})
    response = logs_handler.lambda_handler(event, lambda_context)
    assert response['statusCode'] == 200
    return json.loads(response['body'])['summary']


def _listed(log_type: str, days: int) -> dict[str, int]:
    """What the old summary counted: the length of each source's listing, empty ones left out."""
    lengths = {source: len(logs_handler._query_logs_for_source(log_type, source, days, logs_handler.SUMMARY_COUNT_CAP))
               for source in SOURCES}
    return {source: n for source, n in lengths.items() if n}


@pytest.mark.parametrize('days', [1, 3, 7])
def test_summary_counts_equal_the_listing_lengths(table, api_gateway_event, lambda_context, days):
    _rows(table, 'validation', 'webscraper', [1, 5, 30, 50, 100, 200])
    _rows(table, 'processing', 'webscraper', [2, 70])
    _rows(table, 'validation', 'manual_import', [10, 160])

    summary = _summary(api_gateway_event, lambda_context, days)

    assert summary['validation_failures'] == _listed('validation', days)
    assert summary['processing_errors'] == _listed('processing', days)
    assert summary['total_validation_failures'] == sum(_listed('validation', days).values())
    assert summary['total_processing_errors'] == sum(_listed('processing', days).values())


def test_a_partition_over_the_cap_counts_the_cap(table, api_gateway_event, lambda_context):
    _rows(table, 'processing', 'manual_import', [0] * (logs_handler.SUMMARY_COUNT_CAP + 25))

    summary = _summary(api_gateway_event, lambda_context, 7)

    assert summary['processing_errors'] == {'manual_import': logs_handler.SUMMARY_COUNT_CAP}
    assert summary['processing_errors'] == _listed('processing', 7)
    assert summary['validation_failures'] == {}
