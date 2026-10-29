"""Mutation hardening for `shared/avatar.py`.

`test_avatar.py` and `test_avatar_image_model_lockstep.py` (and the since-removed `test_avatar_coverage.py`)
pin the happy path, the config lockstep and that every failure degrades to
``avatar_url=None``, but a mutation run found 113 mutants they cannot see:

* every log line (the only signal an operator gets, since avatar failures are
  silent by design), its ``extra`` keys and ``exc_info`` — pinned here verbatim;
* the two helpers the project-delete path relies on, `avatar_object_keys` and
  `avatar_object_owner`, which no test under `shared/` exercised at all;
* the client configuration literals (pool 16, 3 attempts, 120 s / 10 s), which
  were only asserted as ``>=`` or truthy;
* the seed arithmetic at the top of the 32-bit range, where ``_MAX_SEED - 1``,
  ``- 2`` and ``+ 1`` differ — only reachable by driving the digest directly;
* the defaults (`'Unknown'`, `'unknown'`, `'1:1'`, the fallback prompt template,
  the 300-character bio cut) and the exact Stability request body;
* that a cached client is served WITHOUT taking the lock (the fast path of the
  double-checked cache), and that `generate_persona_avatar` is still traced.

The run also found one dead branch (`len(parts) < 2` in `get_avatar_cdn_url`,
unreachable behind the ``s3://`` check), which was removed.
"""
from __future__ import annotations

import hashlib
import json
import threading
from types import MappingProxyType
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from shared import avatar
from shared.avatar import (
    _MAX_SEED,
    AVATAR_OWNER_METADATA_KEY,
    IMAGE_CLIENT_CONNECT_TIMEOUT,
    IMAGE_CLIENT_MAX_ATTEMPTS,
    IMAGE_CLIENT_POOL_CONNECTIONS,
    IMAGE_CLIENT_READ_TIMEOUT,
    _stable_seed,
    avatar_object_key,
    avatar_object_keys,
    avatar_object_owner,
    generate_avatar_prompt_with_llm,
    generate_persona_avatar,
    get_avatar_cdn_url,
    get_image_model_client,
    get_image_model_config,
)
from shared.prompts import get_avatar_prompt_config
from shared.test.avatar_fixtures import image_model_response

IMAGE_MODEL = {'model_id': 'test.image-model', 'region': 'us-west-2',
               'aspect_ratio': '1:1', 'output_format': 'jpeg'}
CONFIG = {'system_prompt': 'S', 'user_prompt_template': '{name}', 'max_tokens': 200,
          'fallback_prompt_template': 'H', 'image_model': IMAGE_MODEL}
PERSONA = {'persona_id': 'p1', 'name': 'Test Persona', 'identity': {}}
# The content-addressed key the default stubbed image (b'image-bytes') is stored under.
KEY = avatar_object_key('p1', b'image-bytes', 'jpeg')


def _generate(persona: dict = PERSONA, *, config: dict = CONFIG, bedrock: MagicMock | None = None,
              s3: MagicMock | None = None, prompt: str = 'A prompt', env: dict[str, str] | None = None,
              **kwargs: Any) -> tuple[dict, MagicMock, MagicMock, MagicMock]:
    """generate_persona_avatar with every collaborator stubbed.

    A *bedrock* passed in is used as configured; the default answers one
    ``b'image-bytes'`` image. Returns ``(result, logger, bedrock, s3)``.
    """
    if bedrock is None:
        bedrock = MagicMock()
        bedrock.invoke_model.return_value = image_model_response(b'image-bytes')
    s3 = s3 if s3 is not None else MagicMock()
    with patch('shared.avatar.get_avatar_prompt_config', return_value=config), \
            patch('shared.avatar.generate_avatar_prompt_with_llm', return_value=prompt), \
            patch('shared.aws.get_s3_client', return_value=s3), \
            patch('shared.avatar.boto3') as boto3_mock, \
            patch('shared.avatar.logger') as logger, \
            patch('shared.avatar_failure.logger', logger), \
            patch.dict('os.environ', env or {}, clear=env is not None):
        boto3_mock.client.return_value = bedrock
        result = generate_persona_avatar(persona, **kwargs)
    return result, logger, bedrock, s3


def _info_messages(logger: MagicMock) -> list[str]:
    return [c.args[0] for c in logger.info.call_args_list]


