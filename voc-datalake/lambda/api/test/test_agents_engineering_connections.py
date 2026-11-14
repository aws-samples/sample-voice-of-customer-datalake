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
from engineering.connectors.attestations import POINTS
from engineering.connectors.broker import NOT_ATTESTED, OTHER_REPOSITORY
from engineering.connectors.connections import LOG_PREFIX, PARTITION
from engineering.connectors.github import GitHubHost, Response
from engineering.connectors.hosts import CI_DEFAULT_UNPROTECTED, NO_CONNECTION, STORED_BRANCH_MISSING
from engineering.connectors.test.app_keys import APP_ID, INSTALLATION_ID, OWNER, REPOSITORY, connection_body, pem
from engineering.connectors.test.fakes import BRANCH, OTHER_RUN, PATTERN, RUN, STARTER, TREE, role_arn, url_event
from engineering.connectors.test.test_github import (
    NOW,
    REPO,
    Clock,
    FakeGitHub,
    answer,
    draftable,
    protected_branch,
    ruled,
    writes,
)
from engineering.connectors.test.test_handler import lambda_context as broker_context
from engineering.connectors.test.test_records import checked, final_go, gate_record, meta
from engineering.runtime.runs import RunCaps, RunStore
from shared.ai_mode import set_ai_mode
from shared.test.agents_fixtures import AGENTS_TABLE_NAME

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

    def start_run(self, connection: str = 'refunds', run_id: str = RUN, repo: str = f'{OWNER}/{REPOSITORY}',
                  default_branch: str = '') -> None:
        RunStore(boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)).start(
            run_id, caps=RunCaps(max_tasks=10), now=int(NOW), connection=connection, repo=repo, commit='c' * 40,
            language='python', actor='admin-sub', default_branch=default_branch)


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


