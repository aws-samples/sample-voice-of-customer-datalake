"""Tests for document generator job handler."""

import pytest
from unittest.mock import MagicMock, call

# Constants for max_tokens validation
PRD_MIN_TOKENS = 5000
PRFAQ_MIN_TOKENS = 8000


class TestDocumentGeneratorHandler:
    """Tests for the document generator job Lambda handler."""

    @pytest.fixture(autouse=True)
    def setup_empty_query_response(self, mock_dynamodb):
        """Set default empty query response for all tests."""
        mock_dynamodb['table'].query.return_value = {'Items': []}

    def test_successful_prd_generation(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Test successful PRD generation job."""
        from jobs.document_generator.handler import lambda_handler

        result = lambda_handler(prd_generation_event, lambda_context)

        assert result['success'] is True
        assert 'document_id' in result
        assert result['document_id'].startswith('prd_')
        mock_converse.assert_called_once()

    def test_successful_prfaq_generation(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prfaq_generation_event, lambda_context
    ):
        """Test successful PR-FAQ generation job."""
        from jobs.document_generator.handler import lambda_handler

        result = lambda_handler(prfaq_generation_event, lambda_context)

        assert result['success'] is True
        assert 'document_id' in result
        assert result['document_id'].startswith('prfaq_')
        call_kwargs = mock_converse.call_args.kwargs
        assert call_kwargs.get('max_tokens', 0) >= PRFAQ_MIN_TOKENS

    def test_prd_uses_correct_system_prompt(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Test that PRD generation uses appropriate system prompt."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        call_kwargs = mock_converse.call_args.kwargs
        system_prompt = call_kwargs.get('system_prompt', '')
        assert 'PRD' in system_prompt or 'Product Requirements' in system_prompt

    def test_prfaq_uses_correct_system_prompt(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prfaq_generation_event, lambda_context
    ):
        """Test that PR-FAQ generation uses appropriate system prompt."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prfaq_generation_event, lambda_context)

        call_kwargs = mock_converse.call_args.kwargs
        system_prompt = call_kwargs.get('system_prompt', '')
        assert 'PR-FAQ' in system_prompt or 'Working Backwards' in system_prompt

    def test_document_saved_to_dynamodb(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Test that generated document is saved to DynamoDB."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        mock_dynamodb['table'].put_item.assert_called()
        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert 'document_id' in item
        assert item.get('document_type') == 'prd'
        assert item.get('title') == 'Test PRD'
        assert 'content' in item
        assert 'created_at' in item

    def test_project_document_count_updated(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Test that project document_count is incremented after generation."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        # Find the update_item call for META
        update_calls = mock_dynamodb['table'].update_item.call_args_list
        meta_update = next(
            (c for c in update_calls if 'META' in str(c.kwargs.get('Key', {}))),
            None
        )
        assert meta_update is not None, "Project META should be updated"
        assert 'document_count' in meta_update.kwargs.get('UpdateExpression', '')

    def test_job_status_updated_on_failure(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Test that job status is updated to failed on error."""
        from jobs.document_generator.handler import lambda_handler
        from shared.exceptions import ServiceError

        mock_converse.side_effect = Exception("Bedrock error")

        with pytest.raises(ServiceError, match="Document generation failed"):
            lambda_handler(prd_generation_event, lambda_context)

        mock_jobs_table.update_item.assert_called()
        update_call = mock_jobs_table.update_item.call_args
        expr_values = update_call.kwargs.get('ExpressionAttributeValues', {})
        assert expr_values.get(':status') == 'failed'

    def test_progress_updates_during_generation(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Test that progress is updated at key stages."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        # Verify multiple progress updates occurred
        update_calls = mock_jobs_table.update_item.call_args_list
        assert len(update_calls) >= 2, "Should have multiple progress updates"

    def test_gathers_feedback_when_enabled(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Test that feedback is gathered when data_sources.feedback is True."""
        mock_feedback_table = MagicMock()
        mock_feedback_table.query.return_value = {
            'Items': [
                {
                    'original_text': 'Great app!',
                    'source_platform': 'app_store',
                    'sentiment_label': 'positive'
                },
            ]
        }

        def table_factory(name):
            if 'feedback' in name.lower():
                return mock_feedback_table
            return mock_dynamodb['table']

        mock_dynamodb['resource'].Table.side_effect = table_factory

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        # Verify feedback table was specifically queried
        assert mock_feedback_table.query.called, "Feedback table should be queried"

    def test_skips_feedback_when_disabled(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Test that feedback is not gathered when data_sources.feedback is False."""
        prd_generation_event['doc_config']['data_sources']['feedback'] = False
        mock_feedback_table = MagicMock()

        def table_factory(name):
            if 'feedback' in name.lower():
                return mock_feedback_table
            return mock_dynamodb['table']

        mock_dynamodb['resource'].Table.side_effect = table_factory

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        # Feedback table should not be queried
        assert not mock_feedback_table.query.called, "Feedback table should not be queried"

    def test_returns_title_in_result(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Test that result includes the document title."""
        from jobs.document_generator.handler import lambda_handler

        result = lambda_handler(prd_generation_event, lambda_context)

        assert result.get('title') == 'Test PRD'