class TestImageModelClientConfiguration:
    """The literals are the fan-out's contract, not lower bounds."""

    @staticmethod
    def _config():
        with patch('shared.avatar.boto3') as boto3_mock, patch('shared.avatar.logger') as logger:
            get_image_model_client('us-west-2')
        return boto3_mock.client.call_args, logger

    def test_the_pool_retries_and_timeouts_are_exactly_the_module_constants(self):
        call, _ = self._config()
        config = call.kwargs['config']
        assert call.args == ('bedrock-runtime',)
        assert call.kwargs['region_name'] == 'us-west-2'
        assert config.max_pool_connections == 16 == IMAGE_CLIENT_POOL_CONNECTIONS
        assert config.retries == {'mode': 'standard', 'max_attempts': 3}
        assert IMAGE_CLIENT_MAX_ATTEMPTS == 3
        assert config.read_timeout == 120 == IMAGE_CLIENT_READ_TIMEOUT
        assert config.connect_timeout == 10 == IMAGE_CLIENT_CONNECT_TIMEOUT

    def test_building_a_client_logs_the_region(self):
        _, logger = self._config()
        logger.info.assert_called_once_with(
            '[PERSONA_AVATAR] Creating Bedrock client for us-west-2 (image model region)')

    def test_a_cached_client_is_served_without_taking_the_lock(self):
        """The fast path reads the cache before locking, so a thread building the
        client for one region never stalls another thread's cached lookup."""
        cached = MagicMock(name='cached-client')
        avatar._image_model_clients['us-west-2'] = cached
        seen: list[object] = []
        worker = threading.Thread(target=lambda: seen.append(get_image_model_client('us-west-2')), daemon=True)
        with avatar._image_model_clients_lock:
            worker.start()
            worker.join(timeout=2)
            finished = not worker.is_alive()
        worker.join(timeout=2)
        assert finished, 'a cached lookup blocked on the construction lock'
        assert seen == [cached]

    def test_a_client_built_while_waiting_for_the_lock_is_reused_not_rebuilt(self):
        """The second read under the lock is what makes the cache race-free: a
        thread whose unlocked read missed must see the client another thread
        stored while it waited, instead of building a duplicate."""
        cached = MagicMock(name='client-built-by-the-other-thread')

        class CacheFilledBetweenReads(dict):
            reads = 0

            def get(self, key, default=None):
                self.reads += 1
                if self.reads == 1:
                    self[key] = cached
                    return None
                return super().get(key, default)

        cache = CacheFilledBetweenReads()
        with patch.object(avatar, '_image_model_clients', cache), patch('shared.avatar.boto3') as boto3_mock:
            assert get_image_model_client('us-west-2') is cached
        boto3_mock.client.assert_not_called()
        assert cache.reads == 2


class TestImageModelConfig:
    def test_the_block_is_read_as_written(self):
        cfg = {'image_model': {'model_id': 'm.x', 'region': 'eu-west-1', 'aspect_ratio': '4:5', 'output_format': 'png'}}
        with patch('shared.avatar.get_avatar_prompt_config', return_value=cfg):
            assert get_image_model_config() == cfg['image_model']

    def test_an_unsupported_format_is_logged_verbatim(self):
        cfg = {'image_model': {**IMAGE_MODEL, 'output_format': 'webp'}}
        with patch('shared.avatar.get_avatar_prompt_config', return_value=cfg), \
                patch('shared.avatar.logger') as logger:
            assert get_image_model_config()['output_format'] == 'jpeg'
        logger.warning.assert_called_once_with(
            "[PERSONA_AVATAR] Unsupported output_format 'webp'; falling back to 'jpeg' "
            "(supported: ['jpeg', 'png'])")


class TestAvatarObjectInventory:
    def test_every_historical_extension_in_order(self):
        assert avatar_object_keys('p1') == (
            'avatars/p1.png', 'avatars/p1.jpeg', 'avatars/p1.jpg', 'avatars/p1.webp')

    def test_a_generated_image_gets_its_own_content_addressed_key(self):
        expected = 'avatars/p1/' + hashlib.sha256(b'image-bytes').hexdigest()[:24] + '.jpeg'
        assert expected == KEY
        assert avatar_object_key('p1', b'other-bytes', 'jpeg') != KEY


