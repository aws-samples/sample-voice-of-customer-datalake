"""
Root conftest for all plugin tests.
Sets up paths before any imports happen.
"""
import os
import sys
from unittest.mock import patch

import pytest

# Add lambda directory to path for shared module imports FIRST
# This must happen before any plugin modules are imported
lambda_dir = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'lambda'
)
plugins_dir = os.path.dirname(os.path.abspath(__file__))

# Insert at beginning of path
sys.path.insert(0, lambda_dir)
sys.path.insert(0, plugins_dir)

# Set environment variables BEFORE any imports
os.environ.setdefault('WATERMARKS_TABLE', 'test-watermarks')
os.environ.setdefault('PROCESSING_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue')
os.environ.setdefault('RAW_DATA_BUCKET', '')
os.environ.setdefault('SECRETS_ARN', 'arn:aws:secretsmanager:us-east-1:123456789:secret:test')
os.environ.setdefault('BRAND_NAME', 'TestBrand')
os.environ.setdefault('BRAND_HANDLES', '["@testbrand", "testbrand"]')
os.environ.setdefault('SOURCE_PLATFORM', 'test_source')
os.environ.setdefault('AWS_DEFAULT_REGION', 'us-east-1')
os.environ.setdefault('POWERTOOLS_SERVICE_NAME', 'test-service')
os.environ.setdefault('POWERTOOLS_METRICS_NAMESPACE', 'TestVoC')
os.environ.setdefault('CIRCUIT_BREAKER_THRESHOLD', '3')
os.environ.setdefault('CIRCUIT_BREAKER_WINDOW', '5')
os.environ.setdefault('AUDIT_EVENT_BUS', '')
os.environ.setdefault('WEBHOOK_SECRET', 'test-webhook-secret')

# Credentials that cannot resolve to a real account. Belt to the braces of the
# fixture below: if a call somehow escapes it, this is what stops the request from
# being signed with a developer's or CI runner's live credentials.
os.environ.setdefault('AWS_ACCESS_KEY_ID', 'testing')
os.environ.setdefault('AWS_SECRET_ACCESS_KEY', 'testing')
os.environ.setdefault('AWS_SESSION_TOKEN', 'testing')
os.environ.setdefault('AWS_SECURITY_TOKEN', 'testing')
# Stops botocore reading ~/.aws/{config,credentials} and an EC2/ECS metadata
# endpoint, either of which can supply real credentials the four above do not
# cover.
os.environ.setdefault('AWS_EC2_METADATA_DISABLED', 'true')
# `pop`, not `setdefault`: the point is to DISCARD a value inherited from the
# developer's shell. Emptying the config file while leaving AWS_PROFILE pointing
# into it makes the profile unresolvable, so botocore raises ProfileNotFound the
# first time anything builds a client — and `_shared/audit.py` builds one at
# IMPORT time via Powertools' Tracer, which turns that into collection errors and
# zero tests run. CI never sets a profile, so this lands only on developers.
os.environ.pop('AWS_PROFILE', None)
os.environ.pop('AWS_DEFAULT_PROFILE', None)
os.environ.setdefault('AWS_CONFIG_FILE', os.devnull)
os.environ.setdefault('AWS_SHARED_CREDENTIALS_FILE', os.devnull)


@pytest.fixture(autouse=True)
def no_real_aws_calls():
    """Fail a plugin test that reaches AWS, rather than letting it succeed quietly.

    Every AWS-touching path in this tree swallows its own errors — `record_failure`
    and `_trip_breaker` in `circuit_breaker.py`, `get_secret` in `shared/aws.py`,
    `emit_audit_event` — so a test that misses a patch does not fail: the call goes
    out, the error is logged and discarded, and the assertion still passes. That is
    how three tests came to issue a real `dynamodb.Query` against whatever account
    the runner was credentialed for, invisibly. `AccessDeniedException` is the
    BENIGN outcome; a laptop or a CI role that does grant DynamoDB gets a genuine
    query and `put_item` against a live `test-watermarks`, and at the breaker's
    threshold a genuine `events:DisableRule`.

    Enforced at `botocore`'s single choke point rather than by patching each
    `get_*_client` accessor, because the accessors are what a test forgets to patch
    — a guard that shares the omission it is meant to catch is no guard. Raising
    (not returning a mock) is deliberate too: a silent mock would let the test pass
    on a code path nobody meant to exercise, which is the defect, one level up.

    The attempt is BOTH refused and recorded, and the recording is what the failure
    is reported from. Refusing alone is not enough to be loud: the very `except
    Exception` blocks that hid the real call would equally hide this AssertionError,
    leaving a green test that reached for AWS and was quietly stopped. Asserting
    after the test body has finished puts the report somewhere no `except` can
    reach.

    NOT compatible with `moto`'s `mock_aws` or `botocore.stub.Stubber`: both
    intercept this same `_make_api_call` seam, so a call they would have faked is
    refused here with a message that says "real", which is the wrong diagnosis to
    hand someone holding a `mock_aws` context. `moto` is already in
    `requirements-dev.txt` and used under `lambda/`, so this is a likely next step
    rather than a hypothetical. The compatible styles — and what every test in
    `plugins/` uses today — are patching the `get_*_client` / `get_dynamodb_resource`
    accessors, or `patch.object` on a specific method such as
    `CircuitBreaker.record_failure`.

    Yields the record of attempts, so a test whose SUBJECT is this guard can make a
    deliberate call, assert on it, and `.clear()` the list to say the attempt was
    intentional. That is the whole escape hatch — deliberately not a marker that
    disarms the patch, because a disarmed test is one that can still reach a real
    account, which is the thing being prevented. See
    `test_plugin_secret_isolation.py::TestNoPluginTestReachesRealAws`.
    """
    import botocore.client

    attempted = []

    def _refuse(self, operation_name, api_params):
        call = f"{self.meta.service_model.service_name}.{operation_name}"
        attempted.append(call)
        raise AssertionError(
            f"refused real AWS call: {call}. Patch the client accessor the code "
            "under test resolves through (`get_*_client` / `get_dynamodb_resource`) "
            "or the specific method. Note that `moto`'s mock_aws and "
            "botocore.stub.Stubber also route through this same seam, so neither "
            "can be used to fake a call here."
        )

    with patch.object(botocore.client.BaseClient, '_make_api_call', _refuse):
        yield attempted

    assert not attempted, (
        f"This test attempted real AWS calls: {sorted(set(attempted))}. They were "
        'refused, so nothing reached an account — but patch the boundary the code '
        'under test resolves through. Note that `_shared.circuit_breaker` imports '
        '`get_dynamodb_resource` itself, so patching '
        '`_shared.base_ingestor.get_dynamodb_resource` does NOT cover it; patch '
        '`base_ingestor.CircuitBreaker.record_failure` or '
        '`_shared.circuit_breaker.get_dynamodb_resource` as well.'
    )
