"""Tests for shared.avatar module - avatar generation utilities."""

import json
import pytest
from unittest.mock import patch, MagicMock
import base64


class TestGenerateAvatarPromptWithLlm:
    """Tests for generate_avatar_prompt_with_llm function."""

    @patch('shared.avatar.get_avatar_prompt_config')
    @patch('shared.aws.BEDROCK_MODEL_ID', 'test-model')
    def test_successful_prompt_generation(self, mock_config):
        """Generates image prompt from persona data using Claude."""
        from shared.avatar import generate_avatar_prompt_with_llm

        mock_config.return_value = {
            'system_prompt': 'Generate image prompts',
            'user_prompt_template': 'Create avatar for {name}, {occupation}',
            'max_tokens': 200,
            'fallback_prompt_template': 'Headshot of {occupation}',
        }

        mock_bedrock = MagicMock()
        response_body = json.dumps({
            'content': [{'type': 'text', 'text': 'Professional headshot of a software engineer'}]
        }).encode()
        mock_bedrock.invoke_model.return_value = {
            'body': MagicMock(read=MagicMock(return_value=response_body))
        }

        persona = {
            'name': 'Alice', 'tagline': 'Tech enthusiast',
            'identity': {
                'bio': 'A software engineer who loves coding',
                'age_range': '25-35', 'occupation': 'Software Engineer',
                'location': 'San Francisco',
            }
        }

        result = generate_avatar_prompt_with_llm(persona, mock_bedrock)
        assert result == 'Professional headshot of a software engineer'
        mock_bedrock.invoke_model.assert_called_once()

    @patch('shared.avatar.get_avatar_prompt_config')
    @patch('shared.aws.BEDROCK_MODEL_ID', 'test-model')
    def test_handles_thinking_blocks_in_response(self, mock_config):
        """Extracts text from response with thinking blocks."""
        from shared.avatar import generate_avatar_prompt_with_llm

        mock_config.return_value = {
            'system_prompt': 'S', 'user_prompt_template': '{name}',
            'max_tokens': 200, 'fallback_prompt_template': 'Headshot of {occupation}',
        }

        mock_bedrock = MagicMock()
        response_body = json.dumps({
            'content': [
                {'type': 'thinking', 'text': 'Let me think...'},
                {'type': 'text', 'text': 'A portrait of a teacher'},
            ]
        }).encode()
        mock_bedrock.invoke_model.return_value = {
            'body': MagicMock(read=MagicMock(return_value=response_body))
        }

        result = generate_avatar_prompt_with_llm({'name': 'Bob', 'identity': {}}, mock_bedrock)
        assert result == 'A portrait of a teacher'

    @patch('shared.avatar.get_avatar_prompt_config')
    @patch('shared.aws.BEDROCK_MODEL_ID', 'test-model')
    def test_fallback_on_llm_error(self, mock_config):
        """Uses fallback prompt when LLM call fails."""
        from shared.avatar import generate_avatar_prompt_with_llm

        mock_config.return_value = {
            'system_prompt': 'S', 'user_prompt_template': '{name}',
            'max_tokens': 200,
            'fallback_prompt_template': 'Professional headshot of a {occupation}, friendly expression',
        }

        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.side_effect = Exception("Bedrock error")

        result = generate_avatar_prompt_with_llm(
            {'name': 'Carol', 'identity': {'occupation': 'Designer'}}, mock_bedrock
        )
        assert 'Designer' in result

    @patch('shared.avatar.get_avatar_prompt_config')
    @patch('shared.aws.BEDROCK_MODEL_ID', 'test-model')
    def test_fallback_with_empty_occupation(self, mock_config):
        """Uses 'professional' as default occupation in fallback."""
        from shared.avatar import generate_avatar_prompt_with_llm

        mock_config.return_value = {
            'system_prompt': 'S', 'user_prompt_template': '{name}',
            'max_tokens': 200, 'fallback_prompt_template': 'Headshot of a {occupation}',
        }

        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.side_effect = Exception("Error")

        result = generate_avatar_prompt_with_llm({'name': 'X', 'identity': {}}, mock_bedrock)
        assert 'professional' in result


