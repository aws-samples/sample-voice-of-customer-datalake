"""Radar counts agree with the review list behind them (wave-4 live finding).

Six reviews imported twice (under a second feedback id each) made the page header say 12
while "Read all reviews" listed 6, and a theme say "2 reviews" that opened 1. Every count
now comes from the list's own walk (`shared.radar_counts`), so a second stored copy is one
review everywhere.
"""
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from test_radar_handler import ADMIN, _call, radar_tables

from shared.radar_store import radar_item, store_item

TEXTS = ('Slow sync', 'Great editor', 'Crashes on save')


def _review(feedback_id: str, text: str, label: str) -> dict:
    return {'feedback_id': feedback_id, 'date': datetime.now(UTC).date().isoformat(),
            'original_text': text, 'category': 'delivery', 'subcategory': None,
            'sentiment_label': label, 'sentiment_score': Decimal('-0.5'),
            'direct_customer_quote': text, 'source_platform': 'rival_reviews'}


@pytest.fixture
def imported_twice():
    with radar_tables() as (radar, aggregates):
        for copy in ('a', 'b'):
            for n, text in enumerate(TEXTS):
                store_item(radar, 'acme', radar_item(_review(f'{copy}{n}', text, 'negative'), 'acme', 'Acme'))
        yield radar, aggregates


def _listed(tables, lambda_context, **query) -> int:
    _, body, _ = _call(tables, lambda_context, 'GET', '/radar/brands/acme/reviews', claims=ADMIN,
                       query={'limit': '50', **query})
    return len(body['reviews'])


def test_the_brand_total_is_the_number_of_reviews_listed(imported_twice, lambda_context):
    _, detail, _ = _call(imported_twice, lambda_context, 'GET', '/radar/brands/acme', claims=ADMIN)
    assert detail['total'] == _listed(imported_twice, lambda_context) == len(TEXTS)


def test_the_overview_total_matches_the_list_too(imported_twice, lambda_context):
    _, overview, _ = _call(imported_twice, lambda_context, 'GET', '/radar', claims=ADMIN)
    assert overview['brands'][0]['total'] == len(TEXTS)


def test_the_trend_counts_each_review_once(imported_twice, lambda_context):
    _, detail, _ = _call(imported_twice, lambda_context, 'GET', '/radar/brands/acme', claims=ADMIN)
    assert sum(point['count'] for point in detail['trend']) == len(TEXTS)


def test_a_theme_count_opens_that_many_reviews(imported_twice, lambda_context):
    _, detail, _ = _call(imported_twice, lambda_context, 'GET', '/radar/brands/acme', claims=ADMIN)
    theme = detail['hate'][0]
    opened = _listed(imported_twice, lambda_context, category=theme['category'], sentiment='negative')
    assert theme['count'] == opened == len(TEXTS)


def test_the_compare_volume_counts_each_review_once(imported_twice, lambda_context):
    # Wave-9 finding: compare read the per-copy counters, so 2 reviews showed as "4".
    _, body, _ = _call(imported_twice, lambda_context, 'GET', '/radar/brands/acme/compare', claims=ADMIN)
    row = next(row for row in body['categories'] if row['category'] == 'delivery')
    assert row['theirs'] == {'volume': len(TEXTS), 'positive_share': 0.0, 'negative_share': 1.0}
    assert row['theirs']['volume'] == _listed(imported_twice, lambda_context, category='delivery')
