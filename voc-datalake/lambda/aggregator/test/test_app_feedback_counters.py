"""The VoC app's own micro-feedback (an item tagged ``voc_app``, shared/app_feedback_tag.py, 7.66.00) counts in no
aggregate: no counter, no score in the average, in either direction; an edit that adds or removes the tag moves the
item out of or into the counters like any counted dimension (the MODIFY's symmetric difference)."""
from __future__ import annotations

from decimal import Decimal
from unittest.mock import patch

import pytest

from aggregator import handler
from aggregator.handler import counter_dimensions, counter_keys, process_modified_feedback

DAY = '2026-11-20'
ITEM = {'pk': 'SOURCE#Acme', 'sk': 'FEEDBACK#f1', 'feedback_id': 'f1', 'date': DAY, 'source_platform': 'feedback_form',
        'category': 'features', 'sentiment_label': 'negative', 'sentiment_score': Decimal('-0.5'), 'urgency': 'high',
        'tags': ['beta']}
APP = {**ITEM, 'tags': ['beta', 'VOC_APP']}


@pytest.mark.parametrize('tags', [['voc_app'], ['Voc_App', 'beta'], [' voc_app ']])
def test_an_app_feedback_item_has_no_counter_and_no_score(tags):
    item = {**ITEM, 'tags': tags}
    assert counter_dimensions(item) == []
    assert counter_keys(item, DAY) == set()
    assert handler._image_score(item) == Decimal('0')


def test_any_other_item_is_counted_as_before():
    pks = {pk for pk, _ in counter_dimensions(ITEM)}
    assert {'METRIC#daily_total', 'METRIC#daily_tag#beta'} <= pks
    assert handler._image_score(ITEM) == Decimal('-0.5')


def test_an_arrival_writes_only_its_claim():
    with patch.object(handler, '_claimed_transaction', return_value=True) as claimed:
        assert handler.apply_arrival_once(APP, DAY, 'evt-1') is True
    claimed.assert_called_once_with('evt-1', [])


def test_a_removal_moves_nothing():
    with patch.object(handler, 'apply_counter_keys', return_value=(0, {})) as counters, \
            patch.object(handler, 'update_average') as average:
        assert handler.process_deleted_feedback(APP) is True
    counters.assert_called_once_with(set(), -1)
    average.assert_not_called()


def _rebucket(old: dict, new: dict) -> tuple[set, set, list]:
    """The decrements and increments a MODIFY sends, and its average writes (both days live)."""
    sent: dict[int, set] = {}

    def counters(keys, sign):
        sent[sign] = set(keys)
        return len(keys), {}

    with patch.object(handler, '_day_has_aggregates', return_value=True), \
            patch.object(handler, 'apply_counter_keys', side_effect=counters), \
            patch.object(handler, 'update_average', return_value=True) as average:
        process_modified_feedback(old, new)
    return sent.get(-1, set()), sent.get(1, set()), [call.kwargs['sign'] for call in average.call_args_list]


def test_tagging_an_item_voc_app_takes_it_out_of_every_counter():
    decrements, increments, averages = _rebucket(ITEM, APP)
    assert decrements == counter_keys(ITEM, DAY)
    assert increments == set()
    assert averages == [-1]


def test_untagging_it_counts_it_from_then_on():
    decrements, increments, averages = _rebucket(APP, ITEM)
    assert decrements == set()
    assert increments == counter_keys(ITEM, DAY)
    assert averages == [1]


def test_an_edit_of_an_app_feedback_item_moves_nothing():
    decrements, increments, averages = _rebucket(APP, {**APP, 'category': 'ux'})
    assert (decrements, increments, averages) == (set(), set(), [])
