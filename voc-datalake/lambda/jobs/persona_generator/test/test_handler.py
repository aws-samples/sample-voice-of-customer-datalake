"""Tests for persona generator job handler."""

from unittest.mock import MagicMock, patch

import pytest


class TestPersonaGeneratorHandler:
    """Tests for the persona generator job Lambda handler."""

    def test_successful_persona_generation(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event, lambda_context
    ):
        """Test successful persona generation job."""
        from jobs.persona_generator.handler import lambda_handler
        
        result = lambda_handler(persona_generation_event, lambda_context)
        
        assert result['success'] is True
        mock_generate_personas.assert_called_once()
        # Verify progress callback was passed
        call_args = mock_generate_personas.call_args
        assert 'progress_callback' in call_args.kwargs

    def test_job_status_updated_on_completion(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event, lambda_context
    ):
        """Test that job status is updated to completed."""
        from jobs.persona_generator.handler import lambda_handler
        
        lambda_handler(persona_generation_event, lambda_context)
        
        # Verify job was marked as completed
        mock_jobs_table.update_item.assert_called()
        last_call = mock_jobs_table.update_item.call_args
        assert ':status' in str(last_call) or 'completed' in str(last_call)

    def test_job_status_updated_on_failure(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event, lambda_context
    ):
        """Test that job status is updated to failed on error."""
        from jobs.persona_generator.handler import lambda_handler
        from shared.exceptions import ServiceError
        
        mock_generate_personas.side_effect = Exception("LLM error")
        
        with pytest.raises(ServiceError):
            lambda_handler(persona_generation_event, lambda_context)
        
        # Verify job was marked as failed
        mock_jobs_table.update_item.assert_called()

    def test_progress_callback_updates_job(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event, lambda_context
    ):
        """Test that progress callback updates job status."""
        from jobs.persona_generator.handler import lambda_handler
        
        # Capture the progress callback
        captured_callback = None
        def capture_callback(*args, **kwargs):
            nonlocal captured_callback
            captured_callback = kwargs.get('progress_callback')
            return {'success': True, 'personas': []}
        
        mock_generate_personas.side_effect = capture_callback
        
        lambda_handler(persona_generation_event, lambda_context)
        
        # Verify callback was provided
        assert captured_callback is not None
        
        # Call the callback and verify it updates job status
        captured_callback(50, 'generating_personas')
        assert mock_jobs_table.update_item.called

    def test_handler_extracts_filters_from_event(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event, lambda_context
    ):
        """Test that handler correctly extracts filters from event."""
        from jobs.persona_generator.handler import lambda_handler
        
        lambda_handler(persona_generation_event, lambda_context)
        
        call_args = mock_generate_personas.call_args
        assert call_args[0][0] == persona_generation_event['project_id']
        assert call_args[0][1] == persona_generation_event['filters']



class TestDateBasisPassThrough:
    """The filters dict travels intact into generate_personas (issue #150).

    The consumption chain is: projects_handler validates date_basis into the
    filters dict → this job forwards filters verbatim → projects.py's
    get_feedback_context unpacks it → shared/feedback.py applies the review
    post-filter. This test pins the job-Lambda link of that chain, so a
    future rebuild of the filters dict here can't silently drop the field.
    """

    def test_filters_including_date_basis_reach_generate_personas(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event, lambda_context
    ):
        from jobs.persona_generator.handler import lambda_handler

        persona_generation_event['filters']['date_basis'] = 'review'
        lambda_handler(persona_generation_event, lambda_context)

        forwarded = mock_generate_personas.call_args.args[1]
        assert forwarded['date_basis'] == 'review'
        # The whole dict is forwarded verbatim, not rebuilt field-by-field.
        assert forwarded == persona_generation_event['filters']


