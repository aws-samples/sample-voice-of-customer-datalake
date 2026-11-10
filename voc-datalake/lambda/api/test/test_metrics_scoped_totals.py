"""A restricted caller's summary and category totals agree, and a capped walk says where it stopped.

Live finding (verify13, prod 5.17.01): a viewer restricted to one category got
`/metrics/summary?days=0` = 1,457 with a bare `is_partial: true`, while
`/metrics/categories?days=0` said 4,277. The item walk capped after 5,000 rows of
EVERY category and filtered the scope afterwards. Reproduced here on moto with the
cap lowered to a handful of rows.
"""
from __future__ import annotations

from contextlib import ExitStack
from datetime import UTC, datetime, timedelta
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

CATEGORIES = ['delivery', 'billing', 'app']


def _day(offset: int) -> str:
    return (datetime.now(UTC) - timedelta(days=offset)).strftime('%Y-%m-%d')


def _seed_feedback(table) -> None:
    """Three days; each day 1 delivery review after 4 others (the walk reads newest first)."""
    for offset in range(3):
        day = _day(offset)
        for n, category in enumerate(['billing', 'app', 'billing', 'app', 'delivery']):
            fid = f'{day}-{n}'
            table.put_item(Item={
                'pk': f'SOURCE#{"app" if n % 2 else "web"}', 'sk': f'FEEDBACK#{fid}', 'feedback_id': fid,
                'gsi1pk': f'DATE#{day}', 'gsi1sk': f'{day}T00:00:0{n}', 'date': day,
                'category': category, 'source_platform': 'app' if n % 2 else 'web',
                'sentiment_label': 'negative', 'sentiment_score': Decimal('-0.5'), 'urgency': 'high',
            })


def _seed_aggregates(table, access: dict) -> None:
    table.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config',
                         'categories': [{'name': name} for name in CATEGORIES]})
    table.put_item(Item={**access_key(RESTRICTED_SUB), **access})
    for offset in range(3):
        for category, count in (('delivery', 1), ('billing', 2), ('app', 2)):
            table.put_item(Item={'pk': f'METRIC#daily_category#{category}', 'sk': _day(offset), 'count': count})


@pytest.fixture
def world():
    """A builder: seed moto tables for an access row, with the aggregate walk's cap lowered to 4 rows."""
    with ExitStack() as stack:
        stack.enter_context(mock_aws())
        clear_categories_cache()

        def build(access: dict) -> None:
            feedback = pk_sk_table('scoped-feedback', gsi1_index='gsi1-by-date')
            aggregates = pk_sk_table('scoped-aggregates')
            _seed_feedback(feedback)
            _seed_aggregates(aggregates, access)
            stack.enter_context(patch('metrics_handler.feedback_table', feedback))
            stack.enter_context(patch('metrics_handler.aggregates_table', aggregates))
            stack.enter_context(patch('metrics_handler.AGGREGATE_READ_ROWS', 4))

        yield build
    clear_categories_cache()


def _get(api_gateway_event, lambda_context, path: str) -> dict:
    _, body = call_route(lambda_handler, api_gateway_event, lambda_context, method='GET', path=path,
                         query_params={'days': '3'}, claims=RESTRICTED_CLAIMS)
    return body


def test_category_restricted_summary_matches_categories(world, api_gateway_event, lambda_context):
    world({'categories': ['delivery']})
    summary = _get(api_gateway_event, lambda_context, '/metrics/summary')
    categories = _get(api_gateway_event, lambda_context, '/metrics/categories')
    assert categories['categories'] == {'delivery': 3}
    assert summary['total_feedback'] == 3
    # The walk behind sentiment/urgency counts only visible rows now: 3 < the cap of 4.
    assert (summary['urgent_count'], summary['is_partial']) == (3, False)
    assert 'partial_reason' not in summary


def test_category_restricted_sentiment_walk_is_complete(world, api_gateway_event, lambda_context):
    world({'categories': ['delivery']})
    sentiment = _get(api_gateway_event, lambda_context, '/metrics/sentiment')
    assert (sentiment['total'], sentiment['is_partial']) == (3, False)


def test_capped_source_restricted_walk_names_where_it_stopped(world, api_gateway_event, lambda_context):
    # A source rule cannot use the counters: the item walk serves both routes and
    # hits the cap (3 visible web rows a day; the cap of 4 cuts yesterday after one), so both
    # say partial, that a ROW cap stopped them, and that only today was read in full:
    # yesterday was cut part-way and is not claimed (it once was, labelled 'time_budget').
    world({'categories': ['*'], 'sources': ['web']})
    summary = _get(api_gateway_event, lambda_context, '/metrics/summary')
    categories = _get(api_gateway_event, lambda_context, '/metrics/categories')
    assert summary['total_feedback'] == sum(categories['categories'].values()) == 4
    for body in (summary, categories):
        assert (body['is_partial'], body['partial_reason']) == (True, 'row_cap')
        assert body['scanned_through'] == _day(0)
