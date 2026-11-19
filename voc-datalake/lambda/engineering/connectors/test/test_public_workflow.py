"""Any public repository, the Agents API's side (7.57.00): the picker and the read-only connection (public_repos.py),
the fork workflow and its owner's settings (forks.py), a person's GitHub user authorization (user_authorizations.py),
and the App's OAuth client kept at its creation (github_apps.py). Under moto: no secret is ever answered, a read-only
connection takes no attestation and no label, and a kind never changes."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from moto import mock_aws

from engineering.connectors.connections import KIND_FORK, ConnectionRefused, parse_attestation, parse_request
from engineering.connectors.credentials import parse_credential
from engineering.connectors.forks import Forks
from engineering.connectors.github_apps import FORK_INSTALL, GitHubApps
from engineering.connectors.public_repos import NO_APP, PublicRepositories
from engineering.connectors.test.app_keys import connection_body, private_key
from engineering.connectors.test.connections_aws import connections_aws
from engineering.connectors.test.test_github_apps import (
    ADMIN,
    CODE,
    FRONTEND,
    HOOK,
    OTHER_ADMIN,
    PREFIX,
    TABLE,
    Env,
    answer,
    conversion,
    created,
    listed,
    state_of,
)
from engineering.connectors.user_auth_paths import client_parameter, subject_hash, user_parameter
from engineering.connectors.user_authorizations import UserAuthorizations

USER_PREFIX = '/voc/engineering-user-auth/'
UPSTREAM = 'upstream-org/lint-kit'
CLIENT_ID = 'Iv23liExample0Client1'
CLIENT_SECRET = '0123456789abcdef0123456789abcdef01234567'


@pytest.fixture
def env() -> Iterator[Env]:
    with mock_aws():
        yield Env(*connections_aws(TABLE))


def public_facts(name: str = UPSTREAM, **change: Any) -> dict[str, Any]:
    return {'repository': name, 'description': 'A linter', 'stars': 1200, 'licence_spdx': 'MIT',
            'licence_name': 'MIT License', 'archived': False, 'private': False, 'fork': False, 'parent': '',
            'pushed_at': '2026-11-01T00:00:00Z', 'default_branch': 'main', 'html_url': f'https://github.com/{name}',
            'topics': [], **change}


@dataclass
class PublicTokens:
    """The token function, its 7.57.00 actions too: the upstream's facts (``facts``, ``opt_out``) and the fork an
    install covers (``forks``)."""

    facts: dict[str, Any] = field(default_factory=public_facts)
    opt_out: str | None = None
    forks: list[dict[str, Any]] = field(default_factory=lambda: [
        {'repository': 'casey-dev/lint-kit', 'default_branch': 'main', 'private': False, 'archived': False}])
    account: dict[str, str] = field(default_factory=lambda: {'login': 'casey-dev', 'type': 'User'})
    calls: list[dict[str, Any]] = field(default_factory=list)

    def __call__(self, request: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(request)
        action = request['action']
        if action == 'inspect_installation':
            return {'account': {'login': 'example-org', 'type': 'Organization'}, 'truncated': False,
                    'app_slug': 'voc-agents-a1b2c3', 'repositories': [listed('example-org/refund-service')]}
        if action == 'public_search':
            return {'repositories': [self.facts, public_facts('someone/hidden', private=True)]}
        if action == 'public_repository':
            return {'repository': self.facts, 'opt_out': self.opt_out, 'contributing': None}
        if action == 'inspect_fork':
            return {'account': self.account, 'forks': self.forks}
        return {'repository': request.get('repository'), 'label': 'voc-agent', 'created': True}


def wired(env: Env, tokens: PublicTokens) -> tuple[GitHubApps, PublicRepositories, Forks]:
    apps = GitHubApps(env.table, lambda: env.ssm, PREFIX, env.key_id, env.connections(), tokens,
                      frontend_url=FRONTEND, webhook_url=HOOK, clock=env.clock, transport=env.github,
                      user_prefix=USER_PREFIX)
    apps.forks = Forks(env.connections(), apps, tokens)
    return apps, PublicRepositories(env.connections(), tokens), apps.forks


def own_repository(env: Env, tokens: PublicTokens) -> GitHubApps:
    """The deployment's App, installed on one of its own repositories (the anchor a public read uses)."""
    apps, _, _ = wired(env, tokens)
    made = apps.manifest({'account': 'organization', 'org': 'example-org'}, ADMIN)
    converted = apps.convert({'code': CODE, 'state': state_of(made['action_url'])}, ADMIN)
    apps.installed({'installation_id': 777, 'setup_action': 'install', 'state': state_of(converted['install_url'])},
                   ADMIN)
    return apps


# --- the picker and the read-only connection -------------------------------------------------------------------------


