"""``POST /webhooks/github_issues/{ws}``: a workspace's own webhook (docs/multi-workspace.md, "Public and non-user entry
points"; plugins/_shared/base_webhook.py).

The ``{ws}`` path value is only the key of the workspace's stored ``META``: the HMAC is checked with the webhook secret
of THAT workspace's own parameter of this plugin (``/voc/ws/{ws}/credentials/{plugin}``, decision 19), never the
shared secret, and a verified delivery is queued with that workspace and archived under its prefix. A malformed or
unknown id, a ``deleting`` workspace, a parameter missing or without a webhook secret, A's secret on B's endpoint and
an unsigned delivery all get the same 401 as a bad signature, after the body checks; ``/webhooks/github_issues`` is
unchanged.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from collections.abc import Generator, Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from github_fixtures import REPO, issue

from _shared import base_webhook
from _shared.test.scoped_secret import scoped_secret
from _shared.test.sqs_response_fixtures import echo_batch_success
from _shared.test.webhook_fixtures import webhook_event
from shared import workspace_plugin_settings

WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
#: A workspace whose META still carries an old ``secret_status: pending``: nothing reads it any more.
WS_OLD_PENDING = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DA'
WS_GONE = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DB'
WS_UNKNOWN = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DC'
WS_NO_HOOK = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7DD'
SECRET_A = 'secret-of-a'
SECRET_B = 'secret-of-b'
SHARED = 'shared-secret'
SHARED_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:voc-api-credentials'
BAD_SIGNATURE = (401, {'error': 'Invalid signature'})
PREFIX = '/voc/ws'
META = {
    WS_A: {'status': 'active'},
    WS_B: {'status': 'active'},
    WS_OLD_PENDING: {'status': 'active', 'secret_status': 'pending'},
    WS_GONE: {'status': 'deleting'},
    WS_NO_HOOK: {'status': 'active'},
}


def _parameter(ws: str, plugin: str = base_webhook.SOURCE_PLATFORM) -> str:
    """The plugin's credentials parameter in ``ws`` (this test session's plugin, ``SOURCE_PLATFORM``)."""
    return f'{PREFIX}/{ws}/credentials/{plugin}'


SECRETS = {
    _parameter(WS_A): {'webhook_secret': SECRET_A, 'repos': REPO},
    _parameter(WS_B): {'webhook_secret': SECRET_B, 'repos': REPO},
    _parameter(WS_OLD_PENDING): {'webhook_secret': SECRET_A, 'repos': REPO},
    _parameter(WS_GONE): {'webhook_secret': SECRET_A, 'repos': REPO},
    # Another plugin's parameter only: none of this plugin's.
    _parameter(WS_NO_HOOK, 'webscraper'): {'webhook_secret': SECRET_A},
    SHARED_ARN: scoped_secret(webhook_secret=SHARED, repos=REPO),
}


class _Workspaces:
    """voc-workspaces' META rows (a GetItem by key, as the routing reads them)."""

    def __init__(self) -> None:
        self.reads: list[dict] = []

    def get_item(self, Key: dict, **_kwargs: Any) -> dict:
        self.reads.append(Key)
        ws = Key['pk'].removeprefix('WS#')
        row = META.get(ws)
        return {'Item': {'pk': Key['pk'], 'sk': 'META', **row}} if row and Key['sk'] == 'META' else {}


@pytest.fixture
def hook() -> Iterator[tuple[Any, MagicMock, MagicMock, MagicMock]]:
    sqs = MagicMock()
    sqs.send_message_batch.side_effect = echo_batch_success
    # One double for both reads, by name: the shared secret's (`get_secret`) and a workspace parameter's
    # (`_read_credentials`, behind the TTL cache, emptied around each test: it is module state).
    secrets = MagicMock(side_effect=lambda name: SECRETS.get(name, {}))
    base_webhook.WORKSPACE_SECRETS.clear()
    with (
        patch.object(base_webhook, 'get_sqs_client', return_value=sqs),
        patch.object(base_webhook, 'get_secret', secrets),
        patch.object(base_webhook, '_read_credentials', lambda ws, plugin: secrets(_parameter(ws, plugin))),
        patch.object(base_webhook, 'get_s3_client'),
        patch.object(base_webhook, 'archive_raw_item', return_value=None) as archive,
        patch.object(base_webhook, 'get_workspaces_table', return_value=_Workspaces()),
        patch.object(base_webhook, 'SECRETS_ARN', SHARED_ARN),
        patch.object(base_webhook, 'WORKSPACE_PARAMETER_PREFIX', PREFIX),
        patch('github_issues.webhook.handler.emit_audit_event'),
    ):
        from github_issues.webhook.handler import lambda_handler

        yield lambda_handler, sqs, secrets, archive
    base_webhook.WORKSPACE_SECRETS.clear()