class TestAvatarObjectOwner:
    def test_the_metadata_key_is_project_id(self):
        assert AVATAR_OWNER_METADATA_KEY == 'project-id'

    def test_reads_the_owner_from_the_head_metadata(self):
        s3 = MagicMock()
        s3.head_object.return_value = {'Metadata': {'project-id': 'proj_1'}}
        assert avatar_object_owner(s3, 'b', 'avatars/p1.jpeg') == 'proj_1'
        s3.head_object.assert_called_once_with(Bucket='b', Key='avatars/p1.jpeg')

    @pytest.mark.parametrize('response', [
        pytest.param({'Metadata': {'project-id': ''}}, id='empty_owner'),
        pytest.param({'Metadata': {'project-id': 7}}, id='non_string_owner'),
        pytest.param({'Metadata': {}}, id='no_owner_key'),
        pytest.param({'Metadata': 'x'}, id='metadata_not_a_dict'),
        pytest.param({}, id='no_metadata'),
        pytest.param(['not', 'a', 'dict'], id='response_not_a_dict'),
    ])
    def test_anything_short_of_a_non_empty_string_owner_is_none(self, response):
        s3 = MagicMock()
        s3.head_object.return_value = response
        assert avatar_object_owner(s3, 'b', 'k') is None

    def test_a_failed_head_is_none(self):
        s3 = MagicMock()
        s3.head_object.side_effect = RuntimeError('404')
        assert avatar_object_owner(s3, 'b', 'k') is None


class TestStableSeedAtTheTopOfTheRange:
    """Only digests within 3 of 2**32 tell ``_MAX_SEED - 1`` from its neighbours."""

    @staticmethod
    def _seed_for_digest(prefix: str) -> int:
        digest = MagicMock()
        digest.hexdigest.return_value = prefix + '0' * 56
        with patch('shared.avatar.hashlib') as hashlib_mock:
            hashlib_mock.sha256.return_value = digest
            seed = _stable_seed('p')
        hashlib_mock.sha256.assert_called_once_with(b'p')
        return seed

    def test_the_maximum_is_pinned(self):
        assert _MAX_SEED == 4294967294

    @pytest.mark.parametrize(('prefix', 'seed'), [
        ('00000000', 1),
        ('fffffffc', 4294967293),   # the largest seed ever produced: _MAX_SEED - 1
        ('fffffffd', 1),            # wraps exactly at _MAX_SEED - 1
        ('fffffffe', 2),
        ('ffffffff', 3),
    ])
    def test_seed_is_one_plus_digest_mod_max_minus_one(self, prefix, seed):
        assert self._seed_for_digest(prefix) == seed

    def test_a_real_persona_id_hashes_to_a_known_seed(self):
        # sha256('persona_abc') starts 279fbe76 → 1 + 0x279fbe76 % (_MAX_SEED - 1)
        assert _stable_seed('persona_abc') == 664780407


# Every key the bundled avatar-generation.json has (the code reads them unconditionally).
PROMPT_BASE = MappingProxyType({'system_prompt': '', 'user_prompt_template': '', 'max_tokens': 200,
                                'fallback_prompt_template': get_avatar_prompt_config()['fallback_prompt_template']})


