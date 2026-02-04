"""Tests for document merger job handler."""

import pytest
from unittest.mock import MagicMock


class TestDocumentMergerHandler:
    """Tests for the document merger job Lambda handler."""

    def test_successful_document_merge(
        self, mock_dynamodb, mock_jobs_table, mock_converse, 
        merge_documents_event, mock_project_documents
    ):
        """Test successful document merge job."""
        mock_dynamodb['table'].query.return_value = {'Items': mock_project_documents}
        
        from jobs.document_merger.handler import lambda_handler
        
        result = lambda_handler(merge_documents_event, None)
        
        assert result['success'] is True
        assert 'document_id' in result
        mock_converse.assert_called_once()

    def test_fails_with_less_than_two_documents(
        self, mock_dynamodb, mock_jobs_table, mock_converse, merge_documents_event
    ):
        """Test that merge fails when less than 2 documents are selected."""
        from jobs.document_merger.handler import lambda_handler
        from shared.exceptions import ServiceError
        
        # Only one document available
        mock_dynamodb['table'].query.return_value = {
            'Items': [{'sk': 'PRD#doc_1', 'document_id': 'doc_1', 'content': 'test'}]
        }
        
        with pytest.raises((ServiceError, ValueError)):
            lambda_handler(merge_documents_event, None)

    def test_merged_document_saved_to_dynamodb(
        self, mock_dynamodb, mock_jobs_table, mock_converse,
        merge_documents_event, mock_project_documents
    ):
        """Test that merged document is saved to DynamoDB."""
        mock_dynamodb['table'].query.return_value = {'Items': mock_project_documents}
        
        from jobs.document_merger.handler import lambda_handler
        
        lambda_handler(merge_documents_event, None)
        
        mock_dynamodb['table'].put_item.assert_called()
        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert 'source_documents' in item
        assert item.get('merge_instructions') == merge_documents_event['merge_config']['instructions']

    def test_uses_correct_output_type_prefix(
        self, mock_dynamodb, mock_jobs_table, mock_converse,
        merge_documents_event, mock_project_documents
    ):
        """Test that document uses correct SK prefix based on output_type."""
        mock_dynamodb['table'].query.return_value = {'Items': mock_project_documents}
        
        from jobs.document_merger.handler import lambda_handler
        
        # Test PRD output type
        merge_documents_event['merge_config']['output_type'] = 'prd'
        lambda_handler(merge_documents_event, None)
        
        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert item.get('sk', '').startswith('PRD#')

    def test_custom_output_type_uses_doc_prefix(
        self, mock_dynamodb, mock_jobs_table, mock_converse,
        merge_documents_event, mock_project_documents
    ):
        """Test that custom output type uses DOC# prefix."""
        mock_dynamodb['table'].query.return_value = {'Items': mock_project_documents}
        
        from jobs.document_merger.handler import lambda_handler
        
        merge_documents_event['merge_config']['output_type'] = 'custom'
        lambda_handler(merge_documents_event, None)
        
        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert item.get('sk', '').startswith('DOC#')

    def test_includes_personas_when_selected(
        self, mock_dynamodb, mock_jobs_table, mock_converse, merge_documents_event
    ):
        """Test that personas are included in context when selected."""
        mock_items = [
            {'sk': 'PRD#doc_1', 'document_id': 'doc_1', 'content': 'PRD content'},
            {'sk': 'PRD#doc_2', 'document_id': 'doc_2', 'content': 'PRD content 2'},
            {'sk': 'PERSONA#persona_1', 'persona_id': 'persona_1', 'name': 'Test User', 'tagline': 'A test persona'},
        ]
        mock_dynamodb['table'].query.return_value = {'Items': mock_items}
        
        merge_documents_event['merge_config']['selected_persona_ids'] = ['persona_1']
        
        from jobs.document_merger.handler import lambda_handler
        
        lambda_handler(merge_documents_event, None)
        
        # Verify persona context was included in prompt
        call_kwargs = mock_converse.call_args.kwargs
        prompt = call_kwargs.get('prompt', '')
        assert 'Test User' in prompt or 'PERSONA' in prompt
