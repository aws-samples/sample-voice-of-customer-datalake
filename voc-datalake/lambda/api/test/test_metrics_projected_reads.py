"""The metric routes answer byte-for-byte what they answered when the walks read full reviews.

The day walks (and `/feedback`'s candidate window) read PROJECTED rows
(`metrics_handler._metric_row_read`) and `/feedback` fetches its page in full by key;
`/feedback/entities` samples issues from projected rows (`ISSUE_SAMPLE_PROJECTION`).
Here every route the SPA calls, with every filter that reads a field off a review, runs
twice on the same moto tables: once as shipped, once with both projections switched off
(the full-row reads the routes made before), and the response bodies must be identical.
The reviews carry every field a route or filter reads, plus the heavy ones none does.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from category_access_fixtures import RESTRICTED_CLAIMS, RESTRICTED_SUB
from moto import mock_aws

import metrics_handler
from shared import dynamodb_fast_items
from shared.api import clear_categories_cache
from shared.category_access import access_key
from shared.response_cache import DEFAULT_CACHE

CATEGORIES = ['delivery', 'billing', 'app']
DIMENSIONS = [
    {'key': 'platform', 'label': 'Platform', 'values': [{'name': 'Mobile'}, {'name': 'Desktop'}]},
    {'key': 'plan', 'label': 'Plan', 'values': [{'name': 'business'}]},
]
SOURCES = ['web', 'app_store', 'github_issues']
SENTIMENTS = [('positive', '0.8'), ('negative', '-0.6'), ('neutral', '0.05'), ('mixed', '-0.1')]
OTHER_CATEGORIES = ['delivery', 'billing', 'app', 'legacy_removed', None]
# The walk's soft cap, lowered so a 7-day window of 92 reviews is cut short (partial flags exercised).
LOWERED_CAP = 40


def _day(offset: int) -> str:
    return (datetime.now(UTC) - timedelta(days=offset)).strftime('%Y-%m-%d')


def _review(day_offset: int, n: int) -> dict[str, Any]:
    """One stored review: every field a route reads, varied by `n`, plus fields no route reads."""
    day = _day(day_offset)
    fid = f'{day}-{n:02d}'
    source = SOURCES[n % len(SOURCES)]
    label, score = SENTIMENTS[n % len(SENTIMENTS)]
    item: dict[str, Any] = {
        'pk': f'SOURCE#{source}', 'sk': f'FEEDBACK#{fid}', 'feedback_id': fid, 'id': fid,
        'gsi1pk': f'DATE#{day}', 'gsi1sk': f'{day}T10:{n:02d}:00Z', 'date': day,
        'source_platform': source, 'source_channel': ['email', 'chat'][n % 2],
        'sentiment_label': label, 'sentiment_score': Decimal(score), 'urgency': ['high', 'low', 'medium'][n % 3],
        'persona_type': ['existing_customer', 'prospect', ''][n % 3], 'persona_name': 'Loyal Customer',
        'problem_summary': ['Checkout fails on submit', 'Late delivery of order', 'Billing double charge'][n % 3],
        'problem_root_cause_hypothesis': 'Payment gateway timeout',
        'source_created_at': f'{_day(day_offset + (400 if n % 5 == 0 else 1))}T08:00:00Z',
        'rating': Decimal(n % 5 + 1), 'tags': ['refund', 'vip'][: n % 3],
        'dimensions': {'platform': ['Mobile', 'Desktop'][n % 2], **({'plan': 'business'} if n % 4 == 0 else {})},
        # Heavy fields no metric reads: the page must still carry them in full.
        'original_text': f'Acme order {fid} ' + 'long review text ' * 20,
        'title': f'Review {fid}', 'translated_text': 'translated ' * 10,
        'metadata': {'store': 'Example Air', 'nested': {'list': [Decimal('1.5'), 'two', None, True]}},
        'category_override': {'by_sub': 'editor-sub', 'at': '2026-01-01T00:00:00Z'},
        'key_phrases': ['checkout', 'delivery'], 'dimension_sources': {'platform': 'source'},
    }
    category = OTHER_CATEGORIES[n % len(OTHER_CATEGORIES)]
    if category is not None:
        item['category'] = category
        item['gsi2pk'] = f'CATEGORY#{category}'
        item['gsi2sk'] = f'{score}#{day}T10:{n:02d}:00Z'
        item['subcategory'] = ['general', 'refunds'][n % 2]
    if source == 'github_issues':
        item['issue_attributes'] = {'kind': ['issue', 'comment'][n % 2], 'repo': 'acme/app', 'number': n,
                                    'labels': ['bug', 'regression'][: n % 3], 'plus_one': n % 4, 'state': 'open',
                                    'software_version': ['0.4.1', '0.4.2'][n % 2], 'error_signature': 'typeerror: x'}
    return item


def _table(dynamodb: Any, name: str, indexes: dict[str, tuple[str, str]]) -> Any:
    attributes = {'pk', 'sk', *(a for keys in indexes.values() for a in keys)}
    kwargs: dict[str, Any] = {}
    if indexes:
        kwargs['GlobalSecondaryIndexes'] = [
            {'IndexName': index, 'Projection': {'ProjectionType': 'ALL'},
             'KeySchema': [{'AttributeName': h, 'KeyType': 'HASH'}, {'AttributeName': r, 'KeyType': 'RANGE'}]}
            for index, (h, r) in indexes.items()]
    return dynamodb.create_table(
        TableName=name, BillingMode='PAY_PER_REQUEST',
        KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
        AttributeDefinitions=[{'AttributeName': a, 'AttributeType': 'S'} for a in sorted(attributes)], **kwargs)


@pytest.fixture
def tables() -> Iterator[None]:
    """Moto feedback (date + category indexes) and aggregates tables, the fast decode installed."""
    with mock_aws():
        dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
        dynamodb_fast_items.install(dynamodb.meta.client)
        feedback = _table(dynamodb, 'feedback', {'gsi1-by-date': ('gsi1pk', 'gsi1sk'),
                                                 'gsi2-by-category': ('gsi2pk', 'gsi2sk')})
        aggregates = _table(dynamodb, 'aggregates', {'gsi1-by-metric-type': ('metric_type', 'pk')})
        with feedback.batch_writer() as batch:
            for day_offset in range(4):
                for n in range(23):
                    batch.put_item(Item=_review(day_offset, n))
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config',
                                  'categories': [{'name': name} for name in CATEGORIES]})
        aggregates.put_item(Item={'pk': 'SETTINGS#dimensions', 'sk': 'config', 'dimensions': DIMENSIONS})
        aggregates.put_item(Item={**access_key(RESTRICTED_SUB), 'categories': ['delivery', 'billing']})
        clear_categories_cache()
        with patch('metrics_handler.feedback_table', feedback), patch('metrics_handler.aggregates_table', aggregates), \
                patch('metrics_handler.MAX_FEEDBACK_OFFSET', LOWERED_CAP):
            yield
        clear_categories_cache()


ROUTES: list[tuple[str, dict[str, str]]] = [
    ('/feedback', {'days': '7', 'limit': '10'}),
    ('/feedback', {'days': '0', 'limit': '10', 'offset': '20'}),
    ('/feedback', {'days': '7', 'source': 'web', 'limit': '100'}),
    ('/feedback', {'days': '7', 'category': 'delivery'}),
    ('/feedback', {'days': '7', 'category': 'other'}),
    ('/feedback', {'days': '7', 'sentiment': 'negative', 'offset': '3', 'limit': '5'}),
    ('/feedback', {'days': '7', 'version': '0.4.2'}),
    ('/feedback', {'days': '7', 'label': 'regression'}),
    ('/feedback', {'days': '7', 'rating_min': '3', 'dims': 'platform:Mobile', 'tag': 'refund'}),
    ('/feedback', {'days': '7', 'channel': 'email', 'date_basis': 'review'}),
    ('/metrics/summary', {'days': '7', 'source': 'app_store'}),
    ('/metrics/summary', {'days': '7', 'date_basis': 'review'}),
    ('/metrics/sentiment', {'days': '7', 'category': 'billing'}),
    ('/metrics/sentiment', {'days': '7', 'tag': 'vip'}),
    ('/metrics/categories', {'days': '7', 'source': 'web'}),
    ('/metrics/sources', {'days': '7', 'date_basis': 'review'}),
    ('/metrics/personas', {'days': '7', 'source': 'web'}),
    ('/metrics/dimensions', {'days': '7', 'key': 'platform', 'source': 'web'}),
    ('/metrics/github', {'days': '7'}),
    ('/feedback/entities', {'days': '7'}),
    ('/feedback/entities', {'days': '7', 'source': 'app_store', 'rating_max': '4'}),
]


def _body(api_gateway_event: Any, lambda_context: Any, path: str, query: dict[str, str], claims: Any) -> str:
    DEFAULT_CACHE.clear()
    metrics_handler.app.clear_context()
    kwargs = {'claims': claims} if claims else {}
    response = metrics_handler.lambda_handler(
        api_gateway_event(method='GET', path=path, query_params=query, **kwargs), lambda_context)
    assert response['statusCode'] == 200, response['body']
    return response['body']


@pytest.mark.usefixtures('tables')
@pytest.mark.parametrize('claims', [None, RESTRICTED_CLAIMS], ids=['admin', 'restricted'])
@pytest.mark.parametrize(('path', 'query'), ROUTES, ids=[f'{p}?{q}' for p, q in ROUTES])
def test_projected_reads_answer_exactly_what_full_reads_answered(api_gateway_event, lambda_context, path, query,
                                                                 claims):
    projected = _body(api_gateway_event, lambda_context, path, query, claims)
    with patch('metrics_handler._metric_row_read', return_value=None), \
            patch('metrics_handler.ISSUE_SAMPLE_PROJECTION', {}):
        full = _body(api_gateway_event, lambda_context, path, query, claims)
    assert projected == full


@pytest.mark.usefixtures('tables')
def test_the_list_page_carries_every_stored_field(api_gateway_event, lambda_context):
    """The candidate rows are projected, but the page is the full reviews, in window order."""
    query = {'days': '7', 'source': 'web', 'limit': '10'}
    body = json.loads(_body(api_gateway_event, lambda_context, '/feedback', query, None))
    assert (body['count'], body['total']) == (10, 32)
    first = body['items'][0]
    assert first['original_text'].startswith('Acme order')
    assert first['metadata']['store'] == 'Example Air'
    assert 'by_sub' not in first['category_override']
    assert [i['gsi1sk'] for i in body['items']] == sorted((i['gsi1sk'] for i in body['items']), reverse=True)
