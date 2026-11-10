"""Usefulness end to end, on moto (docs/data-quality.md).

processor (builds and writes the review with its band) → aggregator Lambda (a stream batch moves the
per-source band counters and bumps the data version) → `GET /metrics/data-quality` (counters for an
admin, the visible items for a restricted caller) → category reprocess (rates a review stored before
the band existed) → aggregator MODIFY → the route again. Each Lambda's real handler runs; only the
model, Comprehend and Translate are stubbed.
"""
from __future__ import annotations

from collections.abc import Generator
from contextlib import contextmanager
from datetime import UTC, datetime
from unittest.mock import patch

import boto3
import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

import metrics_handler
from aggregator import handler as aggregator
from aggregator.test.aggregator_fixtures import stream_record
from jobs.category_reprocess import handler as reprocess
from processor import handler as processor
from processor.test.process_fixtures import process_with_model
from shared import reprocess_jobs as jobs
from shared.api import clear_categories_cache
from shared.category_access import access_key
from shared.indexes import AGGREGATES_BY_METRIC_TYPE_INDEX

ADMIN = {'sub': 'admin-1', 'cognito:groups': 'admins'}
RESTRICTED = {'sub': 'rita-1', 'cognito:groups': 'users', 'cognito:username': 'rita'}
CATEGORIES = [{'name': 'delivery', 'subcategories': []}, {'name': 'billing', 'subcategories': []}]
DETAILED = ('Order 5512 was delivered two weeks late and the tracking page showed an error every day, '
            'support never answered my three emails')
LEGACY_TEXT = 'The parcel was delivered late and the box was damaged when it finally arrived'  # a term: medium


def _model(category: str, feedback_type: str | None = None) -> dict:
    insights = {'category': category, 'subcategory': None, 'sentiment_label': 'negative',
                'sentiment_score': -0.5, 'urgency': 'low', 'problem_summary': 'Late delivery'}
    if feedback_type:
        insights['dimensions'] = {'feedback_type': feedback_type}
    return {'insights': insights, 'metadata': {}}