def _delivery(ws: str | None, secret: str | None, *, body: bytes | None = None) -> dict:
    raw = body if body is not None else json.dumps(
        {'action': 'opened', 'issue': issue(7), 'repository': {'full_name': REPO}}).encode()
    headers = {'X-GitHub-Event': 'issues'}
    if secret is not None:
        headers['X-Hub-Signature-256'] = 'sha256=' + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    event = webhook_event(body=raw.decode(), headers=headers)
    if ws is not None:
        event['pathParameters'] = {'ws': ws}
    return event


def _call(handler: Any, event: dict) -> tuple[int, dict]:
    response = handler(event, MagicMock())
    return response['statusCode'], json.loads(response['body'])


def _queued(sqs: MagicMock) -> list[dict]:
    return [json.loads(e['MessageBody']) for c in sqs.send_message_batch.call_args_list for e in c.kwargs['Entries']]


@pytest.mark.usefixtures('ingestion_on')
def test_a_delivery_signed_with_the_workspaces_own_secret_lands_in_it(hook):
    handler, sqs, secrets, archive = hook

    status, body = _call(handler, _delivery(WS_A, SECRET_A))

    assert (status, body['items_processed']) == (200, 1)
    [message] = _queued(sqs)
    assert message['workspace_id'] == WS_A
    assert list(message)[-1] == 'workspace_id'
    assert archive.call_args.kwargs['scope'].ws == WS_A  # ws/{ws}/raw/github_issues/…
    # Its own plugin's parameter only: never the shared secret, never another plugin's parameter.
    assert [call.args[0] for call in secrets.call_args_list] == [_parameter(WS_A)]


@pytest.mark.usefixtures('ingestion_on')
def test_an_old_pending_meta_no_longer_refuses_the_delivery(hook):
    """Decision 19: nothing is made with a workspace, so ``secret_status`` is not read; its parameter decides."""
    handler, sqs, _secrets, _archive = hook

    assert _call(handler, _delivery(WS_OLD_PENDING, SECRET_A))[0] == 200
    assert _queued(sqs)[0]['workspace_id'] == WS_OLD_PENDING


@pytest.mark.parametrize(('ws', 'secret'), [
    (WS_B, SECRET_A),  # A's secret on B's endpoint
    (WS_B, None),  # unsigned
    (WS_B, SHARED),  # the deployment's shared secret
    (WS_NO_HOOK, None),  # a workspace without the plugin's parameter
    (WS_NO_HOOK, ''),
    (WS_NO_HOOK, SECRET_A),  # another plugin's parameter holds this secret: never read
    (WS_GONE, SECRET_A),  # being deleted
    (WS_UNKNOWN, SECRET_A),
    ('ws_not-an-id', SECRET_A),
    ('', SECRET_A),
    (f'{WS_A}#x', SECRET_A),
])
def test_anything_else_gets_the_bad_signatures_answer_and_queues_nothing(hook, ws, secret):
    handler, sqs, _secrets, archive = hook

    assert _call(handler, _delivery(ws, secret)) == BAD_SIGNATURE
    sqs.send_message_batch.assert_not_called()
    archive.assert_not_called()


@pytest.mark.parametrize('ws', [WS_UNKNOWN, WS_GONE, 'ws_not-an-id'])
def test_a_workspace_that_routes_nowhere_costs_no_secret_read(hook, ws):
    handler, _sqs, secrets, _archive = hook

    _call(handler, _delivery(ws, SECRET_A))

    secrets.assert_not_called()


@pytest.mark.parametrize('ws', [WS_A, WS_UNKNOWN, WS_NO_HOOK])
def test_the_body_checks_come_first_so_they_confirm_no_workspace(hook, ws):
    handler, _sqs, _secrets, _archive = hook
    big = b'{"x": "' + b'a' * 1_000_001 + b'"}'

    assert _call(handler, _delivery(ws, SECRET_A, body=big)) == (413, {'error': 'Payload too large'})


def test_the_deployment_wide_route_is_unchanged(hook):
    handler, sqs, secrets, archive = hook

    status, _ = _call(handler, _delivery(None, SHARED))

    assert status == 200
    assert 'workspace_id' not in _queued(sqs)[0]
    assert [call.args[0] for call in secrets.call_args_list] == [SHARED_ARN]
    assert 'scope' not in archive.call_args.kwargs
    # A workspace's secret is not the deployment's: it does not open the shared route.
    sqs.reset_mock()
    assert _call(handler, _delivery(None, SECRET_A)) == BAD_SIGNATURE


