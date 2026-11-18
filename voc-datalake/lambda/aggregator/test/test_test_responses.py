"""A form's test response (docs/feedback-forms.md "Test mode") never counts towards a metric, NPS or dashboard.

Test responses never reach voc-feedback (the form API keeps them with the form). A stream record of one marked
``is_test`` anyway moves nothing: its INSERT, MODIFY and REMOVE are skipped before any counter, average or
data-version write; an unmarked item is counted as before.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from aggregator import handler
from aggregator.test.aggregator_fixtures import stream_record

ITEM = {'pk': 'SOURCE#Acme', 'sk': 'FEEDBACK#f1', 'feedback_id': 'f1', 'date': '2026-11-17',
        'source_platform': 'feedback_form', 'category': 'features', 'sentiment_label': 'NEGATIVE',
        'sentiment_score': -0.5, 'urgency': 'low'}


@pytest.mark.parametrize(('event', 'images'), [
    ('INSERT', {'new': {**ITEM, 'is_test': True}}),
    ('MODIFY', {'old': {**ITEM, 'is_test': True}, 'new': {**ITEM, 'is_test': True, 'category': 'ux'}}),
    ('REMOVE', {'old': {**ITEM, 'is_test': True}}),
])
def test_a_test_responses_record_moves_no_aggregate(event, images):
    with patch.object(handler, 'process_new_feedback') as insert, \
            patch.object(handler, 'process_modified_feedback') as modify, \
            patch.object(handler, 'process_deleted_feedback') as remove, \
            patch.object(handler, '_mark_data_changed') as changed:
        result = handler.record_handler(stream_record(event, **images))
    assert result == {'status': 'skipped', 'reason': 'test response'}
    for call in (insert, modify, remove, changed):
        call.assert_not_called()


def test_an_unmarked_item_is_counted_as_before():
    with patch.object(handler, 'process_new_feedback', return_value=True) as insert, \
            patch.object(handler, '_mark_data_changed'), patch.object(handler, 'lower_earliest_date'):
        result = handler.record_handler(stream_record('INSERT', new={**ITEM, 'is_test': False}))
    assert result == {'status': 'success'}
    insert.assert_called_once()