def broker_call(api: FakeGitHub, role: str, session: str, operation: str,
                args: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """One operation through the broker's Lambda as ``role`` (its session ``session``), in a fresh container (its
    caches empty), against ``api``."""
    handler.broker_for.cache_clear()
    credentials._ssm.cache_clear()
    try:
        with patch.object(handler, 'GitHubHost', lambda read: GitHubHost(read, api, clock=Clock())), \
                patch('shared.aws.get_dynamodb_client', return_value=boto3.client('dynamodb', region_name='us-east-1')), \
                patch('shared.aws.get_s3_client', return_value=boto3.client('s3', region_name='us-east-1')):
            response = handler.lambda_handler(
                url_event(role_arn(role, session=session), {'operation': operation, 'args': args}), broker_context())
    finally:
        handler.broker_for.cache_clear()
        credentials._ssm.cache_clear()
    return response['statusCode'], json.loads(response['body'])


def broker_read(api: FakeGitHub, run_id: str = RUN) -> tuple[int, dict[str, Any]]:
    """A mapper's file read through the broker's Lambda, in a fresh container (its caches empty), against ``api``."""
    return broker_call(api, 'mapper', f'{run_id}.3', 'read', {'kind': 'file', 'target': 'README.md'})


@pytest.fixture
def broker_env(env: Env, monkeypatch: pytest.MonkeyPatch) -> Env:
    """``env`` with the broker's own env (its role pattern, the workspace bucket and the aggregates table)."""
    for name, value in ((handler.ROLE_NAME_PATTERN_ENV, PATTERN), (handler.BUCKET_ENV, 'voc-eng-workspace'),
                        (handler.AGGREGATES_ENV, 'voc-aggregates')):
        monkeypatch.setenv(name, value)
    return env


def test_the_broker_answers_a_runs_read_once_its_connection_is_stored_and_503_once_it_is_removed(
        lambda_context: Any, broker_env: Env) -> None:
    env = broker_env
    # (a run started with no stored default branch reads on the repository's own)
    api = FakeGitHub().on('GET', REPO, answer(200, {'default_branch': 'main'})) \
        .on('GET', f'{REPO}/contents/README.md?ref=main', Response(status=200, headers={}, body=b'# Refund service\n'))
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


def test_the_broker_serves_a_run_on_its_connections_stored_default_branch_only_while_the_host_has_it(
        lambda_context: Any, broker_env: Env) -> None:
    env = broker_env
    api = FakeGitHub().on('GET', f'{REPO}/git/ref/heads/develop', answer(200, {'object': {'sha': 'd' * 40}})) \
        .on('GET', f'{REPO}/git/ref/heads/gone', answer(404, {})) \
        .on('GET', f'{REPO}/contents/README.md?ref=develop', Response(status=200, headers={}, body=b'# On develop\n'))
    assert _call(lambda_context, 'PUT', connection_path(), body=body(default_branch='develop'))[0] == 200
    # The start copies the stored branch onto the run (as it does the repository); the broker confirms it on the host.
    env.start_run(**agents_handler._run_connection('refunds'))
    # The file is read on the run's stored default branch, not the repository's own (6.32.00).
    assert broker_read(api) == (200, {'result': {'content': '# On develop\n', 'next_cursor': None}})
    assert ('GET', f'{REPO}/git/ref/heads/develop') in api.calls()
    assert ('GET', REPO) not in api.calls()   # (never the host's own default branch)
    # A branch the repository does not have: every operation refused, nothing read.
    sent = len(api.sent)
    env.start_run(run_id=OTHER_RUN, default_branch='gone')
    assert broker_read(api, OTHER_RUN) == (409, {'error': STORED_BRANCH_MISSING})
    assert [s.path for s in api.sent[sent:] if '/contents/' in s.path] == []


@pytest.mark.usefixtures('env')
def test_a_runs_repository_and_default_branch_are_its_stored_connections(lambda_context: Any) -> None:
    with pytest.raises(agents_handler.ValidationError, match='no stored repository connection'):
        agents_handler._run_connection('refunds')
    assert _call(lambda_context, 'PUT', connection_path(), body=body(default_branch='trunk'))[0] == 200
    assert agents_handler._run_connection('refunds') == {'repo': f'{OWNER}/{REPOSITORY}', 'default_branch': 'trunk'}


def test_a_change_and_a_removal_record_the_administrators_reason(lambda_context: Any, env: Env) -> None:
    assert _call(lambda_context, 'PUT', connection_path(), body=body(reason='New App for the team'))[0] == 200
    assert _call(lambda_context, 'DELETE', connection_path(), body={'reason': ['not text']})[0] == 400
    assert _call(lambda_context, 'DELETE', connection_path(), body={'why': 'x'})[0] == 400
    assert _call(lambda_context, 'DELETE', connection_path(), body={'reason': 'Repository archived'}) == (
        200, {'removed': True})
    audits = env.agents.query(KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
                              ExpressionAttributeValues={':pk': PARTITION, ':log': LOG_PREFIX})['Items']
    assert sorted((row['action'], row['reason']) for row in audits) == [
        ('created', 'New App for the team'), ('removed', 'Repository archived')]


# --- the CI attestation (engineering/connectors/attestations.py) -----------------------------------------------------


def attestation_path(connection_id: str = 'refunds') -> str:
    return f'{connection_path(connection_id)}/ci-attestation'


def attest_body(**change: Any) -> dict[str, Any]:
    """Every point, for the connection as the page shows it now (its repository and version; the first ones when
    there is none), with ``change``."""
    row = boto3.resource('dynamodb', region_name='us-east-1').Table(AGENTS_TABLE_NAME).get_item(
        Key={'pk': PARTITION, 'sk': 'CONNECTION#refunds'}).get('Item') or {}
    return {'points': list(POINTS), 'repository': row.get('repository', f'{OWNER}/{REPOSITORY}'),
            'version': int(str(row.get('version', 1))), **change}


def audit_actions(env: Env) -> list[tuple[str, str]]:
    rows = env.agents.query(KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
                            ExpressionAttributeValues={':pk': PARTITION, ':log': LOG_PREFIX})['Items']
    return sorted((row['action'], row.get('reason', '')) for row in rows)


def test_an_administrator_attests_lists_and_withdraws_a_connections_ci_with_an_audit_row_each(
        lambda_context: Any, env: Env) -> None:
    assert _call(lambda_context, 'PUT', connection_path(), body=body())[0] == 200
    status, answered = _call(lambda_context, 'POST', attestation_path(), body=attest_body(reason='Checked the runners'))
    # (the connection's version moved with the attestation: what the page reviews next)
    assert (status, answered['created'], answered['connection_version']) == (200, True, 2)
    assert {key: answered['attestation'][key] for key in ('version', 'state', 'repository', 'points', 'by')} == {
        'version': 1, 'state': 'attested', 'repository': f'{OWNER}/{REPOSITORY}', 'points': list(POINTS),
        'by': 'alice'}
    # (shown with the connection; an attestation that holds is answered as it stands)
    assert _call(lambda_context, 'GET', PATH)[1]['connections'][0]['ci_attestation'] == answered['attestation']
    assert _call(lambda_context, 'POST', attestation_path(), body=attest_body()) == (
        200, {'attestation': answered['attestation'], 'created': False, 'connection_version': 2})
    assert _call(lambda_context, 'DELETE', attestation_path(), body={'reason': 'A runner was added'}) == (
        200, {'withdrawn': True})
    assert _call(lambda_context, 'DELETE', attestation_path())[0] == 404   # (none holds now)
    assert _call(lambda_context, 'GET', PATH)[1]['connections'][0]['ci_attestation']['state'] == 'withdrawn'
    assert audit_actions(env) == [('ci_attested', 'Checked the runners'), ('ci_withdrawn', 'A runner was added'),
                                  ('created', '')]


@pytest.mark.parametrize('payload', [
    {}, {'points': list(POINTS[:2])}, {'points': [*POINTS, 'unknown_point']}, {'points': list(POINTS), 'reason': [1]},
    [1]], ids=['no points', 'some points', 'an unknown point', 'a reason not text', 'not an object'])
def test_an_attestation_off_its_rules_is_400_and_records_nothing(lambda_context: Any, env: Env, payload: Any) -> None:
    assert _call(lambda_context, 'PUT', connection_path(), body=body())[0] == 200
    assert _call(lambda_context, 'POST', attestation_path(), body=payload)[0] == 400
    assert _call(lambda_context, 'DELETE', attestation_path(), body={'why': 'x'})[0] == 400
    assert audit_actions(env) == [('created', '')]


def test_an_attestation_of_a_connection_repointed_after_the_page_showed_it_is_409(lambda_context: Any,
                                                                                env: Env) -> None:
    assert _call(lambda_context, 'PUT', connection_path(), body=body())[0] == 200
    shown = attest_body()   # (administrator A's dialog: this repository, at this version)
    # Administrator B repoints the connection before A confirms.
    assert _call(lambda_context, 'PUT', connection_path(), body=body(repository='example-org/other'))[0] == 200
    status, refused = _call(lambda_context, 'POST', attestation_path(), body=shown)
    assert (status, 'review its repository again' in refused['error']) == (409, True)
    # (a stale version alone, the repository the same, is refused too)
    assert _call(lambda_context, 'POST', attestation_path(),
                 body={**attest_body(), 'version': attest_body()['version'] - 1})[0] == 409
    assert _call(lambda_context, 'GET', PATH)[1]['connections'][0]['ci_attestation'] is None
    assert [action for action, _ in audit_actions(env)] == ['created', 'updated']


def test_an_attestation_of_a_connection_not_stored_is_404(lambda_context: Any, env: Env) -> None:
    assert _call(lambda_context, 'POST', attestation_path(), body=attest_body())[0] == 404
    assert _call(lambda_context, 'POST', attestation_path('Not_An_Id'), body=attest_body())[0] == 400
    assert audit_actions(env) == []


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_the_ci_attestation_is_an_administrators_acting_for_themselves(lambda_context: Any, env: Env,
                                                                       claims: dict[str, Any]) -> None:
    assert _call(lambda_context, 'PUT', connection_path(), body=body())[0] == 200
    assert _call(lambda_context, 'POST', attestation_path(), body=attest_body(), claims=claims)[0] == 403
    assert _call(lambda_context, 'DELETE', attestation_path(), claims=claims)[0] == 403
    assert audit_actions(env) == [('created', '')]


@pytest.mark.usefixtures('env')
@pytest.mark.parametrize('claims', [ADMIN, USER], ids=['admin', 'plain user'])
def test_the_ci_attestation_routes_are_404_while_the_module_is_off(lambda_context: Any,
                                                                   monkeypatch: pytest.MonkeyPatch,
                                                                   claims: dict[str, Any]) -> None:
    monkeypatch.delenv('ENGINEERING_AGENTS')
    assert _call(lambda_context, 'POST', attestation_path(), body=attest_body(), claims=claims)[0] == 404
    assert _call(lambda_context, 'DELETE', attestation_path(), claims=claims)[0] == 404


# --- end to end: the broker's pull request waits for the attestation, on the fake host ------------------------------


def draft(api: FakeGitHub, attempt: int) -> tuple[int, dict[str, Any]]:
    """The PR author's draft pull request through the broker's Lambda (each call its own attempt)."""
    return broker_call(api, 'pr-author', f'{RUN}.4', 'open_or_update_draft_pr',
                       {'branch': BRANCH, 'title': 'Fix the refund total', 'body': 'Rounds to cents (fb_01).',
                        'attempt': attempt})


@pytest.fixture
def writing_env(broker_env: Env, monkeypatch: pytest.MonkeyPatch) -> Env:
    """``broker_env`` with what a pull request needs besides the attestation: the run on the connection (started by a
    person working AI-driven), its final go's GO for the branch's tree, the workspace and the agents table named."""
    env = broker_env
    s3 = boto3.client('s3', region_name='us-east-1')
    s3.create_bucket(Bucket='voc-eng-workspace')
    aggregates = boto3.resource('dynamodb', region_name='us-east-1').Table('test-aggregates-agents')
    for name, value in ((handler.AGGREGATES_ENV, aggregates.name), (handler.CONNECTIONS_TABLE_ENV, env.agents.name)):
        monkeypatch.setenv(name, value)
    set_ai_mode(aggregates, sub=STARTER, changes={'ai_mode': 'ai_driven'}, actor_sub='admin-sub')
    meta(env.engineering, connection='refunds', repo=f'{OWNER}/{REPOSITORY}')
    checked(env.engineering, s3, 'g1', TREE)
    final_go(env.engineering, s3, 't1', gate_record('GO', TREE), updated_at='2026-11-13T10:00:00+00:00')
    return env


def done_writes(env: Env) -> list[dict[str, Any]]:
    """The results of the broker's done writes (its claim rows)."""
    rows = env.engineering.scan(TableName=TABLE)['Items']
    return [json.loads(row['result']['S']) for row in rows
            if row['pk']['S'].startswith('WS#default#WRITES#') and row['state']['S'] == 'done']


def fake_host() -> FakeGitHub:
    """The host with a branch holding the GO'd tree, no open pull request, and the branch rules the guide asks for."""
    return ruled(draftable(FakeGitHub(), open_prs=[]).on('GET', REPO, answer(200, {'default_branch': 'main'})))


def test_the_broker_opens_a_draft_only_while_an_attestation_holds(lambda_context: Any, writing_env: Env) -> None:
    api = fake_host()
    assert _call(lambda_context, 'PUT', connection_path(), body=body())[0] == 200
    # No attestation: refused, and nothing is asked of the host's pull requests or branch rules.
    assert draft(api, 1) == (409, {'error': NOT_ATTESTED})
    assert [path for _, path in api.calls() if '/pulls' in path or '/branches/' in path] == []
    # Attested through the route: the draft is opened, and its claim keeps the attestation and the branch rules read.
    assert _call(lambda_context, 'POST', attestation_path(), body=attest_body())[0] == 200
    assert draft(api, 2) == (200, {'result': {'number': 8, 'url': 'https://h/pull/8'}})
    assert [w[:2] for w in writes(api)] == [('POST', f'{REPO}/pulls')]
    assert [result['ci'] for result in done_writes(writing_env)] == [
        {'attestation': 1, 'checked_at': int(NOW), 'required_checks': ['ci / test']}]
    # Withdrawn: refused from the next write on.
    assert _call(lambda_context, 'DELETE', attestation_path())[0] == 200
    assert draft(api, 3) == (409, {'error': NOT_ATTESTED})
    assert len(writes(api)) == 1


def test_a_voided_attestation_is_refused_until_the_repository_is_attested_again(lambda_context: Any,
                                                                                writing_env: Env) -> None:
    api = fake_host()
    assert _call(lambda_context, 'PUT', connection_path(), body=body())[0] == 200
    assert _call(lambda_context, 'POST', attestation_path(), body=attest_body())[0] == 200
    # (the run here is not in the runs' registry, so the courtesy 409 lets the change through: the void holds)
    assert _call(lambda_context, 'PUT', connection_path(), body=body(repository='example-org/other'))[0] == 200
    status, back = _call(lambda_context, 'PUT', connection_path(), body=body())
    assert (status, back['connection']['ci_attestation']['state']) == (200, 'voided')
    assert draft(api, 1) == (409, {'error': NOT_ATTESTED})
    assert writes(api) == []
    assert _call(lambda_context, 'POST', attestation_path(), body=attest_body())[1]['attestation']['version'] == 3
    assert draft(api, 2)[0] == 200
    assert ('voided', 'repository_changed') in [
        (row['state'], row.get('cause')) for row in writing_env.agents.scan()['Items'] if row['sk'].startswith('V#')]


@pytest.mark.usefixtures('writing_env')
def test_an_attested_connection_whose_default_branch_is_unprotected_is_refused(lambda_context: Any) -> None:
    api = ruled(draftable(FakeGitHub(), open_prs=[]).on('GET', REPO, answer(200, {'default_branch': 'main'})),
                default=protected_branch(protected=False))
    assert _call(lambda_context, 'PUT', connection_path(), body=body())[0] == 200
    assert _call(lambda_context, 'POST', attestation_path(), body=attest_body())[0] == 200
    assert draft(api, 1) == (409, {'error': CI_DEFAULT_UNPROTECTED})
    assert writes(api) == []
