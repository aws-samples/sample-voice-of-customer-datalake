"""Mutation-hardening tests for the persona generator job handler.

The mutation run found two literals no earlier test pinned: the
``error_message`` handed to ``@job_handler`` (it is the prefix of the failed
job's ``error`` field, which the Background Jobs panel shows, and the message
of the ServiceError that reaches the DLQ) and the entry log line. The earlier
tests only checked that *some* failure was recorded, and nothing read the log.
These tests assert the exact strings, plus the exact progress write the
callback makes.
"""

from unittest.mock import MagicMock, patch

import pytest

from shared.exceptions import ServiceError, ValidationError


def _error_writes(jobs_table: MagicMock) -> list[str]:
    """Every ``:error`` value the job wrote to DynamoDB, in order."""
    return [
        call.kwargs['ExpressionAttributeValues'][':error']
        for call in jobs_table.update_item.call_args_list
        if ':error' in call.kwargs['ExpressionAttributeValues']
    ]


class TestEveryFailureNamesPersonaGeneration:
    def test_an_unexpected_fault_raises_and_stores_the_persona_prefix(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event, lambda_context,
    ):
        from jobs.persona_generator.handler import lambda_handler

        mock_generate_personas.side_effect = RuntimeError('LLM error')

        with pytest.raises(ServiceError) as raised:
            lambda_handler(persona_generation_event, lambda_context)

        assert raised.value.message == 'Persona generation failed'
        assert _error_writes(mock_jobs_table) == ['Persona generation failed: LLM error']

    def test_a_client_error_returns_the_persona_prefixed_reason(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event, lambda_context,
    ):
        from jobs.persona_generator.handler import lambda_handler

        mock_generate_personas.side_effect = ValidationError('no feedback matched')

        result = lambda_handler(persona_generation_event, lambda_context)

        assert result == {'success': False, 'error': 'Persona generation failed: no feedback matched'}
        assert _error_writes(mock_jobs_table) == ['Persona generation failed: no feedback matched']


class TestEntryLogLine:
    @pytest.mark.usefixtures('mock_jobs_table', 'mock_generate_personas')
    def test_the_invocation_logs_the_event_keys_in_order(
        self, persona_generation_event, lambda_context,
    ):
        from jobs.persona_generator.handler import lambda_handler

        with patch('jobs.persona_generator.handler.logger') as handler_logger:
            lambda_handler(persona_generation_event, lambda_context)

        handler_logger.info.assert_called_once_with(
            "Persona generator invoked with event keys: ['project_id', 'job_id', 'filters']"
        )


class TestSuccessfulRun:
    @pytest.mark.usefixtures('mock_jobs_table')
    def test_returns_success_merged_with_the_generation_result(
        self, mock_generate_personas, persona_generation_event, lambda_context,
    ):
        from jobs.persona_generator.handler import lambda_handler

        mock_generate_personas.return_value = {'personas': [{'persona_id': 'persona_1'}]}

        result = lambda_handler(persona_generation_event, lambda_context)

        assert result == {'success': True, 'personas': [{'persona_id': 'persona_1'}]}

    @pytest.mark.usefixtures('mock_generate_personas')
    def test_the_last_write_marks_the_job_completed_at_100(
        self, mock_jobs_table, persona_generation_event, lambda_context,
    ):
        from jobs.persona_generator.handler import lambda_handler

        lambda_handler(persona_generation_event, lambda_context)

        values = mock_jobs_table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert (values[':status'], values[':progress'], values[':step']) == ('completed', 100, 'complete')


class TestProgressCallbackWritesTheJob:
    def test_the_callback_writes_running_with_the_given_progress_and_step(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event, lambda_context,
    ):
        from jobs.persona_generator.handler import lambda_handler

        def report_progress(_project_id, _filters, *, progress_callback):
            mock_jobs_table.update_item.reset_mock()
            progress_callback(42, 'generating_personas')
            return {'personas': []}

        mock_generate_personas.side_effect = report_progress

        lambda_handler(persona_generation_event, lambda_context)

        first = mock_jobs_table.update_item.call_args_list[0].kwargs
        assert first['Key'] == {'pk': 'PROJECT#proj_20250101120000', 'sk': 'JOB#job_abc123def456'}
        values = first['ExpressionAttributeValues']
        assert (values[':status'], values[':progress'], values[':step']) == (
            'running', 42, 'generating_personas',
        )
