"""Map and list attributes of a REAL Powertools stream record reach the counters (see
`aggregator.handler.deserialize_image` for the 5.67.01 bug these tests pin).
"""
from decimal import Decimal
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


def test_tags_from_a_stream_record_are_counted():
    stream = stream_record('INSERT', new={**BASE, 'tags': ['Beta', 'vip']}).dynamodb
    assert stream is not None
    assert stream.new_image is not None
    item = handler.deserialize_image(stream.new_image)
    assert item['tags'] == ['Beta', 'vip']
    assert (f'{handler.TAG_PREFIX}beta', 'count') in handler.counter_dimensions(item)


@pytest.mark.parametrize(('image', 'expected'), [
    ({'s': {'S': 'text'}, 'm': {'M': {'k': {'S': 'v'}, 'n': {'N': '2'}}}}, {'s': 'text', 'm': {'k': 'v', 'n': 2}}),
    ({'n': {'N': '1'}, 'flag': {'BOOL': True}, 'gone': {'NULL': True}}, {'n': 1, 'flag': True, 'gone': None}),
    ({'tags': {'SS': ['a', 'b']}, 'l': {'L': [{'S': 'x'}]}}, {'tags': {'a', 'b'}, 'l': ['x']}),
    ({'n': {'N': 3}, 'd': {'N': Decimal('1.5')}}, {'n': 3, 'd': Decimal('1.5')}),
])
def test_a_raw_wire_image_is_deserialized_all_the_way_down(image, expected):
    assert handler.deserialize_image(image) == expected


def test_a_deserialized_one_key_map_that_looks_like_a_type_is_kept():
    # {'N': 'north'} is not a number and {'S': 1} has no str payload: neither is a wire value, so
    # both are kept as they came, never dropped or read as NaN.
    item = handler.deserialize_image({'region': {'N': 'north'}, 'meta': {'S': 1}})
    assert item == {'region': {'N': 'north'}, 'meta': {'S': 1}}


def test_a_deserialized_image_is_kept_as_it_is():
    image = {'date': DATE, 'dimensions': {'feedback_type': 'bug'}, 'tags': ['a'], 'score': 1}
    assert handler.deserialize_image(image) == image
