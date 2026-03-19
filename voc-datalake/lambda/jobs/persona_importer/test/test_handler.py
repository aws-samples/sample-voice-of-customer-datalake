"""Tests for persona importer job handler."""

import pytest
from unittest.mock import patch, MagicMock


class TestPersonaImporterHandler:
    """Tests for the persona importer job Lambda handler."""

    def test_successful_text_import(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, mock_bedrock_persona_response
    ):
        """Test successful persona import from text."""
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        
        from jobs.persona_importer.handler import lambda_handler
        
        result = lambda_handler(text_import_event, None)
        
        assert result['success'] is True
        assert 'persona_id' in result
        mock_bedrock.converse.assert_called_once()

    def test_successful_image_import(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, image_import_event, mock_bedrock_persona_response
    ):
        """Test successful persona import from image."""
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        
        from jobs.persona_importer.handler import lambda_handler
        
        result = lambda_handler(image_import_event, None)
        
        assert result['success'] is True
        assert 'persona_id' in result
        
        # Verify image was included in converse call
        call_args = mock_bedrock.converse.call_args
        messages = call_args.kwargs.get('messages', [])
        assert any('image' in str(m) for m in messages)

    def test_persona_saved_to_dynamodb(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, mock_bedrock_persona_response
    ):
        """Test that imported persona is saved to DynamoDB."""
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        
        from jobs.persona_importer.handler import lambda_handler
        
        lambda_handler(text_import_event, None)
        
        mock_dynamodb['table'].put_item.assert_called()
        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert item.get('name') == 'Sarah Chen'
        assert item.get('imported_from') == 'text'

    def test_avatar_generated_for_imported_persona(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, mock_bedrock_persona_response
    ):
        """Test that avatar is generated for imported persona."""
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        
        from jobs.persona_importer.handler import lambda_handler
        
        lambda_handler(text_import_event, None)
        
        mock_avatar_generation.assert_called_once()
        
        # Verify avatar URL is saved
        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert 'avatar_url' in item

    def test_handles_json_in_markdown_code_block(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event
    ):
        """Test that handler extracts JSON from markdown code blocks."""
        mock_bedrock.converse.return_value = {
            'output': {
                'message': {
                    'content': [{
                        'text': '''Here's the extracted persona:
                        
```json
{
    "name": "Test User",
    "tagline": "A test persona",
    "confidence": "medium",
    "identity": {},
    "goals_motivations": {},
    "pain_points": {},
    "behaviors": {},
    "context_environment": {},
    "quotes": [],
    "scenario": {}
}
```'''
                    }]
                }
            }
        }
        
        from jobs.persona_importer.handler import lambda_handler
        
        result = lambda_handler(text_import_event, None)
        
        assert result['success'] is True
        put_call = mock_dynamodb['table'].put_item.call_args
        item = put_call.kwargs.get('Item', {})
        assert item.get('name') == 'Test User'

    def test_job_fails_on_invalid_json(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event
    ):
        """Test that job fails when LLM returns invalid JSON."""
        from jobs.persona_importer.handler import lambda_handler
        from shared.exceptions import ServiceError
        
        mock_bedrock.converse.return_value = {
            'output': {
                'message': {
                    'content': [{'text': 'This is not valid JSON'}]
                }
            }
        }
        
        with pytest.raises(ServiceError):
            lambda_handler(text_import_event, None)
        
        mock_jobs_table.update_item.assert_called()

    def test_persona_count_incremented(
        self, mock_dynamodb, mock_jobs_table, mock_bedrock,
        mock_avatar_generation, text_import_event, mock_bedrock_persona_response
    ):
        """Test that project persona count is incremented."""
        mock_bedrock.converse.return_value = mock_bedrock_persona_response
        
        from jobs.persona_importer.handler import lambda_handler
        
        lambda_handler(text_import_event, None)
        
        # Verify update_item was called to increment persona_count
        update_calls = [c for c in mock_dynamodb['table'].update_item.call_args_list]
        assert any('persona_count' in str(c) for c in update_calls)
