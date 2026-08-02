"""The avatar image model must be single-sourced and actually honoured.

Two problems motivated these tests:

1. avatar-generation.json carried an "image_model" block that avatar.py never
   read — it used its own module constants instead. The config looked
   authoritative but editing it did nothing.
2. The model id was ALSO pasted into lib/stacks/api-stack.ts as a literal IAM
   ARN in three places. A model that is invoked but not granted AccessDenies;
   one that is granted but not invoked wastes the grant.

So the Python config and the CDK source must agree, and the runtime must use
what the config says. amazon.nova-canvas-v1:0 reaches EOL on 2026-09-30, so the
migration these tests protect is a matter of when, not if.
"""
import json
import re
from pathlib import Path
from unittest.mock import MagicMock, patch


def _repo_root() -> Path:
    # lambda/shared/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _cdk_source() -> str:
    return (_repo_root() / 'lib' / 'utils' / 'model-allowlist.ts').read_text(encoding='utf-8')


def _avatar_config() -> dict:
    path = _repo_root() / 'lambda' / 'api' / 'prompts' / 'avatar-generation.json'
    return json.loads(path.read_text(encoding='utf-8'))


def _ts_const(name: str) -> str:
    """Read a single exported string constant out of the CDK source."""
    match = re.search(rf"export const {name} = '([^']+)';", _cdk_source())
    assert match, f'{name} not found in model-allowlist.ts'
    return match.group(1)


class TestImageModelLockstep:
    """The runtime config and the IAM grant must name the same model."""

    def test_config_model_id_matches_cdk_source(self):
        assert _avatar_config()['image_model']['model_id'] == _ts_const('IMAGE_MODEL_ID')

    def test_config_region_matches_cdk_source(self):
        assert _avatar_config()['image_model']['region'] == _ts_const('IMAGE_MODEL_REGION')

    def test_runtime_fallback_defaults_match_cdk_source(self):
        """The defaults are a third copy of the id, so pin them too.

        avatar.py falls back to DEFAULT_IMAGE_MODEL_* when the config's
        image_model block is absent. If those drift from the CDK constants, that
        fallback invokes a model the IAM grant does not cover — an AccessDenied
        on a path that already degrades silently to avatar_url=None, so nobody
        would notice. (Raised in review of PR #228.)
        """
        from shared.avatar import DEFAULT_IMAGE_MODEL_ID, DEFAULT_IMAGE_MODEL_REGION

        assert DEFAULT_IMAGE_MODEL_ID == _ts_const('IMAGE_MODEL_ID')
        assert DEFAULT_IMAGE_MODEL_REGION == _ts_const('IMAGE_MODEL_REGION')

    def test_api_stack_derives_the_arn_instead_of_hardcoding_it(self):
        """Three roles used to embed the ARN as a literal, so a model swap had to
        be repeated in three places or it silently AccessDenied."""
        api_stack = (_repo_root() / 'lib' / 'stacks' / 'api-stack.ts').read_text(encoding='utf-8')
        assert 'imageModelArn()' in api_stack
        assert 'foundation-model/amazon.nova-canvas' not in api_stack


