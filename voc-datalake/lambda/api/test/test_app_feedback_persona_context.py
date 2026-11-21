"""Persona generation's feedback read (``projects.get_feedback_context`` and its pre-check ``feedback_exists``) never
holds the VoC app's own micro-feedback (an item tagged ``voc_app``, 7.66.00: shared/item_filters.py)."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import projects
from shared.test.clock import today_utc
from shared.test.feedback_doubles import fetch_rows_as_read

ROWS = [{'pk': 'SOURCE#web', 'sk': 'FEEDBACK#c1', 'feedback_id': 'c1', 'category': 'delivery', 'date': today_utc()},
        {'pk': 'SOURCE#feedback_form', 'sk': 'FEEDBACK#app1', 'feedback_id': 'app1', 'category': 'delivery',
         'date': today_utc(), 'tags': ['voc_app']}]


def test_persona_generation_reads_no_micro_feedback(monkeypatch):
    fetch_rows_as_read(monkeypatch)
    table = MagicMock()
    table.query.return_value = {'Items': ROWS}
    with patch.object(projects, 'feedback_table', table):
        assert {item['feedback_id'] for item in projects.get_feedback_context({'days': 7}, 50)} == {'c1'}
        table.query.return_value = {'Items': ROWS[1:]}
        assert projects.feedback_exists({'days': 7}) is False
