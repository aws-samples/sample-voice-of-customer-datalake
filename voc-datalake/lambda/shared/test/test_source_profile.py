"""`shared.source_profile`: the per-source rating / sentiment / length profile (docs/data-quality.md)."""
from decimal import Decimal

import pytest

from shared import data_quality, source_profile


@pytest.mark.parametrize(('raw', 'bucket'), [
    (5, '5'), (Decimal('4.5'), '5'), (Decimal('4.4'), '4'), ('3', '3'), (Decimal('0.4'), '1'),
    (None, 'none'), (0, 'none'), (-1, 'none'), (6, 'none'), ('n/a', 'none'), (True, 'none'),
    (Decimal('NaN'), 'none'), ([], 'none'),
])
def test_rating_bucket(raw, bucket):
    assert source_profile.rating_bucket(raw) == bucket


@pytest.mark.parametrize(('label', 'bucket'), [
    ('positive', 'positive'), ('mixed', 'mixed'), (None, 'neutral'), ('POSITIVE', 'other'), (3, 'other'),
])
def test_sentiment_bucket(label, bucket):
    assert source_profile.sentiment_bucket(label) == bucket


@pytest.mark.parametrize(('size', 'bucket'), [
    (0, 'short'), (49, 'short'), (50, 'medium'), (199, 'medium'), (200, 'long'), (999, 'long'), (1000, 'very_long'),
])
def test_length_bucket_bounds(size, bucket):
    assert source_profile.length_bucket('a' * size) == bucket


def test_a_missing_text_is_short():
    assert source_profile.length_bucket(None) == 'short'


def test_counter_rows_parse_the_last_segment_and_ignore_unknown_values():
    profiles = source_profile.from_counter_rows({
        'rating': {'web#site#5': 2, 'web#site#11': 9},
        'sentiment': {'web#site#positive': 2},
        'colour': {'web#site#blue': 1},
    })
    assert profiles['web#site']['profiled'] == 2
    assert profiles['web#site']['rating']['5'] == 2
    assert profiles['web#site']['sentiment']['positive'] == 2


def test_items_and_attach_add_a_profile_to_every_row_and_the_overall():
    items = [{'source_platform': 'web', 'rating': 1, 'sentiment_label': 'negative', 'original_text': 'x' * 300},
             {'source_platform': 'app'}]
    result = source_profile.attach(data_quality.from_items(items),
                                   source_profile.from_items(items, data_quality.source_of))
    by_source = {row['source']: row['profile'] for row in result['sources']}
    assert by_source['web']['rating']['1'] == 1
    assert by_source['web']['length']['long'] == 1
    assert by_source['app']['rating']['none'] == 1
    assert result['overall']['profile']['profiled'] == 2


def test_a_source_without_profile_rows_gets_an_empty_profile():
    result = source_profile.attach(data_quality.from_counters({'web': 3}, {}), {})
    assert result['sources'][0]['profile'] == source_profile.empty_profile()
