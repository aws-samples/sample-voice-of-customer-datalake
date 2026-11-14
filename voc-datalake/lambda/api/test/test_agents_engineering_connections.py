"""The Agents API's repository connections (``GET /agents/engineering/connections``, ``PUT`` / ``DELETE
…/connections/<id>``; engineering/connectors/connections.py), and the broker reading what they store.

Administrators acting for themselves only (a plain user and a delegated MCP credential get 403), and only with the
engineering module on (404 for everyone otherwise). The GitHub App's private key goes to SSM and nowhere else: no
answer, row or log line carries it. End to end: a connection saved through the route is what the broker's reader
reads, so a run's read is answered (no longer 503) until the connection is removed.
"""
from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call

import agents_handler
from engineering.board.test.table import TABLE, create_table
from engineering.connectors import credentials, handler
from engineering.connectors.broker import OTHER_REPOSITORY
from engineering.connectors.connections import LOG_PREFIX, PARTITION
from engineering.connectors.github import GitHubHost, Response
from engineering.connectors.hosts import NO_CONNECTION
from engineering.connectors.test.app_keys import APP_ID, INSTALLATION_ID, OWNER, REPOSITORY, connection_body, pem
from engineering.connectors.test.fakes import OTHER_RUN, PATTERN, RUN, role_arn, url_event
from engineering.connectors.test.test_github import NOW, REPO, Clock, FakeGitHub, answer
from engineering.connectors.test.test_handler import lambda_context as broker_context
from engineering.runtime.runs import RunCaps, RunStore

PATH = '/agents/engineering/connections'
PREFIX = '/voc/engineering/'
#: An MCP credential an administrator minted: delegated, so never an administrator here.
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}


body = connection_body


@dataclass
class Env:
    agents: Any
    engineering: Any
    ssm: Any

    def start_run(self, connection: str = 'refunds', run_id: str = RUN, repo: str = f'{OWNER}/{REPOSITORY}') -> None:
        RunStore(boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)).start(
            run_id, caps=RunCaps(max_tasks=10), now=int(NOW), connection=connection, repo=repo, commit='c' * 40,
            language='python', actor='admin-sub')


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    with _api() as agents:
        engineering = create_table()
        key = boto3.client('kms', region_name='us-east-1').create_key()['KeyMetadata']['Arn']
        for name, value in (('ENGINEERING_AGENTS', 'on'), ('ENGINEERING_TABLE', TABLE),
                            ('ENGINEERING_PARAMETER_PREFIX', PREFIX), ('ENGINEERING_PARAMETER_KEY', key)):
            monkeypatch.setenv(name, value)
        agents_handler._ssm_client.cache_clear()
        with patch.object(agents_handler, 'get_dynamodb_resource', return_value=agents.resource):
            yield Env(agents.agents, engineering, boto3.client('ssm', region_name='us-east-1'))
        agents_handler._ssm_client.cache_clear()


def connection_path(connection_id: str = 'refunds') -> str:
    return f'{PATH}/{connection_id}'


def test_an_administrator_adds_lists_changes_and_removes_a_connection(lambda_context: Any, env: Env) -> None:
    assert _call(lambda_context, 'GET', PATH) == (200, {'connections': [], 'limit': 20})
    status, saved = _call(lambda_context, 'PUT', connection_path(), body=body())
    assert (status, saved['created'], saved['connection']['credential']) == (
        200, True, {'kind': 'app', 'set': True, 'app_id': APP_ID, 'installation_id': str(INSTALLATION_ID)})
    assert saved['connection']['updated_by'] == 'alice'
    assert _call(lambda_context, 'GET', PATH)[1]['connections'] == [saved['connection']]
    # The branch alone changes without the credential, which stays as stored.
    status, changed = _call(lambda_context, 'PUT', connection_path(), body=body(default_branch='trunk', credential=None))
    assert (status, changed['created'], changed['connection']['default_branch']) == (200, False, 'trunk')
    assert _call(lambda_context, 'DELETE', connection_path()) == (200, {'removed': True})
    assert _call(lambda_context, 'DELETE', connection_path())[0] == 404
    assert _call(lambda_context, 'GET', PATH)[1]['connections'] == []
    assert env.ssm.describe_parameters()['Parameters'] == []
    actions = [row['action'] for row in env.agents.query(
        KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
        ExpressionAttributeValues={':pk': PARTITION, ':log': LOG_PREFIX})['Items']]
    assert sorted(actions) == ['created', 'removed', 'updated']


