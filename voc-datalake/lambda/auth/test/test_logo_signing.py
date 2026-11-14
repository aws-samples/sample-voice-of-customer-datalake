"""The invitation's logo link (auth/logo_signing.py): CloudFront-signed for as long as the invitation, or nothing."""
from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import boto3
import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from moto import mock_aws

from auth import logo_signing

SITE = 'https://d111.cloudfront.net'
KEY = 'company-context/design/logo_0123456789ab.png'
NOW = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)


def _pem(private_key) -> str:
    return private_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                     serialization.NoEncryption()).decode()


@pytest.fixture
def rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture
def signing(monkeypatch, rsa_key):
    """A signing secret in (moto) Secrets Manager and the two env vars the trigger gets."""
    monkeypatch.setattr(logo_signing, '_signer_cache', [])
    with mock_aws():
        arn = boto3.client('secretsmanager', region_name='us-east-1').create_secret(
            Name='cdn-signing', SecretString=json.dumps({'privateKeyPem': _pem(rsa_key)}))['ARN']
        monkeypatch.setenv('CDN_SIGNING_SECRET_ARN', arn)
        monkeypatch.setenv('CDN_SIGNING_KEY_PAIR_ID', 'K2EXAMPLE')
        yield rsa_key
    monkeypatch.setattr(logo_signing, '_signer_cache', [])


def _cloudfront_b64decode(value: str) -> bytes:
    return base64.b64decode(value.replace('-', '+').replace('_', '=').replace('~', '/'))


def _signed(key=KEY, site=SITE) -> tuple[str, dict[str, str]]:
    """A signed logo URL (required to exist) and its single-valued query parameters."""
    url = logo_signing.signed_logo_url(key, site, 7, now=NOW)
    assert url is not None
    return url, {name: values[0] for name, values in parse_qs(urlsplit(url).query).items()}


def _canned_policy(resource: str, expires: int | str) -> bytes:
    """CloudFront's canned policy, exactly as botocore's CloudFrontSigner serialises it."""
    condition = '{"DateLessThan":{"AWS:EpochTime":' + str(expires) + '}}'
    return ('{"Statement":[{"Resource":"' + resource + '","Condition":' + condition + '}]}').encode()


@pytest.mark.usefixtures('signing')
def test_signs_the_logo_url_for_as_long_as_the_invitation():
    url, query = _signed(site=SITE + '/')
    parts = urlsplit(url)
    assert f'{parts.scheme}://{parts.netloc}{parts.path}' == f'{SITE}/{KEY}'
    assert query['Key-Pair-Id'] == 'K2EXAMPLE'
    assert int(query['Expires']) == int((NOW + timedelta(days=7)).timestamp())


def test_the_signature_verifies_with_the_distribution_public_key(signing):
    _, query = _signed()
    policy = _canned_policy(f'{SITE}/{KEY}', query['Expires'])
    signing.public_key().verify(_cloudfront_b64decode(query['Signature']), policy, padding.PKCS1v15(),
                                hashes.SHA1())  # noqa: S303 - CloudFront's format


def test_a_signature_for_another_object_does_not_verify(signing):
    _, query = _signed()
    other = _canned_policy(f'{SITE}/avatars/x.png', query['Expires'])
    with pytest.raises(InvalidSignature):
        signing.public_key().verify(_cloudfront_b64decode(query['Signature']), other, padding.PKCS1v15(),
                                    hashes.SHA1())  # noqa: S303


@pytest.mark.usefixtures('signing')
@pytest.mark.parametrize('key', [
    None, '', 'company-context/design/logo_preview_0123456789ab.png', 'company-context/design/logo_0123.png',
    'avatars/p/x.png', 'company-context/design/logo_0123456789ab.svg', '../company-context/design/logo_0123456789ab.png',
])
def test_signs_nothing_but_an_uploaded_logo_key(key):
    assert logo_signing.signed_logo_url(key, SITE, 7, now=NOW) is None


@pytest.mark.usefixtures('signing')
@pytest.mark.parametrize(('site', 'days'), [('http://d111.cloudfront.net', 7), ('', 7), (SITE, 0), (SITE, -1)])
def test_signs_only_https_and_a_positive_lifetime(site, days):
    assert logo_signing.signed_logo_url(KEY, site, days, now=NOW) is None


def test_fails_closed_without_signing_configuration(monkeypatch):
    monkeypatch.setattr(logo_signing, '_signer_cache', [])
    monkeypatch.delenv('CDN_SIGNING_SECRET_ARN', raising=False)
    monkeypatch.delenv('CDN_SIGNING_KEY_PAIR_ID', raising=False)
    assert logo_signing.signed_logo_url(KEY, SITE, 7, now=NOW) is None


def test_fails_closed_when_the_secret_cannot_be_read(monkeypatch):
    monkeypatch.setattr(logo_signing, '_signer_cache', [])
    with mock_aws():
        monkeypatch.setenv('CDN_SIGNING_SECRET_ARN', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:missing')
        monkeypatch.setenv('CDN_SIGNING_KEY_PAIR_ID', 'K2EXAMPLE')
        assert logo_signing.signed_logo_url(KEY, SITE, 7, now=NOW) is None
        assert logo_signing._signer_cache == []  # not cached: the next invitation tries again


def test_fails_closed_for_a_key_that_is_not_rsa(monkeypatch):
    monkeypatch.setattr(logo_signing, '_signer_cache', [])
    with mock_aws():
        arn = boto3.client('secretsmanager', region_name='us-east-1').create_secret(
            Name='cdn-signing', SecretString=json.dumps({'privateKeyPem': _pem(ec.generate_private_key(ec.SECP256R1()))})
        )['ARN']
        monkeypatch.setenv('CDN_SIGNING_SECRET_ARN', arn)
        monkeypatch.setenv('CDN_SIGNING_KEY_PAIR_ID', 'K2EXAMPLE')
        assert logo_signing.signed_logo_url(KEY, SITE, 7, now=NOW) is None


@pytest.mark.usefixtures('signing')
def test_reads_the_secret_once_per_container(monkeypatch):
    logo_signing.signed_logo_url(KEY, SITE, 7, now=NOW)
    monkeypatch.setenv('CDN_SIGNING_SECRET_ARN', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:gone')
    assert logo_signing.signed_logo_url(KEY, SITE, 7, now=NOW) is not None