def test_with_no_app_installation_a_public_repository_is_not_read_at_all(env: Env) -> None:
    _, public, _ = wired(env, PublicTokens())
    with pytest.raises(ConnectionRefused) as refused:
        public.search('lint-kit')
    assert (refused.value.kind, str(refused.value)) == ('conflict', NO_APP)


def test_the_picker_answers_public_repositories_only_through_the_apps_installation(env: Env) -> None:
    tokens = PublicTokens()
    own_repository(env, tokens)
    _, public, _ = wired(env, tokens)
    found = public.search('lint')
    assert [item['repository'] for item in found['repositories']] == [UPSTREAM]   # (never the private one)
    assert found['repositories'][0]['licence'] == {'spdx': 'MIT', 'name': 'MIT License'}
    assert tokens.calls[-1] == {'action': 'public_search', 'app_id': '4242', 'installation_id': 777, 'query': 'lint'}
    with pytest.raises(ConnectionRefused):
        public.search('')


def test_a_public_repository_is_connected_read_only_with_no_write_credential(env: Env) -> None:
    tokens = PublicTokens()
    own_repository(env, tokens)
    _, public, _ = wired(env, tokens)
    connection, created_, _ = public.connect({'repository': f'https://github.com/{UPSTREAM}'}, ADMIN)
    assert created_
    assert connection['kind'] == 'public_read'
    assert connection['public'] == {'stars': 1200, 'licence': 'MIT', 'archived': False,
                                    'pushed_at': '2026-11-01T00:00:00Z'}
    assert connection['credential']['kind'] == 'public_read'
    stored = env.parameter(connection['connection_id'])['Value']
    assert json.loads(stored) == {'kind': 'public_read', 'app_id': '4242', 'installation_id': 777,
                                  'repository': UPSTREAM, 'key': 'app'}   # (no key, no token: the App's, read only)
    assert parse_credential(stored, lambda _: private_key()).kind == 'public_read'
    with pytest.raises(ConnectionRefused) as again:
        public.connect({'repository': UPSTREAM}, ADMIN)
    assert again.value.kind == 'conflict'


def test_a_private_or_missing_repository_does_not_connect_as_public(env: Env) -> None:
    tokens = PublicTokens(facts=public_facts(private=True))
    own_repository(env, tokens)
    _, public, _ = wired(env, tokens)
    with pytest.raises(ConnectionRefused) as refused:
        public.connect({'repository': UPSTREAM}, ADMIN)
    assert refused.value.kind == 'not_found'


def test_a_read_only_connection_takes_no_attestation_and_keeps_its_kind(env: Env) -> None:
    _, _, connection = _public(env, PublicTokens())
    store = env.connections()
    with pytest.raises(ConnectionRefused, match='read-only connection'):
        store.attest(connection['connection_id'], parse_attestation({
            'points': ['protected_secrets', 'read_only_token', 'oidc_pinned', 'no_self_hosted_runner',
                       'no_privileged_pull_request', 'branch_rules'], 'repository': UPSTREAM,
            'version': connection['version']}), ADMIN)
    with pytest.raises(ConnectionRefused, match='public read connection'):
        store.save(connection['connection_id'], parse_request(connection_body()), ADMIN)


# --- the fork workflow ---------------------------------------------------------------------------------------------


def _public(env: Env, tokens: PublicTokens) -> tuple[GitHubApps, Forks, dict[str, Any]]:
    """The deployment's App on its own repository, and the upstream connected read only: the Apps, the forks and the
    connection."""
    own_repository(env, tokens)
    apps, public, forks = wired(env, tokens)
    connection, _, _ = public.connect({'repository': UPSTREAM}, ADMIN)
    return apps, forks, connection


def test_contribute_answers_githubs_fork_page_and_an_install_link_of_its_own(env: Env) -> None:
    tokens = PublicTokens()
    _, forks, connection = _public(env, tokens)
    started = forks.start(connection['connection_id'], {'account': 'user', 'licence': 'MIT'}, ADMIN)
    assert started['fork_url'] == f'https://github.com/{UPSTREAM}/fork'
    assert urlsplit(started['install_url']).path == '/apps/voc-agents-a1b2c3/installations/new'
    assert tokens.calls[-1]['details'] is True   # (the upstream read again, its opt-out and CONTRIBUTING too)
    state = [row for row in env.rows() if row.get('purpose') == FORK_INSTALL]
    assert len(state) == 1
    assert state[0]['upstream'] == UPSTREAM
    assert state[0]['licence'] == 'MIT'