class TestAvatarPromptBuilder:
    FULL_TEMPLATE = '{name}|{tagline}|{age_range}|{occupation}|{location}|{bio}'
    def _call(self, persona: dict, overrides: dict, converse: MagicMock | None = None) -> tuple[str, MagicMock, MagicMock]:
        converse = converse or MagicMock(return_value='p')
        with patch('shared.avatar.get_avatar_prompt_config', return_value={**PROMPT_BASE, **overrides}), \
                patch('shared.converse.converse', converse), \
                patch('shared.avatar.logger') as logger:
            result = generate_avatar_prompt_with_llm(persona)
        return result, converse, logger

    def test_every_persona_field_lands_in_its_slot(self):
        persona = {'name': 'Alice', 'tagline': 'Ships it', 'identity': {
            'bio': 'Builds things', 'age_range': '30-40', 'occupation': 'Engineer', 'location': 'Lyon'}}
        _, converse, _ = self._call(persona, {'user_prompt_template': self.FULL_TEMPLATE})
        assert converse.call_args.kwargs['prompt'] == 'Alice|Ships it|30-40|Engineer|Lyon|Builds things'

    def test_missing_fields_default_to_unknown_empty_and_n_a(self):
        _, converse, _ = self._call({}, {'user_prompt_template': self.FULL_TEMPLATE})
        assert converse.call_args.kwargs['prompt'] == 'Unknown|||||N/A'

    def test_the_bio_is_cut_at_exactly_300_characters(self):
        persona = {'name': 'A', 'identity': {'bio': 'x' * 300 + 'Y'}}
        _, converse, _ = self._call(persona, {'user_prompt_template': '{bio}'})
        assert converse.call_args.kwargs['prompt'] == 'x' * 300

    def test_config_values_and_fixed_call_arguments(self):
        _, converse, _ = self._call({'name': 'A'}, {'system_prompt': 'S'})
        converse.assert_called_once_with(
            prompt='', system_prompt='S', max_tokens=2248, temperature=None, surface='utility',
            step_name='persona_avatar_prompt', max_continuations=0)

    def test_configured_max_tokens_is_forwarded_with_thinking_headroom(self):
        _, converse, _ = self._call({'name': 'A'}, {'max_tokens': 64})
        assert converse.call_args.kwargs['max_tokens'] == 64 + 2048

    def test_the_bundled_fallback_template_on_a_failed_call(self):
        converse = MagicMock(side_effect=RuntimeError('throttled'))
        result, _, logger = self._call({'name': 'A', 'identity': {'occupation': 'Chef'}}, {}, converse)
        assert result == ('Professional headshot of a Chef, friendly expression, soft studio '
                          'lighting, neutral background, photorealistic')
        logger.exception.assert_called_once_with(
            '[PERSONA_AVATAR] LLM prompt generation failed: throttled, using fallback')

    def test_an_empty_answer_is_logged_as_a_warning(self):
        result, _, logger = self._call({'name': 'A', 'identity': {}}, {}, MagicMock(return_value=' \n'))
        assert result == ('Professional headshot of a professional, friendly expression, soft studio '
                          'lighting, neutral background, photorealistic')
        logger.warning.assert_called_once_with(
            '[PERSONA_AVATAR] LLM returned an empty image prompt, using fallback')


class TestGeneratePersonaAvatarHappyPath:
    def test_it_is_traced(self):
        assert vars(generate_persona_avatar)['__wrapped__'].__qualname__ == 'generate_persona_avatar'

    def test_the_stability_request_body_is_exact(self):
        _, _, bedrock, _ = _generate(s3_bucket='b')
        call = bedrock.invoke_model.call_args
        assert call.kwargs['modelId'] == 'test.image-model'
        assert json.loads(call.kwargs['body']) == {
            'prompt': 'A prompt', 'mode': 'text-to-image', 'aspect_ratio': '1:1',
            'output_format': 'jpeg', 'seed': _stable_seed('p1')}

    def test_the_put_carries_bytes_cache_control_and_the_owner_stamp(self):
        _, _, _, s3 = _generate(s3_bucket='b', project_id='proj_1')
        s3.put_object.assert_called_once_with(
            Bucket='b', Key=KEY, Body=b'image-bytes', ContentType='image/jpeg',
            CacheControl='public, max-age=31536000, immutable', Metadata={'project-id': 'proj_1'})

    def test_no_project_writes_an_empty_metadata_map(self):
        _, _, _, s3 = _generate(s3_bucket='b')
        assert s3.put_object.call_args.kwargs['Metadata'] == {}

    def test_a_persona_without_an_id_is_written_as_unknown(self):
        result, _, _, _ = _generate({'name': 'N', 'identity': {}}, s3_bucket='b')
        assert result['avatar_url'] == f"s3://b/{avatar_object_key('unknown', b'image-bytes', 'jpeg')}"

    def test_the_progress_log_lines_verbatim(self):
        _, logger, _, _ = _generate(s3_bucket='b')
        assert logger.info.call_args_list[0].args == ('[PERSONA_AVATAR] Starting avatar generation for Test Persona',)
        assert logger.info.call_args_list[0].kwargs == {'extra': {'persona_id': 'p1'}}
        assert _info_messages(logger) == [
            '[PERSONA_AVATAR] Starting avatar generation for Test Persona',
            '[PERSONA_AVATAR] Generating image prompt with Claude for Test Persona',
            '[PERSONA_AVATAR] Generated prompt: A prompt',
            '[PERSONA_AVATAR] Creating Bedrock client for us-west-2 (image model region)',
            '[PERSONA_AVATAR] Invoking image model: test.image-model',
            '[PERSONA_AVATAR] test.image-model generated 1 image(s)',
            f'[PERSONA_AVATAR] Uploading avatar to S3: s3://b/{KEY}',
            f'[PERSONA_AVATAR] SUCCESS - Avatar generated for Test Persona: s3://b/{KEY}',
        ]

    def test_a_nameless_persona_logs_as_unknown(self):
        _, logger, _, _ = _generate({'persona_id': 'p1', 'identity': {}}, s3_bucket='b')
        assert _info_messages(logger)[0] == '[PERSONA_AVATAR] Starting avatar generation for Unknown'