class TestAvatarMetricsActuallyReachCloudWatch:
    """generate_personas counts avatar outcomes with metrics.add_metric, which writes to
    an in-memory store — the counters only become CloudWatch metrics when something
    flushes that store. Here that is @metrics.log_metrics on this handler's
    lambda_handler, and this handler is generate_personas' only production caller.

    Without this test, removing the decorator leaves every existing test green while the
    observability fix silently emits nothing: exactly the "reads as healthy during a real
    outage" failure the metric was added to prevent, one level up.

    Asserted through the real EMF output rather than by checking the decorator is present,
    so it holds however the flush is wired.
    """

    @pytest.fixture(autouse=True)
    def _empty_metrics_store(self):
        """Clear the shared store on both sides.

        Before, because a metric left by an earlier test would make the flush assertion
        pass without anything flushing here. After, because these tests deliberately add
        to a process-wide singleton, and leaving it dirty makes some later test's result
        depend on ordering.
        """
        from shared.logging import metrics

        metrics.clear_metrics()
        yield
        metrics.clear_metrics()

    @staticmethod
    def _flushed_metric_names(captured_stdout: str) -> set[str]:
        """Metric names in the EMF documents the handler printed."""
        import json

        names = set()
        for line in captured_stdout.splitlines():
            if not line.startswith('{'):
                continue
            try:
                doc = json.loads(line)
            except json.JSONDecodeError:
                continue
            for family in doc.get('_aws', {}).get('CloudWatchMetrics', []):
                names.update(m['Name'] for m in family.get('Metrics', []))
        return names

    def test_a_metric_added_during_the_job_is_flushed_as_emf(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event,
        lambda_context, capsys,
    ):
        from shared.logging import metrics

        from jobs.persona_generator.handler import lambda_handler

        def count_an_avatar_failure_like_generate_personas_does(*args, **kwargs):
            metrics.add_metric(name='AvatarGenerationFailed', unit='Count', value=1)
            return {'success': True, 'personas': [], 'metadata': {}}

        mock_generate_personas.side_effect = count_an_avatar_failure_like_generate_personas_does

        lambda_handler(persona_generation_event, lambda_context)

        names = self._flushed_metric_names(capsys.readouterr().out)
        assert 'AvatarGenerationFailed' in names, (
            'the avatar counter never reached the EMF output — nothing flushed the '
            f'metrics store on this handler (saw: {sorted(names)})'
        )

    def test_the_control_that_the_name_is_not_something_always_printed(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event,
        lambda_context, capsys,
    ):
        """With no avatar metric added, the name must be absent. Without this control the
        assertion above could pass on anything the handler always emits — it also flushes
        a ColdStart metric — rather than on the counter under test.
        """
        from jobs.persona_generator.handler import lambda_handler

        lambda_handler(persona_generation_event, lambda_context)

        assert 'AvatarGenerationFailed' not in self._flushed_metric_names(
            capsys.readouterr().out
        )


