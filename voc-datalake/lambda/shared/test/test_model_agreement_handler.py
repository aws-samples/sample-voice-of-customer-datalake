"""Behavioural tests for BedrockAccessStack's inline ModelAgreement handler.

The handler lives as an inline Python string inside
``lib/stacks/bedrock-access-stack.ts`` (``getModelAgreementLambdaCode``), so it
has no import path of its own. These tests extract that string and ``exec`` it
with a stubbed boto3, which is the only way to exercise its branches.

Fail-on-revert intent, in two parts:

- Strict mode (a resource without ``bestEffort``): a Private-Marketplace
  ``AccessDeniedException`` on CreateFoundationModelAgreement and a transient
  network failure must NOT fail the stack, while every other error must still
  raise.
- Best-effort mode (``bestEffort: 'true'``, which every agreement the app creates
  sets, BedrockModelAgreements in VocCoreStack): NO error fails the deploy, since
  a raise there rolls back the stack holding every table. Every error class is
  reported as UNAVAILABLE with its code. (Ported from PR #429 by @aws-bryan.)

Precedent for reading a TS file from a Python test:
``test_avatar_image_model_lockstep.py``.
"""
import re
import sys
import types
from collections.abc import Callable
from typing import Any

import pytest

from shared.test.repo_paths import repo_root


def _handler_source() -> str:
    """Extract the inline handler body from the CDK stack."""
    ts = (repo_root() / 'lib' / 'stacks' / 'bedrock-access-stack.ts').read_text(encoding='utf-8')
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


class _FakeBotoCoreError(Exception):
    """Stand-in for botocore BotoCoreError: a connection-level failure with no .response."""


class _FakeEndpointConnectionError(_FakeBotoCoreError):
    """Stand-in for botocore EndpointConnectionError (a BotoCoreError subclass)."""


class _FakeConnectTimeoutError(_FakeBotoCoreError):
    """Stand-in for botocore ConnectTimeoutError."""


class _FakeReadTimeoutError(_FakeBotoCoreError):
    """Stand-in for botocore ReadTimeoutError."""


class _FakeConnectionClosedError(_FakeBotoCoreError):
    """Stand-in for botocore ConnectionClosedError."""


_TRANSIENT_STAND_INS = {
    'EndpointConnectionError': _FakeEndpointConnectionError,
    'ConnectTimeoutError': _FakeConnectTimeoutError,
    'ReadTimeoutError': _FakeReadTimeoutError,
    'ConnectionClosedError': _FakeConnectionClosedError,
}


class _FakeParamValidationError(_FakeBotoCoreError):
    """Stand-in for botocore ParamValidationError: a BotoCoreError that is OUR bug (a bad model id)."""


class _FakeNoCredentialsError(_FakeBotoCoreError):
    """Stand-in for botocore NoCredentialsError: a BotoCoreError that is a broken role, not the network."""


class _FakeConflict(_FakeClientError):
    """Stand-in for bedrock's ConflictException.

    MUST subclass _FakeClientError: botocore's ConflictException *is* a
    ClientError subclass, so the handler's inner `except ClientError` sees it
    first and re-raises it (code not in NON_FATAL_ERROR_CODES) to the outer
    ConflictException handler. A sibling class would skip that inner branch
    entirely and the "ClientError branch does not shadow ConflictException"
    assertion below would prove nothing. (Review nit on PR #269.)
    """

    def __init__(self, message: str = 'already exists'):
        super().__init__('ConflictException', message)


class _FakeBoto3(types.ModuleType):
    """The `boto3` module as the exec'd handler sees it: only `client`."""

    client: Callable[..., Any]


class _FakeBotocoreExceptions(types.ModuleType):
    """`botocore.exceptions`, carrying the stand-in `ClientError` and `BotoCoreError`."""

    ClientError: type[Exception]
    BotoCoreError: type[Exception]


class _FakeBotocore(types.ModuleType):
    """`botocore`, carrying only its `exceptions` submodule."""

    exceptions: _FakeBotocoreExceptions


