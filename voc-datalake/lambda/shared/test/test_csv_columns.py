"""`shared/csv_columns.py`: CSV header -> feedback field plan."""
import pytest

from shared.csv_columns import ColumnPlan, bounded_metadata, plan_columns


def test_auto_detection_matches_the_legacy_aliases_and_sends_the_rest_to_metadata():
    plan, warnings = plan_columns(['Review', 'Stars', 'Source', 'Plan', 'Region'])
    assert plan == ColumnPlan(single={'text': ['Review'], 'rating': ['Stars'], 'channel': ['Source']},
                              metadata=['Plan', 'Region'])
    assert warnings == []


def test_aliases_keep_their_priority_order():
    plan, _ = plan_columns(['comment', 'text', 'review'])
    assert plan.single['text'] == ['text', 'review', 'comment']


def test_an_explicit_map_wins_and_switches_that_targets_auto_detection_off():
    plan, _ = plan_columns(['Body', 'comment', 'Product', 'Labels', 'Secret'], {
        'body': 'text', 'Product': 'dimension:product', 'Labels': 'tags', 'Secret': 'ignore'})
    assert plan.single == {'text': ['Body'], 'tags': ['Labels']}
    assert plan.dimensions == {'product': 'Product'}
    assert plan.metadata == ['comment']


def test_a_map_naming_an_absent_header_warns():
    _plan, warnings = plan_columns(['text'], {'Missing': 'author'})
    assert warnings == ['column_map: no "Missing" column in the CSV — ignored']


@pytest.mark.parametrize(('column_map', 'message'), [
    (['text'], 'must be an object'),
    ({'a': 3}, 'must be a string'),
    ({'a': 'nope'}, 'is not one of'),
    ({'a': 'dimension:Bad Key'}, 'is not one of'),
    ({'a': 'text', 'b': 'text'}, 'more than one column to text'),
    ({f'h{i}': 'metadata' for i in range(201)}, 'at most 200'),
])
def test_bad_maps_are_refused(column_map, message):
    with pytest.raises(ValueError, match=message):
        plan_columns(['a', 'b'], column_map)


def test_several_columns_may_feed_tags_and_metadata():
    plan, _ = plan_columns(['t', 'a', 'b', 'c'], {'a': 'tags', 'b': 'tags', 'c': 'metadata', 't': 'text'})
    assert (plan.single['tags'], plan.metadata) == (['a', 'b'], ['c'])


def test_bounded_metadata_drops_blank_and_over_limit_entries():
    values = {'k': ' v ', 'blank': ' ', 'long': 'x' * 1001, **{f'm{i}': 'v' for i in range(40)}}
    out, dropped = bounded_metadata(values)
    assert out['k'] == 'v'
    assert len(out) == 30
    assert 'long' in dropped
    assert len(dropped) == 1 + 11
