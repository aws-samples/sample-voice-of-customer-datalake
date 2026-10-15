"""
Tests for CloudFront signed-URL minting (issue #229).

The behavior that matters most here is FAILING CLOSED. `/avatars/*` and
`/prototypes/*` are restricted by a trusted key group, so an unsigned URL is
both useless and dangerous to emit: useless because CloudFront rejects it, and
dangerous because a code path that returns bare URLs is one key-group removal
away from being an open door again. Every "not configured" / "broken key" case
below therefore asserts None, not a fallback URL.
"""
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import pytest


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

    def test_true_when_both_are_set(self, cdn_signing_configured):
        from shared.cloudfront_signing import is_configured
        assert is_configured() is True


class TestSignUrl:
    URL = 'https://d111.cloudfront.net/avatars/persona_1.jpeg'

    def test_appends_the_three_cloudfront_parameters(self, cdn_signing_configured):
        from shared.cloudfront_signing import sign_url

        signed = sign_url(self.URL)

        assert signed.startswith(f'{self.URL}?')
        params = parse_qs(urlparse(signed).query)
        assert set(params) == {'Expires', 'Signature', 'Key-Pair-Id'}
        assert params['Key-Pair-Id'] == ['K2TESTKEYPAIRID']

    def test_signature_avoids_characters_that_break_urls(self, cdn_signing_configured):
        from shared.cloudfront_signing import sign_url

        signature = parse_qs(urlparse(sign_url(self.URL)).query)['Signature'][0]

        # CloudFront's base64 variant replaces + / = with - ~ _
        assert not set('+/=') & set(signature)

    def test_expiry_defaults_to_one_hour(self, cdn_signing_configured):
        from shared.cloudfront_signing import sign_url

        expires = int(parse_qs(urlparse(sign_url(self.URL)).query)['Expires'][0])

        expected = datetime.now(timezone.utc) + timedelta(hours=1)
        # Generous window: this asserts the order of magnitude, not the clock.
        assert abs(expires - int(expected.timestamp())) < 60

    def test_explicit_ttl_is_honored(self, cdn_signing_configured):
        from shared.cloudfront_signing import sign_url

        expires = int(parse_qs(urlparse(sign_url(self.URL, ttl_seconds=90)).query)['Expires'][0])

        expected = datetime.now(timezone.utc) + timedelta(seconds=90)
        assert abs(expires - int(expected.timestamp())) < 30

    def test_ttl_env_override(self, cdn_signing_configured):
        from shared.cloudfront_signing import sign_url

        with patch.dict('os.environ', {'CDN_SIGNED_URL_TTL_SECONDS': '120'}):
            expires = int(parse_qs(urlparse(sign_url(self.URL)).query)['Expires'][0])

        expected = datetime.now(timezone.utc) + timedelta(seconds=120)
        assert abs(expires - int(expected.timestamp())) < 30

    @pytest.mark.parametrize('bad_ttl', ['0', '-5', 'not-a-number', ''])
    def test_unusable_ttl_falls_back_to_the_default(self, cdn_signing_configured, bad_ttl):
        """A zero or negative TTL would mint URLs that are already expired,
        which is indistinguishable from a broken key when debugging."""
        from shared.cloudfront_signing import sign_url

        with patch.dict('os.environ', {'CDN_SIGNED_URL_TTL_SECONDS': bad_ttl}):
            expires = int(parse_qs(urlparse(sign_url(self.URL)).query)['Expires'][0])

        expected = datetime.now(timezone.utc) + timedelta(hours=1)
        assert abs(expires - int(expected.timestamp())) < 60

    def test_preserves_an_existing_query_string(self, cdn_signing_configured):
        from shared.cloudfront_signing import sign_url

        signed = sign_url(f'{self.URL}?v=2')

        assert '?v=2&' in signed
        assert signed.count('?') == 1

    def test_returns_none_for_empty_url(self, cdn_signing_configured):
        from shared.cloudfront_signing import sign_url
        assert sign_url('') is None

    def test_returns_none_when_not_configured(self):
        from shared.cloudfront_signing import sign_url
        with patch.dict('os.environ', {'CDN_SIGNING_SECRET_ARN': '', 'CDN_SIGNING_KEY_PAIR_ID': ''}):
            assert sign_url(self.URL) is None

    def test_returns_none_when_the_secret_has_no_private_key(self, cdn_signing_keypair):
        """A secret that exists but holds no key must not degrade to an unsigned
        URL. CDK seeds the secret with a random password before the custom
        resource populates it, so this state is reachable in a real deploy."""
        from shared import aws as shared_aws
        from shared import cloudfront_signing

        shared_aws.clear_secret_cache()
        cloudfront_signing.clear_signer_cache()
        env = {
            'CDN_SIGNING_SECRET_ARN': 'arn:aws:secretsmanager:us-east-1:1:secret:x',
            'CDN_SIGNING_KEY_PAIR_ID': 'K1',
        }
        try:
            with patch.dict('os.environ', env), \
                    patch.object(shared_aws, 'get_secrets_client') as mock_client:
                mock_client.return_value.get_secret_value.return_value = {
                    'SecretString': json.dumps({'password': 'seeded-by-cdk'}),
                }
                assert cloudfront_signing.sign_url(self.URL) is None
        finally:
            shared_aws.clear_secret_cache()
            cloudfront_signing.clear_signer_cache()


class TestSignatureVerifies:
    def test_signature_validates_against_the_public_key(self, cdn_signing_configured):
        """End-to-end crypto check: recompute what CloudFront does.

        Without this, every other test here would pass on a signature that is
        well-formed but cryptographically wrong — which is exactly the failure
        that only shows up as a 403 after deploying.
        """
        import base64

        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        from shared.cloudfront_signing import sign_url

        url = 'https://d111.cloudfront.net/prototypes/proj_1/prototype_1.html'
        signed = sign_url(url, ttl_seconds=600)
        params = parse_qs(urlparse(signed).query)
        expires = int(params['Expires'][0])

        # Undo CloudFront's base64 variant.
        raw_signature = base64.b64decode(
            params['Signature'][0].replace('-', '+').replace('_', '=').replace('~', '/')
        )
        policy = (
            '{"Statement":[{"Resource":"' + url + '",'
            '"Condition":{"DateLessThan":{"AWS:EpochTime":' + str(expires) + '}}}]}'
        )

        public_key = serialization.load_pem_public_key(
            cdn_signing_configured['publicKeyPem'].encode('utf-8')
        )
        # Raises InvalidSignature on mismatch.
        public_key.verify(raw_signature, policy.encode('utf-8'), padding.PKCS1v15(), hashes.SHA1())
