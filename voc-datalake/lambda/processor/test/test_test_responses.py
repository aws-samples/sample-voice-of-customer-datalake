"""A form's test response (docs/feedback-forms.md "Test mode") never enters processing.

The form API never queues one (lambda/api/test/test_feedback_form_v2.py pins it). One that reaches the queue anyway,
marked ``is_test`` on the message or in its metadata, is dropped before validation: no enrichment call, no write, no
dead letter; a message without the mark is processed as before.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord

from processor import handler
from processor.test.sqs_fixtures import sqs_record

MESSAGE = {'id': 'r1', 'source_platform': 'feedback_form', 'text': 'Slow', 'created_at': '2026-11-17T10:00:00+00:00',
           'source_channel': 'form_ff_x'}


@pytest.mark.parametrize('marked', [{**MESSAGE, 'is_test': True}, {**MESSAGE, 'metadata': {'is_test': True}}])
def test_a_message_marked_as_a_test_is_dropped_before_anything_reads_it(marked):
    with patch.object(handler, '_process_record') as process, patch.object(handler, 'count_metric') as count:
        result = handler.record_handler(SQSRecord(sqs_record('m1', marked)))
    assert result == {'status': 'skipped', 'reason': 'test response'}
    process.assert_not_called()
    count.assert_called_once_with('TestResponseDropped')


@pytest.mark.parametrize('message', [MESSAGE, {**MESSAGE, 'is_test': False}, {**MESSAGE, 'metadata': {'x': 1}}])
def test_any_other_message_is_processed_as_before(message):
    with patch.object(handler, '_process_record', return_value={'status': 'success'}) as process:
        assert handler.record_handler(SQSRecord(sqs_record('m1', message))) == {'status': 'success'}
    process.assert_called_once()


def test_is_test_message_reads_only_a_true_mark():
    assert handler.is_test_message({'is_test': 'yes'}) is False
    assert handler.is_test_message(['is_test']) is False