def test_a_workspace_read_fault_is_a_500_and_reads_no_secret(hook):
    handler, sqs, secrets, _archive = hook
    table = MagicMock()
    table.get_item.side_effect = ClientError({'Error': {'Code': 'InternalServerError'}}, 'GetItem')

    with patch.object(base_webhook, 'get_workspaces_table', return_value=table):
        status, _ = _call(handler, _delivery(WS_A, SECRET_A))

    assert status == 500
    secrets.assert_not_called()
    sqs.send_message_batch.assert_not_called()


@contextmanager
def _no_workspaces_table() -> Generator[None]:
    with patch.object(base_webhook, 'get_workspaces_table', return_value=None):
        yield


def test_without_the_workspaces_table_a_workspace_route_is_refused(hook):
    handler, sqs, _secrets, _archive = hook

    with _no_workspaces_table():
        assert _call(handler, _delivery(WS_A, SECRET_A)) == BAD_SIGNATURE
    sqs.send_message_batch.assert_not_called()


def test_without_the_parameter_prefix_a_workspace_route_is_refused(hook):
    handler, sqs, secrets, _archive = hook

    with patch.object(base_webhook, 'WORKSPACE_PARAMETER_PREFIX', ''):
        assert _call(handler, _delivery(WS_A, SECRET_A)) == BAD_SIGNATURE
    secrets.assert_not_called()
    sqs.send_message_batch.assert_not_called()


#: The real uncached read, taken before the `hook` fixture replaces it.
_UNCACHED_READ = base_webhook._read_credentials


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _not_found(name: str) -> ClientError:
    return ClientError({'Error': {'Code': 'ParameterNotFound', 'Message': name}}, 'GetParameter')


@contextmanager
def _parameter_store(store: dict[str, dict]) -> Generator[tuple[MagicMock, _Clock]]:
    """The real TTL cache (a fake clock) over an SSM double answering from ``store`` at call time
    (``ParameterNotFound`` for a name it does not hold)."""
    client = MagicMock()

    def get_parameter(Name: str, WithDecryption: bool) -> dict:
        assert WithDecryption is True
        if Name not in store:
            raise _not_found(Name)
        return {'Parameter': {'Name': Name, 'Value': json.dumps(store[Name])}}

    client.get_parameter.side_effect = get_parameter
    clock = _Clock()
    with (patch.object(base_webhook, '_read_credentials', _UNCACHED_READ),
          patch.object(base_webhook, 'get_ssm_client', return_value=client),
          patch.object(base_webhook, 'WORKSPACE_SECRETS', base_webhook.WorkspaceSecrets(clock=clock))):
        yield client, clock


@pytest.mark.usefixtures('ingestion_on')
def test_a_rotated_workspace_secret_takes_effect_within_the_ttl(hook):
    handler, sqs, _secrets, _archive = hook
    name = _parameter(WS_A)
    store = {name: {'webhook_secret': SECRET_A, 'repos': REPO}}
    with _parameter_store(store) as (client, clock):
        assert _call(handler, _delivery(WS_A, SECRET_A))[0] == 200  # the old secret, now kept
        store[name] = {'webhook_secret': 'rotated', 'repos': REPO}
        assert _call(handler, _delivery(WS_A, 'rotated')) == BAD_SIGNATURE  # inside the TTL: the kept one

        clock.now += base_webhook.WORKSPACE_SECRET_TTL_SECONDS
        assert _call(handler, _delivery(WS_A, 'rotated'))[0] == 200
        assert _call(handler, _delivery(WS_A, SECRET_A)) == BAD_SIGNATURE  # the old one no longer opens it
    assert len(_queued(sqs)) == 2
    assert client.get_parameter.call_count == 2


