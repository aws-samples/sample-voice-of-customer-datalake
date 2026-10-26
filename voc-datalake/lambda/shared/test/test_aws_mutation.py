"""Mutation hardening for `shared/aws.py`.

`test_aws.py` pins the secret cache, the `is_conditional_check_failure`
predicate and the Bedrock budget ARITHMETIC, but a mutation run found 36
survivors it cannot see:

* every other client factory: `get_dynamodb_resource`, `get_s3_client`,
  `get_sqs_client`, `get_secrets_client` and `get_lambda_client` had no test at
  all (the module docstring of `test_aws.py` says they were dropped as "only
  verify boto3 is called"), so the service name, the `is None` cache check, the
  S3 `s3v4` signature and the six cold-start `None` sentinels all mutated freely.
  A sentinel that is `""` instead of `None` returns `""` as the client forever.
* the LITERAL Bedrock numbers. The earlier tests compare the client against the
  constants (tautological for the constants themselves) and check `< 900` and
  `>= 30`, so `840 → 841` and `10 → 11` passed. The 60 s reserve under the
  15-minute ceiling is a stated design decision, so it is pinned as 60.
* `put_secret_json`: the 65,536-byte service limit, which side of it is still
  accepted, the exact refusal message, and that the write is skipped on
  refusal — none of it was tested from this module.
* `get_secret`'s LRU size (10) and the text/`exc_info` of its failure log, and
  the exact `BEDROCK_MODEL_ID` (only `claude`/`sonnet` substrings were checked).
"""
import json
from types import ModuleType
from unittest.mock import MagicMock, patch

import pytest

import shared.aws as shared_aws
from shared.exceptions import ValidationError
from shared.test.repo_paths import fresh_module_copy

_FACTORY_SENTINELS = [
    ('get_dynamodb_resource', '_dynamodb_resource', 'resource', 'dynamodb'),
    ('get_s3_client', '_s3_client', 'client', 's3'),
    ('get_sqs_client', '_sqs_client', 'client', 'sqs'),
    ('get_secrets_client', '_secrets_client', 'client', 'secretsmanager'),
    ('get_bedrock_client', '_bedrock_client', 'client', 'bedrock-runtime'),
    ('get_lambda_client', '_lambda_client', 'client', 'lambda'),
    # The plugin circuit breaker's DisableRule goes through this one.
    ('get_eventbridge_client', '_eventbridge_client', 'client', 'events'),
]


def _fresh_module() -> ModuleType:
    """`shared/aws.py` executed as a NEW module, so every cache is at its cold-start value.

    Not a reload: every importer holds `get_secret` and the factories by
    reference, and a reload would split the `lru_cache` the whole session shares.
    """
    return fresh_module_copy(shared_aws)


class TestEveryClientFactoryBuildsOnceFromAColdStart:
    """Each factory has exactly one observable contract: on a cold start it asks
    boto3 for ONE named service and hands that object back, then returns the same
    object without asking again. A `""` sentinel, an inverted `is None`, a mangled
    service name or a factory that stores `None` each break a different half."""

    @pytest.mark.parametrize('sentinel', [row[1] for row in _FACTORY_SENTINELS])
    def test_the_cold_start_sentinel_is_none(self, sentinel):
        assert getattr(_fresh_module(), sentinel) is None

    @pytest.mark.parametrize(('factory', 'sentinel', 'boto_method', 'service'), _FACTORY_SENTINELS)
    def test_the_first_call_builds_the_named_service_and_the_second_reuses_it(
        self, factory, sentinel, boto_method, service,
    ):
        fresh = _fresh_module()
        built = MagicMock(name=f'{service}-client')
        with patch.object(fresh, 'boto3') as boto3_mock:
            getattr(boto3_mock, boto_method).return_value = built
            first = getattr(fresh, factory)()
            second = getattr(fresh, factory)()

        constructor: MagicMock = getattr(boto3_mock, boto_method)
        assert constructor.call_count == 1
        assert constructor.call_args.args == (service,)
        assert first is built
        assert second is built
        assert getattr(fresh, sentinel) is built

    @pytest.mark.parametrize(
        ('factory', 'sentinel', 'boto_method'),
        [row[:3] for row in _FACTORY_SENTINELS],
    )
    def test_a_sentinel_that_is_already_set_is_returned_without_building(
        self, factory, sentinel, boto_method,
    ):
        fresh = _fresh_module()
        cached = object()
        setattr(fresh, sentinel, cached)
        with patch.object(fresh, 'boto3') as boto3_mock:
            assert getattr(fresh, factory)() is cached
        constructor: MagicMock = getattr(boto3_mock, boto_method)
        assert constructor.call_count == 0

    def test_only_s3_and_bedrock_pass_a_config(self):
        fresh = _fresh_module()
        with patch.object(fresh, 'boto3') as boto3_mock:
            fresh.get_dynamodb_resource()
            fresh.get_s3_client()
            fresh.get_sqs_client()
            fresh.get_secrets_client()
            fresh.get_bedrock_client()
            fresh.get_lambda_client()

        assert boto3_mock.resource.call_args_list[0].kwargs == {}
        kwargs_by_service = {
            call.args[0]: sorted(call.kwargs) for call in boto3_mock.client.call_args_list
        }
        assert kwargs_by_service == {
            's3': ['config'],
            'sqs': [],
            'secretsmanager': [],
            'bedrock-runtime': ['config'],
            'lambda': [],
        }


class TestTheS3ClientSignsWithSigV4:
    """KMS-encrypted buckets reject SigV2; the signature version is the one
    thing the S3 factory configures, and nothing checked it."""

    def test_signature_version_is_s3v4(self):
        fresh = _fresh_module()
        with patch.object(fresh, 'boto3') as boto3_mock:
            fresh.get_s3_client()

        config = boto3_mock.client.call_args.kwargs['config']
        assert config.signature_version == 's3v4'