def test_the_private_key_is_never_answered_logged_or_kept_outside_ssm(lambda_context: Any, env: Env,
                                                                     caplog: pytest.LogCaptureFixture) -> None:
    secret = pem().split('\n')[1]
    with caplog.at_level(logging.INFO):
        answers = [_call(lambda_context, 'PUT', connection_path(), body=body()),
                   _call(lambda_context, 'GET', PATH),
                   # (a refusal names the field, never the value)
                   _call(lambda_context, 'PUT', connection_path(), body=body(repository='no-slash'))]
    assert secret not in json.dumps(answers)
    assert secret not in caplog.text
    assert secret not in json.dumps(env.agents.scan()['Items'], default=str)
    assert secret in env.ssm.get_parameter(Name=f'{PREFIX}refunds', WithDecryption=True)['Parameter']['Value']


@pytest.mark.parametrize(('path', 'payload', 'status'), [
    (connection_path('Not_An_Id'), body(), 400),
    (connection_path(), body(host='gitlab'), 400),
    (connection_path(), body(credential=None), 400),
    (connection_path(), {'repository': f'{OWNER}/{REPOSITORY}'}, 400),
    (connection_path(), [1], 400),
])
def test_a_save_off_the_rules_is_400(lambda_context: Any, env: Env, path: str, payload: Any, status: int) -> None:
    assert _call(lambda_context, 'PUT', path, body=payload)[0] == status
    assert env.ssm.describe_parameters()['Parameters'] == []


def test_a_repository_change_is_409_while_a_run_of_the_connection_is_live(lambda_context: Any, env: Env) -> None:
    assert _call(lambda_context, 'PUT', connection_path(), body=body())[0] == 200
    env.start_run()
    status, refused = _call(lambda_context, 'PUT', connection_path(), body=body(repository='example-org/other'))
    assert (status, 'are live' in refused['error']) == (409, True)
    assert _call(lambda_context, 'GET', PATH)[1]['connections'][0]['repository'] == f'{OWNER}/{REPOSITORY}'
    assert _call(lambda_context, 'PUT', connection_path(), body=body(default_branch='trunk'))[0] == 200


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_the_connections_are_an_administrators_acting_for_themselves(lambda_context: Any, env: Env,
                                                                    claims: dict[str, Any]) -> None:
    assert _call(lambda_context, 'GET', PATH, claims=claims)[0] == 403
    assert _call(lambda_context, 'PUT', connection_path(), body=body(), claims=claims)[0] == 403
    assert _call(lambda_context, 'DELETE', connection_path(), claims=claims)[0] == 403
    assert env.ssm.describe_parameters()['Parameters'] == []


@pytest.mark.usefixtures('env')
@pytest.mark.parametrize('claims', [ADMIN, USER], ids=['admin', 'plain user'])
def test_every_connection_route_is_404_while_the_module_is_off(lambda_context: Any, monkeypatch: pytest.MonkeyPatch,
                                                               claims: dict[str, Any]) -> None:
    monkeypatch.delenv('ENGINEERING_AGENTS')
    assert _call(lambda_context, 'GET', PATH, claims=claims)[0] == 404
    assert _call(lambda_context, 'PUT', connection_path(), body=body(), claims=claims)[0] == 404
    assert _call(lambda_context, 'DELETE', connection_path(), claims=claims)[0] == 404


