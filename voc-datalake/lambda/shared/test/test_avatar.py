"""Tests for shared.avatar module - avatar generation utilities."""

import base64
import json
import re
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock, patch

import pytest

from shared.test.avatar_fixtures import (
    avatar_after_image_model_raises,
    bedrock_runtime_only,
    image_model_response,
)

PROMPT_CONFIG = {
    'system_prompt': 'Generate image prompts',
    'user_prompt_template': 'Create avatar for {name}, {occupation}',
    'max_tokens': 200,
    'fallback_prompt_template': 'Headshot of a {occupation}',
}


def _prompt_with(converse_mock: MagicMock, persona: dict) -> str:
    """generate_avatar_prompt_with_llm with shared.converse.converse = *converse_mock*."""
    from shared.avatar import generate_avatar_prompt_with_llm

    with patch('shared.avatar.get_avatar_prompt_config', return_value=PROMPT_CONFIG), \
            patch('shared.converse.converse', converse_mock):
        return generate_avatar_prompt_with_llm(persona)



def _flat(url: str) -> str:
    """The URI with its per-image digest folded away: `.../avatars/p1/{digest}.jpeg` → `.../avatars/p1.jpeg`.

    Keys are content-addressed per image (see test_avatar_versioned_keys.py); these
    tests are about WHICH persona and format was written, not the digest.
    """
    return re.sub(r'/[0-9a-f]{24}\.', '.', url)

class TestGenerateAvatarPromptWithLlm:
    """The image-prompt writer resolves its text model through the picker (#273)."""

    def test_returns_the_models_prompt_stripped(self):
        converse = MagicMock(return_value='  Professional headshot of an engineer \n')

        result = _prompt_with(converse, {'name': 'Alice', 'identity': {'occupation': 'Engineer'}})

        assert result == 'Professional headshot of an engineer'

    def test_sends_the_configured_system_prompt_and_formatted_user_prompt(self):
        converse = MagicMock(return_value='p')

        _prompt_with(converse, {'name': 'Alice', 'identity': {'occupation': 'Pilot'}})

        assert converse.call_args.kwargs['system_prompt'] == 'Generate image prompts'
        assert converse.call_args.kwargs['prompt'] == 'Create avatar for Alice, Pilot'
        assert converse.call_args.kwargs['max_tokens'] == 200

    def test_falls_back_to_the_template_when_the_call_fails(self):
        converse = MagicMock(side_effect=RuntimeError('AccessDeniedException'))

        result = _prompt_with(converse, {'name': 'Carol', 'identity': {'occupation': 'Designer'}})

        assert result == 'Headshot of a Designer'

    def test_falls_back_to_the_template_when_the_model_answers_empty(self):
        converse = MagicMock(return_value='   ')

        result = _prompt_with(converse, {'name': 'X', 'identity': {'occupation': 'Chef'}})

        assert result == 'Headshot of a Chef'

    def test_fallback_uses_professional_without_an_occupation(self):
        converse = MagicMock(side_effect=RuntimeError('boom'))

        result = _prompt_with(converse, {'name': 'X', 'identity': {}})

        assert result == 'Headshot of a professional'


class TestGeneratePersonaAvatar:
    """Tests for generate_persona_avatar function."""

    @patch('shared.aws.get_s3_client')
    @patch('shared.avatar.boto3')
    @patch('shared.avatar.generate_avatar_prompt_with_llm')
    def test_successful_avatar_generation(self, mock_prompt, mock_boto3, mock_get_s3):
        """Generates avatar and uploads to S3."""
        from shared.avatar import generate_persona_avatar

        mock_prompt.return_value = 'A portrait prompt'

        # Mock Nova Canvas response
        mock_bedrock_runtime = MagicMock()
        mock_s3 = MagicMock()

        def client_factory(service, **_kwargs):
            if service == 'bedrock-runtime':
                return mock_bedrock_runtime
            return mock_s3

        mock_boto3.client.side_effect = client_factory
        # S3 comes from the shared module-cached, s3v4-pinned accessor now, not from a
        # per-call boto3.client('s3') — that construction was unsafe once the avatar loop
        # went concurrent, and the bucket is KMS-encrypted so it needs the pinned signer.
        mock_get_s3.return_value = mock_s3

        image_data = base64.b64encode(b'fake-png-data').decode()
        nova_response = json.dumps({'images': [image_data]}).encode()
        mock_bedrock_runtime.invoke_model.return_value = {
            'body': MagicMock(read=MagicMock(return_value=nova_response))
        }

        persona = {
            'persona_id': 'p123', 'name': 'Test Persona',
            'identity': {'occupation': 'Engineer'},
        }

        result = generate_persona_avatar(persona, s3_bucket='test-bucket')

        # Deliberately a LITERAL. Deriving the extension from
        # get_image_model_config() would take the expectation from the same
        # production code under test, so a wrong extension could never fail this.
        assert _flat(result['avatar_url']) == 's3://test-bucket/avatars/p123.jpeg'
        assert result['avatar_prompt'] == 'A portrait prompt'

    @pytest.mark.parametrize('error', [
        pytest.param(Exception("AccessDenied: not authorized"), id='access_denied'),
        pytest.param(Exception("ValidationException: invalid params"), id='validation_exception'),
        pytest.param(RuntimeError("Something broke"), id='generic_error'),
    ])
    @patch('shared.avatar.boto3')
    @patch('shared.avatar.generate_avatar_prompt_with_llm')
    def test_handles_image_model_errors_gracefully(self, mock_prompt, mock_boto3, error):
        """An image-model failure costs the avatar, never the persona or its prompt."""
        result = avatar_after_image_model_raises(mock_prompt, mock_boto3, error)
        assert result['avatar_url'] is None
        assert result['avatar_prompt'] == 'A prompt'


