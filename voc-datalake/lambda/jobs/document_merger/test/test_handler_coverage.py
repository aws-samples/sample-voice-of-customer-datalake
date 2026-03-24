"""
Additional coverage tests for document_merger/handler.py.
Covers: use_feedback=True path (lines 80-107), feedback filtering (line 115).
"""
import pytest
from unittest.mock import MagicMock


class TestDocumentMergerFeedbackPath:
    """Cover the use_feedback=True branch (lines 80-107, 115)."""

    def test_includes_feedback_when_use_feedback_enabled(
        self, mock_dynamodb, mock_jobs_table, mock_converse, merge_documents_event
    ):
        """Cover the use_feedback=True path with feedback items."""
        mock_projects_table = MagicMock()
        mock_feedback_table = MagicMock()

        project_items = [
            {'sk': 'PRD#doc_1', 'document_id': 'doc_1', 'document_type': 'prd', 'title': 'PRD 1', 'content': 'Content 1'},
            {'sk': 'RESEARCH#doc_2', 'document_id': 'doc_2', 'document_type': 'research', 'title': 'Research', 'content': 'Content 2'},
        ]
        mock_projects_table.query.return_value = {'Items': project_items}
        mock_projects_table.put_item.return_value = {}
        mock_projects_table.update_item.return_value = {}

        mock_feedback_table.query.return_value = {
            'Items': [
                {'original_text': 'Great app!', 'source_platform': 'app_store', 'sentiment_label': 'positive'},
                {'original_text': 'Needs work', 'source_platform': 'webscraper', 'sentiment_label': 'negative'},
            ]
        }

        def table_factory(name):
            if 'feedback' in name.lower():
                return mock_feedback_table
            return mock_projects_table

        mock_dynamodb['resource'].Table.side_effect = table_factory

        merge_documents_event['merge_config']['use_feedback'] = True
        merge_documents_event['merge_config']['feedback_sources'] = ['app_store']
        merge_documents_event['merge_config']['feedback_categories'] = []
        merge_documents_event['merge_config']['days'] = 7

        from jobs.document_merger.handler import lambda_handler
        result = lambda_handler(merge_documents_event, None)

        assert result['success'] is True
        assert mock_feedback_table.query.called
        # Verify feedback was included in prompt
        call_kwargs = mock_converse.call_args.kwargs
        prompt = call_kwargs.get('prompt', '')
        assert 'Great app!' in prompt

    def test_filters_feedback_by_category(
        self, mock_dynamodb, mock_jobs_table, mock_converse, merge_documents_event
    ):
        """Cover feedback_categories filtering branch (line 115)."""
        mock_projects_table = MagicMock()
        mock_feedback_table = MagicMock()

        project_items = [
            {'sk': 'PRD#doc_1', 'document_id': 'doc_1', 'document_type': 'prd', 'title': 'PRD 1', 'content': 'C1'},
            {'sk': 'PRD#doc_2', 'document_id': 'doc_2', 'document_type': 'prd', 'title': 'PRD 2', 'content': 'C2'},
        ]
        mock_projects_table.query.return_value = {'Items': project_items}
        mock_projects_table.put_item.return_value = {}
        mock_projects_table.update_item.return_value = {}

        mock_feedback_table.query.return_value = {
            'Items': [
                {'original_text': 'Billing issue', 'source_platform': 'ws', 'sentiment_label': 'negative', 'category': 'billing'},
                {'original_text': 'Good delivery', 'source_platform': 'ws', 'sentiment_label': 'positive', 'category': 'delivery'},
            ]
        }

        def table_factory(name):
            if 'feedback' in name.lower():
                return mock_feedback_table
            return mock_projects_table

        mock_dynamodb['resource'].Table.side_effect = table_factory

        merge_documents_event['merge_config']['use_feedback'] = True
        merge_documents_event['merge_config']['feedback_categories'] = ['billing']
        merge_documents_event['merge_config']['days'] = 7

        from jobs.document_merger.handler import lambda_handler
        result = lambda_handler(merge_documents_event, None)

        assert result['success'] is True
        # Only billing feedback should be in prompt
        call_kwargs = mock_converse.call_args.kwargs
        prompt = call_kwargs.get('prompt', '')
        assert 'Billing issue' in prompt

    def test_use_feedback_with_no_feedback_items(
        self, mock_dynamodb, mock_jobs_table, mock_converse, merge_documents_event
    ):
        """Cover use_feedback=True when no feedback items are returned."""
        mock_projects_table = MagicMock()
        mock_feedback_table = MagicMock()

        project_items = [
            {'sk': 'PRD#doc_1', 'document_id': 'doc_1', 'document_type': 'prd', 'title': 'PRD 1', 'content': 'C1'},
            {'sk': 'PRD#doc_2', 'document_id': 'doc_2', 'document_type': 'prd', 'title': 'PRD 2', 'content': 'C2'},
        ]
        mock_projects_table.query.return_value = {'Items': project_items}
        mock_projects_table.put_item.return_value = {}
        mock_projects_table.update_item.return_value = {}

        mock_feedback_table.query.return_value = {'Items': []}

        def table_factory(name):
            if 'feedback' in name.lower():
                return mock_feedback_table
            return mock_projects_table

        mock_dynamodb['resource'].Table.side_effect = table_factory

        merge_documents_event['merge_config']['use_feedback'] = True
        merge_documents_event['merge_config']['days'] = 7

        from jobs.document_merger.handler import lambda_handler
        result = lambda_handler(merge_documents_event, None)

        assert result['success'] is True

    def test_prfaq_output_type_uses_correct_prompt(
        self, mock_dynamodb, mock_jobs_table, mock_converse, merge_documents_event, mock_project_documents
    ):
        """Cover the prfaq output_type branch for system prompt."""
        mock_dynamodb['table'].query.return_value = {'Items': mock_project_documents}
        merge_documents_event['merge_config']['output_type'] = 'prfaq'

        from jobs.document_merger.handler import lambda_handler
        result = lambda_handler(merge_documents_event, None)

        assert result['success'] is True
        call_kwargs = mock_converse.call_args.kwargs
        assert 'PR-FAQ' in call_kwargs.get('system_prompt', '')
        assert call_kwargs.get('max_tokens') == 8000