@pytest.mark.parametrize(('tokens', 'body', 'said'), [
    (PublicTokens(facts=public_facts(archived=True)), {'account': 'user', 'licence': 'MIT'}, 'archived'),
    (PublicTokens(opt_out='no-bot-prs'), {'account': 'user', 'licence': 'MIT'}, 'opts out'),
    (PublicTokens(facts=public_facts(licence_spdx=None)), {'account': 'user', 'licence': 'MIT'}, 'no licence'),
    (PublicTokens(), {'account': 'user', 'licence': 'Apache-2.0'}, 'acknowledge it again'),
])
def test_contribute_is_refused_for_an_archived_opted_out_or_unacknowledged_repository(
        env: Env, tokens: PublicTokens, body: dict[str, Any], said: str) -> None:
    _, forks, connection = _public(env, PublicTokens())
    forks._tokens = tokens  # (the upstream as GitHub answers it at the start)
    with pytest.raises(ConnectionRefused, match=said):
        forks.start(connection['connection_id'], body, ADMIN)


def test_the_installs_return_saves_the_forks_one_connection_owned_by_who_started_it(env: Env) -> None:
    tokens = PublicTokens()
    apps, forks, connection = _public(env, tokens)
    started = forks.start(connection['connection_id'], {'account': 'user', 'licence': 'MIT'}, ADMIN)
    done = apps.installed({'installation_id': 888, 'setup_action': 'install',
                           'state': state_of(started['install_url'])}, ADMIN)
    assert done['fork'] == {'upstream': UPSTREAM, 'repository': 'casey-dev/lint-kit'}
    [saved] = done['connections']
    fork = saved['connection']
    assert (fork['kind'], fork['repository'], fork['credential']['kind']) == (KIND_FORK, 'casey-dev/lint-kit',
                                                                             'app_reference')
    assert fork['fork']['owned_by_me'] is True
    assert fork['fork']['upstream_pr_assisted'] is False
    value = json.loads(env.parameter(fork['connection_id'])['Value'])
    assert (value['kind'], value['upstream'], value['owner'], value['licence']) == (
        'fork', UPSTREAM, subject_hash(ADMIN.subject), 'MIT')
    assert ADMIN.subject not in json.dumps(value)   # (the parameter names the owner by a hash)
    assert all(fork['fork']['owned_by_me'] is False for fork in [c for c in env.connections().list(OTHER_ADMIN.subject)
                                                                 if c['kind'] == KIND_FORK])


def test_an_install_that_covers_no_fork_in_the_chosen_account_keeps_its_state(env: Env) -> None:
    tokens = PublicTokens(forks=[])
    apps, forks, connection = _public(env, tokens)
    started = forks.start(connection['connection_id'], {'account': 'organization', 'org': 'acme-tools',
                                                         'licence': 'MIT'}, ADMIN)
    tokens.account = {'login': 'acme-tools', 'type': 'Organization'}
    with pytest.raises(ConnectionRefused, match='fork it on GitHub first'):
        apps.installed({'installation_id': 888, 'setup_action': 'install',
                        'state': state_of(started['install_url'])}, ADMIN)
    tokens.forks = [{'repository': 'acme-tools/lint-kit', 'default_branch': 'main', 'private': False,
                     'archived': False}]
    done = apps.installed({'installation_id': 888, 'setup_action': 'install',
                           'state': state_of(started['install_url'])}, ADMIN)   # (the same link, once forked)
    assert done['fork']['repository'] == 'acme-tools/lint-kit'


def test_only_the_owner_changes_the_forks_upstream_settings(env: Env) -> None:
    tokens = PublicTokens()
    apps, forks, connection = _public(env, tokens)
    started = forks.start(connection['connection_id'], {'account': 'user', 'licence': 'MIT'}, ADMIN)
    fork = apps.installed({'installation_id': 888, 'setup_action': 'install',
                           'state': state_of(started['install_url'])}, ADMIN)['connections'][0]['connection']
    with pytest.raises(ConnectionRefused, match='only the connection'):
        forks.set_upstream(fork['connection_id'], {'assisted': True}, OTHER_ADMIN)
    changed = forks.set_upstream(fork['connection_id'], {'assisted': True, 'reason': 'trusted repo'}, ADMIN)
    assert changed['fork']['upstream_pr_assisted'] is True
    assert json.loads(env.parameter(fork['connection_id'])['Value'])['upstream_pr_assisted'] is True
    audits = [row for row in env.rows() if row.get('connection_id') == fork['connection_id']
              and str(row['sk']).startswith('LOG#') and row.get('action') == 'updated']
    assert audits
    assert audits[-1]['changes']['upstream_pr_assisted'] == {'from': False, 'to': True}


# --- the user authorization ---------------------------------------------------------------------------------------


def authorizations(env: Env, apps: GitHubApps, exchange: Any) -> UserAuthorizations:
    return UserAuthorizations(env.table, lambda: env.ssm, USER_PREFIX, env.key_id, apps, exchange,
                              frontend_url=FRONTEND, clock=env.clock)