def test_a_flood_of_bad_signatures_reads_the_parameter_once_per_ttl(hook):
    """A missing parameter (``ParameterNotFound``: nothing saved) and an empty one are kept for the TTL like any
    other value, so forged deliveries cost one read per workspace per TTL."""
    handler, sqs, _secrets, _archive = hook
    store = {_parameter(WS_A): {'webhook_secret': SECRET_A, 'repos': REPO},
             _parameter(WS_B): {}}  # saved, but without a webhook secret
    with _parameter_store(store) as (client, _clock):
        for _ in range(20):
            assert _call(handler, _delivery(WS_A, 'forged')) == BAD_SIGNATURE
            assert _call(handler, _delivery(WS_NO_HOOK, 'forged')) == BAD_SIGNATURE  # not found, kept too
            assert _call(handler, _delivery(WS_B, 'forged')) == BAD_SIGNATURE  # `{}`, kept too
    assert client.get_parameter.call_count == 3
    assert {call.kwargs['Name'] for call in client.get_parameter.call_args_list} == {
        _parameter(WS_A), _parameter(WS_NO_HOOK), _parameter(WS_B)}
    sqs.send_message_batch.assert_not_called()


def test_the_cache_is_bounded_and_starts_again_empty_when_full():
    reads: list[str] = []

    def read(ws: str, _plugin: str) -> dict:
        reads.append(ws)
        return {}

    cache = base_webhook.WorkspaceSecrets(clock=_Clock())
    with patch.object(base_webhook, '_read_credentials', read):
        for index in range(base_webhook.MAX_CACHED_WORKSPACE_SECRETS):
            cache.get(f'ws-{index}', 'p')
        assert len(cache) == base_webhook.MAX_CACHED_WORKSPACE_SECRETS
        cache.get('ws-0', 'p')  # still kept
        assert len(reads) == base_webhook.MAX_CACHED_WORKSPACE_SECRETS

        cache.get('one-more', 'p')  # a miss on a full cache: it starts again empty
        assert len(cache) == 1
        cache.get('ws-0', 'p')
    assert reads[-1] == 'ws-0'


@pytest.mark.usefixtures('ingestion_on')
def test_a_failed_read_is_not_kept(hook):
    handler, _sqs, _secrets, _archive = hook
    with _parameter_store({}) as (client, _clock):
        client.get_parameter.side_effect = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'GetParameter')
        assert _call(handler, _delivery(WS_A, SECRET_A)) == BAD_SIGNATURE
        client.get_parameter.side_effect = None
        client.get_parameter.return_value = {
            'Parameter': {'Value': json.dumps({'webhook_secret': SECRET_A, 'repos': REPO})}}
        assert _call(handler, _delivery(WS_A, SECRET_A))[0] == 200
    assert client.get_parameter.call_count == 2


def test_a_parameter_that_is_not_a_json_object_reads_as_empty():
    client = MagicMock()
    client.get_parameter.return_value = {'Parameter': {'Value': '["a"]'}}
    with patch.object(base_webhook, 'get_ssm_client', return_value=client):
        assert _UNCACHED_READ(WS_A, base_webhook.SOURCE_PLATFORM) == {}
    assert client.get_parameter.call_args.kwargs['Name'] == f'{base_webhook.WORKSPACE_PARAMETER_PREFIX}/{WS_A}/credentials/{base_webhook.SOURCE_PLATFORM}'


@pytest.mark.parametrize(('refused', 'path_parameters'), [
    (True, None),  # refused by delivery_workspace, whatever the plugin then skipped
    (False, {'ws': WS_A}),  # a `{ws}` delivery the plugin built without delivery_workspace
])
def test_a_workspace_delivery_that_was_not_routed_is_never_handled(refused, path_parameters):
    """`BaseWebhook.handle` fails closed: never deployment-wide for a `{ws}` delivery, never for a refused one."""
    with (patch.object(base_webhook, 'get_sqs_client') as sqs, patch.object(base_webhook, 'get_s3_client'),
          patch.object(base_webhook, 'get_secret', return_value=scoped_secret())):
        from _shared.test.webhook_fixtures import webhook_parsing

        hook = webhook_parsing([{'id': 'a', 'text': 't'}])
        hook.refused = refused
        event = {**webhook_event(), 'pathParameters': path_parameters}
        assert hook.handle(event, MagicMock()) == {'statusCode': 401, 'body': json.dumps({'error': 'Invalid signature'})}
    sqs.return_value.send_message_batch.assert_not_called()


def test_a_verified_delivery_to_a_workspace_is_held_and_queues_nothing(hook):
    """While per-workspace ingestion is off, a delivery on a workspace's own endpoint is ingestion into it: the same
    409 and reason as enabling a plugin (shared/workspace_plugin_settings.py hold_workspace_ingestion), after the
    signature is checked and before anything is archived or queued."""
    handler, sqs, _secrets, archive = hook

    status, body = _call(handler, _delivery(WS_A, SECRET_A))

    assert (status, body['error']) == (409, workspace_plugin_settings.INGESTION_NOT_YET)
    assert _queued(sqs) == []
    archive.assert_not_called()
