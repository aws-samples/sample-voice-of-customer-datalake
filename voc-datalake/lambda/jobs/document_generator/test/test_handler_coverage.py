"""
Additional coverage tests for document_generator/handler.py.
Covers: feedback gathering with filtering (lines 71-96), personas gathering (lines 100-110),
documents/research gathering (lines 91, 93-96).
"""
from unittest.mock import MagicMock


class TestDocumentGeneratorFeedbackGathering:
    """Cover feedback gathering with source/category filtering (lines 71-96)."""

    def test_filters_feedback_by_source(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Cover feedback_sources filtering branch."""
        mock_projects_table = MagicMock()
        mock_feedback_table = MagicMock()

        mock_projects_table.query.return_value = {'Items': []}
        mock_projects_table.put_item.return_value = {}
        mock_projects_table.update_item.return_value = {}

        mock_feedback_table.query.return_value = {
            'Items': [
                {'original_text': 'App review', 'source_platform': 'app_store', 'sentiment_label': 'positive'},
                {'original_text': 'Web review', 'source_platform': 'webscraper', 'sentiment_label': 'negative'},
            ]
        }

        def table_factory(name):
            if 'feedback' in name.lower():
                return mock_feedback_table
            return mock_projects_table

        mock_dynamodb['resource'].Table.side_effect = table_factory

        prd_generation_event['doc_config']['feedback_sources'] = ['app_store']
        prd_generation_event['doc_config']['feedback_categories'] = []

        from jobs.document_generator.handler import lambda_handler
        result = lambda_handler(prd_generation_event, lambda_context)

        assert result['success'] is True
        call_kwargs = mock_converse.call_args.kwargs
        prompt = call_kwargs.get('prompt', '')
        assert 'App review' in prompt

    def test_filters_feedback_by_category(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Cover feedback_categories filtering branch."""
        mock_projects_table = MagicMock()
        mock_feedback_table = MagicMock()

        mock_projects_table.query.return_value = {'Items': []}
        mock_projects_table.put_item.return_value = {}
        mock_projects_table.update_item.return_value = {}

        mock_feedback_table.query.return_value = {
            'Items': [
                {'original_text': 'Billing issue', 'source_platform': 'ws', 'sentiment_label': 'negative', 'category': 'billing', 'date': '2026-03-28'},
                {'original_text': 'Good delivery', 'source_platform': 'ws', 'sentiment_label': 'positive', 'category': 'delivery', 'date': '2026-03-28'},
            ]
        }

        def table_factory(name):
            if 'feedback' in name.lower():
                return mock_feedback_table
            return mock_projects_table

        mock_dynamodb['resource'].Table.side_effect = table_factory

        prd_generation_event['doc_config']['feedback_categories'] = ['billing']

        from jobs.document_generator.handler import lambda_handler
        result = lambda_handler(prd_generation_event, lambda_context)

        assert result['success'] is True
        call_kwargs = mock_converse.call_args.kwargs
        prompt = call_kwargs.get('prompt', '')
        assert 'Billing issue' in prompt


class TestDocumentGeneratorPersonasGathering:
    """Cover personas gathering with selected_persona_ids (lines 100-110)."""

    def test_gathers_selected_personas(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Cover the personas gathering branch with selected IDs."""
        mock_projects_table = MagicMock()
        mock_feedback_table = MagicMock()

        mock_projects_table.query.return_value = {
            'Items': [
                {'sk': 'PERSONA#p1', 'persona_id': 'p1', 'name': 'Power User', 'tagline': 'Uses daily', 'goals': ['Speed'], 'frustrations': ['Bugs']},
                {'sk': 'PERSONA#p2', 'persona_id': 'p2', 'name': 'Casual User', 'tagline': 'Occasional', 'goals': ['Simple'], 'frustrations': ['Complex']},
            ]
        }
        mock_projects_table.put_item.return_value = {}
        mock_projects_table.update_item.return_value = {}
        mock_feedback_table.query.return_value = {'Items': []}

        def table_factory(name):
            if 'feedback' in name.lower():
                return mock_feedback_table
            return mock_projects_table

        mock_dynamodb['resource'].Table.side_effect = table_factory

        prd_generation_event['doc_config']['data_sources']['personas'] = True
        prd_generation_event['doc_config']['selected_persona_ids'] = ['p1']

        from jobs.document_generator.handler import lambda_handler
        result = lambda_handler(prd_generation_event, lambda_context)

        assert result['success'] is True
        call_kwargs = mock_converse.call_args.kwargs
        prompt = call_kwargs.get('prompt', '')
        assert 'Power User' in prompt


class TestDocumentGeneratorDocumentsGathering:
    """Cover documents/research gathering (lines 91, 93-96, 100-110)."""

    def test_gathers_reference_documents(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Cover the documents gathering branch."""
        mock_projects_table = MagicMock()
        mock_feedback_table = MagicMock()

        mock_projects_table.query.return_value = {
            'Items': [
                {'sk': 'RESEARCH#r1', 'document_id': 'r1', 'title': 'Research Report', 'content': 'Research findings...'},
                {'sk': 'PRD#d1', 'document_id': 'd1', 'title': 'Existing PRD', 'content': 'PRD content...'},
            ]
        }
        mock_projects_table.put_item.return_value = {}
        mock_projects_table.update_item.return_value = {}
        mock_feedback_table.query.return_value = {'Items': []}

        def table_factory(name):
            if 'feedback' in name.lower():
                return mock_feedback_table
            return mock_projects_table

        mock_dynamodb['resource'].Table.side_effect = table_factory

        prd_generation_event['doc_config']['data_sources']['feedback'] = False
        prd_generation_event['doc_config']['data_sources']['personas'] = False
        prd_generation_event['doc_config']['data_sources']['documents'] = True
        prd_generation_event['doc_config']['selected_document_ids'] = ['r1']

        from jobs.document_generator.handler import lambda_handler
        result = lambda_handler(prd_generation_event, lambda_context)

        assert result['success'] is True
        call_kwargs = mock_converse.call_args.kwargs
        prompt = call_kwargs.get('prompt', '')
        assert 'Research Report' in prompt

    def test_gathers_research_documents(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Cover the research data_source branch."""
        mock_projects_table = MagicMock()
        mock_feedback_table = MagicMock()

        mock_projects_table.query.return_value = {
            'Items': [
                {'sk': 'RESEARCH#r1', 'document_id': 'r1', 'title': 'Analysis', 'content': 'Analysis content'},
            ]
        }
        mock_projects_table.put_item.return_value = {}
        mock_projects_table.update_item.return_value = {}
        mock_feedback_table.query.return_value = {'Items': []}

        def table_factory(name):
            if 'feedback' in name.lower():
                return mock_feedback_table
            return mock_projects_table

        mock_dynamodb['resource'].Table.side_effect = table_factory

        prd_generation_event['doc_config']['data_sources'] = {'research': True}

        from jobs.document_generator.handler import lambda_handler
        result = lambda_handler(prd_generation_event, lambda_context)

        assert result['success'] is True
        call_kwargs = mock_converse.call_args.kwargs
        prompt = call_kwargs.get('prompt', '')
        assert 'Analysis' in prompt

    def test_no_context_when_all_sources_disabled(
        self, mock_dynamodb, mock_jobs_table, mock_converse, prd_generation_event, lambda_context
    ):
        """Cover the 'No additional context provided' fallback."""
        mock_dynamodb['table'].query.return_value = {'Items': []}

        prd_generation_event['doc_config']['data_sources'] = {}

        from jobs.document_generator.handler import lambda_handler
        result = lambda_handler(prd_generation_event, lambda_context)

        assert result['success'] is True
        call_kwargs = mock_converse.call_args.kwargs
        prompt = call_kwargs.get('prompt', '')
        assert 'No additional context provided' in prompt
