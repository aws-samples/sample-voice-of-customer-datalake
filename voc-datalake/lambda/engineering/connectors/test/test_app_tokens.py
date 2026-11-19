"""voc-engineering-app-tokens (app_tokens.py): three actions and nothing else, refused before anything is read; the
Issues source's tokens exactly ``{issues: read, metadata: read}`` and narrowed to the run's repositories; an
inspection answering no token and revoking the one it used; the ``voc-agent`` label alone, created only when missing
with an ``{issues: write}`` token of its one repository (7.50.02); the App's key read once, checked, never answered or
logged."""
from __future__ import annotations

import base64
import json
import logging
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from moto import mock_aws

from engineering.connectors import app_tokens
from engineering.connectors.app_tokens import (
    INSPECT_PERMISSIONS,
    ISSUES_PERMISSIONS,
    LABEL,
    LABEL_PERMISSIONS,
    AppKeyUnavailable,
    AppTokens,
    AppTokensRefused,
    InstallationRefused,
    parse_request,
)
from engineering.connectors.credentials import CACHE_SECONDS
from engineering.connectors.hosts import HostError
from engineering.connectors.test.app_keys import pem
from engineering.connectors.test.scripted_hosts import answer
from engineering.connectors.transport import Response

PREFIX = '/voc/engineering/'
APP_ID = '4242'
NOW = 1_800_000_000.0


@dataclass
class Sent:
    method: str
    path: str
    authorization: str
    body: Any


@dataclass
class FakeGitHub:
    """api.github.com as the function sees it: an answer (or a function of the request) per (method, path)."""

    routes: dict[tuple[str, str], Response | Callable[[Sent], Response]] = field(default_factory=dict)
    sent: list[Sent] = field(default_factory=list)
    minted: int = 0

    def mint(self, _sent: Sent) -> Response:
        self.minted += 1
        return answer(201, {'token': f'ghs_minted_{self.minted}', 'expires_at': '2027-01-15T10:00:00Z'})

    def request(self, method: str, path: str, headers: Any, body: bytes | None) -> Response:
        sent = Sent(method, path, headers.get('Authorization', ''), None if body is None else json.loads(body))
        self.sent.append(sent)
        route = self.routes.get((method, path))
        if route is None:
            if method == 'POST' and path.endswith('/access_tokens'):
                return self.mint(sent)
            if (method, path) == ('DELETE', '/installation/token'):
                return answer(204)
            raise AssertionError(f'unexpected {method} {path}')
        return route(sent) if callable(route) else route


def installation(installation_id: int, **change: Any) -> dict[str, Any]:
    return {'id': installation_id, 'app_id': int(APP_ID), 'app_slug': 'voc-autonomous-agent-a1b2', 'suspended_at': None,
            'account': {'login': 'example-org', 'type': 'Organization'}, **change}


@pytest.fixture
def ssm() -> Iterator[Any]:
    with mock_aws():
        client = boto3.client('ssm', region_name='us-east-1')
        client.put_parameter(Name=f'{PREFIX}_github-app/{APP_ID}/key', Type='SecureString',
                             Value=json.dumps({'app_id': APP_ID, 'slug': 'voc-agents-x', 'private_key': pem()}))
        yield client


def tokens(ssm: Any, github: FakeGitHub, clock: list[float] | None = None) -> AppTokens:
    moments = clock if clock is not None else [0.0]
    return AppTokens(PREFIX, client=lambda: ssm, transport=github, clock=lambda: NOW, monotonic=lambda: moments[0])


def claims(authorization: str) -> dict[str, Any]:
    part = authorization.removeprefix('Bearer ').split('.')[1]
    return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))


# --- what the function takes -----------------------------------------------------------------------------------------


