"""Tests for document generator job handler (multi-step chain)."""

import pytest
from unittest.mock import MagicMock


class TestDocumentGeneratorHandler:
    """Tests for the document generator job Lambda handler."""

    @pytest.fixture(autouse=True)
    def setup_empty_query_response(self, mock_dynamodb):
        """Set default empty query response for all tests."""
        mock_dynamodb['table'].query.return_value = {'Items': []}

    def test_successful_prd_generation(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Test successful PRD generation using multi-step chain."""
        from jobs.document_generator.handler import lambda_handler

        result = lambda_handler(prd_generation_event, lambda_context)

        assert result['success'] is True
        assert 'document_id' in result
        assert result['document_id'].startswith('prd_')
        mock_converse_chain.assert_called_once()

    def test_successful_prfaq_generation(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prfaq_generation_event, lambda_context
    ):
        """Test successful PR-FAQ generation using multi-step chain."""
        mock_converse_chain.return_value = [
            "Customer insights", "Press release content",
            "Customer FAQ content", "Internal FAQ content",
        ]

        from jobs.document_generator.handler import lambda_handler

        result = lambda_handler(prfaq_generation_event, lambda_context)

        assert result['success'] is True
        assert result['document_id'].startswith('prfaq_')
        mock_converse_chain.assert_called_once()

    def test_prd_uses_multi_step_chain_from_prompt_template(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """PRD generation should use get_prd_generation_steps to build the chain."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        mock_prompt_steps['prd'].assert_called_once()
        call_kwargs = mock_prompt_steps['prd'].call_args.kwargs
        assert call_kwargs['feature_idea'] == 'Improve user onboarding flow'

    def test_prfaq_uses_multi_step_chain_from_prompt_template(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prfaq_generation_event, lambda_context
    ):
        """PR-FAQ generation should use get_prfaq_generation_steps to build the chain."""
        mock_converse_chain.return_value = [
            "Insights", "Press release", "Customer FAQ", "Internal FAQ",
        ]

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prfaq_generation_event, lambda_context)

        mock_prompt_steps['prfaq'].assert_called_once()
        call_kwargs = mock_prompt_steps['prfaq'].call_args.kwargs
        assert call_kwargs['feature_idea'] == 'New mobile app feature'

    def test_prd_stores_analysis_sections(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """PRD should store problem/solution analysis from intermediate chain steps."""
        mock_converse_chain.return_value = [
            "Deep problem analysis", "Solution design", "Final PRD document",
        ]

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert item['analysis']['problem'] == 'Deep problem analysis'
        assert item['analysis']['solution'] == 'Solution design'
        assert item['content'] == 'Final PRD document'

    def test_prfaq_composes_full_document_from_chain_results(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prfaq_generation_event, lambda_context
    ):
        """PR-FAQ should compose press release + FAQ sections into a single document."""
        mock_converse_chain.return_value = [
            "Customer insights", "The press release text",
            "Customer FAQ section", "Internal FAQ section",
        ]

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prfaq_generation_event, lambda_context)

        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        content = item['content']
        assert 'The press release text' in content
        assert 'Customer FAQ section' in content
        assert 'Internal FAQ section' in content
        # Sections should be stored separately too
        assert item['analysis']['press_release'] == 'The press release text'
        assert item['analysis']['customer_faq'] == 'Customer FAQ section'

    def test_document_saved_to_dynamodb(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
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
        assert item.get('feature_idea') == 'Improve user onboarding flow'

    def test_project_document_count_updated(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Test that project document_count is incremented after generation."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        update_calls = mock_dynamodb['table'].update_item.call_args_list
        meta_update = next(
            (c for c in update_calls if 'META' in str(c.kwargs.get('Key', {}))),
            None
        )
        assert meta_update is not None, "Project META should be updated"
        assert 'document_count' in meta_update.kwargs.get('UpdateExpression', '')

    def test_job_status_updated_on_failure(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Test that job status is updated to failed on error."""
        from jobs.document_generator.handler import lambda_handler
        from shared.exceptions import ServiceError

        mock_converse_chain.side_effect = Exception("Bedrock error")

        with pytest.raises(ServiceError, match="Document generation failed"):
            lambda_handler(prd_generation_event, lambda_context)

        mock_jobs_table.update_item.assert_called()
        update_call = mock_jobs_table.update_item.call_args
        expr_values = update_call.kwargs.get('ExpressionAttributeValues', {})
        assert expr_values.get(':status') == 'failed'

    def test_progress_updates_during_generation(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Test that progress is updated at key stages."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        update_calls = mock_jobs_table.update_item.call_args_list
        assert len(update_calls) >= 2, "Should have multiple progress updates"

    def test_gathers_feedback_when_enabled(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
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

        assert mock_feedback_table.query.called, "Feedback table should be queried"

    def test_skips_feedback_when_disabled(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
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

        assert not mock_feedback_table.query.called, "Feedback table should not be queried"

    def test_returns_title_in_result(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Test that result includes the document title."""
        from jobs.document_generator.handler import lambda_handler

        result = lambda_handler(prd_generation_event, lambda_context)

        assert result.get('title') == 'Test PRD'

    def test_passes_response_language_to_chain_steps(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """Regression: response_language must be forwarded for CJK language support."""
        prd_generation_event['doc_config']['response_language'] = 'ko'

        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        call_kwargs = mock_prompt_steps['prd'].call_args.kwargs
        assert call_kwargs['response_language'] == 'ko'

    def test_chain_steps_passed_to_converse_chain(
        self, mock_dynamodb, mock_jobs_table, mock_converse_chain, mock_prompt_steps,
        prd_generation_event, lambda_context
    ):
        """The steps from get_prd_generation_steps should be passed directly to converse_chain."""
        from jobs.document_generator.handler import lambda_handler

        lambda_handler(prd_generation_event, lambda_context)

        chain_call_args = mock_converse_chain.call_args
        steps = chain_call_args[0][0]  # First positional arg
        assert len(steps) == 3  # problem_analysis, solution_design, prd_document
        assert steps[0]['step_name'] == 'problem_analysis'