class TestTheBedrockBudgetLiterals:
    """`test_aws.py` pins the arithmetic (`< 900`, `>= 30`) and that the client
    carries the constants; it does not pin the constants, so 841 and 11 passed."""

    def test_read_timeout_is_840_seconds(self):
        assert shared_aws.BEDROCK_READ_TIMEOUT_SECONDS == 840

    def test_connect_timeout_is_10_seconds(self):
        assert shared_aws.BEDROCK_CONNECT_TIMEOUT_SECONDS == 10

    def test_the_reserve_under_the_lambda_ceiling_is_exactly_60_seconds(self):
        """The module comment states the 60 s left under 900 s is deliberate: it
        is what shared/jobs.py has to write the job `failed`."""
        budget = shared_aws.BEDROCK_READ_TIMEOUT_SECONDS * shared_aws.BEDROCK_MAX_ATTEMPTS
        assert 900 - budget == 60

    def test_the_client_receives_the_literals(self):
        fresh = _fresh_module()
        with patch.object(fresh, 'boto3') as boto3_mock:
            fresh.get_bedrock_client()

        config = boto3_mock.client.call_args.kwargs['config']
        assert config.read_timeout == 840
        assert config.connect_timeout == 10
        assert config.retries == {'max_attempts': 1, 'mode': 'standard'}


class TestTheDefaultModelIdIsExact:
    def test_the_fallback_is_the_sonnet_5_5_global_inference_profile(self):
        assert shared_aws.BEDROCK_MODEL_ID == 'global.anthropic.claude-sonnet-5-5'


class TestTheSecretCacheHoldsTenEntries:
    """`maxsize=10`: the eleventh distinct secret evicts the first; the tenth does not."""

    @staticmethod
    def _arn(i: int) -> str:
        return f'arn:aws:secretsmanager:us-east-1:123:secret:lru-{i}'

    @pytest.fixture
    def secrets_client(self) -> MagicMock:
        client = MagicMock()
        client.get_secret_value.side_effect = lambda SecretId: {
            'SecretString': json.dumps({'arn': SecretId})
        }
        return client

    def test_maxsize_is_10(self):
        assert shared_aws.get_secret.cache_info().maxsize == 10

    def test_ten_distinct_secrets_all_stay_cached(self, secrets_client):
        with patch('shared.aws.get_secrets_client', return_value=secrets_client):
            shared_aws.clear_secret_cache()
            for i in range(10):
                shared_aws.get_secret(self._arn(i))
            again = shared_aws.get_secret(self._arn(0))
            shared_aws.clear_secret_cache()

        assert again == {'arn': self._arn(0)}
        assert secrets_client.get_secret_value.call_count == 10

    def test_the_eleventh_distinct_secret_evicts_the_first(self, secrets_client):
        with patch('shared.aws.get_secrets_client', return_value=secrets_client):
            shared_aws.clear_secret_cache()
            for i in range(11):
                shared_aws.get_secret(self._arn(i))
            shared_aws.get_secret(self._arn(0))
            shared_aws.clear_secret_cache()

        assert secrets_client.get_secret_value.call_count == 12


class TestASecretFailureIsLoggedWithItsCauseAndTraceback:
    def test_the_log_line_names_the_secret_and_the_error_with_exc_info(self):
        client = MagicMock()
        client.get_secret_value.side_effect = PermissionError('Access denied')
        arn = 'arn:aws:secretsmanager:us-east-1:123:secret:logged'
        with patch('shared.aws.get_secrets_client', return_value=client), \
                patch('shared.aws.logger') as logger_mock:
            shared_aws.clear_secret_cache()
            result = shared_aws.get_secret(arn)
            shared_aws.clear_secret_cache()

        assert result == {}
        error_log: MagicMock = logger_mock.error
        error_log.assert_called_once_with(
            f'Failed to load secret {arn}: Access denied', exc_info=True,
        )


def _payload_of(size_bytes: int) -> dict:
    """A dict whose `json.dumps` is exactly *size_bytes* long: `{"k": "…"}` is 9 bytes of framing."""
    secrets = {'k': 'a' * (size_bytes - 9)}
    assert len(json.dumps(secrets).encode()) == size_bytes
    return secrets


class TestPutSecretJsonRefusesOnlyOverTheServiceLimit:
    """Secrets Manager rejects a SecretString over 65,536 bytes, so exactly
    65,536 must write and 65,537 must be refused BEFORE the write, with a 400
    body that states both numbers."""

    def test_the_limit_is_65536_bytes(self):
        assert shared_aws.SECRET_STRING_MAX_BYTES == 65536

    @pytest.mark.parametrize('size', [9, 65535, 65536])
    def test_at_or_under_the_limit_the_serialized_payload_is_written(self, size):
        client = MagicMock()
        secrets = _payload_of(size)

        shared_aws.put_secret_json(client, 'arn:secret', secrets)

        put: MagicMock = client.put_secret_value
        put.assert_called_once_with(SecretId='arn:secret', SecretString=json.dumps(secrets))

    @pytest.mark.parametrize('size', [65537, 70000])
    def test_over_the_limit_is_refused_before_any_write_naming_both_sizes(self, size):
        client = MagicMock()
        secrets = _payload_of(size)

        with pytest.raises(ValidationError) as exc:
            shared_aws.put_secret_json(client, 'arn:secret', secrets)

        assert str(exc.value) == (
            f'Configuration is too large to store: {size} bytes exceeds the '
            '65536-byte limit. Remove some entries and retry.'
        )
        assert client.put_secret_value.call_count == 0
