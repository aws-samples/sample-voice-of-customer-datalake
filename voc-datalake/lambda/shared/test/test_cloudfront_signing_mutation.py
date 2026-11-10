"""
Mutation-hardening for shared/cloudfront_signing.py (signed URLs for /avatars/* and
/prototypes/*).

What the mutation run found that test_cloudfront_signing.py could not see:
- Expiry was only checked within a 30-60 s tolerance, so a fallback TTL of 3601 and
  a positivity guard of `> 1` both survived. The clock is frozen here and every
  `Expires` is an exact epoch, including the 1-second boundary.
- The env defaults were only exercised with the variables SET to '', never unset,
  so a non-empty default (which would report signing as configured) survived.
- Every refusal returned None, and nothing checked why. Each refusal's log line
  (the message and the `extra` flags) is now pinned, so a fallback can't hide
  behind a different failure.
- The canned policy was rebuilt from the URL's own Expires; the verify test in
  test_cloudfront_signing.py now checks a literal document with a literal epoch,
  and this file pins the URL shape and parameter order.
"""
import json
from collections.abc import Iterator
from datetime import datetime
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlparse

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from shared import aws as shared_aws
from shared import cloudfront_signing

URL = 'https://d111.cloudfront.net/avatars/persona_1.jpeg'
NOW_EPOCH = 1767225600  # 2026-01-01T00:00:00Z
NOT_CONFIGURED_MESSAGE = (
    'CloudFront URL signing is not configured; refusing to return an '
    'unsigned URL for a private CDN path'
)


class _FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 1, 1, tzinfo=tz)


@pytest.fixture
def frozen_clock() -> Iterator[None]:
    with patch.object(cloudfront_signing, 'datetime', _FrozenDatetime):
        yield


@pytest.fixture
def mock_logger() -> Iterator[MagicMock]:
    with patch.object(cloudfront_signing, 'logger') as logger:
        yield logger


def _ec_private_key_pem() -> str:
    """A valid PEM whose key is not RSA (CloudFront can only verify RSA-SHA1)."""
    return ec.generate_private_key(ec.SECP256R1()).private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode('utf-8')


def _expires(**sign_kwargs) -> int:
    signed = cloudfront_signing.sign_url(URL, **sign_kwargs)
    assert signed is not None
    return int(parse_qs(urlparse(signed).query)['Expires'][0])


@pytest.mark.usefixtures('cdn_signing_configured', 'frozen_clock')
class TestExpiryIsExact:
    def test_the_fallback_ttl_is_one_hour(self):
        assert cloudfront_signing.FALLBACK_TTL_SECONDS == 3600

    def test_default_expiry_is_now_plus_3600(self, monkeypatch):
        monkeypatch.delenv('CDN_SIGNED_URL_TTL_SECONDS', raising=False)
        assert _expires() == NOW_EPOCH + 3600

    @pytest.mark.parametrize(('raw', 'expected'), [
        ('1', NOW_EPOCH + 1),
        ('2', NOW_EPOCH + 2),
        ('120', NOW_EPOCH + 120),
        ('0', NOW_EPOCH + 3600),
        ('-1', NOW_EPOCH + 3600),
        ('', NOW_EPOCH + 3600),
        ('abc', NOW_EPOCH + 3600),
    ])
    def test_env_ttl_boundary(self, monkeypatch, raw, expected):
        monkeypatch.setenv('CDN_SIGNED_URL_TTL_SECONDS', raw)
        assert _expires() == expected

    @pytest.mark.parametrize('ttl', [1, 90, 7200])
    def test_explicit_ttl_wins_over_env(self, monkeypatch, ttl):
        monkeypatch.setenv('CDN_SIGNED_URL_TTL_SECONDS', '120')
        assert _expires(ttl_seconds=ttl) == NOW_EPOCH + ttl


