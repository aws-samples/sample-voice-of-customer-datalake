"""The deployment's GitHub Apps made in two clicks (github_apps.py): the manifest, the single-use states, the code's
exchange with the App's key going to SSM and nowhere else, the installation's repositories saved as connections that
reference the App's key, the check, the removal, and the audit rows."""
from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import boto3
import pytest
from moto import mock_aws

from engineering.connectors import github_apps
from engineering.connectors.connections import (
    LOG_PREFIX,
    MAX_CONNECTIONS,
    PARTITION,
    Actor,
    ConnectionRefused,
    ConnectionStore,
    parse_request,
)
from engineering.connectors.credentials import ParameterStoreCredentials
from engineering.connectors.github_apps import (
    CODE_REFUSED,
    MAX_APPS,
    SETUP_PARTITION,
    STATE_REFUSED,
    STATE_SECONDS,
    STATE_TTL_SECONDS,
    UNDER_WAY,
    GitHubApps,
    connection_id_for,
)
from engineering.connectors.hosts import HostBusy, HostError
from engineering.connectors.test.app_keys import connection_body, pem, private_key
from engineering.connectors.transport import Response

PREFIX = '/voc/engineering/'
TABLE = 'voc-agents-test'
ADMIN = Actor(subject='admin-sub', name='alice')
OTHER_ADMIN = Actor(subject='other-sub', name='bob')
WHEN = datetime(2026, 11, 16, 9, 0, tzinfo=UTC)
FRONTEND = 'https://d111.cloudfront.net'
HOOK = 'https://abc.execute-api.us-east-1.amazonaws.com/v1/webhooks/github_issues'
APP_ID = '4242'
SLUG = 'voc-agents-a1b2c3'
CODE = 'a180b1a3d263c81bc6441d7b990bae27d4c10679'
CLIENT_SECRET = 'client-secret-' + 'c' * 30
WEBHOOK_SECRET = 'webhook-secret-' + 'w' * 30


def answer(status: int, data: object = None) -> Response:
    return Response(status=status, headers={}, body=json.dumps(data).encode())


def conversion(**change: Any) -> dict[str, Any]:
    """GitHub's answer to the code (``POST /app-manifests/<code>/conversions``), with ``change``."""
    return {'id': int(APP_ID), 'slug': SLUG, 'node_id': 'A_kw', 'name': 'VoC agents a1b2c3',
            'owner': {'login': 'example-org', 'type': 'Organization'}, 'html_url': f'https://github.com/apps/{SLUG}',
            'client_id': 'Iv1.0123456789abcdef', 'client_secret': CLIENT_SECRET, 'webhook_secret': WEBHOOK_SECRET,
            'pem': pem(), 'permissions': dict(github_apps.PERMISSIONS), **change}


@dataclass
class FakeGitHub:
    """GitHub's conversion endpoint: the answers in turn (an exception is raised), every request recorded."""

    answers: list[Response | Exception] = field(default_factory=lambda: [answer(201, conversion())])
    sent: list[tuple[str, str, dict[str, str], bytes | None]] = field(default_factory=list)

    def request(self, method: str, path: str, headers: Any, body: bytes | None) -> Response:
        self.sent.append((method, path, dict(headers), body))
        found = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(found, Exception):
            raise found
        return found


def listed(name: str, *, private: bool = True, archived: bool = False, branch: str = 'main') -> dict[str, Any]:
    return {'repository': name, 'private': private, 'archived': archived, 'default_branch': branch}


