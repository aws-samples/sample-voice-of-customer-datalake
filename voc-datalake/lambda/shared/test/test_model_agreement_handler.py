"""Behavioural tests for BedrockAccessStack's inline ModelAgreement handler.

The handler lives as an inline Python string inside
``lib/stacks/bedrock-access-stack.ts`` (``getModelAgreementLambdaCode``), so it
has no import path of its own. These tests extract that string and ``exec`` it
with a stubbed boto3, which is the only way to exercise its branches.

Fail-on-revert intent: a Private-Marketplace ``AccessDeniedException`` on
CreateFoundationModelAgreement must NOT fail the stack (the whole point of the
non-fatal branch), while every other error must still raise. Reverting either
half turns one of these red.

Precedent for reading a TS file from a Python test:
``test_avatar_image_model_lockstep.py``.
"""
import re
import sys
import types
from pathlib import Path

import pytest


def _repo_root() -> Path:
    # …/voc-datalake/lambda/shared/test/this_file.py -> …/voc-datalake
    return Path(__file__).resolve().parents[3]


def _handler_source() -> str:
    """Extract the inline handler body from the CDK stack."""
    ts = (_repo_root() / 'lib' / 'stacks' / 'bedrock-access-stack.ts').read_text(encoding='utf-8')
    match = re.search(
        r'private getModelAgreementLambdaCode\(\): string \{\s*return `(.*?)`;\s*\}',
        ts,
        re.DOTALL,
    )
    assert match, 'getModelAgreementLambdaCode() template literal not found'
    source = match.group(1)
    # The TS template literal escapes ${...} so Python f-strings survive.
    return source.replace('\\${', '${')


class _FakeClientError(Exception):
    """Stand-in for botocore ClientError (same .response shape)."""

    def __init__(self, code: str, message: str = 'denied'):
        super().__init__(message)
        self.response = {'Error': {'Code': code, 'Message': message}}


class _FakeConflict(Exception):
    pass


def _load_handler(*, create_raises: Exception | None = None):
    """exec the extracted handler with boto3/botocore stubbed out."""
    calls: dict[str, int] = {'create': 0}

    class _Bedrock:
        class exceptions:  # noqa: N801 — mirrors botocore's client.exceptions
            ConflictException = _FakeConflict
            AccessDeniedException = _FakeClientError

        def get_foundation_model_availability(self, modelId):  # noqa: N803
            return {'agreementAvailability': {'status': 'NOT_AVAILABLE'}}

        def list_foundation_model_agreement_offers(self, modelId):  # noqa: N803
            return {'offers': [{'offerToken': 'tok'}]}

        def create_foundation_model_agreement(self, modelId, offerToken):  # noqa: N803
            calls['create'] += 1
            if create_raises is not None:
                raise create_raises
            return {}

    fake_boto3 = types.ModuleType('boto3')
    fake_boto3.client = lambda *a, **k: _Bedrock()

    fake_botocore = types.ModuleType('botocore')
    fake_exceptions = types.ModuleType('botocore.exceptions')
    fake_exceptions.ClientError = _FakeClientError
    fake_botocore.exceptions = fake_exceptions

    saved = {k: sys.modules.get(k) for k in ('boto3', 'botocore', 'botocore.exceptions')}
    sys.modules['boto3'] = fake_boto3
    sys.modules['botocore'] = fake_botocore
    sys.modules['botocore.exceptions'] = fake_exceptions
    try:
        namespace: dict = {}
        exec(compile(_handler_source(), '<model-agreement-handler>', 'exec'), namespace)
        return namespace['handler'], calls
    finally:
        for key, value in saved.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value


def _event():
    return {'RequestType': 'Create', 'ResourceProperties': {'modelId': 'anthropic.claude-sonnet-5',
                                                            'region': 'us-east-1'}}


def test_access_denied_is_non_fatal_and_reported():
    """A Private-Marketplace refusal must return UNAVAILABLE, not raise."""
    handler, calls = _load_handler(
        create_raises=_FakeClientError(
            'AccessDeniedException',
            'Unauthorized to perform action due to private marketplace eligibility',
        )
    )

    result = handler(_event(), None)

    assert calls['create'] == 1, 'the agreement call should have been attempted'
    assert result['Data']['status'] == 'UNAVAILABLE'
    assert result['Data']['modelId'] == 'anthropic.claude-sonnet-5'
    assert result['Data']['errorCode'] == 'AccessDeniedException'


def test_other_client_errors_still_fail_the_stack():
    """Absorbing everything would hide real breakage, so only the allowlisted code is caught."""
    handler, _ = _load_handler(create_raises=_FakeClientError('ThrottlingException', 'slow down'))

    with pytest.raises(_FakeClientError):
        handler(_event(), None)


def test_happy_path_still_reports_created():
    handler, calls = _load_handler()

    result = handler(_event(), None)

    assert calls['create'] == 1
    assert result['Data']['status'] == 'CREATED'


def test_conflict_is_still_treated_as_already_existing():
    """The ClientError branch must not shadow the ConflictException branch."""
    handler, _ = _load_handler(create_raises=_FakeConflict('already there'))

    result = handler(_event(), None)

    assert result['Data']['status'] == 'ALREADY_EXISTS'
