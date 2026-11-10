"""Per-day, per-source profile counters: rating, sentiment, text length (docs/data-quality.md)."""
from decimal import Decimal

import pytest

from aggregator.handler import counter_dimensions, counter_keys, get_metric_type

DAY = '2026-10-01'
ITEM = {'source_platform': 'webscraper', 'category': 'billing', 'sentiment_label': 'negative', 'date': DAY,
        'rating': Decimal('2'), 'original_text': 'Example Air lost my bag'}


def _profile_rows(keys) -> set[str]:
    return {pk for pk, _sk, _field in keys if pk.startswith('METRIC#daily_profile_')}


def test_every_item_counts_once_per_facet_under_its_source():
    assert _profile_rows(counter_keys(ITEM, DAY)) == {
        'METRIC#daily_profile_rating#webscraper#2',
        'METRIC#daily_profile_sentiment#webscraper#negative',
        'METRIC#daily_profile_length#webscraper#short',
    }


def test_each_profile_row_names_its_own_item():
    """A transaction may not name one item twice (`apply_transaction`'s warning)."""
    pks = [pk for pk, _field in counter_dimensions(ITEM)]
    assert len(pks) == len(set(pks))


@pytest.mark.parametrize(('pk', 'kind'), [
    ('METRIC#daily_profile_rating#webscraper#5', 'profile_rating'),
    ('METRIC#daily_profile_sentiment#webscraper#mixed', 'profile_sentiment'),
    ('METRIC#daily_profile_length#webscraper#long', 'profile_length'),
])
def test_the_rows_are_on_the_metric_type_index(pk, kind):
    assert get_metric_type(pk) == kind


def test_an_edit_moves_only_the_facets_that_changed():
    edited = {**ITEM, 'rating': Decimal('4')}
    old, new = counter_keys(ITEM, DAY), counter_keys(edited, DAY)
    assert _profile_rows(old - new) == {'METRIC#daily_profile_rating#webscraper#2'}
    assert _profile_rows(new - old) == {'METRIC#daily_profile_rating#webscraper#4'}


def test_an_item_without_a_source_counts_under_unknown_like_the_source_row():
    keys = counter_keys({'rating': 5}, DAY)
    assert 'METRIC#daily_profile_rating#unknown#5' in _profile_rows(keys)
    assert ('METRIC#daily_source#unknown', DAY, 'count') in keys