class TestBucketResolution:
    def test_the_env_bucket_is_used_when_none_is_passed(self):
        result, _, _, _ = _generate(env={'RAW_DATA_BUCKET': 'env-bucket'})
        assert result['avatar_url'] == f's3://env-bucket/{KEY}'

    def test_an_unset_env_var_stops_before_the_prompt_is_generated(self):
        result, logger, bedrock, _ = _generate(env={})
        assert result['avatar_url'] is None
        assert result['avatar_prompt'] is None
        assert result['failure']['reason'] == 'not_configured'
        logger.error.assert_called_once()
        assert 'RAW_DATA_BUCKET' in logger.error.call_args.args[0]
        assert logger.error.call_args.kwargs['extra']['stage'] == 'config'
        bedrock.invoke_model.assert_not_called()


def _no_image_bedrock(finish_reasons: list[str]) -> MagicMock:
    bedrock = MagicMock()
    bedrock.invoke_model.return_value = {'body': MagicMock(read=MagicMock(
        return_value=json.dumps({'images': [], 'finish_reasons': finish_reasons}).encode()))}
    return bedrock


class TestNoImageReturned:
    def test_a_filtered_answer_is_one_error_line_with_the_finish_reasons(self):
        result, logger, _, s3 = _generate(bedrock=_no_image_bedrock(['Filter reason']), s3_bucket='b')
        assert result['avatar_url'] is None
        assert result['avatar_prompt'] == 'A prompt'
        assert result['failure']['reason'] == 'content_filtered'
        assert result['failure']['error_code'] == 'NoImageReturned'
        logger.error.assert_called_once()
        assert logger.error.call_args.kwargs['extra']['aws_message'] == "finish_reasons=['Filter reason']"
        logger.warning.assert_not_called()
        s3.put_object.assert_not_called()

    def test_an_unexplained_empty_answer_is_an_error(self):
        result, _, _, _ = _generate(bedrock=_no_image_bedrock(['SUCCESS?']), s3_bucket='b')
        assert result['failure']['reason'] == 'error'


class ResourceNotFoundException(Exception):
    pass


class AccessDeniedException(Exception):
    pass


class ValidationException(Exception):
    pass


class FakeClientError(Exception):
    """A botocore ClientError's shape: the code lives in ``response['Error']``."""

    def __init__(self, code: str, message: str = 'aws says no'):
        super().__init__(f'An error occurred ({code}): {message}')
        self.response = {'Error': {'Code': code, 'Message': message}}