def test_a_new_apps_oauth_client_goes_to_the_user_auth_path_never_answered(env: Env) -> None:
    env.github.answers = [answer(201, conversion(client_id=CLIENT_ID, client_secret=CLIENT_SECRET))]
    apps, _, _ = wired(env, PublicTokens())
    made = apps.manifest({'account': 'user'}, ADMIN)
    assert made['manifest']['callback_urls'] == [f'{FRONTEND}/agents/connections/github/authorized']
    converted = apps.convert({'code': CODE, 'state': state_of(made['action_url'])}, ADMIN)
    assert (converted['app']['oauth'], converted['app']['client_id']) == (True, CLIENT_ID)
    stored = env.ssm.get_parameter(Name=client_parameter(USER_PREFIX, '4242'), WithDecryption=True)
    assert json.loads(stored['Parameter']['Value'])['client_secret'] == CLIENT_SECRET
    assert CLIENT_SECRET not in json.dumps(converted, default=str)
    assert CLIENT_SECRET not in json.dumps(env.rows(), default=str)


def test_authorize_then_the_return_records_the_login_and_never_a_token(env: Env) -> None:
    apps, _, _ = wired(env, PublicTokens())
    made = created(env)
    asked: list[dict[str, Any]] = []

    def exchange(request: dict[str, Any]) -> dict[str, Any]:
        asked.append(request)
        return {'login': 'casey-dev', 'user_id': 99, 'expires_at': None,
                'refresh_token_expires_at': '2027-05-01T00:00:00+00:00'}

    users = authorizations(env, apps, exchange)
    with pytest.raises(ConnectionRefused, match='OAuth client is not stored'):
        users.authorize(made['app']['app_id'], {}, ADMIN)
    with pytest.raises(ConnectionRefused):
        users.set_client(made['app']['app_id'], {'client_id': CLIENT_ID, 'client_secret': 'too-short'}, ADMIN)
    app = users.set_client(made['app']['app_id'], {'client_id': CLIENT_ID, 'client_secret': CLIENT_SECRET}, ADMIN)
    assert app['oauth'] is True
    link = users.authorize(app['app_id'], {}, ADMIN)['authorize_url']
    query = parse_qs(urlsplit(link).query)
    assert (urlsplit(link).netloc, query['client_id'], query['redirect_uri']) == (
        'github.com', [CLIENT_ID], [f'{FRONTEND}/agents/connections/github/authorized'])
    done = users.complete({'code': 'code123', 'state': query['state'][0]}, ADMIN)
    assert done == {'authorization': {'app_id': app['app_id'], 'login': 'casey-dev',
                                      'authorized_at': env.clock().isoformat(),
                                      'refresh_expires_at': '2027-05-01T00:00:00+00:00'}}
    assert asked == [{'action': 'exchange', 'app_id': app['app_id'], 'subject_hash': subject_hash(ADMIN.subject),
                      'code': 'code123', 'redirect_uri': f'{FRONTEND}/agents/connections/github/authorized'}]
    assert users.complete({'code': 'code123', 'state': query['state'][0]}, ADMIN) == done   # (a replay)
    assert users.mine(ADMIN) == [done['authorization']]
    assert users.mine(OTHER_ADMIN) == []
    with pytest.raises(ConnectionRefused):
        users.complete({'code': 'code123', 'state': query['state'][0]}, OTHER_ADMIN)   # (not their state)
    env.ssm.put_parameter(Name=user_parameter(USER_PREFIX, app['app_id'], subject_hash(ADMIN.subject)),
                          Type='SecureString', Value='{}')   # (as voc-engineering-user-auth would have stored it)
    users.remove(app['app_id'], ADMIN)
    assert users.mine(ADMIN) == []
    with pytest.raises(env.ssm.exceptions.ParameterNotFound):
        env.ssm.get_parameter(Name=user_parameter(USER_PREFIX, app['app_id'], subject_hash(ADMIN.subject)))
    assert sorted(row['action'] for row in env.rows() if row.get('action', '').startswith('github_user')) == [
        'github_user_authorization_removed', 'github_user_authorized']


def test_a_public_connection_gets_no_label(env: Env) -> None:
    from engineering.connectors.issues_sync import IssuesFollow, app_of

    tokens = PublicTokens()
    _, _, connection = _public(env, tokens)
    assert app_of(connection) == ('4242', 777)   # (its issues followed, read with the App's read-only token)
    follow = IssuesFollow(None, env.table, tokens)
    assert follow._labels([connection], {}, ADMIN) == []
    assert not [call for call in tokens.calls if call['action'] == 'ensure_label']
