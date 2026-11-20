"""Any public repository, the Agents API's side (7.57.00): the picker and the read-only connection (public_repos.py),
the fork workflow and (7.58.00) its owner's acknowledgement of a changed licence (forks.py), and the App's OAuth client
never kept (github_apps.py: the user authorization that kept it is gone). Under moto: no secret is ever answered, a
read-only connection takes no attestation and no label, and a kind never changes."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

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
    listed,
    state_of,
)
from shared.digests import sha256_hex as subject_hash

UPSTREAM = 'upstream-org/lint-kit'
#: A GitHub App's OAuth client as its conversion answers one (fixtures: no real client has them).
CLIENT_ID = 'Iv23liExample0Client1'
CLIENT_SECRET = '0123456789abcdef0123456789abcdef01234567'
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
                      frontend_url=FRONTEND, webhook_url=HOOK, clock=env.clock, transport=env.github)
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
    assert 'upstream_pr_assisted' not in fork['fork']
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


def _fork(env: Env, tokens: PublicTokens) -> tuple[Forks, dict[str, Any]]:
    """A fork connection made by ADMIN through the install's return."""
    apps, forks, connection = _public(env, tokens)
    started = forks.start(connection['connection_id'], {'account': 'user', 'licence': 'MIT'}, ADMIN)
    fork = apps.installed({'installation_id': 888, 'setup_action': 'install',
                           'state': state_of(started['install_url'])}, ADMIN)['connections'][0]['connection']
    return forks, fork


def test_only_the_owner_acknowledges_the_upstreams_current_licence_again(env: Env) -> None:
    # (Q22, 7.58.00) {licence, reason?}: the upstream read again, its current licence alone taken.
    tokens = PublicTokens()
    forks, fork = _fork(env, tokens)
    with pytest.raises(ConnectionRefused, match='only the connection'):
        forks.set_upstream(fork['connection_id'], {'licence': 'MIT'}, OTHER_ADMIN)
    for body in ({}, {'assisted': True}, {'licence': 'MIT', 'assisted': False}):
        with pytest.raises(ConnectionRefused, match=r'the body is \{licence, reason\?\}'):
            forks.set_upstream(fork['connection_id'], body, ADMIN)
    tokens.facts = public_facts(licence_spdx='Apache-2.0')
    with pytest.raises(ConnectionRefused, match=r"licence is Apache-2\.0, not the MIT acknowledged"):
        forks.set_upstream(fork['connection_id'], {'licence': 'MIT'}, ADMIN)
    changed = forks.set_upstream(fork['connection_id'], {'licence': 'Apache-2.0', 'reason': 'licence changed'}, ADMIN)
    assert changed['fork']['licence'] == 'Apache-2.0'
    value = json.loads(env.parameter(fork['connection_id'])['Value'])
    assert (value['licence'], 'upstream_pr_assisted' in value) == ('Apache-2.0', False)
    audits = [row for row in env.rows() if row.get('connection_id') == fork['connection_id']
              and str(row['sk']).startswith('LOG#') and row.get('action') == 'updated']
    assert audits[-1]['changes']['licence'] == {'from': 'MIT', 'to': 'Apache-2.0'}


def test_acknowledging_the_licence_again_refreshes_the_upstreams_default_branch(env: Env) -> None:
    # (Q20, 7.58.00) The stored default branch was frozen at connect time: the acknowledgement reads the upstream and
    # stores the one GitHub answers now.
    tokens = PublicTokens()
    forks, fork = _fork(env, tokens)
    tokens.facts = public_facts(default_branch='trunk')
    changed = forks.set_upstream(fork['connection_id'], {'licence': 'MIT'}, ADMIN)
    assert changed['fork']['upstream_default_branch'] == 'trunk'
    assert json.loads(env.parameter(fork['connection_id'])['Value'])['upstream_default_branch'] == 'trunk'


def test_an_apps_oauth_client_is_never_kept_and_its_manifest_names_no_callback(env: Env) -> None:
    # (7.58.00) The user authorization that kept it is gone: GitHub's answer's client id and secret are read into nothing.
    env.github.answers = [answer(201, conversion(client_id=CLIENT_ID, client_secret=CLIENT_SECRET))]
    apps, _, _ = wired(env, PublicTokens())
    made = apps.manifest({'account': 'user'}, ADMIN)
    assert 'callback_urls' not in made['manifest']
    converted = apps.convert({'code': CODE, 'state': state_of(made['action_url'])}, ADMIN)
    assert not {'oauth', 'client_id'} & set(converted['app'])
    kept = json.dumps([converted, env.rows()], default=str)
    assert (CLIENT_SECRET in kept, CLIENT_ID in kept) == (False, False)
    assert [name for name in env.parameter_names() if 'engineering-user-auth' in name] == []


def test_a_public_connection_gets_no_label(env: Env) -> None:
    from engineering.connectors.issues_sync import IssuesFollow, app_of

    tokens = PublicTokens()
    _, _, connection = _public(env, tokens)
    assert app_of(connection) == ('4242', 777)   # (its issues followed, read with the App's read-only token)
    follow = IssuesFollow(None, env.table, tokens)
    assert follow._labels([connection], {}, ADMIN) == []
    assert not [call for call in tokens.calls if call['action'] == 'ensure_label']