@dataclass
class FakeTokens:
    """The token function's ``inspect_installation``: the installation's account and repositories, or ``error``."""

    repositories: list[dict[str, Any]] = field(default_factory=lambda: [listed('example-org/refund-service')])
    error: ConnectionRefused | None = None
    calls: list[dict[str, Any]] = field(default_factory=list)

    def __call__(self, request: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(request)
        if self.error is not None:
            raise self.error
        return {'account': {'login': 'example-org', 'type': 'Organization'}, 'repositories': self.repositories,
                'truncated': False}


class Clock:
    def __init__(self) -> None:
        self.now = WHEN

    def __call__(self) -> datetime:
        return self.now


@dataclass
class Env:
    table: Any
    ssm: Any
    key_id: str
    github: FakeGitHub = field(default_factory=FakeGitHub)
    tokens: FakeTokens = field(default_factory=FakeTokens)
    clock: Clock = field(default_factory=Clock)

    def connections(self) -> ConnectionStore:
        return ConnectionStore(self.table, lambda: self.ssm, PREFIX, self.key_id, lambda _: [], clock=self.clock)

    def apps(self, webhook_url: str = HOOK) -> GitHubApps:
        return GitHubApps(self.table, lambda: self.ssm, PREFIX, self.key_id, self.connections(), self.tokens,
                          frontend_url=FRONTEND, webhook_url=webhook_url, clock=self.clock, transport=self.github)

    def rows(self) -> list[dict[str, Any]]:
        return self.table.scan()['Items']

    def parameter(self, name: str) -> dict[str, Any]:
        return self.ssm.get_parameter(Name=f'{PREFIX}{name}', WithDecryption=True)['Parameter']

    def parameter_names(self) -> list[str]:
        return sorted(p['Name'] for p in self.ssm.describe_parameters()['Parameters'])


@pytest.fixture
def env() -> Iterator[Env]:
    with mock_aws():
        table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName=TABLE, BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                                  {'AttributeName': 'sk', 'AttributeType': 'S'}])
        key_id = boto3.client('kms', region_name='us-east-1').create_key()['KeyMetadata']['Arn']
        yield Env(table, boto3.client('ssm', region_name='us-east-1'), key_id)


def state_of(url: str) -> str:
    return parse_qs(urlsplit(url).query)['state'][0]


def created(env: Env, actor: Actor = ADMIN) -> dict[str, Any]:
    """The first click and GitHub's return: the App made, its key stored."""
    manifest = env.apps().manifest({'account': 'organization', 'org': 'example-org'}, actor)
    return env.apps().convert({'code': CODE, 'state': state_of(manifest['action_url'])}, actor)


def installed(env: Env, made: dict[str, Any], actor: Actor = ADMIN, installation_id: int = 777) -> dict[str, Any]:
    return env.apps().installed({'installation_id': installation_id, 'setup_action': 'install',
                                 'state': state_of(made['install_url'])}, actor)


# --- the manifest ---------------------------------------------------------------------------------------------------


def test_the_manifest_is_a_private_app_with_the_brokers_permissions_and_this_deployments_addresses(env: Env) -> None:
    made = env.apps().manifest({'account': 'user'}, ADMIN)
    manifest = made['manifest']
    assert manifest['default_permissions'] == {'contents': 'write', 'pull_requests': 'write', 'issues': 'write',
                                               'metadata': 'read'}
    assert (manifest['public'], manifest['request_oauth_on_install'], manifest['setup_on_update']) == (False, False, True)
    assert (manifest['url'], manifest['redirect_url'], manifest['setup_url']) == (
        FRONTEND, f'{FRONTEND}/agents/connections/github/created', f'{FRONTEND}/agents/connections/github/installed')
    assert manifest['hook_attributes'] == {'url': HOOK, 'active': True}
    assert manifest['default_events'] == ['issues', 'issue_comment']
    assert manifest['name'].startswith('VoC agents ')
    assert len(manifest['name']) <= 34
    assert made['action_url'].startswith('https://github.com/settings/apps/new?state=')
    assert made['expires_at'] == (WHEN + timedelta(seconds=STATE_SECONDS)).isoformat()


def test_an_organization_posts_to_its_own_settings_and_a_login_off_githubs_rule_is_refused(env: Env) -> None:
    made = env.apps().manifest({'account': 'organization', 'org': 'example-org'}, ADMIN)
    assert made['action_url'].startswith('https://github.com/organizations/example-org/settings/apps/new?state=')
    for body in ({'account': 'organization', 'org': 'bad--name'}, {'account': 'organization', 'org': '-x'},
                 {'account': 'organization'}, {'account': 'user', 'org': 'example-org'}, {'account': 'team'},
                 {'account': 'user', 'extra': 1}, {'account': 'organization', 'org': 'a' * 40}):
        with pytest.raises(ConnectionRefused) as refused:
            env.apps().manifest(body, ADMIN)
        assert refused.value.kind == 'invalid'


def test_without_the_webhook_the_manifest_asks_for_no_hook_and_no_events(env: Env) -> None:
    manifest = env.apps(webhook_url='').manifest({'account': 'user'}, ADMIN)['manifest']
    assert 'hook_attributes' not in manifest
    assert 'default_events' not in manifest


