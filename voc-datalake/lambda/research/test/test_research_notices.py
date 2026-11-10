"""research_step_handler: the research job's end reaches its starter (shared/job_notices.py, docs/realtime.md)."""
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
import research_step_handler as rsh


@pytest.fixture
def notified() -> Iterator[MagicMock]:
    with patch('research_step_handler.update_job_status'), \
            patch('research_step_handler._discard_feedback_context'), \
            patch('research_step_handler.notify_project_job', return_value=True) as notify:
        yield notify


@pytest.mark.usefixtures('mock_tables', 'mock_job_status')
def test_a_saved_research_tells_its_starter(notified: MagicMock) -> None:
    event = {
        'project_id': 'p1', 'job_id': 'j1',
        'research_config': {'question': 'What?', 'title': 'Test', 'filters': {}},
        'feedback_count': 1, 'analysis': 'A', 'synthesis': 'S', 'validation': 'V',
    }
    assert rsh.step_save(event)['success'] is True
    notified.assert_called_once_with('p1', 'j1', 'completed')


def test_a_failed_research_tells_its_starter(notified: MagicMock) -> None:
    result = rsh.step_error({'project_id': 'p1', 'job_id': 'j1', 'error': {'Error': 'States.Timeout'}})
    assert result['success'] is False
    notified.assert_called_once_with('p1', 'j1', 'failed')


def test_a_lost_notice_still_answers(notified: MagicMock) -> None:
    notified.return_value = False
    assert rsh.step_error({'project_id': 'p1', 'job_id': 'j1', 'error': {}})['error'] == 'Unknown error'
