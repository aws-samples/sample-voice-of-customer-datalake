"""PR/FAQ and PRD generation's feedback block (``_feedback_context``) never holds the VoC app's own micro-feedback (an
item tagged ``voc_app``, 7.66.00: shared/item_filters.py)."""
from __future__ import annotations

from unittest.mock import MagicMock

from jobs.document_generator import handler
from shared.test.clock import today_utc
from shared.test.feedback_doubles import fetch_rows_as_read


def test_a_document_is_written_from_no_micro_feedback(monkeypatch):
    fetch_rows_as_read(monkeypatch)
    table = MagicMock()
    table.query.return_value = {'Items': [
        {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#c1', 'feedback_id': 'c1', 'date': today_utc(),
         'original_text': 'Delivery was late', 'source_platform': 'web'},
        {'pk': 'SOURCE#feedback_form', 'sk': 'FEEDBACK#app1', 'feedback_id': 'app1', 'date': today_utc(),
         'original_text': 'The tool is slow', 'source_platform': 'feedback_form', 'tags': ['voc_app']},
    ]}
    sample = handler._feedback_context(table, {'days': 7})
    assert [set(sample.input_ids), 'The tool is slow' in sample.context] == [{'c1'}, False]
