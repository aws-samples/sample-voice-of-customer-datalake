"""
Root pytest configuration for Lambda tests.

This conftest sets up the environment consistently for all tests,
preventing conflicts between different test directories.
"""
import os
import sys

# Remove any layers directories from sys.path to avoid importing
# incomplete packages (missing compiled extensions like pydantic_core)
sys.path = [p for p in sys.path if 'lambda/layers' not in p and 'layers/' not in p]

# Set environment variables BEFORE any module imports
# These are the common environment variables needed by all handlers
os.environ.setdefault('AWS_DEFAULT_REGION', 'us-east-1')
os.environ.setdefault('POWERTOOLS_SERVICE_NAME', 'test-voc')
os.environ.setdefault('POWERTOOLS_METRICS_NAMESPACE', 'TestVoC')
os.environ.setdefault('FEEDBACK_TABLE', 'test-feedback')
os.environ.setdefault('AGGREGATES_TABLE', 'test-aggregates')
os.environ.setdefault('CONVERSATIONS_TABLE', 'test-conversations')
os.environ.setdefault('PROJECTS_TABLE', 'test-projects')
os.environ.setdefault('JOBS_TABLE', 'test-jobs')
os.environ.setdefault('ALLOWED_ORIGIN', 'http://localhost:5173')
os.environ.setdefault('SECRETS_ARN', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secrets')
os.environ.setdefault('RAW_DATA_BUCKET', 'test-raw-data-bucket')
os.environ.setdefault('PROCESSING_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue')
os.environ.setdefault('USER_POOL_ID', 'us-east-1_testpool')

# Add lambda directory to path for shared module imports
lambda_dir = os.path.dirname(os.path.abspath(__file__))
if lambda_dir not in sys.path:
    sys.path.insert(0, lambda_dir)


# ── CloudFront URL signing (issue #229) ──────────────────────────────────────
# `/avatars/*` and `/prototypes/*` are restricted by a trusted key group, so
# every URL handed to a browser is signed. Signing FAILS CLOSED: with no key
# configured the helpers return None rather than an unsigned URL. Tests that
# expect a URL therefore have to opt in via the `cdn_signing_configured`
# fixture; tests that omit it are exercising the fail-closed path, which is the
# behavior worth defaulting to.
import json
from unittest.mock import patch

import pytest

SIGNING_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-cdn-signing'
SIGNING_KEY_PAIR_ID = 'K2TESTKEYPAIRID'


@pytest.fixture(scope='session')
def cdn_signing_keypair():
    """A real 2048-bit RSA keypair, generated once per test session.

    Real rather than a canned fixture because the point is to exercise the
    actual RSA-SHA1 signing path; key generation is ~50ms once.
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode('utf-8')
    public_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode('utf-8')
    return {'privateKeyPem': private_pem, 'publicKeyPem': public_pem}


@pytest.fixture
def cdn_signing_configured(cdn_signing_keypair):
    """Configure CloudFront URL signing for the duration of one test.

    Patches the Secrets Manager client rather than `shared.aws.get_secret` so
    the caching in that function is exercised too, and clears both caches on the
    way in and out — leaking a cached signer would let one test silently pass on
    another's configuration.
    """
    from shared import aws as shared_aws
    from shared import cloudfront_signing

    def fake_get_secret_value(SecretId=None, **_kwargs):
        assert SecretId == SIGNING_SECRET_ARN
        return {'SecretString': json.dumps(cdn_signing_keypair)}

    shared_aws.clear_secret_cache()
    cloudfront_signing.clear_signer_cache()

    env = {
        'CDN_SIGNING_SECRET_ARN': SIGNING_SECRET_ARN,
        'CDN_SIGNING_KEY_PAIR_ID': SIGNING_KEY_PAIR_ID,
    }
    with patch.dict(os.environ, env), \
            patch.object(shared_aws, 'get_secrets_client') as mock_client:
        mock_client.return_value.get_secret_value.side_effect = fake_get_secret_value
        yield cdn_signing_keypair

    shared_aws.clear_secret_cache()
    cloudfront_signing.clear_signer_cache()
