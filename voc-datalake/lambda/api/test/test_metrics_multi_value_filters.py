"""Comma-separated `source` / `category` / `sentiment` / `usefulness` on the read routes (moto).

A list is any-of, the same on `/feedback`, `/metrics/*`, `/feedback/entities` and
`/feedback/problems`; the caller's source and category access stays the outer limit, so a
list naming a hidden source never widens it; a malformed list is a 400. Ported from
PR #429 (@aws-bryan).
"""
from __future__ import annotations

from contextlib import ExitStack
from datetime import UTC, datetime
from decimal import Decimal
from unittest.mock import patch

import pytest
from category_access_fixtures import RESTRICTED_CLAIMS, RESTRICTED_SUB
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import pk_sk_table

from metrics_handler import lambda_handler
from shared.api import clear_categories_cache
from shared.category_access import access_key
from shared.item_facets import MAX_FACET_VALUES

ADMIN_CLAIMS = {'sub': 'sub-admin', 'cognito:groups': 'admins', 'cognito:username': 'ada'}
# (id, source, category, sentiment, usefulness band or None = unscored)
REVIEWS = [
    ('w1', 'web', 'delivery', 'negative', 'high'),
    ('w2', 'web', 'billing', 'positive', 'low'),
    ('a1', 'app', 'delivery', 'neutral', None),
    ('a2', 'app', 'app', 'mixed', 'medium'),
    ('e1', 'email', 'billing', 'negative', 'high'),
]


def _review(today: str, n: int, row: tuple[str, str, str, str, str | None]) -> dict:
    fid, source, category, sentiment, band = row
    item = {
        'pk': f'SOURCE#{source}', 'sk': f'FEEDBACK#{fid}', 'feedback_id': fid,
        'gsi1pk': f'DATE#{today}', 'gsi1sk': f'{today}T00:00:0{n}', 'date': today,
        'source_platform': source, 'category': category, 'sentiment_label': sentiment,
        'sentiment_score': Decimal('0'), 'problem_summary': f'Problem {fid}',
    }
    return item if band is None else {**item, 'usefulness': band}


@pytest.fixture
def get(api_gateway_event, lambda_context):
    with ExitStack() as stack:
        stack.enter_context(mock_aws())
        clear_categories_cache()
        feedback = pk_sk_table('multi-feedback', gsi1_index='gsi1-by-date')
        aggregates = pk_sk_table('multi-aggregates')
        today = datetime.now(UTC).strftime('%Y-%m-%d')
        for n, row in enumerate(REVIEWS):
            feedback.put_item(Item=_review(today, n, row))
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config',
                                  'categories': [{'name': name} for name in ('delivery', 'billing', 'app')]})
        aggregates.put_item(Item={**access_key(RESTRICTED_SUB), 'sources': ['web', 'app']})
        stack.enter_context(patch('metrics_handler.feedback_table', feedback))
        stack.enter_context(patch('metrics_handler.aggregates_table', aggregates))

        def call(path: str, claims: dict = ADMIN_CLAIMS, **params: str) -> tuple[int, dict]:
            response, body = call_route(lambda_handler, api_gateway_event, lambda_context, method='GET',
                                        path=path, query_params={'days': '1', **params}, claims=claims)
            return response['statusCode'], body

        yield call
    clear_categories_cache()


def _listed(get, claims: dict = ADMIN_CLAIMS, **params: str) -> list[str]:
    status, body = get('/feedback', claims, **params)
    assert status == 200, body
    return sorted(item['feedback_id'] for item in body['items'])


def test_a_single_source_lists_what_it_always_did(get):
    assert _listed(get, source='web') == ['w1', 'w2']


@pytest.mark.parametrize(('params', 'expected'), [
    ({'source': 'web,email'}, ['e1', 'w1', 'w2']),
    ({'category': 'delivery,app'}, ['a1', 'a2', 'w1']),
    ({'sentiment': 'negative,mixed'}, ['a2', 'e1', 'w1']),
    ({'usefulness': 'high'}, ['e1', 'w1']),
    ({'usefulness': 'unrated'}, ['a1']),
    ({'usefulness': 'unrated,low'}, ['a1', 'w2']),
    ({'source': 'web,app', 'sentiment': 'negative,positive'}, ['w1', 'w2']),
])
def test_a_list_lists_the_union_of_its_values(get, params, expected):
    assert _listed(get, **params) == expected


def test_a_hidden_source_in_the_list_is_dropped_never_widening_access(get):
    assert _listed(get, RESTRICTED_CLAIMS, source='web,email') == ['w1', 'w2']
    assert _listed(get, RESTRICTED_CLAIMS, source='email') == []


@pytest.mark.parametrize('params', [{'sentiment': 'angry'}, {'usefulness': 'great'},
                                    {'source': ','.join(f's{n}' for n in range(MAX_FACET_VALUES + 1))}])
@pytest.mark.parametrize('path', ['/feedback', '/metrics/summary', '/feedback/entities', '/feedback/problems'])
def test_a_malformed_list_is_a_400(get, path, params):
    status, _ = get(path, **params)
    assert status == 400


def test_the_metric_routes_count_the_same_union(get):
    _, summary = get('/metrics/summary', category='delivery,billing', usefulness='high,low')
    _, sources = get('/metrics/sources', category='delivery,billing', usefulness='high,low')
    _, sentiment = get('/metrics/sentiment', source='web,app')
    assert summary['total_feedback'] == 3
    assert sources['sources'] == {'web': 2, 'email': 1}
    assert sentiment['total'] == 4


def test_entities_and_problems_take_the_lists_too(get):
    _, entities = get('/feedback/entities', source='app,email')
    _, problems = get('/feedback/problems', usefulness='high')
    assert entities['entities']['sources'] == {'app': 2, 'email': 1}
    assert problems['feedback_count'] == 2
