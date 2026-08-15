"""Tests for shared.avatar module - avatar generation utilities."""

import json
from concurrent.futures import ThreadPoolExecutor
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

        # Deliberately a LITERAL. Deriving the extension from
        # get_image_model_config() would take the expectation from the same
        # production code under test, so a wrong extension could never fail this.
        assert result['avatar_url'] == 's3://test-bucket/avatars/p123.jpeg'
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

    def test_converts_s3_uri_to_signed_cdn_url(self, cdn_signing_configured):
        from shared.avatar import get_avatar_cdn_url
        result = get_avatar_cdn_url('s3://bucket/avatars/persona_123.png', cdn_url='https://cdn.example.com')
        assert result.startswith('https://cdn.example.com/persona_123.png?')
        assert 'Signature=' in result
        assert 'Key-Pair-Id=K2TESTKEYPAIRID' in result

    def test_returns_none_when_signing_unavailable(self):
        """Fail closed (issue #229).

        `/avatars/*` requires a signature, so an unsigned URL is useless to the
        browser — but more importantly, returning one would mean the code path
        still hands out unauthenticated links if the key group is ever removed.
        None makes the SPA draw its gradient fallback instead.
        """
        from shared.avatar import get_avatar_cdn_url
        result = get_avatar_cdn_url('s3://bucket/avatars/persona_123.png', cdn_url='https://cdn.example.com')
        assert result is None

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

    def test_strips_trailing_slash_from_cdn_url(self, cdn_signing_configured):
        from shared.avatar import get_avatar_cdn_url
        result = get_avatar_cdn_url('s3://bucket/avatars/test.png', cdn_url='https://cdn.example.com/')
        assert result.startswith('https://cdn.example.com/test.png?')

    @patch.dict('os.environ', {'AVATARS_CDN_URL': 'https://env-cdn.example.com'})
    def test_uses_env_var_when_no_cdn_url_param(self, cdn_signing_configured):
        from shared.avatar import get_avatar_cdn_url
        result = get_avatar_cdn_url('s3://bucket/avatars/test.png')
        assert result.startswith('https://env-cdn.example.com/test.png?')


# Avatar prompt config used by the client-reuse tests below. Module-level so it
# is a single shared definition rather than a mutable class attribute.
IMAGE_MODEL_TEST_CONFIG = {
    'system_prompt': 'S', 'user_prompt_template': '{name}', 'max_tokens': 200,
    'fallback_prompt_template': 'H',
    'image_model': {'model_id': 'test.image-model', 'region': 'us-west-2',
                    'aspect_ratio': '1:1', 'output_format': 'jpeg'},
}