class TestGeneratePersonaAvatar:
    """Tests for generate_persona_avatar function."""

    @patch('shared.avatar.boto3')
    @patch('shared.avatar.generate_avatar_prompt_with_llm')
    def test_successful_avatar_generation(self, mock_prompt, mock_boto3):
        """Generates avatar and uploads to S3."""
        from shared.avatar import generate_persona_avatar

        mock_prompt.return_value = 'A portrait prompt'

        # Mock Nova Canvas response
        mock_bedrock_runtime = MagicMock()
        mock_s3 = MagicMock()

        def client_factory(service, **kwargs):
            if service == 'bedrock-runtime':
                return mock_bedrock_runtime
            return mock_s3

        mock_boto3.client.side_effect = client_factory

        image_data = base64.b64encode(b'fake-png-data').decode()
        nova_response = json.dumps({'images': [image_data]}).encode()
        mock_bedrock_runtime.invoke_model.return_value = {
            'body': MagicMock(read=MagicMock(return_value=nova_response))
        }

        persona = {
            'persona_id': 'p123', 'name': 'Test Persona',
            'identity': {'occupation': 'Engineer'},
        }

        result = generate_persona_avatar(persona, MagicMock(), s3_bucket='test-bucket')

        assert result['avatar_url'] == 's3://test-bucket/avatars/p123.png'
        assert result['avatar_prompt'] == 'A portrait prompt'

    @patch('shared.avatar.generate_avatar_prompt_with_llm')
    def test_returns_none_when_no_bucket(self, mock_prompt):
        """Returns None avatar_url when no S3 bucket configured."""
        from shared.avatar import generate_persona_avatar

        with patch.dict('os.environ', {'RAW_DATA_BUCKET': ''}):
            result = generate_persona_avatar(
                {'persona_id': 'p1', 'name': 'Test'}, MagicMock(), s3_bucket='',
            )

        assert result['avatar_url'] is None
        assert result['avatar_prompt'] is None

    @patch('shared.avatar.boto3')
    @patch('shared.avatar.generate_avatar_prompt_with_llm')
    def test_handles_empty_images_array(self, mock_prompt, mock_boto3):
        """Returns None when Nova Canvas returns empty images."""
        from shared.avatar import generate_persona_avatar

        mock_prompt.return_value = 'A prompt'
        mock_bedrock = MagicMock()
        mock_boto3.client.return_value = mock_bedrock

        nova_response = json.dumps({'images': []}).encode()
        mock_bedrock.invoke_model.return_value = {
            'body': MagicMock(read=MagicMock(return_value=nova_response))
        }

        result = generate_persona_avatar(
            {'persona_id': 'p1', 'name': 'Test', 'identity': {}},
            MagicMock(), s3_bucket='bucket',
        )

        assert result['avatar_url'] is None
        assert result['avatar_prompt'] == 'A prompt'

    @patch('shared.avatar.boto3')
    @patch('shared.avatar.generate_avatar_prompt_with_llm')
    def test_handles_access_denied_error(self, mock_prompt, mock_boto3):
        """Handles AccessDenied error gracefully."""
        from shared.avatar import generate_persona_avatar

        mock_prompt.return_value = 'A prompt'
        mock_bedrock = MagicMock()
        mock_boto3.client.return_value = mock_bedrock
        mock_bedrock.invoke_model.side_effect = Exception("AccessDenied: not authorized")

        result = generate_persona_avatar(
            {'persona_id': 'p1', 'name': 'Test', 'identity': {}},
            MagicMock(), s3_bucket='bucket',
        )
        assert result['avatar_url'] is None
        assert result['avatar_prompt'] == 'A prompt'

    @patch('shared.avatar.boto3')
    @patch('shared.avatar.generate_avatar_prompt_with_llm')
    def test_handles_validation_exception(self, mock_prompt, mock_boto3):
        """Handles ValidationException error gracefully."""
        from shared.avatar import generate_persona_avatar

        mock_prompt.return_value = 'A prompt'
        mock_bedrock = MagicMock()
        mock_boto3.client.return_value = mock_bedrock
        mock_bedrock.invoke_model.side_effect = Exception("ValidationException: invalid params")

        result = generate_persona_avatar(
            {'persona_id': 'p1', 'name': 'Test', 'identity': {}},
            MagicMock(), s3_bucket='bucket',
        )
        assert result['avatar_url'] is None

    @patch('shared.avatar.boto3')
    @patch('shared.avatar.generate_avatar_prompt_with_llm')
    def test_handles_generic_error(self, mock_prompt, mock_boto3):
        """Handles generic errors gracefully."""
        from shared.avatar import generate_persona_avatar

        mock_prompt.return_value = 'A prompt'
        mock_bedrock = MagicMock()
        mock_boto3.client.return_value = mock_bedrock
        mock_bedrock.invoke_model.side_effect = RuntimeError("Something broke")

        result = generate_persona_avatar(
            {'persona_id': 'p1', 'name': 'Test', 'identity': {}},
            MagicMock(), s3_bucket='bucket',
        )
        assert result['avatar_url'] is None
        assert result['avatar_prompt'] == 'A prompt'


class TestGetAvatarCdnUrl:
    """Tests for get_avatar_cdn_url function."""

    def test_converts_s3_uri_to_cdn_url(self):
        from shared.avatar import get_avatar_cdn_url
        result = get_avatar_cdn_url('s3://bucket/avatars/persona_123.png', cdn_url='https://cdn.example.com')
        assert result == 'https://cdn.example.com/persona_123.png'

    def test_returns_none_for_empty_uri(self):
        from shared.avatar import get_avatar_cdn_url
        assert get_avatar_cdn_url('') is None
        assert get_avatar_cdn_url(None) is None

    def test_returns_none_for_non_s3_uri(self):
        from shared.avatar import get_avatar_cdn_url
        assert get_avatar_cdn_url('https://example.com/image.png') is None

    def test_returns_none_when_no_cdn_url(self):
        from shared.avatar import get_avatar_cdn_url
        with patch.dict('os.environ', {'AVATARS_CDN_URL': ''}):
            result = get_avatar_cdn_url('s3://bucket/avatars/test.png', cdn_url='')
        assert result is None

    def test_strips_trailing_slash_from_cdn_url(self):
        from shared.avatar import get_avatar_cdn_url
        result = get_avatar_cdn_url('s3://bucket/avatars/test.png', cdn_url='https://cdn.example.com/')
        assert result == 'https://cdn.example.com/test.png'

    @patch.dict('os.environ', {'AVATARS_CDN_URL': 'https://env-cdn.example.com'})
    def test_uses_env_var_when_no_cdn_url_param(self):
        from shared.avatar import get_avatar_cdn_url
        result = get_avatar_cdn_url('s3://bucket/avatars/test.png')
        assert result == 'https://env-cdn.example.com/test.png'
