"""Research's feedback read (``research_step_handler.get_feedback_context``) never holds the VoC app's own
micro-feedback (an item tagged ``voc_app``, 7.66.00: shared/item_filters.py)."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import research_step_handler as rsh

from shared.test.clock import today_utc
from shared.test.feedback_doubles import fetch_rows_as_read


def test_research_reads_no_micro_feedback(monkeypatch):
    fetch_rows_as_read(monkeypatch)
    table = MagicMock()
    table.query.return_value = {'Items': [
        {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#c1', 'feedback_id': 'c1', 'category': 'delivery', 'date': today_utc()},
        {'pk': 'SOURCE#feedback_form', 'sk': 'FEEDBACK#app1', 'feedback_id': 'app1', 'category': 'delivery',
         'date': today_utc(), 'tags': ['VOC_APP']},
    ]}
    with patch('research_step_handler._get_feedback_table', return_value=table):
        assert {item['feedback_id'] for item in rsh.get_feedback_context({'days': 7}, 50)} == {'c1'}
