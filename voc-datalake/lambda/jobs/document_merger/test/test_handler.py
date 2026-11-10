"""Tests for document merger job handler, run through the real version
allocator and persona helper (`test_handler_mutation.py` pins the literals)."""

import pytest


class TestDocumentMergerHandler:
    """Tests for the document merger job Lambda handler."""

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_converse")
    def test_merged_document_saved_to_dynamodb(
        self, mock_dynamodb,         merge_documents_event, mock_project_documents, lambda_context
    ):
        """Test that merged document is saved to DynamoDB."""
        mock_dynamodb['table'].query.return_value = {'Items': mock_project_documents}

        from jobs.document_merger.handler import lambda_handler

        lambda_handler(merge_documents_event, lambda_context)

        mock_dynamodb['table'].put_item.assert_called()
        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert 'source_documents' in item
        assert item.get('merge_instructions') == merge_documents_event['merge_config']['instructions']

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table", "mock_converse")
    def test_uses_correct_output_type_prefix(
        self, mock_dynamodb,         merge_documents_event, mock_project_documents, lambda_context
    ):
        """Test that document uses correct SK prefix based on output_type."""
        mock_dynamodb['table'].query.return_value = {'Items': mock_project_documents}

        from jobs.document_merger.handler import lambda_handler

        # Test PRD output type
        merge_documents_event['merge_config']['output_type'] = 'prd'
        lambda_handler(merge_documents_event, lambda_context)

        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert item.get('sk', '').startswith('PRD#')

    @pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table")
    def test_includes_personas_when_selected(
        self, mock_dynamodb, mock_converse, merge_documents_event, lambda_context
    ):
        """Test that personas are included in context when selected."""
        mock_items = [
            {
                'sk': 'PRD#doc_1', 'document_id': 'doc_1', 'document_type': 'prd',
                'base_title': 'First PRD', 'version': 1,
                'title': 'First PRD (v1)', 'content': 'PRD content',
            },
            {
                'sk': 'PRD#doc_2', 'document_id': 'doc_2', 'document_type': 'prd',
                'base_title': 'Second PRD', 'version': 1,
                'title': 'Second PRD (v1)', 'content': 'PRD content 2',
            },
            {'sk': 'PERSONA#persona_1', 'persona_id': 'persona_1', 'name': 'Test User', 'tagline': 'A test persona'},
        ]
        mock_dynamodb['table'].query.return_value = {'Items': mock_items}

        merge_documents_event['merge_config']['selected_persona_ids'] = ['persona_1']

        from jobs.document_merger.handler import lambda_handler

        lambda_handler(merge_documents_event, lambda_context)

        # The real persona helper renders the section under the merger's header.
        prompt = mock_converse.call_args.kwargs['prompt']
        assert '## USER PERSONAS FOR CONTEXT\n\n' in prompt
        assert 'Test User' in prompt


@pytest.mark.usefixtures("mock_dynamodb", "mock_jobs_table")
@pytest.mark.parametrize('document_type', ['prd', 'prfaq'])
def test_managed_merge_replay_returns_before_queries_or_model_work(
    document_type,
    mock_dynamodb,
    mock_converse,
    merge_documents_event,
    lambda_context,
):
    from unittest.mock import patch

    from jobs.document_merger import handler

    merge_documents_event['merge_config']['output_type'] = document_type
    existing = {
        'document_id': f'{document_type}_existing',
        'title': f'Merged {document_type.upper()} (v1)',
    }
    with patch.object(
        handler,
        'get_versioned_document_by_allocation',
        return_value=existing,
    ) as lookup:
        result = handler.lambda_handler(merge_documents_event, lambda_context)

    assert result == {'success': True, **existing}
    lookup.assert_called_once_with(
        mock_dynamodb['table'],
        merge_documents_event['project_id'],
        document_type,
        merge_documents_event['job_id'],
    )
    mock_dynamodb['table'].query.assert_not_called()
    mock_converse.assert_not_called()
    assert mock_dynamodb['transactions'] == []