def _table(resource, name: str, indexes: list[tuple[str, str, str]]):
    """A pk/sk table with ALL-projected ``(index, hash, range)`` indexes, as in core-stack.ts."""
    keys = sorted({'pk', 'sk', *(key for _, hash_key, range_key in indexes for key in (hash_key, range_key))})
    extra = {'GlobalSecondaryIndexes': [{
        'IndexName': index, 'Projection': {'ProjectionType': 'ALL'},
        'KeySchema': [{'AttributeName': h, 'KeyType': 'HASH'}, {'AttributeName': r, 'KeyType': 'RANGE'}],
    } for index, h, r in indexes]} if indexes else {}
    return resource.create_table(
        TableName=name, BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': key, 'AttributeType': 'S'} for key in keys], **extra)


@contextmanager
def _world() -> Generator[tuple, None, None]:
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        feedback = _table(resource, 'e2e-feedback', [('gsi1-by-date', 'gsi1pk', 'gsi1sk')])
        aggregates = _table(resource, 'e2e-aggregates', [(AGGREGATES_BY_METRIC_TYPE_INDEX, 'metric_type', 'pk')])
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': CATEGORIES})
        aggregates.put_item(Item={**access_key(RESTRICTED['sub']), 'categories': ['delivery']})
        processor._settings_cache.clear()
        processor._failed_settings.clear()
        processor._settings_cache.update({'dimensions': (float('inf'), []), 'sources': (float('inf'), [])})
        clear_categories_cache()
        metrics_handler.app.clear_context()
        with patch.object(processor, 'feedback_table', feedback), \
             patch.object(aggregator, 'aggregates_table', aggregates), \
             patch.object(aggregator, 'IDEMPOTENCY_TABLE', ''), \
             patch.object(aggregator, 'lower_earliest_date', lambda _date: None), \
             patch.object(metrics_handler, 'feedback_table', feedback), \
             patch.object(metrics_handler, 'aggregates_table', aggregates):
            yield feedback, aggregates
        clear_categories_cache()


def _ingest(record: dict, model: dict) -> dict:
    """The processor's item for ``record``, written the way the processor writes it."""
    item = process_with_model(record, model, CATEGORIES)
    assert processor.write_to_dynamodb(item) is True
    return item


def _stream(lambda_context, *records) -> None:
    """One stream batch through the aggregator's real Lambda handler (it bumps the data version)."""
    result = aggregator.lambda_handler({'Records': [record.raw_event for record in records]}, lambda_context)
    assert result == {'batchItemFailures': []}


def _quality(api_gateway_event, lambda_context, claims=ADMIN) -> dict:
    response, body = call_route(metrics_handler.lambda_handler, api_gateway_event, lambda_context,
                                method='GET', path='/metrics/data-quality', query_params={'days': '7'},
                                claims=claims)
    assert response['statusCode'] == 200
    return {row['source']: {k: row[k] for k in ('low', 'medium', 'high', 'unrated', 'total')}
            for row in body['sources']}


def _legacy_item() -> dict:
    """A review stored before the band existed (no `usefulness`), dated today."""
    now = datetime.now(UTC)
    return {
        'pk': 'SOURCE#manual_import', 'sk': 'FEEDBACK#legacy', 'feedback_id': 'legacy',
        'gsi1pk': f"DATE#{now:%Y-%m-%d}", 'gsi1sk': f'{now.isoformat()}#legacy',
        'date': f'{now:%Y-%m-%d}', 'source_platform': 'manual_import', 'category': 'delivery',
        'sentiment_label': 'negative', 'original_text': LEGACY_TEXT,
    }


def _band_only_reprocess(feedback, item: dict) -> dict:
    """A `processed` reprocess whose category comes out unchanged: the band-only update."""
    counters = dict.fromkeys(jobs.COUNTERS, 0)
    with patch.object(reprocess, 'classify_category', return_value=(item['category'], None)):
        reprocess.reprocess_item(feedback, item, {'mode': jobs.MODE_PROCESSED}, CATEGORIES, counters)
    assert counters['updated'] == 1
    return feedback.get_item(Key={'pk': item['pk'], 'sk': item['sk']})['Item']


@pytest.mark.integration
def test_ingest_aggregate_read_backfill_and_read_again(api_gateway_event, lambda_context):
    with _world() as (feedback, _aggregates):
        web = _ingest({'id': 'w1', 'source_platform': 'webscraper', 'text': DETAILED,
                       'created_at': '2026-10-01T00:00:00Z'}, _model('delivery', 'service_failure'))
        form = _ingest({'id': 'f1', 'source_platform': 'feedback_form', 'text': 'Great!',
                        'created_at': '2026-10-01T00:00:00Z'}, _model('billing', 'praise'))
        legacy = _legacy_item()
        feedback.put_item(Item=legacy)
        assert (web['usefulness'], form['usefulness'], 'usefulness' in legacy) == ('high', 'low', False)

        _stream(lambda_context, *(stream_record('INSERT', new=item) for item in (web, form, legacy)))
        assert _quality(api_gateway_event, lambda_context) == {
            'webscraper': {'low': 0, 'medium': 0, 'high': 1, 'unrated': 0, 'total': 1},
            'feedback_form': {'low': 1, 'medium': 0, 'high': 0, 'unrated': 0, 'total': 1},
            'manual_import': {'low': 0, 'medium': 0, 'high': 0, 'unrated': 1, 'total': 1},
        }
        # A caller restricted to `delivery` is counted from the items it can see.
        assert _quality(api_gateway_event, lambda_context, RESTRICTED) == {
            'webscraper': {'low': 0, 'medium': 0, 'high': 1, 'unrated': 0, 'total': 1},
            'manual_import': {'low': 0, 'medium': 0, 'high': 0, 'unrated': 1, 'total': 1},
        }

        rated = _band_only_reprocess(feedback, legacy)
        assert rated['usefulness'] == 'medium'
        assert 'category_source' not in rated  # the category was not touched

        _stream(lambda_context, stream_record('MODIFY', old=legacy, new=rated))
        after = _quality(api_gateway_event, lambda_context)
        assert after['manual_import'] == {'low': 0, 'medium': 1, 'high': 0, 'unrated': 0, 'total': 1}
        assert _quality(api_gateway_event, lambda_context, RESTRICTED)['manual_import'] == after['manual_import']