class TestEveryFailureIsOneClassifiedErrorLine:
    @staticmethod
    def _fail(error: Exception, *, at: str = 'invoke') -> tuple[dict, MagicMock]:
        bedrock = MagicMock()
        s3 = MagicMock()
        if at == 'invoke':
            bedrock.invoke_model.side_effect = error
        else:
            bedrock.invoke_model.return_value = image_model_response(b'image-bytes')
            s3.put_object.side_effect = error
        result, logger, _, _ = _generate(bedrock=bedrock, s3=s3, s3_bucket='b')
        return result, logger

    @pytest.mark.parametrize(('error', 'reason', 'code'), [
        pytest.param(AccessDeniedException('no'), 'no_access', 'AccessDeniedException', id='access_denied_by_type'),
        pytest.param(RuntimeError('AccessDenied: no'), 'no_access', 'RuntimeError', id='access_denied_by_message'),
        pytest.param(FakeClientError('AccessDeniedException'), 'no_access', 'AccessDeniedException',
                     id='access_denied_client_error'),
        pytest.param(ResourceNotFoundException('gone'), 'model_not_found', 'ResourceNotFoundException',
                     id='not_found_by_type'),
        pytest.param(FakeClientError('ValidationException', 'The provided model identifier is invalid.'),
                     'model_not_found', 'ValidationException', id='invalid_model_identifier'),
        pytest.param(FakeClientError('ThrottlingException'), 'throttled', 'ThrottlingException', id='throttled'),
        pytest.param(FakeClientError('ValidationException', 'Your request was blocked by content filters'),
                     'content_filtered', 'ValidationException', id='content_filtered'),
        pytest.param(ValidationException('bad'), 'validation', 'ValidationException', id='validation_by_type'),
        pytest.param(FakeClientError('ValidationException', 'This model is not supported in this region'),
                     'region_unavailable', 'ValidationException', id='region_by_message'),
        pytest.param(type('EndpointConnectionError', (Exception,), {})('no endpoint'), 'region_unavailable',
                     'EndpointConnectionError', id='endpoint_unreachable'),
        pytest.param(RuntimeError('boom'), 'error', 'RuntimeError', id='generic'),
    ])
    def test_the_failure_names_reason_code_model_and_region(self, error, reason, code):
        result, logger = self._fail(error)
        assert result['avatar_url'] is None
        assert result['avatar_prompt'] == 'A prompt'
        assert result['failure']['reason'] == reason
        assert result['failure']['error_code'] == code
        assert result['failure']['model_id'] == 'test.image-model'
        assert result['failure']['region'] == 'us-west-2'
        logger.error.assert_called_once()
        message = logger.error.call_args.args[0]
        assert message.startswith(f'[PERSONA_AVATAR] Avatar generation failed ({reason}, {code}): ')
        extra = logger.error.call_args.kwargs['extra']
        assert extra == {
            'persona_id': 'p1', 'avatar_failure_reason': reason, 'error_code': code,
            'model_id': 'test.image-model', 'region': 'us-west-2', 'stage': 'invoke',
            'aws_message': extra['aws_message'],
        }
        assert logger.error.call_args.kwargs['exc_info'] is True

    def test_the_error_line_carries_no_persona_name_or_prompt(self):
        _, logger = self._fail(FakeClientError('AccessDeniedException'))
        logged = repr(logger.error.call_args)
        assert 'Test Persona' not in logged
        assert 'A prompt' not in logged

    def test_an_access_denied_message_says_the_model_is_not_enabled_in_its_region(self):
        result, _ = self._fail(FakeClientError('AccessDeniedException'))
        assert result['failure']['message'].startswith(
            'the image model test.image-model is not enabled in us-west-2 for this account')
        assert '(AccessDeniedException)' in result['failure']['message']

    def test_an_upload_access_denied_is_not_read_as_a_model_problem(self):
        result, logger = self._fail(FakeClientError('AccessDenied'), at='upload')
        assert result['failure']['reason'] == 'error'
        assert 'storing it in the raw data bucket failed (AccessDenied)' in result['failure']['message']
        assert logger.error.call_args.kwargs['extra']['stage'] == 'upload'


class TestCdnUrl:
    def test_only_trailing_slashes_are_stripped_from_the_cdn_base(self):
        sign_url = MagicMock(return_value='signed')
        with patch('shared.cloudfront_signing.sign_url', sign_url):
            assert get_avatar_cdn_url('s3://b/avatars/t.jpeg', cdn_url='https://cdn.example.com/X//') == 'signed'
        sign_url.assert_called_once_with('https://cdn.example.com/X/t.jpeg')

    def test_an_unset_env_var_is_a_warning_and_none(self):
        with patch.dict('os.environ', {}, clear=True), patch('shared.avatar.logger') as logger:
            assert get_avatar_cdn_url('s3://b/avatars/t.jpeg') is None
        logger.warning.assert_called_once_with('AVATARS_CDN_URL not configured')

    def test_a_signing_failure_is_logged_with_the_uri(self):
        with patch('shared.cloudfront_signing.sign_url', side_effect=RuntimeError('no key')), \
                patch('shared.avatar.logger') as logger:
            assert get_avatar_cdn_url('s3://b/avatars/t.jpeg', cdn_url='https://cdn') is None
        logger.exception.assert_called_once_with('Failed to generate CDN URL for s3://b/avatars/t.jpeg: no key')
