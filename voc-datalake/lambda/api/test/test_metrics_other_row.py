"""`/metrics/categories` has an "Other" row, so the breakdown adds up to `/metrics/summary`.

Live finding (prod 5.18.00): the unrestricted all-time summary said 17,066 reviews
while `/metrics/categories` summed to 16,295. The aggregator writes one
`METRIC#daily_category#<stored category>` row per review beside `METRIC#daily_total`
(they agreed on every day), but the route read only the CONFIGURED categories'
partitions, dropping 378 reviews under `other` and 393 under categories since
removed from the configuration. Reproduced here on moto, mirroring what the
aggregator writes.
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

CONFIGURED = ['delivery', 'billing', 'app']
# Per day: what each review is stored under. None = no category attribute (the
# aggregator counts it as `other`); `pricing` is a category no longer configured.
DAY_REVIEWS: list[str | None] = ['delivery', 'delivery', 'billing', 'app', 'other', None, 'pricing']
DAYS = 3
ADMIN_CLAIMS = {'sub': 'sub-admin', 'cognito:groups': 'admins', 'cognito:username': 'ada'}
USER_CLAIMS = {'sub': 'sub-user', 'cognito:groups': 'users', 'cognito:username': 'uma'}


def _window_days() -> list[str]:
    """The `DAYS` import dates of the window, newest first."""
    today = datetime.now(UTC)
    return [(today - timedelta(days=offset)).strftime('%Y-%m-%d') for offset in range(DAYS)]


def _review(day: str, n: int, category: str | None) -> dict:
    fid = f'{day}-{n}'
    item = {
        'pk': 'SOURCE#web', 'sk': f'FEEDBACK#{fid}', 'feedback_id': fid,
        'gsi1pk': f'DATE#{day}', 'gsi1sk': f'{day}T00:00:0{n}', 'date': day,
        'source_platform': 'web', 'sentiment_label': 'neutral', 'sentiment_score': Decimal('0'),
    }
    return item if category is None else {**item, 'category': category}


def _seed_feedback(table) -> None:
    for day in _window_days():
        for n, category in enumerate(DAY_REVIEWS):
            table.put_item(Item=_review(day, n, category))


def _seed_aggregates(table, access: dict | None) -> None:
    """The rows the aggregator writes for `_seed_feedback`, plus the config and an access row."""
    table.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config',
                         'categories': [{'name': name} for name in CONFIGURED]})
    if access is not None:
        table.put_item(Item={**access_key(RESTRICTED_SUB), **access})
    per_category: dict[str, int] = {}
    for category in DAY_REVIEWS:
        name = category or 'other'
        per_category[name] = per_category.get(name, 0) + 1
    for day in _window_days():
        table.put_item(Item={'pk': 'METRIC#daily_total', 'sk': day, 'count': len(DAY_REVIEWS)})
        table.put_item(Item={'pk': 'METRIC#daily_sentiment_avg', 'sk': day,
                             'sum': Decimal('0'), 'count': len(DAY_REVIEWS)})
        for name, count in per_category.items():
            table.put_item(Item={'pk': f'METRIC#daily_category#{name}', 'sk': day, 'count': count})


@pytest.fixture
def world():
    with ExitStack() as stack:
        stack.enter_context(mock_aws())
        clear_categories_cache()

        def build(access: dict | None = None) -> None:
            feedback = pk_sk_table('other-feedback', gsi1_index='gsi1-by-date')
            aggregates = pk_sk_table('other-aggregates')
            _seed_feedback(feedback)
            _seed_aggregates(aggregates, access)
            stack.enter_context(patch('metrics_handler.feedback_table', feedback))
            stack.enter_context(patch('metrics_handler.aggregates_table', aggregates))

        yield build
    clear_categories_cache()


@pytest.fixture
def get(api_gateway_event, lambda_context):
    def call(path: str, claims: dict, **params: str) -> dict:
        _, body = call_route(lambda_handler, api_gateway_event, lambda_context, method='GET', path=path,
                             query_params={'days': str(DAYS), **params}, claims=claims)
        return body
    return call


@pytest.mark.parametrize('claims', [ADMIN_CLAIMS, USER_CLAIMS], ids=['admin', 'unrestricted-user'])
def test_unrestricted_breakdown_has_other_and_matches_the_summary(world, get, claims):
    world()
    summary = get('/metrics/summary', claims)
    categories = get('/metrics/categories', claims)
    # `other` = the `other` reviews, the ones with no category and the removed `pricing`.
    assert categories['categories'] == {'delivery': 6, 'other': 9, 'billing': 3, 'app': 3}
    assert summary['total_feedback'] == sum(categories['categories'].values()) == 21
    assert categories['is_partial'] is False


def test_restricted_with_other_sees_the_other_row_and_totals_match(world, get):
    world({'categories': ['delivery', 'other']})
    summary = get('/metrics/summary', RESTRICTED_CLAIMS)
    categories = get('/metrics/categories', RESTRICTED_CLAIMS)
    # The removed `pricing` is not granted, so it stays hidden; `other` + no-category are.
    assert categories['categories'] == {'delivery': 6, 'other': 6}
    assert summary['total_feedback'] == sum(categories['categories'].values()) == 12


def test_restricted_without_other_never_sees_the_other_row(world, get):
    world({'categories': ['delivery']})
    summary = get('/metrics/summary', RESTRICTED_CLAIMS)
    categories = get('/metrics/categories', RESTRICTED_CLAIMS)
    assert categories['categories'] == {'delivery': 6}
    assert summary['total_feedback'] == 6


def test_the_item_path_folds_unconfigured_categories_into_other(world, get):
    # A source filter cannot use the counters: the walk tallies items the same way.
    world()
    categories = get('/metrics/categories', ADMIN_CLAIMS, source='web')
    summary = get('/metrics/summary', ADMIN_CLAIMS, source='web')
    assert categories['categories'] == {'delivery': 6, 'other': 9, 'billing': 3, 'app': 3}
    assert summary['total_feedback'] == 21


def test_the_other_list_holds_exactly_the_reviews_the_other_row_counts(world, get):
    world()
    body = get('/feedback', ADMIN_CLAIMS, category='other', limit='100')
    assert body['total'] == 9
    assert {item.get('category', 'none') for item in body['items']} == {'other', 'none', 'pricing'}


def test_the_other_sentiment_card_counts_the_other_row(world, get):
    world()
    body = get('/metrics/sentiment', ADMIN_CLAIMS, category='other')
    assert body['total'] == 9


def test_a_restricted_caller_without_other_lists_no_other_reviews(world, get):
    world({'categories': ['delivery']})
    body = get('/feedback', RESTRICTED_CLAIMS, category='other', limit='100')
    assert body['total'] == 0