@pytest.mark.parametrize('event', [
    {'action': 'start_run'}, {'action': 'read_key', 'app_id': APP_ID}, {}, [], 'issues_token',
    {'action': 'issues_token', 'app_id': APP_ID, 'repositories': ['o/r'], 'workspace_id': 'ws-1'},
    {'action': 'issues_token', 'app_id': APP_ID, 'repositories': ['o/r'], 'ws': 'ws-1'},
    {'action': 'issues_token', 'app_id': APP_ID, 'repositories': ['o/r'], 'permissions': {'contents': 'write'}},
    {'action': 'issues_token', 'app_id': APP_ID, 'repositories': []},
    {'action': 'issues_token', 'app_id': APP_ID, 'repositories': [f'o/r{n}' for n in range(21)]},
    {'action': 'issues_token', 'app_id': APP_ID, 'repositories': ['../x']},
    {'action': 'issues_token', 'app_id': '0123', 'repositories': ['o/r']},
    {'action': 'inspect_installation', 'app_id': APP_ID},
    {'action': 'inspect_installation', 'app_id': APP_ID, 'installation_id': True},
    {'action': 'ensure_label', 'app_id': APP_ID, 'installation_id': 77, 'repository': 'o/r'},
    {'action': 'ensure_label', 'app_id': APP_ID, 'installation_id': 77, 'repository': 'o/r', 'label': 'bug'},
    {'action': 'ensure_label', 'app_id': APP_ID, 'installation_id': 77, 'repository': 'o/r', 'label': 'VOC-AGENT'},
    {'action': 'ensure_label', 'app_id': APP_ID, 'installation_id': 77, 'repository': 'o/r', 'label': 'voc-agent '},
    {'action': 'ensure_label', 'app_id': APP_ID, 'installation_id': 77, 'repository': '../x', 'label': 'voc-agent'},
    {'action': 'ensure_label', 'app_id': APP_ID, 'installation_id': 77, 'repository': ['o/r'], 'label': 'voc-agent'},
    {'action': 'ensure_label', 'app_id': APP_ID, 'installation_id': 77, 'repository': 'o/r', 'label': 'voc-agent',
     'color': 'ff0000'},
    {'action': 'ensure_label', 'app_id': APP_ID, 'installation_id': 77, 'repository': 'o/r', 'label': 'voc-agent',
     'workspace_id': 'ws-1'},
])
def test_anything_but_its_three_actions_on_their_shapes_is_refused_before_anything_is_read(event: Any) -> None:
    with patch.object(app_tokens, 'app_tokens', side_effect=AssertionError('read')) as built, \
            pytest.raises(AppTokensRefused):
        app_tokens.lambda_handler(event, None)
    built.assert_not_called()


def test_a_workspaces_request_is_refused_saying_why() -> None:
    with pytest.raises(AppTokensRefused, match='workspace'):
        parse_request({'action': 'issues_token', 'app_id': APP_ID, 'repositories': ['o/r'], 'workspace': 'w'})


def test_the_three_actions_parse_to_their_arguments() -> None:
    assert parse_request({'action': 'inspect_installation', 'app_id': 4242, 'installation_id': '77'}) == (
        'inspect_installation', {'app_id': APP_ID, 'installation_id': 77})
    assert parse_request({'action': 'ensure_label', 'app_id': APP_ID, 'installation_id': 77, 'repository': 'o/r',
                          'label': 'voc-agent'}) == (
        'ensure_label', {'app_id': APP_ID, 'installation_id': 77, 'repository': 'o/r'})
    assert parse_request({'action': 'issues_token', 'app_id': APP_ID, 'repositories': ['o/r', 'O/R', 'o/s']}) == (
        'issues_token', {'app_id': APP_ID, 'repositories': ('o/r', 'o/s')})


# --- the Issues source's tokens ---------------------------------------------------------------------------------------


def test_each_token_is_exactly_issues_and_metadata_read_narrowed_to_the_runs_repositories(ssm: Any) -> None:
    github = FakeGitHub(routes={
        ('GET', '/repos/example-org/web/installation'): answer(200, installation(11)),
        ('GET', '/repos/example-org/api/installation'): answer(200, installation(11)),
        ('GET', '/repos/other-org/tool/installation'): answer(200, installation(22)),
        ('GET', '/repos/example-org/private/installation'): answer(404, {'message': 'Not Found'}),
        # (7.57.00: an uncovered repository is read as a public one, here private, so it stays uncovered)
        ('GET', '/repos/example-org/private'): answer(404, {'message': 'Not Found'}),
    })
    found = tokens(ssm, github).issues(APP_ID, ('example-org/web', 'example-org/api', 'other-org/tool',
                                                'example-org/private'))
    mints = [sent for sent in github.sent if sent.path.endswith('/access_tokens')]
    assert [(sent.path, sent.body) for sent in mints] == [
        ('/app/installations/11/access_tokens', {'permissions': {'issues': 'read', 'metadata': 'read'},
                                                 'repositories': ['web', 'api']}),
        ('/app/installations/22/access_tokens', {'permissions': {'issues': 'read', 'metadata': 'read'},
                                                 'repositories': ['tool']}),
        ('/app/installations/11/access_tokens', {'permissions': {'metadata': 'read'}})]
    assert ISSUES_PERMISSIONS == {'issues': 'read', 'metadata': 'read'}
    assert found == {'tokens': [
        {'repositories': ['example-org/web', 'example-org/api'], 'token': 'ghs_minted_1', 'expires_at': '2027-01-15T10:00:00Z'},
        {'repositories': ['other-org/tool'], 'token': 'ghs_minted_2', 'expires_at': '2027-01-15T10:00:00Z'}],
        'uncovered': ['example-org/private']}
    lookups = [sent for sent in github.sent if sent.method == 'GET' and sent.path.endswith('/installation')]
    assert {claims(sent.authorization)['iss'] for sent in lookups + mints} == {APP_ID}   # (the App's JWT)
    # (the public read's token, which found nothing public, is revoked)
    assert [sent.authorization for sent in github.sent if sent.method == 'DELETE'] == ['Bearer ghs_minted_3']


