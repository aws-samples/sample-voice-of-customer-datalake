"""The VoC app's own micro-feedback (an item tagged ``voc_app``, shared/app_feedback_tag.py, 7.66.00) counts in no
aggregate: no counter, no score in the average, in either direction; an edit that adds or removes the tag moves the
item out of or into the counters like any counted dimension (the MODIFY's symmetric difference). It keeps its day's
sentinel (the daily total row's ``app_feedback`` field, never its ``count``), so a day of micro-feedback alone is live
to `_day_has_aggregates` (moto, below)."""
from __future__ import annotations

from decimal import Decimal
from unittest.mock import patch

import pytest
from moto import mock_aws

from aggregator import handler
from aggregator.handler import (
    APP_FEEDBACK_SENTINEL_FIELD,
    counter_dimensions,
    counter_keys,
    process_modified_feedback,
    process_new_feedback,
)
from shared.test.moto_tables import create_pk_sk_table

DAY = '2026-11-20'
ITEM = {'pk': 'SOURCE#Acme', 'sk': 'FEEDBACK#f1', 'feedback_id': 'f1', 'date': DAY, 'source_platform': 'feedback_form',
        'category': 'features', 'sentiment_label': 'negative', 'sentiment_score': Decimal('-0.5'), 'urgency': 'high',
        'tags': ['beta']}
APP = {**ITEM, 'tags': ['beta', 'VOC_APP']}
SENTINEL = ('METRIC#daily_total', DAY, APP_FEEDBACK_SENTINEL_FIELD)


@pytest.mark.parametrize('tags', [['voc_app'], ['Voc_App', 'beta'], [' voc_app ']])
def test_an_app_feedback_item_has_no_counter_and_no_score(tags):
    item = {**ITEM, 'tags': tags}
    assert counter_dimensions(item) == [('METRIC#daily_total', APP_FEEDBACK_SENTINEL_FIELD)]
    assert counter_keys(item, DAY) == {SENTINEL}
    assert handler._image_score(item) == Decimal('0')


def test_any_other_item_is_counted_as_before():
    pks = {pk for pk, _ in counter_dimensions(ITEM)}
    assert {'METRIC#daily_total', 'METRIC#daily_tag#beta'} <= pks
    assert handler._image_score(ITEM) == Decimal('-0.5')


def test_an_arrival_writes_only_its_claim_and_its_day_s_sentinel():
    with patch.object(handler, '_claimed_transaction', return_value=True) as claimed:
        assert handler.apply_arrival_once(APP, DAY, 'evt-1') is True
    [(key, items)] = [call.args for call in claimed.call_args_list]
    assert [key, [(item['Update']['Key']['pk'], item['Update']['ExpressionAttributeNames']['#field']) for item in items]] == [
        'evt-1', [('METRIC#daily_total', APP_FEEDBACK_SENTINEL_FIELD)]]


def test_a_removal_moves_nothing():
    with patch.object(handler, 'apply_counter_keys', return_value=(0, {})) as counters, \
            patch.object(handler, 'update_average') as average:
        assert handler.process_deleted_feedback(APP) is True
    counters.assert_called_once_with({SENTINEL}, -1)
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
    assert increments == {SENTINEL}
    assert averages == [-1]


def test_untagging_it_counts_it_from_then_on():
    decrements, increments, averages = _rebucket(APP, ITEM)
    assert decrements == {SENTINEL}
    assert increments == counter_keys(ITEM, DAY)
    assert averages == [1]


def test_an_edit_of_an_app_feedback_item_moves_nothing():
    decrements, increments, averages = _rebucket(APP, {**APP, 'category': 'ux'})
    assert (decrements, increments, averages) == (set(), set(), [])


def test_untagging_on_a_day_of_micro_feedback_alone_counts_the_item():
    # (moto, `_day_has_aggregates` NOT patched: the sentinel the micro-feedback's arrival wrote keeps the day live)
    with mock_aws():
        table = create_pk_sk_table('test-aggregates')
        with patch.object(handler, 'aggregates_table', table):
            assert process_new_feedback(APP) is True
            day = table.get_item(Key={'pk': 'METRIC#daily_total', 'sk': DAY}).get('Item', {})
            assert [day.get('count'), day[APP_FEEDBACK_SENTINEL_FIELD]] == [None, 1]
            process_modified_feedback(APP, ITEM)
            day = table.get_item(Key={'pk': 'METRIC#daily_total', 'sk': DAY}).get('Item', {})
    assert [day['count'], day[APP_FEEDBACK_SENTINEL_FIELD]] == [1, 0]