@pytest.mark.parametrize('missing', ['ENGINEERING_PARAMETER_PREFIX', 'ENGINEERING_PARAMETER_KEY'])
def test_without_the_parameters_path_or_key_a_save_is_503_and_the_list_still_reads(
        lambda_context: Any, env: Env, monkeypatch: pytest.MonkeyPatch, missing: str) -> None:
    monkeypatch.delenv(missing)
    assert _call(lambda_context, 'PUT', connection_path(), body=body())[0] == 503
    assert _call(lambda_context, 'GET', PATH)[0] == 200
    assert env.ssm.describe_parameters()['Parameters'] == []


# --- end to end: the broker reads what the route stored ------------------------------------------------------------


def broker_read(api: FakeGitHub, run_id: str = RUN) -> tuple[int, dict[str, Any]]:
    """A mapper's file read through the broker's Lambda, in a fresh container (its caches empty), against ``api``."""
    handler.broker_for.cache_clear()
    credentials._ssm.cache_clear()
    try:
        with patch.object(handler, 'GitHubHost', lambda read: GitHubHost(read, api, clock=Clock())), \
                patch('shared.aws.get_dynamodb_client', return_value=boto3.client('dynamodb', region_name='us-east-1')), \
                patch('shared.aws.get_s3_client', return_value=boto3.client('s3', region_name='us-east-1')):
            response = handler.lambda_handler(
                url_event(role_arn('mapper', session=f'{run_id}.3'), {'operation': 'read', 'args': {'kind': 'file', 'target': 'README.md'}}),
                broker_context())
    finally:
        handler.broker_for.cache_clear()
        credentials._ssm.cache_clear()
    return response['statusCode'], json.loads(response['body'])


def test_the_broker_answers_a_runs_read_once_its_connection_is_stored_and_503_once_it_is_removed(
        lambda_context: Any, env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in ((handler.ROLE_NAME_PATTERN_ENV, PATTERN), (handler.BUCKET_ENV, 'voc-eng-workspace'),
                        (handler.AGGREGATES_ENV, 'voc-aggregates')):
        monkeypatch.setenv(name, value)
    api = FakeGitHub().on('GET', REPO, answer(200, {'default_branch': 'main'})) \
        .on('GET', f'{REPO}/contents/README.md', Response(status=200, headers={}, body=b'# Refund service\n'))
    # The run names the connection; nothing stored yet, so the broker has no credential to use.
    env.start_run()
    assert broker_read(api) == (503, {'error': NO_CONNECTION})
    assert api.sent == []
    # Stored through the route: the broker reads the App's credential and answers the read.
    assert _call(lambda_context, 'PUT', connection_path(), body=body())[0] == 200
    assert broker_read(api) == (200, {'result': {'content': '# Refund service\n', 'next_cursor': None}})
    # The token was minted for the stored repository alone, with the App's installation.
    assert api.scopes() == [{'repositories': [REPOSITORY], 'permissions': {'metadata': 'read'}},
                            {'repositories': [REPOSITORY], 'permissions': {'contents': 'read'}}]
    # A run that started on another repository than the credential names is refused: nothing of it is read.
    sent = len(api.sent)
    env.start_run(run_id=OTHER_RUN, repo='example-org/other')
    assert broker_read(api, OTHER_RUN) == (409, {'error': OTHER_REPOSITORY})
    assert [s.path for s in api.sent[sent:] if '/contents/' in s.path] == []
    # Removed: its credential goes first, so a broker without a cached copy (a new container, or past five minutes)
    # refuses every operation again.
    assert _call(lambda_context, 'DELETE', connection_path())[0] == 200
    assert broker_read(api) == (503, {'error': NO_CONNECTION})


@pytest.mark.usefixtures('env')
def test_a_runs_repository_is_its_stored_connections(lambda_context: Any) -> None:
    with pytest.raises(agents_handler.ValidationError, match='no stored repository connection'):
        agents_handler._run_repo('refunds')
    assert _call(lambda_context, 'PUT', connection_path(), body=body())[0] == 200
    assert agents_handler._run_repo('refunds') == f'{OWNER}/{REPOSITORY}'