def test_a_state_is_kept_only_as_its_hash_with_its_expiry_and_ttl(env: Env) -> None:
    raw = state_of(env.apps().manifest({'account': 'user'}, ADMIN)['action_url'])
    [row] = [row for row in env.rows() if row['pk'] == SETUP_PARTITION]
    assert row['sk'] == f'STATE#{hashlib.sha256(raw.encode()).hexdigest()}'
    assert (row['purpose'], row['subject'], row['account']) == ('create', 'admin-sub', 'user')
    assert (int(row['expires_at']), int(row['ttl'])) == (int(WHEN.timestamp()) + STATE_SECONDS,
                                                         int(WHEN.timestamp()) + STATE_TTL_SECONDS)
    assert raw not in json.dumps(env.rows(), default=str)


# --- the code's exchange --------------------------------------------------------------------------------------------


def test_the_code_is_exchanged_once_and_the_key_and_webhook_secret_go_to_ssm_before_the_row(env: Env) -> None:
    made = created(env)
    [(method, path, headers, body)] = env.github.sent
    assert (method, path, body, 'Authorization' in headers) == ('POST', f'/app-manifests/{CODE}/conversions', None,
                                                                False)
    key = env.parameter(f'_github-app/{APP_ID}/key')
    assert json.loads(key['Value']) == {'app_id': APP_ID, 'slug': SLUG, 'private_key': pem().strip() + '\n'}
    assert key['Type'] == 'SecureString'
    assert json.loads(env.parameter(f'_github-app/{APP_ID}/webhook')['Value']) == {'webhook_secret': WEBHOOK_SECRET}
    described = {p['Name']: p for p in env.ssm.describe_parameters()['Parameters']}
    assert {(p['KeyId'], p['Tier']) for p in described.values()} == {(env.key_id, 'Standard')}
    assert made['app'] == {'app_id': APP_ID, 'slug': SLUG, 'owner': 'example-org', 'owner_type': 'Organization',
                           'html_url': f'https://github.com/apps/{SLUG}', 'webhook': True, 'connections': [],
                           'created_at': WHEN.isoformat(), 'created_by': 'alice', 'version': 1}
    assert made['install_url'].startswith(f'https://github.com/apps/{SLUG}/installations/new?state=')


def test_its_creation_is_an_audit_row_of_the_connections_shape(env: Env) -> None:
    created(env)
    [audit] = [row for row in env.rows() if row['sk'].startswith(LOG_PREFIX)]
    assert audit['pk'] == PARTITION
    assert audit['app_id'] == APP_ID
    assert {name: audit[name] for name in ('action', 'by', 'by_name', 'at', 'version')} == {
        'action': 'github_app_created', 'by': 'admin-sub', 'by_name': 'alice', 'at': WHEN.isoformat(), 'version': 1}
    assert audit['changes'] == {'slug': SLUG, 'owner': 'example-org', 'owner_type': 'Organization', 'webhook': True,
                                'key': 'stored'}


def test_without_a_hook_no_webhook_secret_is_stored_even_when_github_answers_one(env: Env) -> None:
    manifest = env.apps(webhook_url='').manifest({'account': 'user'}, ADMIN)
    made = env.apps(webhook_url='').convert({'code': CODE, 'state': state_of(manifest['action_url'])}, ADMIN)
    assert made['app']['webhook'] is False
    assert env.parameter_names() == [f'{PREFIX}_github-app/{APP_ID}/key']


def test_a_state_is_used_once_the_same_administrators_replay_gets_the_same_app_and_the_rest_one_400(env: Env) -> None:
    manifest = env.apps().manifest({'account': 'user'}, ADMIN)
    state = state_of(manifest['action_url'])
    first = env.apps().convert({'code': CODE, 'state': state}, ADMIN)
    again = env.apps().convert({'code': CODE, 'state': state}, ADMIN)   # (a refresh, React's double effect)
    assert again['app'] == first['app']
    assert again['install_url'] != first['install_url']
    assert len(env.github.sent) == 1   # (the code is exchanged once)
    refusals = []
    for body, actor in (({'code': CODE, 'state': state}, OTHER_ADMIN),
                        ({'code': CODE, 'state': state_of(first['install_url'])}, ADMIN),   # (another step's state)
                        ({'code': CODE, 'state': 'A' * 43}, ADMIN), ({'code': CODE, 'state': 'short'}, ADMIN)):
        with pytest.raises(ConnectionRefused) as refused:
            env.apps().convert(body, actor)
        refusals.append((refused.value.kind, str(refused.value)))
    assert refusals == [('invalid', STATE_REFUSED)] * 4


