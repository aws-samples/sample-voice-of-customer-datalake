"""Builders shared by the avatar tests (`test_avatar`, `test_avatar_coverage`)."""
import base64
import json
from unittest.mock import MagicMock, patch


def image_model_response(image_bytes: bytes = b'bytes') -> dict:
    """An `invoke_model` response whose body carries one base64 image."""
    return {
        'body': MagicMock(read=MagicMock(return_value=json.dumps(
            {'images': [base64.b64encode(image_bytes).decode()]}).encode()))
    }


def bedrock_runtime_only(mock_bedrock: MagicMock):
    """A `boto3.client` stand-in handing out *mock_bedrock* for bedrock-runtime
    and a throwaway double for every other service."""
    def client_factory(service, **_kwargs):
        return mock_bedrock if service == 'bedrock-runtime' else MagicMock()

    return client_factory


def avatar_after_image_model_raises(mock_prompt, mock_boto3, error: BaseException) -> dict:
    """`generate_persona_avatar` for one persona whose image-model call raises
    *error*, with prompt generation answering 'A prompt'."""
    from shared.avatar import generate_persona_avatar

    mock_prompt.return_value = 'A prompt'
    mock_bedrock = MagicMock()
    mock_boto3.client.return_value = mock_bedrock
    mock_bedrock.invoke_model.side_effect = error

    return generate_persona_avatar(
        {'persona_id': 'p1', 'name': 'Test', 'identity': {}},
        s3_bucket='bucket',
    )


def avatar_prompt_config(output_format: str = 'jpeg') -> dict:
    """A minimal avatar prompt config with an image model in us-west-2."""
    return {
        'system_prompt': 'S', 'user_prompt_template': '{name}', 'max_tokens': 200,
        'fallback_prompt_template': 'H',
        'image_model': {'model_id': 'm', 'region': 'us-west-2',
                        'aspect_ratio': '1:1', 'output_format': output_format},
    }


def generate_avatar_with_config(config: dict, *, mock_s3: MagicMock | None = None,
                                image_bytes: bytes = b'bytes') -> tuple[MagicMock, dict]:
    """Generate persona p1's avatar into bucket ``b`` under *config*, with the
    image model answering *image_bytes* and S3 served by *mock_s3*.

    Returns ``(mock_s3, result)``.
    """
    mock_bedrock = MagicMock()
    mock_bedrock.invoke_model.return_value = image_model_response(image_bytes)
    if mock_s3 is None:
        mock_s3 = MagicMock()
    _, result = run_avatar_generation(config, mock_bedrock=mock_bedrock, mock_s3=mock_s3)
    return mock_s3, result


def run_avatar_generation(config: dict, *, mock_bedrock: MagicMock, mock_s3: MagicMock,
                          llm_prompt: str = 'p') -> tuple[MagicMock, dict]:
    """Run `generate_persona_avatar` for persona p1 into bucket ``b`` under
    *config*, with the image model served by *mock_bedrock*, S3 by *mock_s3*,
    and the LLM prompt step answering *llm_prompt*.

    The S3 client comes from shared.aws.get_s3_client (module-cached and
    s3v4-pinned), so it is stubbed at that accessor; shared.avatar.boto3 still
    covers the region-pinned image-model client.

    Returns ``(mock_boto3, result)`` so callers can inspect the clients built.
    """
    def client_factory(service, **_kwargs):
        return mock_bedrock if service == 'bedrock-runtime' else mock_s3

    with patch('shared.avatar.get_avatar_prompt_config', return_value=config), \
         patch('shared.avatar.generate_avatar_prompt_with_llm', return_value=llm_prompt), \
         patch('shared.aws.get_s3_client', return_value=mock_s3), \
         patch('shared.avatar.boto3') as mock_boto3:
        mock_boto3.client.side_effect = client_factory
        from shared.avatar import generate_persona_avatar
        result = generate_persona_avatar(
            {'persona_id': 'p1', 'name': 'N', 'identity': {}}, s3_bucket='b'
        )
    return mock_boto3, result
