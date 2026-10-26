"""
Root pytest configuration for Lambda tests.

This conftest sets up the environment consistently for all tests,
preventing conflicts between different test directories.
"""
import json
import os
import sys
from unittest.mock import patch

import pytest

# Remove any layers directories from sys.path to avoid importing
# incomplete packages (missing compiled extensions like pydantic_core)
sys.path = [p for p in sys.path if 'lambda/layers' not in p and 'layers/' not in p]

# Set environment variables BEFORE any module imports
# These are the common environment variables needed by all handlers
os.environ.setdefault('AWS_DEFAULT_REGION', 'us-east-1')

# NEVER reach a real AWS account from a unit test. A fixture that runs before
# moto's mock starts (or a client cached from outside it) would otherwise sign
# requests with the developer's own credentials — that once created a real SQS
# queue. Forced, not setdefault: the developer's shell credentials must lose.
for _credential in ('AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN'):
    os.environ.pop(_credential, None)
os.environ['AWS_ACCESS_KEY_ID'] = 'testing'
os.environ['AWS_SECRET_ACCESS_KEY'] = 'testing'
os.environ['AWS_CONFIG_FILE'] = os.devnull
os.environ['AWS_SHARED_CREDENTIALS_FILE'] = os.devnull
os.environ['AWS_EC2_METADATA_DISABLED'] = 'true'
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
SIGNING_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-cdn-signing'
SIGNING_KEY_PAIR_ID = 'K2TESTKEYPAIRID'


# NOTE: shared.avatar's client-cache reset fixture deliberately lives in
# lambda/shared/test/conftest.py, not here. At this level it was autouse for every Python
# test in the repo, so ~1,400 tests imported shared.avatar for the benefit of about ten,
# and any import-time problem in that module would have failed collection for the whole
# suite — which matters because shared.avatar keeps a deliberately narrow import graph
# (it has its own guard test that importing it must not pull in `cryptography`).


@pytest.fixture(autouse=True)
def _strict_dynamodb_queries(monkeypatch):
    """moto made production-faithful for two rules it does not enforce.

    - A Query FilterExpression on a key attribute -> ValidationException (the
      /memory 502). See shared/test/strict_dynamodb.py.
    - A memory/agents Lambda calling a DynamoDB action its role lacks ->
      AccessDeniedException (the memory-scanner outage). See shared/test/strict_iam.py.
    """
    from shared.test import strict_dynamodb, strict_iam

    strict_dynamodb.install(monkeypatch)
    strict_iam.install(monkeypatch)


@pytest.fixture(autouse=True)
def _reset_model_cooldowns():
    """Forget per-container model cooldowns between tests.

    shared.model_fallback remembers a model that failed for capacity for five
    minutes, so one test's throttled model would otherwise be skipped by the
    next. Cleared only when the module is already loaded: importing it here
    would pull powertools into every test's collection for no reason.
    """
    yield
    module = sys.modules.get('shared.model_fallback')
    if module is not None:
        module.cooldown_until.clear()


#: The random tail every `shared.ids.timestamped_id` gets under `fixed_id_suffix`.
FIXED_ID_SUFFIX = 'a1b2c3d4'


@pytest.fixture
def fixed_id_suffix():
    """Pin `shared.ids`' random suffix so a minted id is a literal to compare against.

    Ids are ``<prefix>_<stamp>_<8 hex>``; with the clock pinned too, a test can
    spell the exact id. Yields the suffix.
    """
    from unittest.mock import patch

    with patch('shared.ids.secrets.token_hex', return_value=FIXED_ID_SUFFIX):
        yield FIXED_ID_SUFFIX


def _clear_signer_cache() -> None:
    """Drop shared.cloudfront_signing's per-container key and signer caches.

    Both are `lru_cache`d for the life of the execution environment, so a test
    that configures signing would otherwise be served a signer an earlier test
    built (or keep a stale one after it changes the secret).
    """
    from shared import cloudfront_signing

    cloudfront_signing._load_private_key.cache_clear()
    cloudfront_signing._signer.cache_clear()


@pytest.fixture
def reset_signer_cache():
    """Clear the CloudFront signer caches on the way in and out of one test."""
    _clear_signer_cache()
    yield
    _clear_signer_cache()


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

    def fake_get_secret_value(SecretId=None, **_kwargs):
        assert SecretId == SIGNING_SECRET_ARN
        return {'SecretString': json.dumps(cdn_signing_keypair)}

    shared_aws.clear_secret_cache()
    _clear_signer_cache()

    env = {
        'CDN_SIGNING_SECRET_ARN': SIGNING_SECRET_ARN,
        'CDN_SIGNING_KEY_PAIR_ID': SIGNING_KEY_PAIR_ID,
    }
    with patch.dict(os.environ, env), \
            patch.object(shared_aws, 'get_secrets_client') as mock_client:
        mock_client.return_value.get_secret_value.side_effect = fake_get_secret_value
        yield cdn_signing_keypair

    shared_aws.clear_secret_cache()
    _clear_signer_cache()


@pytest.fixture(scope='session')
def imports_cryptography():
    """Return a predicate: does importing `module_name` pull in `cryptography`?

    Shared by the guards in test_avatar.py and test_prototypes.py. Both modules
    keep their `shared.cloudfront_signing` import inside the one function that
    signs, so the avatar/prototype WRITER paths (used by jobs that never mint a
    URL) do not depend on `cryptography` at cold start.

    Runs in a SUBPROCESS deliberately: `cryptography` is already in sys.modules
    for most of this suite — the signing tests and the cdn_signing_keypair
    fixture both use it — so an in-process `'cryptography' in sys.modules` check
    would pass no matter what the import graph looks like.
    """
    import subprocess
    import sys

    # Anchored on this file, never on the caller's cwd: a hardcoded relative cwd
    # made an earlier version of this check fail with FileNotFoundError instead
    # of on the property under test, depending on where pytest was invoked from.
    lambda_dir = os.path.dirname(os.path.abspath(__file__))

    def _check(module_name: str) -> bool:
        code = f"import sys; import {module_name}; print('cryptography' in sys.modules)"
        # check=False on purpose: with check=True, a module that fails to import
        # at all surfaces as an opaque CalledProcessError instead of anything
        # readable, which is the same "fails for the wrong-looking reason" trap
        # the hardcoded cwd used to cause. Surface the child's stderr instead.
        result = subprocess.run(
            [sys.executable, '-c', code],
            capture_output=True, text=True, check=False, cwd=lambda_dir,
        )
        if result.returncode != 0:
            raise AssertionError(
                f'could not import {module_name} in a subprocess '
                f'(exit {result.returncode}):\n{result.stderr.strip()}'
            )
        return result.stdout.strip() == 'True'

    return _check