class TestGetAvatarCdnUrl:
    """Tests for get_avatar_cdn_url function."""

    @staticmethod
    def _signed_cdn_url(s3_uri: str, **kwargs) -> str:
        """get_avatar_cdn_url for a case that must produce a URL."""
        from shared.avatar import get_avatar_cdn_url
        result = get_avatar_cdn_url(s3_uri, **kwargs)
        assert result is not None
        return result

    @pytest.mark.usefixtures("cdn_signing_configured")
    def test_converts_s3_uri_to_signed_cdn_url(self):
        result = self._signed_cdn_url('s3://bucket/avatars/persona_123.png', cdn_url='https://cdn.example.com')
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

    @pytest.mark.usefixtures("cdn_signing_configured")
    def test_strips_trailing_slash_from_cdn_url(self):
        result = self._signed_cdn_url('s3://bucket/avatars/test.png', cdn_url='https://cdn.example.com/')
        assert result.startswith('https://cdn.example.com/test.png?')

    @pytest.mark.usefixtures("cdn_signing_configured")
    @patch.dict('os.environ', {'AVATARS_CDN_URL': 'https://env-cdn.example.com'})
    def test_uses_env_var_when_no_cdn_url_param(self):
        result = self._signed_cdn_url('s3://bucket/avatars/test.png')
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

    def _generate(self, persona_ids, config=None):
        """Generate avatars for several personas through one patched boto3 and
        report how many bedrock-runtime clients were constructed."""
        from shared.avatar import generate_persona_avatar

        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.return_value = image_model_response()

        client_factory = bedrock_runtime_only(mock_bedrock)

        with patch('shared.avatar.get_avatar_prompt_config', return_value=config or IMAGE_MODEL_TEST_CONFIG), \
             patch('shared.avatar.generate_avatar_prompt_with_llm', return_value='p'), \
             patch('shared.aws.get_s3_client', return_value=MagicMock()), \
             patch('shared.avatar.boto3') as mock_boto3:
            mock_boto3.client.side_effect = client_factory
            results = [
                generate_persona_avatar(
                    {'persona_id': persona_id, 'name': persona_id, 'identity': {}},
                    s3_bucket='b',
                )
                for persona_id in persona_ids
            ]
            bedrock_client_calls = [
                c for c in mock_boto3.client.call_args_list
                if c.args and c.args[0] == 'bedrock-runtime'
            ]
        return results, bedrock_client_calls

    def test_three_personas_build_one_client(self):
        results, client_calls = self._generate(['p1', 'p2', 'p3'])
        # Positive control: all three avatars really were produced, so the
        # single client is reuse and not three skipped generations.
        assert [_flat(r['avatar_url']) for r in results] == [
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
        _, first = self._generate(['p1'])
        assert first[0].kwargs['region_name'] == 'us-west-2'

        # Same process, no cache clear — only the configured region changes.
        eu_config = {
            **IMAGE_MODEL_TEST_CONFIG,
            'image_model': {**IMAGE_MODEL_TEST_CONFIG['image_model'], 'region': 'eu-west-1'},
        }
        _, second = self._generate(['p2'], config=eu_config)
        assert second[0].kwargs['region_name'] == 'eu-west-1'

    def test_concurrent_generations_still_build_one_client(self):
        """The persona generator now runs these calls in parallel, so several
        threads reach the cache at once. The lock must keep that to one client
        while every avatar still comes back."""
        from shared.avatar import generate_persona_avatar

        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.return_value = image_model_response()

        client_factory = bedrock_runtime_only(mock_bedrock)

        persona_ids = [f'p{i}' for i in range(6)]
        with patch('shared.avatar.get_avatar_prompt_config', return_value=IMAGE_MODEL_TEST_CONFIG), \
             patch('shared.avatar.generate_avatar_prompt_with_llm', return_value='p'), \
             patch('shared.aws.get_s3_client', return_value=MagicMock()), \
             patch('shared.avatar.boto3') as mock_boto3:
            mock_boto3.client.side_effect = client_factory
            with ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(
                    lambda pid: generate_persona_avatar(
                        {'persona_id': pid, 'name': pid, 'identity': {}},
                        s3_bucket='b',
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


class TestS3ClientIsSharedNotBuiltPerAvatar:
    """generate_persona_avatar built `boto3.client('s3')` on every call.

    That was already wasteful, and it became a thread-safety hazard the moment the
    persona generator started running these calls in parallel: boto3 clients are
    thread-safe to USE but constructing one is not (aws/boto3#1592) — the same hazard the
    region-pinned image client is cached to avoid, still present one function down.

    Asserted against the REAL accessor rather than a stub of it, because "we call
    get_s3_client()" is not the property that matters; "only one client is constructed"
    is. So shared.aws.boto3 is patched and the module cache reset, and the count is taken
    from actual client construction.
    """

    def _run(self, persona_ids, concurrent):
        import shared.aws as shared_aws
        from shared.avatar import generate_persona_avatar

        mock_bedrock = MagicMock()
        mock_bedrock.invoke_model.return_value = image_model_response()

        avatar_client_factory = bedrock_runtime_only(mock_bedrock)

        shared_aws._s3_client = None          # the cache outlives a test
        try:
            with patch('shared.avatar.get_avatar_prompt_config', return_value=IMAGE_MODEL_TEST_CONFIG), \
                 patch('shared.avatar.generate_avatar_prompt_with_llm', return_value='p'), \
                 patch('shared.aws.boto3') as shared_boto3, \
                 patch('shared.avatar.boto3') as avatar_boto3:
                avatar_boto3.client.side_effect = avatar_client_factory
                shared_boto3.client.return_value = MagicMock()

                def one(pid):
                    return generate_persona_avatar(
                        {'persona_id': pid, 'name': pid, 'identity': {}},
                        s3_bucket='b',
                    )

                if concurrent:
                    with ThreadPoolExecutor(max_workers=len(persona_ids)) as pool:
                        results = list(pool.map(one, persona_ids))
                else:
                    results = [one(pid) for pid in persona_ids]

                s3_constructions = [
                    c for c in shared_boto3.client.call_args_list
                    if c.args and c.args[0] == 's3'
                ]
            return results, s3_constructions
        finally:
            shared_aws._s3_client = None

    def test_six_sequential_avatars_build_one_s3_client(self):
        results, s3_constructions = self._run([f'p{i}' for i in range(6)], concurrent=False)
        # Positive control: every avatar really was produced, so "one client" is reuse
        # and not six generations that bailed out before reaching S3.
        assert [_flat(r['avatar_url']) for r in results] == [
            f's3://b/avatars/p{i}.jpeg' for i in range(6)
        ]
        assert len(s3_constructions) == 1, (
            f'built {len(s3_constructions)} S3 clients for 6 avatars'
        )

    def test_six_concurrent_avatars_build_one_s3_client(self):
        results, s3_constructions = self._run([f'p{i}' for i in range(6)], concurrent=True)
        assert sorted(_flat(r['avatar_url']) for r in results) == sorted(
            f's3://b/avatars/p{i}.jpeg' for i in range(6)
        )
        assert len(s3_constructions) == 1, (
            f'built {len(s3_constructions)} S3 clients across 6 concurrent avatars'
        )

    def test_the_shared_client_pins_the_v4_signer(self):
        """Why the shared accessor and not a local client: RAW_DATA_BUCKET is
        KMS-encrypted, which needs signature_version s3v4. Building the client here
        inherited botocore's default signer instead."""
        _, s3_constructions = self._run(['p1'], concurrent=False)
        config = s3_constructions[0].kwargs['config']
        assert config.signature_version == 's3v4'


class TestConcurrencyCeilingsCannotDrift:
    """The avatar fan-out's worker count and the image client's pool both size themselves
    against the maximum persona count. Those were independent literals whose only link
    was a comment, and a comment does not fail CI: raising the persona ceiling used to
    halve the fan-out benefit while every test still passed.

    Only the half of the lockstep that needs nothing outside `shared` lives here. The two
    assertions that must import `api.projects` / `projects_handler` are in
    lambda/api/test/test_projects_handler.py (TestPersonaCeilingIsShared) — the shared test
    tree should not depend on the api tree importing cleanly, which is the same isolation
    argument that moved the avatar cache fixture out of the root conftest.
    """

    def test_the_client_pool_covers_the_worker_ceiling(self):
        from shared.api import MAX_PERSONAS_PER_GENERATION
        from shared.avatar import IMAGE_CLIENT_POOL_CONNECTIONS

        assert IMAGE_CLIENT_POOL_CONNECTIONS >= MAX_PERSONAS_PER_GENERATION