def test_an_expired_state_is_the_same_400(env: Env) -> None:
    manifest = env.apps().manifest({'account': 'user'}, ADMIN)
    env.clock.now = WHEN + timedelta(seconds=STATE_SECONDS + 1)
    with pytest.raises(ConnectionRefused) as refused:
        env.apps().convert({'code': CODE, 'state': state_of(manifest['action_url'])}, ADMIN)
    assert (refused.value.kind, str(refused.value)) == ('invalid', STATE_REFUSED)
    assert env.github.sent == []


@pytest.mark.parametrize('failure', [HostBusy('unreachable', retry_after=60), answer(502, {}), answer(429, {}),
                                     HostError('lost')])
def test_a_transient_failure_releases_the_state_so_the_same_code_is_tried_again(env: Env, failure: Any) -> None:
    env.github.answers = [failure, answer(201, conversion())]
    manifest = env.apps().manifest({'account': 'user'}, ADMIN)
    body = {'code': CODE, 'state': state_of(manifest['action_url'])}
    with pytest.raises(ConnectionRefused) as refused:
        env.apps().convert(body, ADMIN)
    assert refused.value.kind == 'unavailable'
    assert env.apps().convert(body, ADMIN)['app']['app_id'] == APP_ID
    assert env.parameter_names() == [f'{PREFIX}_github-app/{APP_ID}/key', f'{PREFIX}_github-app/{APP_ID}/webhook']


@pytest.mark.parametrize('status', [404, 422])
def test_a_code_github_no_longer_takes_is_409_saying_the_app_may_exist_there(env: Env, status: int) -> None:
    env.github.answers = [answer(status, {'message': 'Not Found'})]
    manifest = env.apps().manifest({'account': 'user'}, ADMIN)
    body = {'code': CODE, 'state': state_of(manifest['action_url'])}
    for _ in range(2):   # (said again on a replay, without asking GitHub again)
        with pytest.raises(ConnectionRefused) as refused:
            env.apps().convert(body, ADMIN)
        assert (refused.value.kind, str(refused.value)) == ('conflict', CODE_REFUSED)
    assert len(env.github.sent) == 1
    assert env.parameter_names() == []
    assert 'delete it in github' in CODE_REFUSED.lower()


def test_a_step_under_way_is_409_not_a_second_exchange(env: Env) -> None:
    manifest = env.apps().manifest({'account': 'user'}, ADMIN)
    state = state_of(manifest['action_url'])
    env.apps().states.claim(state, 'create', ADMIN)   # (another request holds it, no outcome yet)
    with pytest.raises(ConnectionRefused) as refused:
        env.apps().convert({'code': CODE, 'state': state}, ADMIN)
    assert (refused.value.kind, str(refused.value)) == ('conflict', UNDER_WAY)
    assert env.github.sent == []


def test_an_answer_off_its_shape_stores_nothing(env: Env) -> None:
    env.github.answers = [answer(201, conversion(pem='not a key'))]
    with pytest.raises(ConnectionRefused) as refused:
        created(env)
    assert refused.value.kind == 'unavailable'
    assert env.parameter_names() == []
    assert [row for row in env.rows() if row['sk'].startswith('GITHUB_APP#')] == []


def test_the_apps_limit_refuses_a_manifest(env: Env) -> None:
    for n in range(MAX_APPS):
        env.github.answers = [answer(201, conversion(id=5000 + n, slug=f'voc-agents-{n}'))]
        created(env)
    with pytest.raises(ConnectionRefused) as refused:
        env.apps().manifest({'account': 'user'}, ADMIN)
    assert refused.value.kind == 'conflict'
    assert [app['app_id'] for app in env.apps().list()] == [str(5000 + n) for n in range(MAX_APPS)]