def _load_handler(*, create_raises: Exception | None = None,
                  availability_raises: Exception | None = None,
                  offers_raises: Exception | None = None,
                  offer_list: list | None = None):
    """exec the extracted handler with boto3/botocore stubbed out."""
    calls: dict[str, int] = {'create': 0}

    # The exec'd handler calls these by boto3's API names, which no Python source
    # spells out, so the fake client is assembled from keyword arguments.
    def availability(**_kwargs):
        if availability_raises is not None:
            raise availability_raises
        return {'agreementAvailability': {'status': 'NOT_AVAILABLE'}}

    def offers(**_kwargs):
        if offers_raises is not None:
            raise offers_raises
        return {'offers': [{'offerToken': 'tok'}] if offer_list is None else offer_list}

    def create(**_kwargs):
        calls['create'] += 1
        if create_raises is not None:
            raise create_raises
        return {}

    def bedrock_client():
        return types.SimpleNamespace(
            # mirrors botocore's client.exceptions
            exceptions=types.SimpleNamespace(
                ConflictException=_FakeConflict,
                AccessDeniedException=_FakeClientError,
            ),
            get_foundation_model_availability=availability,
            list_foundation_model_agreement_offers=offers,
            create_foundation_model_agreement=create,
        )

    fake_boto3 = _FakeBoto3('boto3')
    fake_boto3.client = lambda *_a, **_k: bedrock_client()

    fake_botocore = _FakeBotocore('botocore')
    fake_exceptions = _FakeBotocoreExceptions('botocore.exceptions')
    fake_exceptions.ClientError = _FakeClientError
    fake_exceptions.BotoCoreError = _FakeBotoCoreError
    # The transient errors the handler imports by name (TRANSIENT_ERRORS).
    for name, stand_in in _TRANSIENT_STAND_INS.items():
        setattr(fake_exceptions, name, stand_in)
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


def _event(*, best_effort: bool = False):
    properties = {'modelId': 'anthropic.claude-sonnet-5', 'region': 'us-east-1'}
    if best_effort:
        properties['bestEffort'] = 'true'
    return {'RequestType': 'Create', 'ResourceProperties': properties}


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


def test_access_denied_from_the_availability_call_STILL_RAISES():
    """The absorption is scoped to create_foundation_model_agreement only.

    An AccessDenied from get_foundation_model_availability means this stack's
    own role lacks a permission — a real bug — so it must fail the deployment
    instead of being reported as an unavailable model. (Caught in review of
    PR #269: the first version wrapped the whole try block.)
    """
    handler, calls = _load_handler(
        availability_raises=_FakeClientError('AccessDeniedException', 'no bedrock:GetFoundationModelAvailability')
    )

    with pytest.raises(_FakeClientError):
        handler(_event(), None)

    assert calls['create'] == 0, 'must fail before attempting the agreement'


def test_access_denied_from_the_offers_call_STILL_RAISES():
    """Same reasoning for list_foundation_model_agreement_offers."""
    handler, calls = _load_handler(
        offers_raises=_FakeClientError('AccessDeniedException', 'no bedrock:ListFoundationModelAgreementOffers')
    )

    with pytest.raises(_FakeClientError):
        handler(_event(), None)

    assert calls['create'] == 0


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


@pytest.mark.parametrize('error', [
    _FakeEndpointConnectionError, _FakeConnectTimeoutError, _FakeReadTimeoutError, _FakeConnectionClosedError,
])
@pytest.mark.parametrize('stage', ['availability', 'offers', 'create'])
def test_a_connection_failure_is_reported_instead_of_rolling_back_the_stack(stage, error):
    """A dropped connection or a timeout is a transient property of the network,
    not a bug in this stack: it must be reported as UNAVAILABLE like an absorbed
    AccessDenied, not fail the custom resource and roll back VocWebSearchStack
    (which Processing/Api import from)."""
    handler, _ = _load_handler(**{f'{stage}_raises': error('Could not connect to the endpoint URL')})

    result = handler(_event(), None)

    assert result['Data']['status'] == 'UNAVAILABLE'
    assert result['Data']['modelId'] == 'anthropic.claude-sonnet-5'
    assert result['Data']['errorCode'] == error.__name__


@pytest.mark.parametrize('error', [_FakeParamValidationError, _FakeNoCredentialsError, _FakeBotoCoreError])
@pytest.mark.parametrize('stage', ['availability', 'offers', 'create'])
def test_any_other_botocore_error_still_fails_the_deploy(stage, error):
    """A bad model id (ParamValidationError), missing credentials or region are
    BotoCoreErrors too, but they are a broken stack, not the network: reporting
    them as UNAVAILABLE would turn a real fault into a green deploy."""
    handler, _ = _load_handler(**{f'{stage}_raises': error('bad')})

    with pytest.raises(error):
        handler(_event(), None)


