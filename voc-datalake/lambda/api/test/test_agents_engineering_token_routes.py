"""A repository connected with a fine-grained token, this repository only (7.60.00): ``POST
/agents/engineering/token-connections``, ``PUT …/connections/<id>/token``, and what the existing routes do on this kind
(the list's credential, the removal, the go, the start), through the routes over moto, the token's check against a
fake api.github.com.

Every route answers 404 while the module is off, then 403 for anyone but an administrator acting for themselves (a
plain user, a delegated MCP credential). The token goes to SSM under its own path and nowhere else: no answer, row,
audit row or log line carries it.
"""
from __future__ import annotations

import json
import logging
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call

import agents_handler
from engineering.board.test.table import TABLE, create_table
from engineering.connectors import fine_grained, public_repos
from engineering.connectors.connections import LOG_PREFIX, PARTITION, ROW_PREFIX
from engineering.connectors.test.test_fine_grained import FakeGitHub, answer, repository
from engineering.connectors.transport import Response
from engineering.connectors.upstream import RepositoryFacts
from engineering.runtime.runs import RunCaps, RunStore
from shared import agents_engineering_token_routes as token_routes
from shared import engineering_agent_runs as eng_runs
from shared.exceptions import ConflictError

PREFIX = '/voc/engineering/'
TOKEN_PREFIX = '/voc/engineering-token/'
PATH = '/agents/engineering/token-connections'
CONNECTIONS = '/agents/engineering/connections'
REPOSITORY = 'open-tools/lint-kit'
PAT = 'github_pat_11ABCDEFG0' + 'q' * 40
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}
OTHER_ADMIN = {'sub': 'admin2-sub', 'cognito:username': 'dana', 'cognito:groups': 'admins'}
RUN = '01JC8Z3K4M5N6P7Q8R9S0T1V2W'


def today() -> date:
    return datetime.now(UTC).date()


def expiring(days: int) -> dict[str, str]:
    return {'github-authentication-token-expiration': f'{(today() + timedelta(days=days)).isoformat()} 12:00:00 UTC'}


def github(repo: Response | None = None, *, days: int = 60, private: list[object] | None = None) -> FakeGitHub:
    return FakeGitHub({f'/repos/{REPOSITORY}': repo or answer(200, repository(), expiring(days)),
                       '/user': answer(200, {'login': 'casey-dev'}),
                       '/user/repos?visibility=private&per_page=1': answer(200, private or [])})



@dataclass
class Env:
    agents: Any
    ssm: Any
    github: list[FakeGitHub]

    def answering(self, api: FakeGitHub) -> None:
        self.github[0] = api

    def anchor(self) -> None:
        """A connection made through the deployment's App: the installation a token connection reads with."""
        self.agents.put_item(Item={'pk': PARTITION, 'sk': f'{ROW_PREFIX}billing', 'connection_id': 'billing',
                                   'host': 'github', 'repository': 'example-org/billing', 'default_branch': 'main',
                                   'credential_set': True, 'app_id': '123456', 'installation_id': '7890123',
                                   'credential_kind': 'app_reference', 'version': 1})

    def start_run(self, connection: str = 'lint-kit') -> None:
        RunStore(boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)).start(
            RUN, caps=RunCaps(max_tasks=10), now=1_800_000_000, connection=connection, repo=REPOSITORY,
            commit='c' * 40, language='python', actor='admin-sub', default_branch='main')


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    with _api() as agents:
        create_table()
        key = boto3.client('kms', region_name='us-east-1').create_key()['KeyMetadata']['Arn']
        for name, value in (('ENGINEERING_AGENTS', 'on'), ('ENGINEERING_TABLE', TABLE),
                            ('ENGINEERING_WORKSPACE_BUCKET', 'test-workspace'),
                            ('ENGINEERING_PARAMETER_PREFIX', PREFIX), ('ENGINEERING_PARAMETER_KEY', key),
                            ('ENGINEERING_TOKEN_PARAMETER_PREFIX', TOKEN_PREFIX)):
            monkeypatch.setenv(name, value)
        holder = [github()]

        class Https:
            def __init__(self, timeout: float, *, host: str) -> None:
                assert (timeout, host) == (fine_grained.CHECK_TIMEOUT_SECONDS, 'api.github.com')

            def request(self, method: str, path: str, headers: Mapping[str, str], body: bytes | None) -> Any:
                return holder[0].request(method, path, headers, body)

        agents_handler._ssm_client.cache_clear()
        ssm = boto3.client('ssm', region_name='us-east-1')
        with patch.object(agents_handler, 'get_dynamodb_resource', return_value=agents.resource), \
                patch.object(token_routes, 'get_dynamodb_resource', return_value=agents.resource), \
                patch.object(token_routes, 'get_ssm_client', return_value=ssm), \
                patch.object(fine_grained, 'HttpsTransport', Https):
            yield Env(agents.agents, ssm, holder)
        agents_handler._ssm_client.cache_clear()


