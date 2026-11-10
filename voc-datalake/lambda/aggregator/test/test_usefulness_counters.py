"""Per-day, per-source usefulness band counters (docs/data-quality.md)."""
import pytest

from aggregator.handler import counter_dimensions, counter_keys, get_metric_type, usefulness_bucket

DAY = '2026-10-01'
ITEM = {'source_platform': 'webscraper', 'category': 'billing', 'sentiment_label': 'negative', 'date': DAY}


def _usefulness_rows(keys) -> set[str]:
    return {pk for pk, _sk, _field in keys if pk.startswith('METRIC#daily_usefulness#')}


@pytest.mark.parametrize('band', ['low', 'medium', 'high'])
def test_a_rated_item_counts_under_its_source_and_band(band):
    assert usefulness_bucket({**ITEM, 'usefulness': band}) == f'METRIC#daily_usefulness#webscraper#{band}'
    assert (f'METRIC#daily_usefulness#webscraper#{band}', 'count') in counter_dimensions({**ITEM, 'usefulness': band})


@pytest.mark.parametrize('value', [None, '', 'HIGH', 'unrated', 3])
def test_an_unrated_item_has_no_usefulness_row(value):
    item = {**ITEM} if value is None else {**ITEM, 'usefulness': value}
    assert usefulness_bucket(item) is None
    assert _usefulness_rows(counter_keys(item, DAY)) == set()


def test_an_item_without_a_source_counts_under_unknown_like_the_source_row():
    assert usefulness_bucket({'usefulness': 'low'}) == 'METRIC#daily_usefulness#unknown#low'


def test_the_rows_are_on_the_metric_type_index():
    assert get_metric_type('METRIC#daily_usefulness#webscraper#high') == 'usefulness'


def test_a_band_change_moves_one_row_down_and_one_up():
    old, new = {**ITEM, 'usefulness': 'low'}, {**ITEM, 'usefulness': 'high'}
    old_keys, new_keys = counter_keys(old, DAY), counter_keys(new, DAY)
    assert _usefulness_rows(old_keys - new_keys) == {'METRIC#daily_usefulness#webscraper#low'}
    assert _usefulness_rows(new_keys - old_keys) == {'METRIC#daily_usefulness#webscraper#high'}


def test_a_backfill_only_adds_the_band_row():
    """A reprocess rating a pre-band review: no decrement (it was never counted), one increment."""
    old_keys, new_keys = counter_keys(ITEM, DAY), counter_keys({**ITEM, 'usefulness': 'medium'}, DAY)
    assert old_keys - new_keys == set()
    assert new_keys - old_keys == {('METRIC#daily_usefulness#webscraper#medium', DAY, 'count')}


def test_an_unchanged_band_writes_nothing():
    item = {**ITEM, 'usefulness': 'medium'}
    assert counter_keys(item, DAY) == counter_keys({**item, 'problem_summary': 'edited'}, DAY)