@pytest.mark.parametrize('offer_list', [[], [{}], [{'offerToken': ''}]])
@pytest.mark.parametrize('best_effort', [False, True])
def test_no_usable_offer_is_reported_without_attempting_the_agreement(offer_list, best_effort):
    """An offer without a token is as unusable as no offer: NO_OFFERS, never a raise."""
    handler, calls = _load_handler(offer_list=offer_list)

    result = handler(_event(best_effort=best_effort), None)

    assert calls['create'] == 0
    assert result['Data']['status'] == 'NO_OFFERS'


# ── Best effort: every agreement in VocCoreStack ─────────────────────────────────────────────

_BEST_EFFORT_FAILURES = [
    # (stage, error, the errorCode reported)
    ('create', _FakeClientError('AccessDeniedException', 'private marketplace'), 'AccessDeniedException'),
    ('availability', _FakeClientError('AccessDeniedException', 'own role'), 'AccessDeniedException'),
    ('offers', _FakeClientError('AccessDeniedException', 'own role'), 'AccessDeniedException'),
    ('create', _FakeClientError('ThrottlingException', 'slow down'), 'ThrottlingException'),
    ('availability', _FakeClientError('ThrottlingException', 'slow down'), 'ThrottlingException'),
    ('availability', _FakeClientError('ValidationException', 'model not supported in this region'),
     'ValidationException'),
    ('create', _FakeClientError('ResourceNotFoundException', 'no such model'), 'ResourceNotFoundException'),
    ('create', _FakeEndpointConnectionError('Could not connect'), '_FakeEndpointConnectionError'),
    ('availability', _FakeReadTimeoutError('timed out'), '_FakeReadTimeoutError'),
    ('offers', _FakeParamValidationError('bad model id'), '_FakeParamValidationError'),
    ('create', _FakeNoCredentialsError('no credentials'), '_FakeNoCredentialsError'),
]


@pytest.mark.parametrize(('stage', 'error', 'code'), _BEST_EFFORT_FAILURES)
def test_best_effort_reports_every_error_class_instead_of_rolling_back_core(stage, error, code):
    """Access denied, throttling, a model not in the region, a dropped connection, even a
    broken role: in VocCoreStack each is reported, never raised."""
    handler, _ = _load_handler(**{f'{stage}_raises': error})

    result = handler(_event(best_effort=True), None)

    assert result['Data'] == {'status': 'UNAVAILABLE', 'modelId': 'anthropic.claude-sonnet-5', 'errorCode': code}
    assert result['PhysicalResourceId'] == 'model-agreement-anthropic.claude-sonnet-5'


@pytest.mark.parametrize(('stage', 'error', 'code'), [
    ('create', _FakeClientError('ThrottlingException', 'slow down'), 'ThrottlingException'),
    ('availability', _FakeClientError('AccessDeniedException', 'own role'), 'AccessDeniedException'),
])
def test_the_same_errors_still_raise_without_best_effort(stage, error, code):
    """The flag is what absorbs them: a resource without it keeps the strict rules."""
    handler, _ = _load_handler(**{f'{stage}_raises': error})

    with pytest.raises(_FakeClientError) as raised:
        handler(_event(), None)

    assert raised.value.response['Error']['Code'] == code


@pytest.mark.parametrize('best_effort', [False, True])
def test_best_effort_keeps_the_success_statuses(best_effort):
    """Best effort only changes what a failure does: created and existing agreements read the same."""
    created, _ = _load_handler()
    existing, _ = _load_handler(create_raises=_FakeConflict())

    assert created(_event(best_effort=best_effort), None)['Data']['status'] == 'CREATED'
    assert existing(_event(best_effort=best_effort), None)['Data']['status'] == 'ALREADY_EXISTS'


def test_best_effort_skips_update_and_delete_so_nothing_is_revoked():
    """Moving the agreements from VocWebSearchStack to VocCoreStack deletes the old resources;
    a Delete must leave the account's agreement in place."""
    handler, calls = _load_handler()

    results = [handler({**_event(best_effort=True), 'RequestType': kind}, None) for kind in ('Update', 'Delete')]

    assert [r['Data']['status'] for r in results] == ['SKIPPED', 'SKIPPED']
    assert calls['create'] == 0
