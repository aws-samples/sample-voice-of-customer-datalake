"""Radar compare: no verdict from a handful of reviews, an overall row; themes show a quote once (docs/radar.md)."""
from datetime import date
from decimal import Decimal

import pytest
from moto import mock_aws

from shared.category_access import UNRESTRICTED, CategoryScope
from shared.radar_store import radar_item, store_item
from shared.radar_views import MIN_COMPARE_REVIEWS, compare, themes
from shared.test.radar_fixtures import radar_pk_sk_table

DAY = date(2026, 10, 1)
DELIVERY_ONLY = CategoryScope(all=False, categories=frozenset({'delivery'}))


def _review(table, n, label, category, quote='', subcategory=None):
    review = {'feedback_id': f'f{n}', 'date': DAY.isoformat(), 'category': category, 'subcategory': subcategory,
              'sentiment_label': label, 'sentiment_score': Decimal('0.5'), 'direct_customer_quote': quote,
              'source_platform': 'globex_reviews'}
    store_item(table, 'globex', radar_item(review, 'globex', 'Globex'))


@pytest.fixture
def tables():
    with mock_aws():
        radar, aggregates = radar_pk_sk_table('radar'), radar_pk_sk_table('aggregates')
        for n in range(MIN_COMPARE_REVIEWS):
            _review(radar, n, 'positive', 'delivery')
        _review(radar, 50, 'positive', 'billing')
        _review(radar, 51, 'negative', 'billing')
        for pk, count in (('METRIC#category_sentiment#delivery#positive', 2),
                          ('METRIC#category_sentiment#delivery#negative', 6),
                          ('METRIC#category_sentiment#billing#negative', 4),
                          ('METRIC#daily_sentiment#positive', 30), ('METRIC#daily_sentiment#negative', 10)):
            aggregates.put_item(Item={'pk': pk, 'sk': DAY.isoformat(), 'count': count})
        yield radar, aggregates


def _compare(tables, scope=UNRESTRICTED, ours_available=True):
    radar, aggregates = tables
    return compare(radar, aggregates, 'globex', ['delivery', 'billing', 'other'], DAY, DAY, scope,
                   ours_available=ours_available)


def test_a_category_with_fewer_than_ten_of_their_reviews_is_too_few_and_has_no_verdict(tables):
    rows = {row['category']: row for row in _compare(tables)['categories']}
    assert (rows['billing']['theirs']['volume'], rows['billing']['too_few'], rows['billing']['verdict']) == (2, True, None)
    assert (rows['delivery']['too_few'], rows['delivery']['verdict']) == (False, 'they_are_better')


def test_overall_puts_their_whole_window_against_ours(tables):
    overall = _compare(tables)['overall']
    assert overall['theirs'] == {'volume': 12, 'positive_share': 0.917, 'negative_share': 0.083}
    assert overall['ours'] == {'volume': 40, 'positive_share': 0.75, 'negative_share': 0.25}


def test_overall_has_no_us_side_when_ours_is_not_available(tables):
    body = _compare(tables, ours_available=False)
    assert (body['ours_available'], body['overall']['ours'], body['overall']['theirs']['volume']) == (False, None, 12)


def test_a_category_restricted_caller_gets_an_overall_of_only_its_categories(tables):
    overall = _compare(tables, scope=DELIVERY_ONLY)['overall']
    assert overall['theirs']['volume'] == MIN_COMPARE_REVIEWS
    # Ours from the delivery counters (2 + 6), never the whole-feedback daily counters (40).
    assert overall['ours'] == {'volume': 8, 'positive_share': 0.25, 'negative_share': 0.75}


def test_without_stored_review_rows_the_overall_falls_back_to_the_brand_counters(tables):
    radar, aggregates = tables
    radar.put_item(Item={'pk': 'RADAR#initech#daily_sentiment#positive', 'sk': DAY.isoformat(), 'count': 3})
    radar.put_item(Item={'pk': 'RADAR#initech#daily_sentiment#negative', 'sk': DAY.isoformat(), 'count': 1})
    body = compare(radar, aggregates, 'initech', ['delivery'], DAY, DAY, UNRESTRICTED, ours_available=True)
    assert body['overall']['theirs'] == {'volume': 4, 'positive_share': 0.75, 'negative_share': 0.25}


def test_an_empty_window_has_zero_volume_and_no_shares(tables):
    radar, aggregates = tables
    body = compare(radar, aggregates, 'initech', ['delivery'], DAY, DAY, DELIVERY_ONLY, ours_available=True)
    assert body['categories'] == []
    assert body['overall']['theirs'] == {'volume': 0, 'positive_share': None, 'negative_share': None}


class TestThemeQuotes:
    def test_a_quote_shown_under_a_higher_theme_is_not_repeated_under_a_lower_one(self, tables):
        radar, _ = tables
        # Two stored copies of one text under two subcategories, plus a quote of the lower theme's own.
        _review(radar, 60, 'negative', 'support', 'Nobody answers the phone', subcategory='phone')
        _review(radar, 61, 'negative', 'support', 'Waited an hour', subcategory='phone')
        _review(radar, 64, 'negative', 'support', 'Hold music forever', subcategory='phone')
        _review(radar, 62, 'negative', 'support', 'Nobody answers the phone', subcategory='chat')
        _review(radar, 63, 'negative', 'support', 'The bot loops', subcategory='chat')
        hate = {theme['subcategory']: theme for theme in themes(radar, 'globex', DAY, DAY, UNRESTRICTED)['hate']}
        assert sorted(hate['phone']['quotes']) == ['Hold music forever', 'Nobody answers the phone', 'Waited an hour']
        assert (hate['chat']['count'], hate['chat']['quotes']) == (2, ['The bot loops'])

    def test_the_same_text_in_the_other_column_is_still_shown_there(self, tables):
        radar, _ = tables
        _review(radar, 70, 'negative', 'support', 'It depends', subcategory='phone')
        _review(radar, 71, 'positive', 'support', 'It depends', subcategory='chat')
        view = themes(radar, 'globex', DAY, DAY, UNRESTRICTED)
        assert ['It depends'] in [theme['quotes'] for theme in view['love']]
        assert ['It depends'] in [theme['quotes'] for theme in view['hate']]