def test_a_public_repository_no_installation_covers_is_read_with_a_metadata_token_naming_none(ssm: Any) -> None:
    # 7.57.00: a public connection's issues, through a token of the App that holds metadata: read alone and names no
    # repository (it can write nothing anywhere); a private one stays uncovered.
    github = FakeGitHub(routes={
        ('GET', '/repos/someone/public/installation'): answer(404, {}),
        ('GET', '/repos/someone/hidden/installation'): answer(404, {}),
        ('GET', '/app/installations?per_page=100'): answer(200, [installation(31, suspended_at='2026-01-01'),
                                                                  installation(32)]),
        ('GET', '/repos/someone/public'): answer(200, {'full_name': 'someone/public', 'private': False}),
        ('GET', '/repos/someone/hidden'): answer(200, {'full_name': 'someone/hidden', 'private': True}),
    })
    found = tokens(ssm, github).issues(APP_ID, ('someone/public', 'someone/hidden'))
    [mint] = [sent for sent in github.sent if sent.path.endswith('/access_tokens')]
    assert (mint.path, mint.body) == ('/app/installations/32/access_tokens', {'permissions': {'metadata': 'read'}})
    assert found == {'tokens': [{'repositories': ['someone/public'], 'token': 'ghs_minted_1',
                                 'expires_at': '2027-01-15T10:00:00Z'}], 'uncovered': ['someone/hidden']}


def test_a_suspended_or_another_apps_installation_covers_nothing(ssm: Any) -> None:
    github = FakeGitHub(routes={
        ('GET', '/repos/o/a/installation'): answer(200, installation(11, suspended_at='2026-11-01T00:00:00Z')),
        ('GET', '/repos/o/b/installation'): answer(200, installation(12, app_id=999)),
        ('GET', '/app/installations?per_page=100'): answer(200, []),   # (7.57.00: no installation to read as public)
    })
    assert tokens(ssm, github).issues(APP_ID, ('o/a', 'o/b')) == {'tokens': [], 'uncovered': ['o/a', 'o/b']}
    assert github.minted == 0


def test_a_failed_mint_revokes_the_tokens_already_minted(ssm: Any) -> None:
    github = FakeGitHub(routes={
        ('GET', '/repos/o/a/installation'): answer(200, installation(11)),
        ('GET', '/repos/p/b/installation'): answer(200, installation(12)),
        ('POST', '/app/installations/12/access_tokens'): answer(500, {}),
    })
    with pytest.raises(HostError):
        tokens(ssm, github).issues(APP_ID, ('o/a', 'p/b'))
    revoked = [sent.authorization for sent in github.sent if sent.method == 'DELETE']
    assert revoked == ['Bearer ghs_minted_1']


# --- an installation's inspection --------------------------------------------------------------------------------------


def repositories_page(names: list[str], total: int) -> Response:
    return answer(200, {'total_count': total, 'repositories': [
        {'full_name': name, 'private': True, 'archived': name.endswith('old'), 'default_branch': 'main'}
        for name in names]})


def test_an_inspection_lists_the_repositories_with_a_metadata_token_it_revokes_and_never_answers(ssm: Any) -> None:
    github = FakeGitHub(routes={
        ('GET', '/app/installations/77'): answer(200, installation(77)),
        ('GET', '/installation/repositories?per_page=100&page=1'): repositories_page(['example-org/a', 'example-org/old'], 2),
    })
    found = tokens(ssm, github).inspect(APP_ID, 77)
    assert found == {'account': {'login': 'example-org', 'type': 'Organization'}, 'truncated': False,
                     'app_slug': 'voc-autonomous-agent-a1b2', 'repositories': [
        {'repository': 'example-org/a', 'private': True, 'archived': False, 'default_branch': 'main', 'fork': False},
        {'repository': 'example-org/old', 'private': True, 'archived': True, 'default_branch': 'main',
         'fork': False}]}
    [mint] = [sent for sent in github.sent if sent.path.endswith('/access_tokens')]
    assert mint.body == {'permissions': INSPECT_PERMISSIONS} == {'permissions': {'metadata': 'read'}}
    assert [(sent.method, sent.path, sent.authorization) for sent in github.sent[-2:]] == [
        ('GET', '/installation/repositories?per_page=100&page=1', 'Bearer ghs_minted_1'),
        ('DELETE', '/installation/token', 'Bearer ghs_minted_1')]
    assert 'ghs_' not in json.dumps(found)


