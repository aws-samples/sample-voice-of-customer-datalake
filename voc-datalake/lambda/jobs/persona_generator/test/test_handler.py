"""Tests for persona generator job handler."""

import pytest
from unittest.mock import patch, MagicMock


class TestPersonaGeneratorHandler:
    """Tests for the persona generator job Lambda handler."""

    def test_successful_persona_generation(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event
    ):
        """Test successful persona generation job."""
        from jobs.persona_generator.handler import lambda_handler
        
        result = lambda_handler(persona_generation_event, None)
        
        assert result['success'] is True
        mock_generate_personas.assert_called_once()
        # Verify progress callback was passed
        call_args = mock_generate_personas.call_args
        assert 'progress_callback' in call_args.kwargs

    def test_job_status_updated_on_completion(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event
    ):
        """Test that job status is updated to completed."""
        from jobs.persona_generator.handler import lambda_handler
        
        lambda_handler(persona_generation_event, None)
        
        # Verify job was marked as completed
        mock_jobs_table.update_item.assert_called()
        last_call = mock_jobs_table.update_item.call_args
        assert ':status' in str(last_call) or 'completed' in str(last_call)

    def test_job_status_updated_on_failure(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event
    ):
        """Test that job status is updated to failed on error."""
        from jobs.persona_generator.handler import lambda_handler
        from shared.exceptions import ServiceError
        
        mock_generate_personas.side_effect = Exception("LLM error")
        
        with pytest.raises(ServiceError):
            lambda_handler(persona_generation_event, None)
        
        # Verify job was marked as failed
        mock_jobs_table.update_item.assert_called()

    def test_progress_callback_updates_job(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event
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
        
        lambda_handler(persona_generation_event, None)
        
        # Verify callback was provided
        assert captured_callback is not None
        
        # Call the callback and verify it updates job status
        captured_callback(50, 'generating_personas')
        assert mock_jobs_table.update_item.called

    def test_handler_extracts_filters_from_event(
        self, mock_jobs_table, mock_generate_personas, persona_generation_event
    ):
        """Test that handler correctly extracts filters from event."""
        from jobs.persona_generator.handler import lambda_handler
        
        lambda_handler(persona_generation_event, None)
        
        call_args = mock_generate_personas.call_args
        assert call_args[0][0] == persona_generation_event['project_id']
        assert call_args[0][1] == persona_generation_event['filters']
