"""The avatar image model must be single-sourced and actually honoured.

Two problems motivated these tests:

1. avatar-generation.json carried an "image_model" block that avatar.py never
   read — it used its own module constants instead. The config looked
   authoritative but editing it did nothing.
2. The model id was ALSO pasted into lib/stacks/api-stack.ts as a literal IAM
   ARN in three places. A model that is invoked but not granted AccessDenies;
   one that is granted but not invoked wastes the grant.

So the Python config and the CDK source must agree, and the runtime must use
what the config says. The model was migrated off amazon.nova-canvas-v1:0 (EOL
2026-09-30) to an active Stability generator in a DIFFERENT region, so these
tests also pin the region that the IAM grant is built from.
"""
import json
import re
from unittest.mock import MagicMock

from shared.test.avatar_fixtures import (
    avatar_prompt_config,
    generate_avatar_with_config,
    image_model_response,
    run_avatar_generation,
)
from shared.test.repo_paths import cdk_model_allowlist_source, repo_root


def _avatar_config() -> dict:
    path = repo_root() / 'lambda' / 'api' / 'prompts' / 'avatar-generation.json'
    return json.loads(path.read_text(encoding='utf-8'))


def _ts_const(name: str) -> str:
    """Read a single exported string constant out of the CDK source."""
    match = re.search(rf"export const {name} = '([^']+)';", cdk_model_allowlist_source())
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

        assert _ts_const('IMAGE_MODEL_ID') == DEFAULT_IMAGE_MODEL_ID
        assert _ts_const('IMAGE_MODEL_REGION') == DEFAULT_IMAGE_MODEL_REGION

    def test_api_stack_derives_the_arn_instead_of_hardcoding_it(self):
        """Three roles used to embed the ARN as a literal, so a model swap had to
        be repeated in three places or it silently AccessDenied."""
        api_stack = (repo_root() / 'lib' / 'stacks' / 'api-stack.ts').read_text(encoding='utf-8')
        assert 'imageModelArn()' in api_stack
        assert 'foundation-model/amazon.nova-canvas' not in api_stack
        assert 'foundation-model/stability' not in api_stack


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
        mock_bedrock_runtime.invoke_model.return_value = image_model_response(b'png')
        mock_boto3, result = run_avatar_generation(
            config, mock_bedrock=mock_bedrock_runtime, mock_s3=MagicMock(), llm_prompt='prompt',
        )
        return mock_bedrock_runtime, mock_boto3, result

    def test_invokes_the_model_id_from_config(self):
        bedrock, _, result = self._run_with_config({
            'model_id': 'vendor.some-future-image-model-v9:0',
            'region': 'us-west-2', 'aspect_ratio': '1:1', 'output_format': 'png',
        })
        assert re.fullmatch(r's3://b/avatars/p1/[0-9a-f]{24}\.png', result['avatar_url'])
        assert bedrock.invoke_model.call_args.kwargs['modelId'] == 'vendor.some-future-image-model-v9:0'

    def test_creates_the_bedrock_client_in_the_configured_region(self):
        _, boto3_mock, _ = self._run_with_config({
            'model_id': 'm', 'region': 'eu-west-1', 'aspect_ratio': '1:1',
            'output_format': 'png',
        })
        bedrock_calls = [
            c for c in boto3_mock.client.call_args_list if c.args and c.args[0] == 'bedrock-runtime'
        ]
        assert bedrock_calls, 'no bedrock-runtime client was created'
        assert bedrock_calls[0].kwargs['region_name'] == 'eu-west-1'

    def test_uses_the_configured_aspect_ratio_and_format(self):
        bedrock, _, _ = self._run_with_config({
            'model_id': 'm', 'region': 'us-west-2',
            'aspect_ratio': '3:2', 'output_format': 'jpeg',
        })
        body = json.loads(bedrock.invoke_model.call_args.kwargs['body'])
        assert body['aspect_ratio'] == '3:2'
        assert body['output_format'] == 'jpeg'
        assert body['mode'] == 'text-to-image'

class TestAvatarsAreNotShippedAsPng:
    """The model emits 1536x1536 while avatars render at 32-128 CSS px, so the
    encoding choice dominates payload size. Measured on one seed/prompt: PNG
    2,677,833 bytes vs JPEG 401,603 — 6.7x. A revert to PNG is a silent 6x
    regression in page weight, hence an explicit guard."""

    def test_default_format_is_lossy(self):
        """'jpeg' specifically — the model rejects 'jpg' and 'webp', so accepting
        them here would green-light a value that fails Bedrock validation."""
        from shared.avatar import _SUPPORTED_OUTPUT_FORMATS, DEFAULT_OUTPUT_FORMAT

        assert DEFAULT_OUTPUT_FORMAT == 'jpeg'
        assert {'png', 'jpeg'} == _SUPPORTED_OUTPUT_FORMATS

    def test_shipped_config_agrees_with_the_default(self):
        assert _avatar_config()['image_model']['output_format'] != 'png'

    def test_content_type_matches_the_configured_format(self):
        """The S3 ContentType is derived, so a format change must not leave it
        claiming image/png for JPEG bytes."""
        mock_s3, result = generate_avatar_with_config(
            avatar_prompt_config('jpeg'), image_bytes=b'jpegbytes',
        )

        put = mock_s3.put_object.call_args.kwargs
        assert put['ContentType'] == 'image/jpeg'
        assert re.fullmatch(r'avatars/p1/[0-9a-f]{24}\.jpeg', put['Key'])
        assert result['avatar_url'] == f"s3://b/{put['Key']}"


class TestGenerationDeletesNothing:
    """Every image now gets its own key (`avatars/{id}/{digest}.{ext}`), so a format
    change no longer orphans a sibling extension at generation time. Generation must
    not delete anything at all: the persona row still names the previous image until
    the caller saves the new URL. The regeneration route sweeps superseded images
    (legacy flat keys of every extension included) after its update — see
    test_avatar_versioned_keys.py."""

    def test_no_delete_is_issued_while_generating(self):
        mock_s3, _ = generate_avatar_with_config(avatar_prompt_config('jpeg'))
        mock_s3.delete_object.assert_not_called()
        mock_s3.delete_objects.assert_not_called()