@pytest.mark.parametrize('answered', [answer(404, {'message': 'Not Found'}), answer(200, installation(77, app_id=1)),
                                      answer(200, installation(77, suspended_at='2026-11-01T00:00:00Z'))])
def test_another_apps_installation_or_a_suspended_one_is_refused_before_any_token(ssm: Any,
                                                                                  answered: Response) -> None:
    github = FakeGitHub(routes={('GET', '/app/installations/77'): answered})
    with pytest.raises(InstallationRefused):
        tokens(ssm, github).inspect(APP_ID, 77)
    assert github.minted == 0


def test_the_repositories_are_read_page_by_page_and_revoked_even_when_a_page_fails(ssm: Any) -> None:
    github = FakeGitHub(routes={
        ('GET', '/app/installations/77'): answer(200, installation(77)),
        ('GET', '/installation/repositories?per_page=100&page=1'): repositories_page(
            [f'o/r{n}' for n in range(100)], 150),
        ('GET', '/installation/repositories?per_page=100&page=2'): answer(502, {}),
    })
    with pytest.raises(HostError):
        tokens(ssm, github).inspect(APP_ID, 77)
    assert github.sent[-1].method == 'DELETE'


# --- the App's key -----------------------------------------------------------------------------------------------------


def test_the_apps_key_is_read_once_per_cache_window_and_must_name_its_app(ssm: Any) -> None:
    github = FakeGitHub(routes={('GET', '/repos/o/a/installation'): answer(404, {}),
                                ('GET', '/app/installations?per_page=100'): answer(200, [])})
    clock = [0.0]
    source = tokens(ssm, github, clock)
    with patch.object(ssm, 'get_parameter', wraps=ssm.get_parameter) as reads:
        source.issues(APP_ID, ('o/a',))
        source.issues(APP_ID, ('o/a',))
        clock[0] = CACHE_SECONDS + 1
        source.issues(APP_ID, ('o/a',))
    assert reads.call_count == 2
    ssm.put_parameter(Name=f'{PREFIX}_github-app/5555/key', Type='SecureString',
                      Value=json.dumps({'app_id': APP_ID, 'slug': 'x', 'private_key': pem()}))
    for app_id in ('5555', '6666'):   # (another App's key under its name, and none)
        with pytest.raises(AppKeyUnavailable):
            source.issues(app_id, ('o/a',))


def test_no_key_jwt_or_token_reaches_a_log(ssm: Any, caplog: pytest.LogCaptureFixture) -> None:
    github = FakeGitHub(routes={
        ('GET', '/repos/o/a/installation'): answer(200, installation(11)),
        ('GET', '/app/installations/11'): answer(200, installation(11)),
        ('GET', '/installation/repositories?per_page=100&page=1'): repositories_page(['o/a'], 1),
    })
    with caplog.at_level(logging.DEBUG):
        source = tokens(ssm, github)
        source.issues(APP_ID, ('o/a',))
        source.inspect(APP_ID, 11)
    text = '\n'.join(json.dumps(vars(record), default=str) for record in caplog.records
                     if not record.name.startswith(('botocore', 'boto3', 'urllib3')))
    jwt = github.sent[0].authorization.removeprefix('Bearer ')
    assert 'engineering GitHub App issues tokens minted' in text
    for secret in (pem().split('\n')[1], jwt, 'ghs_minted_1', 'ghs_minted_2'):
        assert secret not in text


def test_an_inspection_answers_the_apps_slug_as_github_reports_it_now_and_none_off_its_shape(ssm: Any) -> None:
    """A rename on GitHub can change the App's slug: the installation's ``app_slug`` is answered for the check to
    record (github_apps.py ``check``); an installation read without one answers ''."""
    def inspected(**change: Any) -> dict[str, Any]:
        github = FakeGitHub(routes={
            ('GET', '/app/installations/77'): answer(200, installation(77, **change)),
            ('GET', '/installation/repositories?per_page=100&page=1'): repositories_page(['example-org/a'], 1),
        })
        return tokens(ssm, github).inspect(APP_ID, 77)

    assert inspected(app_slug='renamed-agent')['app_slug'] == 'renamed-agent'
    assert inspected(app_slug=None)['app_slug'] == ''


