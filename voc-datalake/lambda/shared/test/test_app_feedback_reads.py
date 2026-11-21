"""The VoC app's own micro-feedback (an item tagged ``voc_app``, 7.66.00) never reaches a customer-evidence read
unless the read asks for its tag (shared/item_filters.py, the default of every read through the item filters).

Here the shared feedback reads every generator samples from (shared/feedback.py: persona generation and research
through ``get_feedback_context``, PR/FAQ and PRD generation and the merger through ``query_feedback_by_date``, the
persona and research pre-check through ``feedback_context_exists``) and the other readers of voc-feedback that do not
take the request's filters: the agents' new-review walk, the release watch card, Revise from comments' evidence.
"""
from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest

from agents.heartbeat.handler import walk_reviews
from shared import document_revision, release_watch
from shared.feedback import feedback_context_exists, get_feedback_context, query_feedback_by_date
from shared.test.clock import today_utc
from shared.test.feedback_doubles import fetch_rows_as_read
from shared.time_budget import WalkBudget


@pytest.fixture(autouse=True)
def _pool_rows_are_full(monkeypatch):
    fetch_rows_as_read(monkeypatch)


def _review(feedback_id: str, tags: list[str] | None = None) -> dict:
    item = {'pk': 'SOURCE#feedback_form', 'sk': f'FEEDBACK#{feedback_id}', 'feedback_id': feedback_id,
            'category': 'delivery', 'source_platform': 'feedback_form', 'date': today_utc(),
            'original_text': f'Review {feedback_id}'}
    return {**item, 'tags': tags} if tags is not None else item


CUSTOMER = _review('c1', ['beta'])
APP = _review('app1', ['voc_app'])
APP_SPACED = _review('app2', [' VOC_APP '])


def _table(items: list[dict]) -> MagicMock:
    table = MagicMock()
    table.query.return_value = {'Items': items}
    return table


def _ids(items: list[dict]) -> list[str]:
    """The distinct ids read (a double answers every day partition alike)."""
    return sorted({item['feedback_id'] for item in items})


class TestTheGeneratorsSharedRead:
    def test_persona_and_research_context_leaves_it_out(self):
        assert _ids(get_feedback_context(_table([CUSTOMER, APP, APP_SPACED]), {'days': 7})) == ['c1']

    def test_the_document_generators_read_leaves_it_out(self):
        assert _ids(query_feedback_by_date(_table([CUSTOMER, APP]), days=7, limit=10)) == ['c1']

    def test_not_even_its_tag_reads_it(self):
        assert _ids(get_feedback_context(_table([CUSTOMER, APP, APP_SPACED]), {'days': 7, 'tag': 'voc_app'})) == []

    def test_a_window_of_micro_feedback_only_has_nothing_to_generate_from(self):
        assert feedback_context_exists(_table([APP]), {'days': 7}) is False
        assert feedback_context_exists(_table([APP, CUSTOMER]), {'days': 7}) is True


class TestTheOtherReaders:
    def test_an_agent_counts_no_micro_feedback_as_a_new_review(self):
        now = datetime.now(UTC)
        count, kept = walk_reviews(_table([APP, CUSTOMER]), {'all': True}, now.replace(hour=0, minute=0, second=0),
                                   now, 1)
        assert [count, _ids(kept)] == [1, ['c1']]

    def test_the_release_watch_reads_no_micro_feedback(self, monkeypatch):
        monkeypatch.setattr(release_watch, 'iter_query', lambda _table, _kwargs, **_options: iter([CUSTOMER, APP]))
        items, _ = release_watch.read_recent_items(MagicMock(), 1, now=datetime.now(UTC), budget=WalkBudget())
        assert _ids(items) == ['c1']

    def test_revise_from_comments_sends_no_micro_feedback_as_evidence(self):
        table = MagicMock()
        table.query.side_effect = lambda **kwargs: {'Items': [CUSTOMER if 'c1' in str(
            kwargs['KeyConditionExpression'].get_expression()['values'][1]) else APP]}
        found = document_revision.read_evidence(table, {'input_feedback_ids': ['c1', 'app1']}, None)
        assert _ids(found) == ['c1']