class TestGroundingMetadataReachesTheStoredJob:
    """The truncation notice is only real if the metadata survives persistence.

    ``generate_personas`` returns ``metadata.context_truncated`` /
    ``feedback_items_used``; ``JobsSection.tsx`` renders from
    ``job.result.metadata``. Between the two sits ``@job_handler``, which decides
    whether the returned dict is stored whole or field-picked — and the frontend
    tests construct ``result: { metadata }`` by hand, so they pass whether or not
    the backend ever puts it there. Without this test, the handler dropping the
    block would turn the notice into dead code with a green suite.

    Asserted on the DynamoDB write with the real ``generate_personas`` running
    (only its I/O stubbed), so the whole path is covered at once.
    """

    @staticmethod
    def _feedback_item(idx: int, text_len: int = 600) -> dict:
        prefix = f"Review {idx}: "
        return {
            'feedback_id': f'fb-{idx}',
            'source_platform': 'test_source',
            'original_text': prefix + ('x' * (text_len - len(prefix))),
            'sentiment_label': 'positive',
            'sentiment_score': 0.9,
            'category': 'product_quality',
            'urgency': 'low',
            'rating': 5,
            'source_created_at': '2025-01-01T00:00:00',
            'date': '2025-01-01',
        }

    @staticmethod
    def _stored_result(mock_jobs_table) -> dict:
        """The ``result`` dict written to DynamoDB by the completing update."""
        for call in mock_jobs_table.update_item.call_args_list:
            values = call.kwargs.get('ExpressionAttributeValues', {})
            if ':result' in values:
                return values[':result']
        raise AssertionError(
            'no update_item call carried a :result — the job never stored one'
        )

    def _run_real_generation(self, corpus, persona_generation_event, lambda_context):
        import json as _json

        from jobs.persona_generator.handler import lambda_handler

        persona_json = _json.dumps([{
            'name': 'TestUser', 'tagline': 'a tester', 'confidence': 'high',
            'feedback_count': len(corpus), 'identity': {}, 'goals_motivations': {},
            'pain_points': {}, 'behaviors': {}, 'context_environment': {},
            'quotes': [], 'scenario': {}, 'supporting_evidence': [],
        }])

        projects_table = MagicMock()
        projects_table.query.return_value = {'Items': []}
        batch_writer = MagicMock()
        batch_writer.__enter__ = MagicMock(return_value=MagicMock())
        batch_writer.__exit__ = MagicMock(return_value=False)
        projects_table.batch_writer.return_value = batch_writer

        with patch('api.projects.projects_table', projects_table), \
             patch('api.projects.get_feedback_context', return_value=corpus), \
             patch('api.projects.converse_chain',
                   return_value=['Research analysis text.', persona_json]), \
             patch('api.projects.generate_persona_avatar',
                   return_value={'avatar_url': None, 'avatar_prompt': None}):
            return lambda_handler(persona_generation_event, lambda_context)

    def test_the_handler_binding_is_not_a_leaked_mock(self):
        """Guard the fixture-ordering trap described in this package's conftest.

        Without it, a recurrence surfaces as "context_truncated did not survive
        into the stored job record" — which reads as a backend regression when
        the cause is that ``generate_personas`` is still stubbed from an earlier
        test. Named here so the diagnosis is the failure message.
        """
        from jobs.persona_generator import handler

        assert not isinstance(handler.generate_personas, MagicMock), (
            'generate_personas is still a mock — a fixture restored a patched '
            'value as the original (see conftest.mock_generate_personas)'
        )

    def test_the_stored_result_carries_the_grounding_metadata(
        self, mock_jobs_table, persona_generation_event, lambda_context,
    ):
        corpus = [self._feedback_item(i) for i in range(10)]
        self._run_real_generation(corpus, persona_generation_event, lambda_context)

        stored = self._stored_result(mock_jobs_table)
        assert 'metadata' in stored, (
            'the job record stored no metadata block — JobsSection.tsx reads '
            'job.result.metadata, so the truncation notice can never render'
        )
        metadata = stored['metadata']
        for field in ('context_truncated', 'feedback_items_used', 'feedback_count',
                      'fetch_limit_reached'):
            assert field in metadata, (
                f'{field} did not survive into the stored job record'
            )
        assert metadata['feedback_items_used'] == len(corpus)
        assert metadata['context_truncated'] is False

    def test_a_truncated_generation_stores_the_flag_and_the_smaller_count(
        self, mock_jobs_table, persona_generation_event, lambda_context,
    ):
        """The values the notice depends on must be the truncated ones.

        Presence alone would pass on a hardcoded ``False``; this drives the
        branch the notice exists for, so the stored numbers have to disagree with
        each other in the way the UI reports.
        """
        from api import projects
        from shared.feedback import format_feedback_for_llm

        budget = projects.persona_context_budget()[0]
        per_item = len(format_feedback_for_llm([self._feedback_item(0)]))
        corpus = [self._feedback_item(i) for i in range(budget // per_item + 10)]
        assert len(format_feedback_for_llm(corpus)) > budget, (
            'fixture must exceed the char budget for truncation to happen'
        )

        self._run_real_generation(corpus, persona_generation_event, lambda_context)

        metadata = self._stored_result(mock_jobs_table)['metadata']
        assert metadata['context_truncated'] is True
        assert metadata['feedback_items_used'] < metadata['feedback_count'] == len(corpus)
        assert metadata['feedback_items_used'] > 0
