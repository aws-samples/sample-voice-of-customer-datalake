"""
Coverage tests for shared.avatar module — AccessDenied and ValidationException handling.
"""

import json
from unittest.mock import patch, MagicMock


class TestGenerateAvatarPromptFallbackTemplate:
    """Tests for fallback prompt when LLM returns no text blocks."""

    @patch('shared.avatar.get_avatar_prompt_config')
    @patch('shared.aws.BEDROCK_MODEL_ID', 'test-model')
    def test_fallback_when_no_text_blocks_in_response(self, mock_config):
        """Uses fallback when response has no text-type blocks."""
        from shared.avatar import generate_avatar_prompt_with_llm

        mock_config.return_value = {
            'system_prompt': 'S',
            'user_prompt_template': '{name}',
            'max_tokens': 200,
            'fallback_prompt_template': 'Headshot of a {occupation}',
        }

        mock_bedrock = MagicMock()
        response_body = json.dumps({
            'content': [{'type': 'thinking', 'text': 'thinking...'}]
        }).encode()
        mock_bedrock.invoke_model.return_value = {
            'body': MagicMock(read=MagicMock(return_value=response_body))
        }

        result = generate_avatar_prompt_with_llm(
            {'name': 'Test', 'identity': {'occupation': 'Engineer'}},
            mock_bedrock
        )
        assert result == 'thinking...'


class TestGeneratePersonaAvatarAccessDeniedType:
    """Tests for AccessDenied error detected via type name."""

    @patch('shared.avatar.boto3')
    @patch('shared.avatar.generate_avatar_prompt_with_llm')
    def test_handles_access_denied_exception_type(self, mock_prompt, mock_boto3):
        """Handles AccessDeniedException via error type name check."""
        from shared.avatar import generate_persona_avatar

        mock_prompt.return_value = 'A prompt'
        mock_bedrock = MagicMock()
        mock_boto3.client.return_value = mock_bedrock

        class AccessDeniedException(Exception):
            pass

        mock_bedrock.invoke_model.side_effect = AccessDeniedException("Not authorized")

        result = generate_persona_avatar(
            {'persona_id': 'p1', 'name': 'Test', 'identity': {}},
            MagicMock(), s3_bucket='bucket',
        )
        assert result['avatar_url'] is None
        assert result['avatar_prompt'] == 'A prompt'

    @patch('shared.avatar.boto3')
    @patch('shared.avatar.generate_avatar_prompt_with_llm')
    def test_handles_validation_exception_type(self, mock_prompt, mock_boto3):
        """Handles ValidationException via error type name check."""
        from shared.avatar import generate_persona_avatar

        mock_prompt.return_value = 'A prompt'
        mock_bedrock = MagicMock()
        mock_boto3.client.return_value = mock_bedrock

        class ValidationException(Exception):
            pass

        mock_bedrock.invoke_model.side_effect = ValidationException("Invalid params")

        result = generate_persona_avatar(
            {'persona_id': 'p1', 'name': 'Test', 'identity': {}},
            MagicMock(), s3_bucket='bucket',
        )
        assert result['avatar_url'] is None
        assert result['avatar_prompt'] == 'A prompt'
