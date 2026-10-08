"""
Tests for CloudFront signed-URL minting (issue #229).

The behavior that matters most here is FAILING CLOSED. `/avatars/*` and
`/prototypes/*` are restricted by a trusted key group, so an unsigned URL is
both useless and dangerous to emit: useless because CloudFront rejects it, and
dangerous because a code path that returns bare URLs is one key-group removal
away from being an open door again. Every "not configured" / "broken key" case
below therefore asserts None, not a fallback URL.
"""
from datetime import UTC, datetime
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import pytest


def _sign(url: str, **sign_kwargs) -> str:
    """Sign *url* and assert signing succeeded (sign_url fails closed to None)."""
    from shared.cloudfront_signing import sign_url

    signed = sign_url(url, **sign_kwargs)
    assert signed is not None
    return signed


def _signed_params(url: str, **sign_kwargs) -> dict[str, list[str]]:
    """The query parameters of the signed form of *url*."""
    return parse_qs(urlparse(_sign(url, **sign_kwargs)).query)


class TestIsConfigured:
    def test_false_without_env(self):
        from shared.cloudfront_signing import is_configured
        with patch.dict('os.environ', {'CDN_SIGNING_SECRET_ARN': '', 'CDN_SIGNING_KEY_PAIR_ID': ''}):
            assert is_configured() is False

    def test_false_when_only_secret_is_set(self):
        from shared.cloudfront_signing import is_configured
        with patch.dict('os.environ', {'CDN_SIGNING_SECRET_ARN': 'arn:x', 'CDN_SIGNING_KEY_PAIR_ID': ''}):
            assert is_configured() is False

    def test_false_when_only_key_pair_id_is_set(self):
        from shared.cloudfront_signing import is_configured
        with patch.dict('os.environ', {'CDN_SIGNING_SECRET_ARN': '', 'CDN_SIGNING_KEY_PAIR_ID': 'K1'}):
            assert is_configured() is False

    @pytest.mark.usefixtures("cdn_signing_configured")
    def test_true_when_both_are_set(self):
        from shared.cloudfront_signing import is_configured
        assert is_configured() is True


class TestSignUrl:
    URL = 'https://d111.cloudfront.net/avatars/persona_1.jpeg'

    @pytest.mark.usefixtures("cdn_signing_configured")
    def test_appends_the_three_cloudfront_parameters(self):
        signed = _sign(self.URL)

        assert signed.startswith(f'{self.URL}?')
        params = parse_qs(urlparse(signed).query)
        assert set(params) == {'Expires', 'Signature', 'Key-Pair-Id'}
        assert params['Key-Pair-Id'] == ['K2TESTKEYPAIRID']

    @pytest.mark.usefixtures("cdn_signing_configured")
    def test_signature_avoids_characters_that_break_urls(self):
        signature = _signed_params(self.URL)['Signature'][0]

        # CloudFront's base64 variant replaces + / = with - ~ _
        assert not set('+/=') & set(signature)

    @pytest.mark.usefixtures("cdn_signing_configured")
    def test_preserves_an_existing_query_string(self):
        signed = _sign(f'{self.URL}?v=2')

        assert '?v=2&' in signed
        assert signed.count('?') == 1

    @pytest.mark.usefixtures("cdn_signing_configured")
    def test_returns_none_for_empty_url(self):
        from shared.cloudfront_signing import sign_url
        assert sign_url('') is None


class TestSignatureVerifies:
    def test_signature_validates_against_the_public_key(self, cdn_signing_configured):
        """End-to-end crypto check: recompute what CloudFront does.

        Without this, every other test here would pass on a signature that is
        well-formed but cryptographically wrong — which is exactly the failure
        that only shows up as a 403 after deploying.
        """
        import base64

        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding, rsa

        url = 'https://d111.cloudfront.net/prototypes/proj_1/prototype_1.html'
        frozen_now = datetime(2026, 1, 1, tzinfo=UTC)
        with patch('shared.cloudfront_signing.datetime') as mock_datetime:
            mock_datetime.now.return_value = frozen_now
            params = _signed_params(url, ttl_seconds=600)
        mock_datetime.now.assert_called_once_with(UTC)
        assert params['Expires'] == ['1767226200']

        # Undo CloudFront's base64 variant.
        raw_signature = base64.b64decode(
            params['Signature'][0].replace('-', '+').replace('_', '=').replace('~', '/')
        )

        def canned_policy(resource: str) -> bytes:
            # The exact document CloudFront rebuilds and checks: no whitespace,
            # this key order, the epoch as a bare integer.
            return (
                '{"Statement":[{"Resource":"' + resource + '",'
                '"Condition":{"DateLessThan":{"AWS:EpochTime":1767226200}}}]}'
            ).encode('utf-8')

        public_key = serialization.load_pem_public_key(
            cdn_signing_configured['publicKeyPem'].encode('utf-8')
        )
        assert isinstance(public_key, rsa.RSAPublicKey)
        # CloudFront's signed-URL format mandates RSA-SHA1 (see the module docstring).
        sha1 = hashes.SHA1()
        # verify() returns None on success and raises InvalidSignature on mismatch.
        assert public_key.verify(raw_signature, canned_policy(url), padding.PKCS1v15(), sha1) is None
        # The check is real: the same signature does not cover a different resource.
        with pytest.raises(InvalidSignature):
            public_key.verify(raw_signature, canned_policy(f'{url}x'), padding.PKCS1v15(), sha1)