# --- the voc-agent label (7.50.02) --------------------------------------------------------------------------------------


def labelled(present: bool) -> FakeGitHub:
    label = answer(200, {'name': LABEL}) if present else answer(404, {'message': 'Not Found'})
    return FakeGitHub(routes={
        ('GET', '/repos/example-org/web/installation'): answer(200, installation(77)),
        ('GET', '/repos/example-org/web/labels/voc-agent'): label,
        ('POST', '/repos/example-org/web/labels'): answer(201, {'name': LABEL})})


def test_the_action_allows_exactly_the_voc_agent_label() -> None:
    from shared.agents_store import DEFAULT_ISSUE_LABEL
    assert LABEL == DEFAULT_ISSUE_LABEL == 'voc-agent'
    for other in ('bug', 'voc-agent/x', 'Voc-Agent', '', None):
        with pytest.raises(AppTokensRefused, match="'voc-agent'"):
            parse_request({'action': 'ensure_label', 'app_id': APP_ID, 'installation_id': 77, 'repository': 'o/r',
                           'label': other})


def test_a_missing_label_is_created_with_an_issues_write_token_of_that_one_repository_then_revoked(ssm: Any) -> None:
    github = labelled(present=False)
    found = tokens(ssm, github).ensure_label(APP_ID, 77, 'example-org/web')
    assert found == {'repository': 'example-org/web', 'label': 'voc-agent', 'created': True}
    [mint] = [sent for sent in github.sent if sent.path.endswith('/access_tokens')]
    assert mint.path == '/app/installations/77/access_tokens'
    assert mint.body == {'permissions': LABEL_PERMISSIONS, 'repositories': ['web']}
    assert LABEL_PERMISSIONS == {'issues': 'write'}
    [create] = [sent for sent in github.sent if sent.method == 'POST' and sent.path.endswith('/labels')]
    assert create.body == {'name': 'voc-agent', 'color': app_tokens.LABEL_COLOR,
                           'description': 'Picked up by the VoC agents'}
    assert create.authorization == 'Bearer ghs_minted_1'
    assert (github.sent[-1].method, github.sent[-1].path) == ('DELETE', '/installation/token')
    assert 'ghs_' not in json.dumps(found)


def test_a_label_already_there_is_left_as_it_is(ssm: Any) -> None:
    github = labelled(present=True)
    assert tokens(ssm, github).ensure_label(APP_ID, 77, 'example-org/web')['created'] is False
    assert not [sent for sent in github.sent if sent.method == 'POST' and sent.path.endswith('/labels')]
    assert github.sent[-1].method == 'DELETE'


def test_a_label_another_writer_made_meanwhile_is_not_an_error(ssm: Any) -> None:
    github = labelled(present=False)
    github.routes[('POST', '/repos/example-org/web/labels')] = answer(422, {'errors': [{'code': 'already_exists'}]})
    assert tokens(ssm, github).ensure_label(APP_ID, 77, 'example-org/web')['created'] is False


@pytest.mark.parametrize('answered', [answer(404, {'message': 'Not Found'}), answer(200, installation(78)),
                                      answer(200, installation(77, app_id=1)),
                                      answer(200, installation(77, suspended_at='2026-11-01T00:00:00Z'))])
def test_a_repository_another_installation_covers_or_none_is_refused_before_any_token(ssm: Any,
                                                                                    answered: Response) -> None:
    github = labelled(present=False)
    github.routes[('GET', '/repos/example-org/web/installation')] = answered
    with pytest.raises(InstallationRefused):
        tokens(ssm, github).ensure_label(APP_ID, 77, 'example-org/web')
    assert github.minted == 0


def test_a_failed_label_create_still_revokes_the_token(ssm: Any) -> None:
    github = labelled(present=False)
    github.routes[('POST', '/repos/example-org/web/labels')] = answer(403, {'message': 'Resource not accessible'})
    with pytest.raises(HostError):
        tokens(ssm, github).ensure_label(APP_ID, 77, 'example-org/web')
    assert (github.sent[-1].method, github.sent[-1].authorization) == ('DELETE', 'Bearer ghs_minted_1')


def test_the_handler_routes_ensure_label(ssm: Any) -> None:
    github = labelled(present=False)
    with patch.object(app_tokens, 'app_tokens', return_value=tokens(ssm, github)):
        found = app_tokens.lambda_handler({'action': 'ensure_label', 'app_id': APP_ID, 'installation_id': 77,
                                           'repository': 'example-org/web', 'label': 'voc-agent'}, None)
    assert found == {'repository': 'example-org/web', 'label': 'voc-agent', 'created': True}