class TestImageModelClientIsReused:
    """The region-pinned Bedrock client is built once per execution
    environment, not once per persona.

    Persona generation calls this function once per persona (concurrently), and
    each call used to construct its own boto3 client: a botocore session plus
    endpoint resolution, repeated for work that always targets the same region.
    """

    @staticmethod
    def _image_response():
        return {
            'body': MagicMock(read=MagicMock(return_value=json.dumps(
                {'images': [base64.b64encode(b'bytes').decode()]}).encode()))
        }

    def _generate(self, persona_ids, config=None):
        """Generate avatars for several personas through one patched boto3 and
        report how many bedrock-runtime clients were constructed."""
        from shared.avatar import generate_persona_avatar

        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.return_value = self._image_response()

        def client_factory(service, **kwargs):
            return mock_bedrock if service == 'bedrock-runtime' else MagicMock()

        results = []
        with patch('shared.avatar.get_avatar_prompt_config', return_value=config or IMAGE_MODEL_TEST_CONFIG), \
             patch('shared.avatar.generate_avatar_prompt_with_llm', return_value='p'), \
             patch('shared.avatar.boto3') as mock_boto3:
            mock_boto3.client.side_effect = client_factory
            for persona_id in persona_ids:
                results.append(generate_persona_avatar(
                    {'persona_id': persona_id, 'name': persona_id, 'identity': {}},
                    MagicMock(), s3_bucket='b',
                ))
            bedrock_client_calls = [
                c for c in mock_boto3.client.call_args_list
                if c.args and c.args[0] == 'bedrock-runtime'
            ]
        return results, bedrock_client_calls

    def test_three_personas_build_one_client(self):
        results, client_calls = self._generate(['p1', 'p2', 'p3'])
        # Positive control: all three avatars really were produced, so the
        # single client is reuse and not three skipped generations.
        assert [r['avatar_url'] for r in results] == [
            's3://b/avatars/p1.jpeg', 's3://b/avatars/p2.jpeg', 's3://b/avatars/p3.jpeg',
        ]
        assert len(client_calls) == 1, (
            f'built {len(client_calls)} bedrock-runtime clients for 3 personas'
        )

    def test_the_one_client_is_pinned_to_the_configured_region(self):
        _, client_calls = self._generate(['p1', 'p2'])
        assert client_calls[0].kwargs['region_name'] == 'us-west-2'

    def test_a_different_configured_region_gets_its_own_client(self):
        """Cached per region, not globally: the region comes from
        avatar-generation.json, so a config change must not keep serving a
        client pinned to the old region."""
        from shared.avatar import clear_image_model_client_cache

        _, first = self._generate(['p1'])
        assert first[0].kwargs['region_name'] == 'us-west-2'

        # Same process, no cache clear — only the configured region changes.
        eu_config = {
            **IMAGE_MODEL_TEST_CONFIG,
            'image_model': {**IMAGE_MODEL_TEST_CONFIG['image_model'], 'region': 'eu-west-1'},
        }
        _, second = self._generate(['p2'], config=eu_config)
        assert second[0].kwargs['region_name'] == 'eu-west-1'

        clear_image_model_client_cache()

    def test_concurrent_generations_still_build_one_client(self):
        """The persona generator now runs these calls in parallel, so several
        threads reach the cache at once. The lock must keep that to one client
        while every avatar still comes back."""
        from shared.avatar import generate_persona_avatar

        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.return_value = self._image_response()

        def client_factory(service, **kwargs):
            return mock_bedrock if service == 'bedrock-runtime' else MagicMock()

        persona_ids = [f'p{i}' for i in range(6)]
        with patch('shared.avatar.get_avatar_prompt_config', return_value=IMAGE_MODEL_TEST_CONFIG), \
             patch('shared.avatar.generate_avatar_prompt_with_llm', return_value='p'), \
             patch('shared.avatar.boto3') as mock_boto3:
            mock_boto3.client.side_effect = client_factory
            with ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(
                    lambda pid: generate_persona_avatar(
                        {'persona_id': pid, 'name': pid, 'identity': {}},
                        MagicMock(), s3_bucket='b',
                    ),
                    persona_ids,
                ))
            bedrock_client_calls = [
                c for c in mock_boto3.client.call_args_list
                if c.args and c.args[0] == 'bedrock-runtime'
            ]

        assert all(r['avatar_url'] for r in results)
        assert len(bedrock_client_calls) == 1


class TestNoCryptoDependencyForWriters:
    """`shared.avatar` must not pull in `cryptography` at import time.

    Only `get_avatar_cdn_url` signs. The rest of the module is the avatar WRITER
    path (`generate_persona_avatar`), used by the persona-generator and
    persona-importer jobs, which never mint a URL — so a module-scope
    `from shared.cloudfront_signing import sign_url` made those jobs fail at cold
    start over a dependency they do not use. This mirrors the guard in
    test_prototypes.py and is what stops someone hoisting the import back up.
    """

    def test_importing_the_module_does_not_pull_in_cryptography(self, imports_cryptography):
        assert not imports_cryptography('shared.avatar'), (
            'Importing shared.avatar pulled in cryptography. Keep the '
            'shared.cloudfront_signing import inside get_avatar_cdn_url.'
        )
