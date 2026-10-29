"""step_save records how much of the corpus reached the research model (#231).

step_initialize reports ``feedback_usage``; the state machine forwards it to
step_save, which puts it on the job result (the persona job's ``metadata``
shape the SPA's job list reads) and on the saved document (the document
generator's ``feedback_items_used`` / ``context_truncated``).
"""
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import research_step_handler as rsh

USAGE = {
    'feedback_count': 50, 'feedback_items_used': 31, 'context_truncated': True,
    'fetch_limit_reached': True, 'fetch_limit': 50,
}


@pytest.fixture
def job_status() -> Iterator[MagicMock]:
    with patch('research_step_handler.update_job_status') as mock:
        yield mock


@pytest.fixture
def saved() -> Iterator[MagicMock]:
    """The item create_counted_project_child is asked to write."""
    with patch('research_step_handler._get_projects_table', return_value=MagicMock()), \
            patch('research_step_handler.create_counted_project_child',
                  side_effect=lambda _t, _p, _k, build: build('research_1')) as create:
        yield create


def _save(**extra: Any) -> dict:
    return rsh.step_save({
        'project_id': 'p1', 'job_id': 'j1', 'research_config': {'question': 'Q'},
        'feedback_count': 50, 'analysis': 'A', 'synthesis': 'S', 'validation': 'V', **extra,
    })


def _item(saved: MagicMock) -> dict:
    build = saved.call_args.args[3]
    return build('research_1')


def test_reported_usage_lands_on_the_job_result_and_the_document(saved, job_status):
    _save(feedback_usage=USAGE)
    assert job_status.call_args.kwargs['result']['metadata'] == USAGE
    item = _item(saved)
    assert (item['feedback_items_used'], item['context_truncated']) == (31, True)
    assert '**Feedback Analyzed:** 31 of 50 items read (the rest did not fit the context budget)\n' \
        in item['content']


def test_a_fetch_cap_alone_marks_the_document_truncated_but_not_the_header(saved, job_status):
    _save(feedback_usage={**USAGE, 'feedback_items_used': 50, 'context_truncated': False})
    item = _item(saved)
    assert (item['feedback_items_used'], item['context_truncated']) == (50, True)
    assert '**Feedback Analyzed:** 50 items\n' in item['content']
    assert job_status.call_args.kwargs['result']['metadata']['fetch_limit_reached'] is True


@pytest.mark.parametrize('usage', [
    None, 'text', {}, {**USAGE, 'feedback_items_used': -1}, {**USAGE, 'fetch_limit': True},
    {**USAGE, 'context_truncated': 'false'}, {k: v for k, v in USAGE.items() if k != 'fetch_limit'},
])
def test_absent_or_malformed_usage_records_nothing(saved, job_status, usage):
    _save(**({} if usage is None else {'feedback_usage': usage}))
    assert 'metadata' not in job_status.call_args.kwargs['result']
    item = _item(saved)
    assert 'feedback_items_used' not in item
    assert 'context_truncated' not in item
    assert '**Feedback Analyzed:** 50 items\n' in item['content']


def test_received_usage_keeps_only_the_known_fields():
    assert rsh._received_feedback_usage({**USAGE, 'extra': 'x'}) == USAGE


def test_the_input_ids_land_on_the_document_not_the_job_result(saved, job_status):
    """#236: the exact reviews the report was written from are persisted with it."""
    _save(feedback_usage={**USAGE, 'input_feedback_ids': ['f2', 'f1']})
    assert job_status.call_args.kwargs['result']['metadata'] == USAGE
    assert _item(saved)['input_feedback_ids'] == ['f2', 'f1']


@pytest.mark.parametrize('ids', ['f1', [1], ['f1', ''], None])
def test_malformed_input_ids_are_dropped_but_the_counts_kept(ids):
    assert rsh._received_feedback_usage({**USAGE, 'input_feedback_ids': ids}) == USAGE


def test_received_input_ids_are_capped():
    received = rsh._received_feedback_usage({**USAGE, 'input_feedback_ids': [f'f{n}' for n in range(600)]})
    assert len(received['input_feedback_ids']) == 500