class TestTheExactPolicyIsSigned:
    @pytest.mark.usefixtures('cdn_signing_configured', 'frozen_clock')
    def test_url_shape_and_parameter_order(self):
        signed = cloudfront_signing.sign_url(URL, ttl_seconds=600)
        assert signed is not None
        query = urlparse(signed).query
        assert signed == f'{URL}?{query}'
        keys = [pair.split('=', 1)[0] for pair in query.split('&')]
        assert keys == ['Expires', 'Signature', 'Key-Pair-Id']
        params = parse_qs(query)
        assert params['Expires'] == ['1767226200']
        assert params['Key-Pair-Id'] == ['K2TESTKEYPAIRID']
        # The signature itself is verified against the literal policy document in
        # test_cloudfront_signing.py::TestSignatureVerifies (the file allowed SHA1).


class TestUnsetEnvMeansNotConfigured:
    @pytest.mark.parametrize(('present', 'value'), [
        ('CDN_SIGNING_SECRET_ARN', 'arn:x'),
        ('CDN_SIGNING_KEY_PAIR_ID', 'K1'),
    ])
    def test_one_variable_absent(self, monkeypatch, present, value):
        monkeypatch.delenv('CDN_SIGNING_SECRET_ARN', raising=False)
        monkeypatch.delenv('CDN_SIGNING_KEY_PAIR_ID', raising=False)
        monkeypatch.setenv(present, value)
        assert cloudfront_signing.is_configured() is False


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('env', 'extra'), [
        ({}, {'has_secret': False, 'has_key_pair_id': False}),
        ({'CDN_SIGNING_SECRET_ARN': 'arn:x'}, {'has_secret': True, 'has_key_pair_id': False}),
        ({'CDN_SIGNING_KEY_PAIR_ID': 'K1'}, {'has_secret': False, 'has_key_pair_id': True}),
    ])
    def test_not_configured(self, monkeypatch, mock_logger, env, extra):
        monkeypatch.delenv('CDN_SIGNING_SECRET_ARN', raising=False)
        monkeypatch.delenv('CDN_SIGNING_KEY_PAIR_ID', raising=False)
        for key, value in env.items():
            monkeypatch.setenv(key, value)

        assert cloudfront_signing.sign_url(URL) is None
        mock_logger.error.assert_called_once_with(NOT_CONFIGURED_MESSAGE, extra=extra)
        mock_logger.exception.assert_not_called()

    def test_empty_url_logs_nothing(self, mock_logger):
        assert cloudfront_signing.sign_url('') is None
        assert mock_logger.mock_calls == []

    @pytest.mark.usefixtures('reset_signer_cache')
    @pytest.mark.parametrize(('secret', 'message'), [
        ({'password': 'seeded-by-cdk'},
         'Failed to sign CloudFront URL: signing secret has no privateKeyPem'),
        ({'privateKeyPem': _ec_private_key_pem()},
         'Failed to sign CloudFront URL: CloudFront signing key must be RSA, got ECPrivateKey'),
    ])
    def test_unusable_secret(self, monkeypatch, mock_logger, secret, message):
        """A secret that exists but holds no usable RSA key (CDK seeds it with a
        random password before the custom resource writes the key) must not
        degrade to an unsigned URL."""
        monkeypatch.setenv('CDN_SIGNING_SECRET_ARN', 'arn:aws:secretsmanager:us-east-1:1:secret:x')
        monkeypatch.setenv('CDN_SIGNING_KEY_PAIR_ID', 'K1')
        shared_aws.clear_secret_cache()
        try:
            with patch.object(shared_aws, 'get_secrets_client') as mock_client:
                mock_client.return_value.get_secret_value.return_value = {
                    'SecretString': json.dumps(secret),
                }
                assert cloudfront_signing.sign_url(URL) is None
        finally:
            shared_aws.clear_secret_cache()
        mock_logger.exception.assert_called_once_with(message)
        mock_logger.error.assert_not_called()
