"""A failed job's ``error_code`` and a job's remaining time (7.104.00, shared/jobs.py).

An extract that timed out, was refused, was cut or answered unreadably fails its job with the reason as a word
(``error_code``) beside the English ``error``, so the page can offer what fits (a retry at ``xhigh`` after
``timed_out``). A job that keeps its own deadline reads the invocation's remaining time through its ``JobContext``.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from shared.exceptions import ApiError, ValidationError
from shared.jobs import JobContext, job_handler, update_job_status

EVENT = {'project_id': 'p1', 'job_id': 'j1'}


class _TimedOut(ApiError):
    status_code = 422


@pytest.fixture
def table():
    table = MagicMock()
    with patch('shared.jobs.get_jobs_table', return_value=table), \
            patch('shared.jobs.table_view', side_effect=lambda _ws, t: t):
        yield table


class TestTheRecord:
    def test_a_failure_with_a_code_stores_it_beside_the_error(self, table):
        update_job_status('p1', 'j1', 'failed', 0, 'error', error='Timed out', error_code='timed_out', workspace=None)

        kwargs = table.update_item.call_args.kwargs
        assert kwargs['UpdateExpression'].endswith(', error_code = :error_code')
        assert kwargs['ExpressionAttributeValues'][':error_code'] == 'timed_out'

    def test_a_failure_without_a_code_stores_none(self, table):
        update_job_status('p1', 'j1', 'failed', 0, 'error', error='Boom', workspace=None)

        kwargs = table.update_item.call_args.kwargs
        assert 'error_code' not in kwargs['UpdateExpression']
        assert ':error_code' not in kwargs['ExpressionAttributeValues']

    def test_a_progress_update_never_names_a_code(self, table):
        update_job_status('p1', 'j1', 'running', 40, 'thinking', error_code='timed_out', workspace=None)

        assert 'error_code' not in table.update_item.call_args.kwargs['UpdateExpression']


def _failing_job(raised: Exception) -> tuple[dict, MagicMock]:
    """A job whose body raises ``raised``, run through ``job_handler``: its answer and the status write's double."""
    def body(_ctx, _project_id, _job_id):
        raise raised
    body.__name__ = 'extract'

    with patch('shared.jobs.update_job_status') as update, patch('shared.jobs.notify_project_job'), \
            patch('shared.jobs.logger'):
        return job_handler(error_message='Extract failed')(body)(EVENT), update


class TestTheHandler:
    def test_a_4xx_with_a_code_fails_the_job_with_it_and_returns_it(self):
        result, update = _failing_job(_TimedOut('The extract took too long', code='timed_out'))

        assert result == {'success': False, 'error': 'Extract failed: The extract took too long',
                          'error_code': 'timed_out'}
        update.assert_called_once_with('p1', 'j1', 'failed', 0, 'error',
                                       error='Extract failed: The extract took too long', workspace=None,
                                       error_code='timed_out')

    def test_a_4xx_without_a_code_records_none(self):
        result, update = _failing_job(ValidationError('Nothing to read'))

        assert result == {'success': False, 'error': 'Extract failed: Nothing to read'}
        assert update.call_args.kwargs['error_code'] is None

    def test_the_context_carries_the_invocations_remaining_time(self):
        seen: list[int | None] = []

        def body(ctx, _project_id, _job_id):
            seen.append(ctx.remaining_ms())
            return {}
        lambda_context = MagicMock()
        lambda_context.get_remaining_time_in_millis.return_value = 812_000

        with patch('shared.jobs.claim_job_execution', return_value=True), patch('shared.jobs.update_job_status'), \
                patch('shared.jobs.notify_project_job'), patch('shared.jobs.logger'):
            job_handler()(body)(EVENT, lambda_context)

        assert seen == [812_000]


def test_a_context_without_a_lambda_context_has_no_remaining_time():
    assert JobContext('p1', 'j1', workspace=None).remaining_ms() is None