class TestImageModelConfigIsHonoured:
    """What the config declares is what gets invoked."""

    @staticmethod
    def _run_with_config(image_model: dict | None):
        """Generate an avatar with a stubbed image_model block.

        Returns (bedrock_runtime_mock, boto3_mock) for assertions.
        """
        config = {
            'system_prompt': 'S',
            'user_prompt_template': '{name}',
            'max_tokens': 200,
            'fallback_prompt_template': 'Headshot of {occupation}',
        }
        if image_model is not None:
            config['image_model'] = image_model

        mock_bedrock_runtime = MagicMock()
        mock_s3 = MagicMock()
        import base64
        image_data = base64.b64encode(b'png').decode()
        mock_bedrock_runtime.invoke_model.return_value = {
            'body': MagicMock(read=MagicMock(return_value=json.dumps({'images': [image_data]}).encode()))
        }

        def client_factory(service, **kwargs):
            return mock_bedrock_runtime if service == 'bedrock-runtime' else mock_s3

        with patch('shared.avatar.get_avatar_prompt_config', return_value=config), \
             patch('shared.avatar.generate_avatar_prompt_with_llm', return_value='prompt'), \
             patch('shared.avatar.boto3') as mock_boto3:
            mock_boto3.client.side_effect = client_factory
            from shared.avatar import generate_persona_avatar
            result = generate_persona_avatar(
                {'persona_id': 'p1', 'name': 'N', 'identity': {}},
                MagicMock(),
                s3_bucket='b',
            )
        return mock_bedrock_runtime, mock_boto3, result

    def test_invokes_the_model_id_from_config(self):
        bedrock, _, result = self._run_with_config({
            'model_id': 'vendor.some-future-image-model-v9:0',
            'region': 'us-east-1', 'width': 1024, 'height': 1024,
        })
        assert result['avatar_url'] == 's3://b/avatars/p1.png'
        assert bedrock.invoke_model.call_args.kwargs['modelId'] == 'vendor.some-future-image-model-v9:0'

    def test_creates_the_bedrock_client_in_the_configured_region(self):
        _, boto3_mock, _ = self._run_with_config({
            'model_id': 'm', 'region': 'eu-west-1', 'width': 1024, 'height': 1024,
        })
        bedrock_calls = [
            c for c in boto3_mock.client.call_args_list if c.args and c.args[0] == 'bedrock-runtime'
        ]
        assert bedrock_calls, 'no bedrock-runtime client was created'
        assert bedrock_calls[0].kwargs['region_name'] == 'eu-west-1'

    def test_uses_the_configured_dimensions(self):
        bedrock, _, _ = self._run_with_config({
            'model_id': 'm', 'region': 'us-east-1', 'width': 512, 'height': 768,
        })
        body = json.loads(bedrock.invoke_model.call_args.kwargs['body'])
        assert body['imageGenerationConfig']['width'] == 512
        assert body['imageGenerationConfig']['height'] == 768

    def test_falls_back_to_defaults_when_the_block_is_missing(self):
        """Older/partial configs must still work rather than KeyError."""
        from shared.avatar import (
            DEFAULT_IMAGE_MODEL_ID,
            DEFAULT_IMAGE_MODEL_REGION,
            DEFAULT_IMAGE_SIZE,
        )

        bedrock, boto3_mock, _ = self._run_with_config(None)
        assert bedrock.invoke_model.call_args.kwargs['modelId'] == DEFAULT_IMAGE_MODEL_ID
        body = json.loads(bedrock.invoke_model.call_args.kwargs['body'])
        assert body['imageGenerationConfig']['width'] == DEFAULT_IMAGE_SIZE
        bedrock_calls = [
            c for c in boto3_mock.client.call_args_list if c.args and c.args[0] == 'bedrock-runtime'
        ]
        assert bedrock_calls[0].kwargs['region_name'] == DEFAULT_IMAGE_MODEL_REGION


class TestLifecycleFailuresAreDiagnosable:
    """Avatar failures degrade silently by design (avatar_url stays None), so the
    log line is the only signal. Each branch must reference in-scope names and
    name the model, or the outage looks like a mystery — which is what happened
    the last time this model lost access."""

    @staticmethod
    def _fail_with(exc: Exception):
        config = {
            'system_prompt': 'S', 'user_prompt_template': '{name}', 'max_tokens': 200,
            'fallback_prompt_template': 'H',
            'image_model': {'model_id': 'test.image-model', 'region': 'us-east-1',
                            'width': 1024, 'height': 1024},
        }
        mock_bedrock_runtime = MagicMock()
        mock_bedrock_runtime.invoke_model.side_effect = exc

        def client_factory(service, **kwargs):
            return mock_bedrock_runtime if service == 'bedrock-runtime' else MagicMock()

        with patch('shared.avatar.get_avatar_prompt_config', return_value=config), \
             patch('shared.avatar.generate_avatar_prompt_with_llm', return_value='p'), \
             patch('shared.avatar.boto3') as mock_boto3, \
             patch('shared.avatar.logger') as mock_logger:
            mock_boto3.client.side_effect = client_factory
            from shared.avatar import generate_persona_avatar
            result = generate_persona_avatar(
                {'persona_id': 'p1', 'name': 'N', 'identity': {}}, MagicMock(), s3_bucket='b'
            )
        errors = ' '.join(str(c) for c in mock_logger.error.call_args_list)
        return result, errors

    def test_model_not_found_explains_the_legacy_lifecycle(self):
        class ResourceNotFoundException(Exception):
            pass

        result, errors = self._fail_with(ResourceNotFoundException('not found'))
        assert result['avatar_url'] is None
        assert 'test.image-model' in errors
        assert 'LEGACY' in errors

    def test_access_denied_reports_the_arn_it_needs(self):
        class AccessDeniedException(Exception):
            pass

        result, errors = self._fail_with(AccessDeniedException('denied'))
        assert result['avatar_url'] is None
        assert 'test.image-model' in errors
        assert 'us-east-1' in errors

    def test_validation_error_names_the_model(self):
        class ValidationException(Exception):
            pass

        result, errors = self._fail_with(ValidationException('bad body'))
        assert result['avatar_url'] is None
        assert 'test.image-model' in errors

    def test_unexpected_error_still_degrades_gracefully(self):
        result, errors = self._fail_with(RuntimeError('boom'))
        assert result['avatar_url'] is None
        assert 'boom' in errors