def logged(caplog: pytest.LogCaptureFixture) -> str:
    """Every record our code logged, its message and its extras (the AWS SDK's own debug log, which dumps request
    bodies, is never on in a deployment: LOG_LEVEL is INFO, and botocore logs at WARNING)."""
    return '\n'.join(json.dumps(vars(record), default=str) for record in caplog.records
                     if not record.name.startswith(('botocore', 'boto3', 'urllib3', 's3transfer')))


def test_no_key_secret_or_state_reaches_a_log_an_answer_or_a_row(env: Env, caplog: pytest.LogCaptureFixture) -> None:
    key_line = pem().split('\n')[1]
    with caplog.at_level(logging.DEBUG):
        manifest = env.apps().manifest({'account': 'user'}, ADMIN)
        state = state_of(manifest['action_url'])
        made = env.apps().convert({'code': CODE, 'state': state}, ADMIN)
        done = installed(env, made)
        answers = json.dumps([manifest, made, done, env.apps().list(), env.connections().list()], default=str)
    text, rows = logged(caplog), json.dumps(env.rows(), default=str)
    assert 'engineering GitHub App created' in text   # (the scan reads what was logged)
    for secret in (key_line, WEBHOOK_SECRET, CLIENT_SECRET):
        assert secret not in text
        assert secret not in answers
        assert secret not in rows
    for raw in (state, state_of(made['install_url']), CODE):
        assert raw not in text
        assert raw not in rows
    assert 'PRIVATE' not in repr(github_apps._converted(conversion()))


# --- the installation ----------------------------------------------------------------------------------------------


def test_every_installed_repository_becomes_a_connection_that_references_the_apps_key(env: Env) -> None:
    env.connections().save('docs', parse_request(connection_body(repository='example-org/docs')), ADMIN)
    env.tokens.repositories = [listed('example-org/refund-service', private=True), listed('example-org/Docs'),
                               listed('example-org/old-site', archived=True),
                               listed('example-org/web.app', private=False, branch='trunk')]
    done = installed(env, created(env))
    assert env.tokens.calls == [{'action': 'inspect_installation', 'app_id': APP_ID, 'installation_id': 777}]
    assert [(c['connection']['connection_id'], c['created']) for c in done['connections']] == [
        ('refund-service', True), ('web-app', True)]
    assert done['skipped'] == [{'repository': 'example-org/Docs', 'reason': 'already_connected'},
                               {'repository': 'example-org/old-site', 'reason': 'archived'}]
    assert done['account'] == {'login': 'example-org', 'type': 'Organization'}
    assert done['app']['connections'] == ['refund-service', 'web-app']
    web = next(c['connection'] for c in done['connections'] if c['connection']['connection_id'] == 'web-app')
    assert (web['credential']['kind'], web['credential']['app_id'], web['credential']['installation_id'],
            web['repository_private'], web['default_branch']) == ('app_reference', APP_ID, '777', False, 'trunk')
    stored = json.loads(env.parameter('web-app')['Value'])
    assert stored == {'app_id': APP_ID, 'installation_id': 777, 'repository': 'example-org/web.app', 'key': 'app'}


def test_the_broker_reads_such_a_connection_with_the_apps_key(env: Env) -> None:
    installed(env, created(env))
    credential = ParameterStoreCredentials(PREFIX, client=lambda: env.ssm).get('refund-service')
    assert (credential.app_id, credential.installation_id, credential.owner, credential.repository) == (
        APP_ID, 777, 'example-org', 'refund-service')
    assert credential.private_key.private_numbers() == private_key().private_numbers()


def test_repositories_past_the_connections_limit_are_reported_and_ids_never_collide(env: Env) -> None:
    env.tokens.repositories = [listed(f'org-{n}/same') for n in range(MAX_CONNECTIONS + 2)]
    done = installed(env, created(env))
    ids = [c['connection']['connection_id'] for c in done['connections']]
    assert ids[:3] == ['same', 'same-2', 'same-3']
    assert len(set(ids)) == MAX_CONNECTIONS
    assert done['skipped'] == [{'repository': f'org-{n}/same', 'reason': 'limit'}
                               for n in (MAX_CONNECTIONS, MAX_CONNECTIONS + 1)]


