"""Map and list attributes of a REAL Powertools stream record reach the counters (see
`aggregator.handler.deserialize_image` for the bug fixed in 5.68.01).
"""
from unittest.mock import patch

import pytest

from aggregator import handler
from aggregator.test.aggregator_fixtures import stream_record

DATE = '2026-10-18'
BASE = {
    'pk': 'SOURCE#email_intake', 'sk': 'FEEDBACK#f1', 'date': DATE, 'source_platform': 'email_intake',
    'category': 'delivery', 'sentiment_label': 'negative', 'sentiment_score': -0.6, 'urgency': 'low',
}
TYPED = {'dimensions': {'feedback_type': 'service_failure'}, 'dimension_sources': {'feedback_type': 'reprocess'}}
TYPE_COUNTERS = {
    ('METRIC#daily_dim#feedback_type#service_failure', DATE, 'count'),
    ('METRIC#daily_dim_sentiment#feedback_type#service_failure#negative', DATE, 'count'),
}


@pytest.fixture
def writes():
    """Every counter key the handler moves, with its sign; days are live and every write lands."""
    moved: list[tuple[int, tuple[str, str, str]]] = []

    def apply(keys, sign):
        moved.extend((sign, key) for key in keys)
        return len(keys), {}

    with patch.object(handler, '_day_has_aggregates', return_value=True), \
            patch.object(handler, 'apply_counter_keys', side_effect=apply), \
            patch.object(handler, 'update_average', return_value=True):
        yield moved


def test_a_backfill_modify_that_types_a_review_increments_its_type_counters(writes):
    handler.record_handler(stream_record('MODIFY', old=BASE, new={**BASE, **TYPED, 'usefulness': 'high'}))

    increments = {key for sign, key in writes if sign == 1}
    assert increments >= TYPE_COUNTERS
    assert ('METRIC#daily_usefulness#email_intake#high', DATE, 'count') in increments
    assert not [key for sign, key in writes if sign == -1]


def test_a_modify_that_changes_the_type_moves_both_value_rows(writes):
    retyped = {**TYPED, 'dimensions': {'feedback_type': 'bug'}}
    handler.record_handler(stream_record('MODIFY', old={**BASE, **TYPED}, new={**BASE, **retyped}))

    assert {key for sign, key in writes if sign == -1} == TYPE_COUNTERS
    assert {key for sign, key in writes if sign == 1} == {
        ('METRIC#daily_dim#feedback_type#bug', DATE, 'count'),
        ('METRIC#daily_dim_sentiment#feedback_type#bug#negative', DATE, 'count'),
    }


def test_an_insert_hands_the_counters_its_type_and_tags():
    with patch.object(handler, 'process_new_feedback', return_value=True) as process:
        handler.record_handler(stream_record('INSERT', new={**BASE, **TYPED, 'tags': ['Beta', 'vip']}))

    item = process.call_args.args[0]
    counters = set(handler.counter_dimensions(item))
    assert {(pk, field) for pk, _date, field in TYPE_COUNTERS} <= counters
    assert {(f'{handler.TAG_PREFIX}beta', 'count'), (f'{handler.TAG_PREFIX}vip', 'count')} <= counters


def test_a_modify_that_changes_the_tags_moves_their_rows(writes):
    handler.record_handler(stream_record('MODIFY', old={**BASE, 'tags': ['beta']}, new={**BASE, 'tags': ['vip']}))

    assert {key for sign, key in writes if sign == -1} == {(f'{handler.TAG_PREFIX}beta', DATE, 'count')}
    assert {key for sign, key in writes if sign == 1} == {(f'{handler.TAG_PREFIX}vip', DATE, 'count')}


@pytest.mark.parametrize('dimensions', [
    {'feedback_type': 'bug'},
    # Keys that look like DynamoDB type tags are an operator's taxonomy, never a wire value.
    {'S': 'bug'}, {'N': '1'}, {'NULL': False}, {'M': {'a': 'b'}},
])
def test_a_deserialized_image_is_kept_as_it_is_whatever_its_map_keys(dimensions):
    image = {'date': DATE, 'dimensions': dimensions, 'tags': ['a'], 'score': 1}
    assert handler.deserialize_image(image) == image
