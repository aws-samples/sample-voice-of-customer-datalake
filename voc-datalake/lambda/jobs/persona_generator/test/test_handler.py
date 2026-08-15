"""Tests for persona generator job handler."""

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

        # A stale store from an earlier test would make this pass without the flush.
        metrics.clear_metrics()

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
        from shared.logging import metrics

        from jobs.persona_generator.handler import lambda_handler

        metrics.clear_metrics()
        lambda_handler(persona_generation_event, lambda_context)

        assert 'AvatarGenerationFailed' not in self._flushed_metric_names(
            capsys.readouterr().out
        )