def test_a_repository_whose_default_branch_the_connections_refuse_is_not_saved(env: Env) -> None:
    env.tokens.repositories = [listed('example-org/a', branch='voc-agent/x'), listed('example-org/b', branch='')]
    done = installed(env, created(env))
    assert done['connections'] == []
    assert [s['reason'] for s in done['skipped']] == ['not_saved', 'not_saved']


def test_an_installation_the_token_function_refuses_is_409_and_the_state_stays_usable(env: Env) -> None:
    made = created(env)
    env.tokens.error = ConnectionRefused('conflict', 'this installation belongs to another GitHub App')
    with pytest.raises(ConnectionRefused) as refused:
        installed(env, made)
    assert refused.value.kind == 'conflict'
    env.tokens.error = None
    assert [c['connection']['connection_id'] for c in installed(env, made)['connections']] == ['refund-service']


def test_the_same_installation_posted_again_answers_the_same_outcome(env: Env) -> None:
    made = created(env)
    first = installed(env, made)
    again = installed(env, made)
    assert (again['connections'], again['skipped']) == (first['connections'], first['skipped'])
    assert len(env.tokens.calls) == 1


@pytest.mark.parametrize(('body', 'message'), [
    ({'installation_id': 777, 'setup_action': 'request', 'state': 'A' * 43}, 'an owner must approve'),
    ({'installation_id': 777, 'setup_action': 'delete', 'state': 'A' * 43}, 'setup_action'),
    ({'installation_id': '07', 'setup_action': 'install', 'state': 'A' * 43}, 'installation_id'),
    ({'installation_id': 777, 'setup_action': 'install'}, 'the body is'),
])
def test_an_installations_body_off_its_shape_is_refused_before_its_state_is_read(env: Env, body: dict[str, Any],
                                                                                 message: str) -> None:
    with pytest.raises(ConnectionRefused) as refused:
        env.apps().installed(body, ADMIN)
    assert refused.value.kind == 'invalid'
    assert message in str(refused.value)
    assert env.tokens.calls == []


def test_install_issues_a_new_link_with_a_new_install_state(env: Env) -> None:
    made = created(env)
    again = env.apps().install(APP_ID, ADMIN)
    assert again['install_url'] != made['install_url']
    assert [c['connection']['connection_id'] for c in installed(env, {'install_url': again['install_url']})[
        'connections']] == ['refund-service']
    with pytest.raises(ConnectionRefused) as refused:
        env.apps().install('999', ADMIN)
    assert refused.value.kind == 'not_found'


# --- the check and the removal ---------------------------------------------------------------------------------------


def test_the_check_marks_the_connections_whose_repository_left_the_installation(env: Env) -> None:
    env.tokens.repositories = [listed('example-org/refund-service'), listed('example-org/web')]
    installed(env, created(env))
    env.tokens.repositories = [listed('example-org/web')]
    assert env.apps().check(APP_ID) == {'repositories': ['example-org/web'], 'missing': ['refund-service']}
    env.tokens.error = ConnectionRefused('conflict', 'gone')
    assert env.apps().check(APP_ID) == {'repositories': [], 'missing': ['refund-service', 'web']}


def test_an_app_in_use_is_not_removed_and_an_unused_one_is_with_its_parameters(env: Env) -> None:
    installed(env, created(env))
    with pytest.raises(ConnectionRefused) as refused:
        env.apps().remove(APP_ID, ADMIN)
    assert refused.value.kind == 'conflict'
    env.connections().remove('refund-service', ADMIN)
    env.apps().remove(APP_ID, ADMIN, 'Moved to another App')
    assert env.apps().list() == []
    assert env.parameter_names() == []
    [removal] = [row for row in env.rows() if row.get('action') == 'github_app_removed' and row.get('app_id') == APP_ID]
    assert (removal['action'], removal['reason'], removal['version']) == ('github_app_removed', 'Moved to another App', 2)
    with pytest.raises(ConnectionRefused) as again:
        env.apps().remove(APP_ID, ADMIN)
    assert again.value.kind == 'not_found'


def test_connection_ids_follow_the_repository_name() -> None:
    assert connection_id_for('Org/My_Repo.JS', set()) == 'my-repo-js'
    assert connection_id_for('org/repo', {'repo', 'repo-2'}) == 'repo-3'
    assert connection_id_for('org/---', set()) == 'repository'
    assert len(connection_id_for('org/' + 'a' * 100, {'a' * 58})) <= 63