def connect(lambda_context: Any, claims: dict = ADMIN, **change: Any) -> tuple[int, dict]:
    body = {'repository': REPOSITORY, 'token': PAT, 'only_this_repository': True, **change}
    return _call(lambda_context, 'POST', PATH, body={k: v for k, v in body.items() if v is not None}, claims=claims)


def parameter(env: Env, name: str) -> str | None:
    try:
        return env.ssm.get_parameter(Name=name, WithDecryption=True)['Parameter']['Value']
    except env.ssm.exceptions.ParameterNotFound:
        return None


# --- the gate ---------------------------------------------------------------------------------------------------------

ROUTES = (('POST', PATH), ('PUT', f'{CONNECTIONS}/lint-kit/token'))


def test_every_route_is_404_while_the_module_is_off_then_403_for_anyone_but_an_admin_acting_for_themselves(
        lambda_context: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    with _api():
        assert {route: _call(lambda_context, *route, body={})[0] for route in ROUTES} == dict.fromkeys(ROUTES, 404)
        monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
        monkeypatch.setenv('ENGINEERING_TABLE', TABLE)
        for claims in (USER, DELEGATED_ADMIN):
            assert {route: _call(lambda_context, *route, body={}, claims=claims)[0] for route in ROUTES} == \
                dict.fromkeys(ROUTES, 403)


# --- connect -----------------------------------------------------------------------------------------------------------


def test_an_admin_connects_a_repository_with_a_token_kept_in_ssm_alone(lambda_context: Any, env: Env,
                                                                        caplog: pytest.LogCaptureFixture) -> None:
    env.anchor()
    with caplog.at_level(logging.INFO):
        status, saved = connect(lambda_context)
        listed = _call(lambda_context, 'GET', CONNECTIONS)[1]['connections']
    assert (status, saved['created'], saved['connection']['kind']) == (201, True, 'fine_grained')
    credential = saved['connection']['credential']
    assert credential == {'kind': 'fine_grained_token', 'set': True, 'app_id': '123456', 'installation_id': '7890123',
                          'expires_at': (today() + timedelta(days=60)).isoformat(), 'expires_in_days': 60,
                          'login': 'casey-dev', 'saved_by_you': True, 'owner': 'alice'}
    assert next(c for c in listed if c['connection_id'] == 'lint-kit')['credential'] == credential
    # (another administrator sees whose token it is, and that it is not theirs)
    theirs = _call(lambda_context, 'GET', CONNECTIONS, claims=OTHER_ADMIN)[1]['connections']
    assert next(c for c in theirs if c['connection_id'] == 'lint-kit')['credential']['saved_by_you'] is False
    read = json.loads(parameter(env, f'{PREFIX}lint-kit') or '{}')
    assert read == {'kind': 'fine_grained', 'app_id': '123456', 'installation_id': 7890123, 'repository': REPOSITORY,
                    'key': 'app'}
    stored = json.loads(parameter(env, f'{TOKEN_PREFIX}lint-kit') or '{}')
    assert (stored['token'], stored['login'], stored['repository']) == (PAT, 'casey-dev', REPOSITORY)
    rows = json.dumps(env.agents.scan()['Items'], default=str)
    assert PAT not in rows
    assert PAT not in json.dumps([saved, listed])
    assert PAT not in caplog.text
    audit = [row for row in env.agents.scan()['Items'] if str(row['sk']).startswith(LOG_PREFIX)
             and row.get('connection_id') == 'lint-kit']
    assert [(row['action'], row['changes']['credential'], row['changes']['token']) for row in audit] == [
        ('created', 'replaced', 'replaced')]
    assert audit[0]['changes']['token_acknowledged']['to']['only_this_repository'] is True


@pytest.mark.parametrize(('api', 'code'), [
    (github(answer(404, {})), 'not_found'), (github(answer(403, {})), 'org_pending_approval'),
    (github(answer(401, {})), 'not_accepted'), (github(answer(200, repository(private=True), expiring(30))), 'private_repository'),
    (github(answer(200, repository(archived=True), expiring(30))), 'archived'),
    (github(answer(200, repository(permissions={'push': False}), expiring(30))), 'no_push'),
    (github(answer(200, repository())), 'no_expiry'), (github(days=120), 'expires_too_late'),
    (github(days=0), 'expired'), (github(private=[{'full_name': 'x/y'}]), 'other_repositories'),
])
def test_a_token_github_refuses_is_422_with_its_code_and_nothing_stored(lambda_context: Any, env: Env, api: FakeGitHub,
                                                                        code: str) -> None:
    env.anchor()
    env.answering(api)
    status, body = connect(lambda_context)
    assert (status, body['code']) == (422, code)
    assert PAT not in json.dumps(body)
    assert parameter(env, f'{TOKEN_PREFIX}lint-kit') is None


def test_a_classic_token_is_422_classic_token_before_github_is_asked(lambda_context: Any, env: Env) -> None:
    env.anchor()
    status, body = connect(lambda_context, token='ghp_' + 'a' * 36)
    assert (status, body['code']) == (422, 'classic_token')
    assert env.github[0].sent == []


@pytest.mark.parametrize('change', [{'only_this_repository': None}, {'only_this_repository': False},
                                    {'token': 'not-a-token'}, {'repository': 'no slash'}, {'default_branch': '..'},
                                    {'extra': 1}, {'connection_id': 'Not_An_Id'}])
def test_a_body_off_its_shape_is_400_naming_the_field_never_its_value(lambda_context: Any, env: Env,
                                                                      change: dict[str, Any]) -> None:
    env.anchor()
    status, body = connect(lambda_context, **change)
    assert status == 400
    assert PAT not in json.dumps(body)


def test_no_app_installation_to_read_with_or_a_repository_connected_already_is_409(lambda_context: Any,
                                                                                   env: Env) -> None:
    assert connect(lambda_context)[0] == 409   # (Connect GitHub first)
    env.anchor()
    assert connect(lambda_context)[0] == 201
    assert connect(lambda_context)[0] == 409   # (connected already)


def test_a_temporary_github_failure_is_503(lambda_context: Any, env: Env) -> None:
    env.anchor()
    env.answering(github(answer(502, {})))
    assert connect(lambda_context)[0] == 503


# --- replace, remove --------------------------------------------------------------------------------------------------


def test_the_token_is_replaced_by_its_owner_even_while_a_run_is_live_by_another_only_once_runs_end(
        lambda_context: Any, env: Env) -> None:
    env.anchor()
    connect(lambda_context)
    renewed = PAT[:-1] + 'r'
    env.answering(github(days=80))
    env.start_run()
    body = {'token': renewed, 'only_this_repository': True, 'reason': 'renewal'}
    status, answered = _call(lambda_context, 'PUT', f'{CONNECTIONS}/lint-kit/token', body=body)
    assert (status, answered['connection']['credential']['expires_in_days']) == (200, 80)
    assert json.loads(parameter(env, f'{TOKEN_PREFIX}lint-kit') or '{}')['token'] == renewed
    status, refused = _call(lambda_context, 'PUT', f'{CONNECTIONS}/lint-kit/token', body=body, claims=OTHER_ADMIN)
    assert (status, 'alice' in refused['error']) == (409, True)


@pytest.mark.parametrize(('path', 'status'), [(f'{CONNECTIONS}/billing/token', 409), (f'{CONNECTIONS}/nobody/token', 404),
                                              (f'{CONNECTIONS}/Not_An_Id/token', 400)])
def test_a_replace_of_another_kind_or_of_none_is_refused(lambda_context: Any, env: Env, path: str, status: int) -> None:
    env.anchor()
    assert _call(lambda_context, 'PUT', path, body={'token': PAT, 'only_this_repository': True})[0] == status


def test_a_replace_s_token_github_refuses_is_422(lambda_context: Any, env: Env) -> None:
    env.anchor()
    connect(lambda_context)
    env.answering(github(answer(200, repository(permissions={'push': False}), expiring(30))))
    status, body = _call(lambda_context, 'PUT', f'{CONNECTIONS}/lint-kit/token',
                         body={'token': PAT, 'only_this_repository': True})
    assert (status, body['code']) == (422, 'no_push')


def test_removing_the_connection_deletes_its_token_first_then_its_read_parameter(lambda_context: Any, env: Env) -> None:
    env.anchor()
    connect(lambda_context)
    deleted: list[str] = []
    real = env.ssm.delete_parameter

    class Recording:
        exceptions = env.ssm.exceptions

        def put_parameter(self, **kwargs: Any) -> Any:
            return env.ssm.put_parameter(**kwargs)

        def delete_parameter(self, Name: str) -> Any:
            deleted.append(Name)
            return real(Name=Name)

    with patch.object(agents_handler, '_ssm_client', Recording):
        assert _call(lambda_context, 'DELETE', f'{CONNECTIONS}/lint-kit') == (200, {'removed': True})
    assert deleted == [f'{TOKEN_PREFIX}lint-kit', f'{PREFIX}lint-kit']
    assert [parameter(env, f'{TOKEN_PREFIX}lint-kit'), parameter(env, f'{PREFIX}lint-kit')] == [None, None]


# --- the go, the start --------------------------------------------------------------------------------------------------


def test_only_the_token_owner_gives_a_run_on_the_connection_its_go(lambda_context: Any, env: Env) -> None:
    env.anchor()
    connect(lambda_context)
    env.start_run()
    status, refused = _call(lambda_context, 'POST', f'/agents/engineering/{RUN}/go', body={}, claims=OTHER_ADMIN)
    assert (status, refused.get('code'), 'alice' in refused['error']) == (403, 'token_owner_go', True)
    # (the owner passes the check: the go then needs the board function, which this test deploys none of)
    assert _call(lambda_context, 'POST', f'/agents/engineering/{RUN}/go', body={})[0] == 503


def test_a_run_on_another_kind_takes_any_admin_s_go(lambda_context: Any, env: Env) -> None:
    env.anchor()
    env.start_run(connection='billing')
    assert _call(lambda_context, 'POST', f'/agents/engineering/{RUN}/go', body={}, claims=OTHER_ADMIN)[0] == 503


def token_row(expires: str | None, **change: Any) -> dict[str, Any]:
    return {'connection_kind': 'fine_grained', 'credential_set': True, 'token_expires_at': expires, **change}


@pytest.mark.parametrize(('expires', 'refused'), [('2026-11-20', True), ('2026-11-19', True), (None, True),
                                                  ('2026-11-21', False), ('soon', True)])
def test_a_start_refuses_a_run_on_an_expired_or_unset_token(expires: str | None, refused: bool) -> None:
    row = {**token_row(expires), 'repository': REPOSITORY, 'default_branch': 'main'}
    if refused:
        with pytest.raises(ConflictError, match='replace'):
            eng_runs.run_connection(row, today=date(2026, 11, 20), pushes=True)
    else:
        assert eng_runs.run_connection(row, today=date(2026, 11, 20), pushes=True) == {'repo': REPOSITORY, 'default_branch': 'main'}
    with pytest.raises(ConflictError):
        eng_runs.run_connection({**row, 'credential_set': False, 'token_expires_at': '2027-01-01'},
                                today=date(2026, 11, 20), pushes=True)


@pytest.mark.parametrize(('expires', 'warned'), [('2026-11-23', '3 days'), ('2026-11-21', '1 day:'),
                                                 ('2026-11-24', None), ('2026-11-20', None)])
def test_a_start_warns_three_days_or_fewer_before_the_expiry(expires: str, warned: str | None) -> None:
    warning = eng_runs.token_warning(token_row(expires), date(2026, 11, 20), pushes=True)
    assert warning is None if warned is None else warned in (warning or '')
    assert eng_runs.token_warning({'repository': REPOSITORY}, date(2026, 11, 20), pushes=True) is None
    assert eng_runs.token_warning(token_row('2026-11-21'), date(2026, 11, 20), pushes=False) is None


def test_the_public_search_hints_the_ways_each_repository_connects() -> None:
    facts = RepositoryFacts(repository=REPOSITORY, description='', stars=1, licence_spdx='MIT', licence_name='MIT',
                            archived=False, private=False, fork=False, parent='', pushed_at='', default_branch='main',
                            html_url='')
    assert public_repos.ways_of(facts) == {'app': True, 'token': True, 'fork': True}
    assert public_repos.ways_of(replace(facts, licence_spdx='')) == {'app': True, 'token': True, 'fork': False}
    assert public_repos.ways_of(replace(facts, archived=True)) == {'app': False, 'token': False, 'fork': False}


def test_a_token_connection_s_installation_anchors_the_next_read() -> None:
    token = {'connection_id': 'sdk', 'host': 'github', 'kind': 'fine_grained',
             'credential': {'kind': 'fine_grained_token', 'app_id': '123', 'installation_id': '456'}}
    assert public_repos.anchor([token]) == ('123', 456)
