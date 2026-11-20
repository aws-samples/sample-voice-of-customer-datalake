"""The Agents API's routes for any public repository (7.57.00): the picker, the read-only connection, the fork
workflow and (7.58.00) its owner's acknowledgement of a changed licence, through the routes; 7.57.00's user
authorization routes are gone (404 for every one of them).

Every route answers 404 while the module is off, then 403 for anyone but an administrator acting for themselves (a
plain user, a delegated MCP credential), before anything is read; behind Cognito (``/agents/{proxy+}``) like every
Agents API route, so there is no new unauthenticated endpoint. No answer carries a token or a secret.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from agents_handler_fixtures import ADMIN, USER, route_statuses
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from test_agents_engineering_github_apps import DELEGATED_ADMIN, create, engineering_on, state_of

import agents_handler
from engineering.connectors import github_apps
from engineering.connectors.test.test_github_apps import FakeGitHub
from engineering.connectors.test.test_public_workflow import UPSTREAM, PublicTokens

APPS = '/agents/engineering/github-apps'


@pytest.fixture
def tokens(monkeypatch: pytest.MonkeyPatch) -> Iterator[PublicTokens]:
    with _api() as agents:
        engineering_on(monkeypatch)
        fake, github = PublicTokens(), FakeGitHub()
        with patch.object(agents_handler, 'get_dynamodb_resource', return_value=agents.resource), \
                patch.object(github_apps, 'HttpsTransport', lambda **_: github), \
                patch.object(agents_handler, '_invoke_app_tokens', fake):
            yield fake
        agents_handler._ssm_client.cache_clear()


def installed_app(lambda_context: Any) -> dict[str, Any]:
    made = create(lambda_context)
    status, _ = _call(lambda_context, 'POST', f'{APPS}/installations', body={
        'installation_id': 777, 'setup_action': 'install', 'state': state_of(made['install_url'])})
    assert status == 200
    return made['app']


@pytest.mark.usefixtures('tokens')
def test_a_public_repository_is_found_connected_and_contributed_to_through_the_routes(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', '/agents/engineering/public-repositories', query={'q': 'lint'})[0] == 409
    installed_app(lambda_context)
    status, found = _call(lambda_context, 'GET', '/agents/engineering/public-repositories', query={'q': 'lint'})
    assert (status, [item['repository'] for item in found['repositories']]) == (200, [UPSTREAM])
    status, connected = _call(lambda_context, 'POST', '/agents/engineering/public-connections',
                              body={'repository': UPSTREAM})
    assert (status, connected['connection']['kind']) == (201, 'public_read')
    connection_id = connected['connection']['connection_id']
    status, started = _call(lambda_context, 'POST', f'/agents/engineering/connections/{connection_id}/fork',
                            body={'account': 'user', 'licence': 'MIT'})
    assert (status, started['fork_url']) == (200, f'https://github.com/{UPSTREAM}/fork')
    status, done = _call(lambda_context, 'POST', f'{APPS}/installations', body={
        'installation_id': 888, 'setup_action': 'install', 'state': state_of(started['install_url'])})
    assert (status, done['fork']['repository']) == (200, 'casey-dev/lint-kit')
    fork_id = done['connections'][0]['connection']['connection_id']
    status, changed = _call(lambda_context, 'PUT', f'/agents/engineering/connections/{fork_id}/upstream',
                            body={'licence': 'MIT'})
    assert (status, changed['connection']['fork']['licence']) == (200, 'MIT')
    assert _call(lambda_context, 'PUT', f'/agents/engineering/connections/{fork_id}/upstream',
                 body={'assisted': True})[0] == 400   # (7.58.00: no setting for AI-assisted runs any more)
    listed = _call(lambda_context, 'GET', '/agents/engineering/connections')[1]['connections']
    assert {c['kind'] for c in listed} == {'repository', 'public_read', 'fork'}
    assert 'admin-sub' not in json.dumps(listed)   # (the owner's subject is never answered)


ROUTES = (('GET', '/agents/engineering/public-repositories'), ('POST', '/agents/engineering/public-connections'),
          ('POST', '/agents/engineering/connections/lint-kit/fork'),
          ('PUT', '/agents/engineering/connections/lint-kit-fork/upstream'))
#: 7.57.00's GitHub user authorization routes (7.58.00: gone with the app's own upstream pull request).
GONE = (('PUT', f'{APPS}/4242/oauth'), ('POST', f'{APPS}/4242/authorize'), ('POST', f'{APPS}/authorizations'),
        ('GET', f'{APPS}/authorizations'), ('DELETE', f'{APPS}/4242/authorization'))


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_every_route_is_an_administrators_acting_for_themselves(lambda_context: Any, tokens: PublicTokens,
                                                                claims: dict[str, Any]) -> None:
    assert route_statuses(lambda_context, ROUTES, claims) == dict.fromkeys(ROUTES, 403)
    assert tokens.calls == []


@pytest.mark.usefixtures('tokens')
@pytest.mark.parametrize('claims', [ADMIN, USER], ids=['admin', 'plain user'])
def test_every_public_repository_route_is_404_while_the_module_is_off(lambda_context: Any, claims: dict[str, Any],
                                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('ENGINEERING_AGENTS')
    assert route_statuses(lambda_context, ROUTES, claims) == dict.fromkeys(ROUTES, 404)


@pytest.mark.usefixtures('tokens')
def test_the_routes_answer_their_refusals(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', '/agents/engineering/public-repositories')[0] == 400   # (no q)
    assert _call(lambda_context, 'POST', '/agents/engineering/public-connections', body={'x': 1})[0] == 400
    assert _call(lambda_context, 'POST', '/agents/engineering/connections/nope/fork',
                 body={'account': 'user', 'licence': 'MIT'})[0] == 404
    assert route_statuses(lambda_context, GONE, ADMIN) == dict.fromkeys(GONE, 404)
