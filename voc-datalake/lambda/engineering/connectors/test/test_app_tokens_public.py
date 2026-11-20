"""voc-engineering-app-tokens' 7.57.00 actions on any public repository (app_tokens.py): the picker's search and one
repository's facts, opt-out and CONTRIBUTING asks, and the forks of an upstream an installation covers, each read with
a ``metadata: read`` token that names no repository and is revoked before the answer; never a private repository, and
the issues of an uncovered public repository read through the first installation that mints such a token."""
from __future__ import annotations

from typing import Any
from unittest.mock import patch
from urllib.parse import urlencode

import pytest

from engineering.connectors import app_tokens
from engineering.connectors.app_tokens import (
    FORK_ACTION,
    PUBLIC_PERMISSIONS,
    REPOSITORY_ACTION,
    SEARCH_ACTION,
    AppTokensRefused,
    InstallationRefused,
    parse_request,
)
from engineering.connectors.hosts import HostError
from engineering.connectors.test.scripted_hosts import answer
from engineering.connectors.test.test_app_tokens import APP_ID, FakeGitHub, Sent, installation, ssm, tokens
from engineering.connectors.transport import Response
from engineering.connectors.upstream import SEARCH_RESULTS, search_text

__all__ = ['ssm']   # (the moto SSM fixture with the App's key, shared with test_app_tokens.py)

INSTALLATION = 77
PUBLIC = {'full_name': 'open-tools/lint-kit', 'private': False, 'stargazers_count': 120, 'default_branch': 'main',
          'topics': ['lint'], 'license': {'spdx_id': 'MIT', 'name': 'MIT License'}}


def _raw(status: int, text: str = '') -> Response:
    return Response(status=status, headers={}, body=text.encode())


def _minted(github: FakeGitHub) -> list[Sent]:
    return [sent for sent in github.sent if sent.path.endswith('/access_tokens')]


def _revoked(github: FakeGitHub) -> list[str]:
    return [sent.authorization for sent in github.sent if (sent.method, sent.path) == ('DELETE', '/installation/token')]


# --- what the actions take -------------------------------------------------------------------------------------------


def test_the_public_actions_parse_to_their_arguments() -> None:
    base = {'app_id': APP_ID, 'installation_id': INSTALLATION}
    assert parse_request({'action': SEARCH_ACTION, **base, 'query': ' lint   kit '}) == (
        SEARCH_ACTION, {'app_id': APP_ID, 'installation_id': INSTALLATION, 'query': ('search', 'lint kit')})
    assert parse_request({'action': SEARCH_ACTION, **base, 'query': 'https://github.com/open-tools/lint-kit'})[1][
        'query'] == ('repository', 'open-tools/lint-kit')
    assert parse_request({'action': REPOSITORY_ACTION, **base, 'repository': 'open-tools/lint-kit', 'details': True}) == (
        REPOSITORY_ACTION, {'app_id': APP_ID, 'installation_id': INSTALLATION, 'repository': 'open-tools/lint-kit',
                            'details': True})
    assert parse_request({'action': FORK_ACTION, **base, 'upstream': 'open-tools/lint-kit'}) == (
        FORK_ACTION, {'app_id': APP_ID, 'installation_id': INSTALLATION, 'upstream': 'open-tools/lint-kit'})


@pytest.mark.parametrize('event', [
    {'action': SEARCH_ACTION, 'app_id': APP_ID, 'installation_id': INSTALLATION},
    {'action': SEARCH_ACTION, 'app_id': APP_ID, 'installation_id': INSTALLATION, 'query': '   '},
    {'action': SEARCH_ACTION, 'app_id': APP_ID, 'installation_id': INSTALLATION, 'query': 'x' * 201},
    {'action': REPOSITORY_ACTION, 'app_id': APP_ID, 'installation_id': INSTALLATION, 'repository': 'o/r',
     'details': 'yes'},
    {'action': REPOSITORY_ACTION, 'app_id': APP_ID, 'installation_id': INSTALLATION, 'repository': '../x',
     'details': False},
    {'action': FORK_ACTION, 'app_id': APP_ID, 'installation_id': INSTALLATION, 'upstream': 'o/r', 'extra': 1},
])
def test_a_public_request_off_its_shape_is_refused(event: dict[str, Any]) -> None:
    with pytest.raises(AppTokensRefused):
        parse_request(event)


# --- the picker ------------------------------------------------------------------------------------------------------


def test_a_search_by_name_reads_that_repository_with_a_metadata_token_it_revokes(ssm: Any) -> None:
    github = FakeGitHub(routes={('GET', '/repos/open-tools/lint-kit'): answer(200, PUBLIC)})
    found = tokens(ssm, github).public_search(APP_ID, INSTALLATION, ('repository', 'open-tools/lint-kit'))
    assert [item['repository'] for item in found['repositories']] == ['open-tools/lint-kit']
    assert found['repositories'][0]['licence_spdx'] == 'MIT'
    [mint] = _minted(github)
    assert (mint.path, mint.body) == (f'/app/installations/{INSTALLATION}/access_tokens',
                                      {'permissions': dict(PUBLIC_PERMISSIONS)})
    assert _revoked(github) == ['Bearer ghs_minted_1']


def test_a_search_by_name_of_no_repository_or_a_private_one_answers_none(ssm: Any) -> None:
    github = FakeGitHub(routes={('GET', '/repos/o/missing'): answer(404, {}),
                                ('GET', '/repos/o/hidden'): answer(200, {'full_name': 'o/hidden', 'private': True})})
    assert tokens(ssm, github).public_search(APP_ID, INSTALLATION, ('repository', 'o/missing')) == {'repositories': []}
    assert tokens(ssm, github).public_search(APP_ID, INSTALLATION, ('repository', 'o/hidden')) == {'repositories': []}


def test_a_search_by_words_asks_for_public_repositories_only_and_drops_a_private_one(ssm: Any) -> None:
    query = urlencode({'q': search_text('lint is:private'), 'per_page': SEARCH_RESULTS})
    github = FakeGitHub(routes={('GET', f'/search/repositories?{query}'): answer(200, {'items': [
        PUBLIC, {'full_name': 'o/secret', 'private': True}, {'full_name': 'not a name'}]})})
    found = tokens(ssm, github).public_search(APP_ID, INSTALLATION, ('search', 'lint is:private'))
    assert [item['repository'] for item in found['repositories']] == ['open-tools/lint-kit']
    assert 'is:private' not in search_text('lint is:private')


def test_another_apps_installation_mints_no_public_token(ssm: Any) -> None:
    github = FakeGitHub(routes={('POST', f'/app/installations/{INSTALLATION}/access_tokens'): answer(404, {})})
    with pytest.raises(InstallationRefused):
        tokens(ssm, github).public_search(APP_ID, INSTALLATION, ('repository', 'o/r'))


# --- one repository --------------------------------------------------------------------------------------------------


def test_one_repositorys_facts_without_details_read_nothing_more(ssm: Any) -> None:
    github = FakeGitHub(routes={('GET', '/repos/open-tools/lint-kit'): answer(200, PUBLIC)})
    found = tokens(ssm, github).public_repository(APP_ID, INSTALLATION, 'open-tools/lint-kit', False)
    assert (found['repository']['repository'], found['opt_out'], found['contributing']) == (
        'open-tools/lint-kit', None, None)
    assert [sent.path for sent in github.sent if sent.method == 'GET'] == ['/repos/open-tools/lint-kit']


@pytest.mark.parametrize('answered', [answer(404, {}), answer(200, {'full_name': 'o/r', 'private': True})])
def test_no_public_repository_by_that_name_answers_none(ssm: Any, answered: Response) -> None:
    github = FakeGitHub(routes={('GET', '/repos/o/r'): answered})
    assert tokens(ssm, github).public_repository(APP_ID, INSTALLATION, 'o/r', True) == {
        'repository': None, 'opt_out': None, 'contributing': None}


def test_the_details_read_its_opt_out_labels_and_its_contributing_file(ssm: Any) -> None:
    github = FakeGitHub(routes={
        ('GET', '/repos/open-tools/lint-kit'): answer(200, PUBLIC),
        ('GET', '/repos/open-tools/lint-kit/labels/no-bot-prs'): answer(404, {}),
        ('GET', '/repos/open-tools/lint-kit/labels/no-ai-prs'): answer(200, {'name': 'no-ai-prs'}),
        ('GET', '/repos/open-tools/lint-kit/contents/CONTRIBUTING.md'): _raw(404),
        ('GET', '/repos/open-tools/lint-kit/contents/.github/CONTRIBUTING.md'): _raw(
            200, 'Open an issue first.\nSign off every commit (DCO): Signed-off-by.'),
    })
    found = tokens(ssm, github).public_repository(APP_ID, INSTALLATION, 'open-tools/lint-kit', True)
    assert found['opt_out'] == 'no-ai-prs'
    assert found['contributing']['path'] == '.github/CONTRIBUTING.md'
    assert _revoked(github) == ['Bearer ghs_minted_1']


def test_a_repository_without_a_contributing_file_asks_nothing(ssm: Any) -> None:
    routes: dict[tuple[str, str], Any] = {('GET', '/repos/open-tools/lint-kit'): answer(200, PUBLIC)}
    routes.update({('GET', f'/repos/open-tools/lint-kit/labels/{marker}'): answer(404, {})
                   for marker in ('no-bot-prs', 'no-ai-prs')})
    routes.update({('GET', f'/repos/open-tools/lint-kit/contents/{path}'): _raw(404)
                   for path in ('CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md')})
    found = tokens(ssm, FakeGitHub(routes=routes)).public_repository(APP_ID, INSTALLATION, 'open-tools/lint-kit', True)
    assert (found['opt_out'], found['contributing']) == (None, None)


# --- a fork ----------------------------------------------------------------------------------------------------------


def _fork_world(listed: list[dict[str, Any]], parents: dict[str, str]) -> FakeGitHub:
    routes: dict[tuple[str, str], Any] = {
        ('GET', f'/app/installations/{INSTALLATION}'): answer(200, installation(INSTALLATION)),
        ('GET', '/installation/repositories?per_page=100&page=1'): answer(200, {'repositories': listed,
                                                                                 'total_count': len(listed)}),
    }
    routes.update({('GET', f'/repos/{name}'): answer(200, {'full_name': name, 'private': False, 'fork': True,
                                                           'default_branch': 'main', 'parent': {'full_name': parent}})
                   for name, parent in parents.items()})
    return FakeGitHub(routes=routes)


def test_the_forks_of_the_upstream_the_installation_covers_are_found_by_their_parent(ssm: Any) -> None:
    github = _fork_world(
        [{'full_name': 'admin-demo/lint-kit', 'fork': True}, {'full_name': 'admin-demo/other', 'fork': True},
         {'full_name': 'admin-demo/own', 'fork': False}],
        {'admin-demo/lint-kit': 'Open-Tools/Lint-Kit', 'admin-demo/other': 'someone/else'})
    found = tokens(ssm, github).inspect_fork(APP_ID, INSTALLATION, 'open-tools/lint-kit')
    assert found == {'account': {'login': 'example-org', 'type': 'Organization'}, 'forks': [
        {'repository': 'admin-demo/lint-kit', 'default_branch': 'main', 'private': False, 'archived': False}]}
    # (the inspection's token and the public one, each revoked)
    assert _revoked(github) == ['Bearer ghs_minted_1', 'Bearer ghs_minted_2']


def test_an_installation_with_no_fork_reads_no_repository_with_a_public_token(ssm: Any) -> None:
    github = _fork_world([{'full_name': 'admin-demo/own', 'fork': False}], {})
    assert tokens(ssm, github).inspect_fork(APP_ID, INSTALLATION, 'open-tools/lint-kit')['forks'] == []
    assert len(_minted(github)) == 1   # (the inspection's only)


# --- an uncovered public repository's issues -------------------------------------------------------------------------


def test_the_first_installation_that_mints_a_public_token_reads_the_issues(ssm: Any) -> None:
    github = FakeGitHub(routes={
        ('GET', '/repos/someone/public/installation'): answer(404, {}),
        ('GET', '/app/installations?per_page=100'): answer(200, [installation(31), installation(32)]),
        ('POST', '/app/installations/31/access_tokens'): answer(403, {}),
        ('GET', '/repos/someone/public'): answer(200, {'full_name': 'someone/public', 'private': False}),
    })
    found = tokens(ssm, github).issues(APP_ID, ('someone/public',))
    assert found['tokens'][0]['repositories'] == ['someone/public']
    assert [sent.path for sent in _minted(github)] == ['/app/installations/31/access_tokens',
                                                       '/app/installations/32/access_tokens']


def test_a_public_token_that_reads_nothing_public_is_revoked_and_the_repository_stays_uncovered(ssm: Any) -> None:
    github = FakeGitHub(routes={
        ('GET', '/repos/someone/gone/installation'): answer(404, {}),
        ('GET', '/app/installations?per_page=100'): answer(200, [installation(32)]),
        ('GET', '/repos/someone/gone'): answer(404, {}),
    })
    assert tokens(ssm, github).issues(APP_ID, ('someone/gone',)) == {'tokens': [], 'uncovered': ['someone/gone']}
    assert _revoked(github) == ['Bearer ghs_minted_1']


def test_a_public_read_that_fails_revokes_its_token_and_leaves_the_repository_uncovered(ssm: Any) -> None:
    def refuse(_sent: Sent) -> Response:
        raise HostError('GitHub is down')

    github = FakeGitHub(routes={
        ('GET', '/repos/someone/public/installation'): answer(404, {}),
        ('GET', '/app/installations?per_page=100'): answer(200, [installation(32)]),
        ('GET', '/repos/someone/public'): refuse,
    })
    assert tokens(ssm, github).issues(APP_ID, ('someone/public',)) == {'tokens': [], 'uncovered': ['someone/public']}
    assert _revoked(github) == ['Bearer ghs_minted_1']


# --- the handler -----------------------------------------------------------------------------------------------------


class _Recorded:
    """The handler's tokens: each public action recorded with its arguments."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def __getattr__(self, name: str) -> Any:
        def call(*args: Any) -> dict[str, Any]:
            self.calls.append((name, args))
            return {'action': name}
        return call


@pytest.mark.parametrize(('event', 'call'), [
    ({'action': SEARCH_ACTION, 'query': 'lint'}, ('public_search', (APP_ID, INSTALLATION, ('search', 'lint')))),
    ({'action': REPOSITORY_ACTION, 'repository': 'o/r', 'details': False},
     ('public_repository', (APP_ID, INSTALLATION, 'o/r', False))),
    ({'action': FORK_ACTION, 'upstream': 'o/r'}, ('inspect_fork', (APP_ID, INSTALLATION, 'o/r'))),
])
def test_the_handler_routes_the_public_actions(event: dict[str, Any], call: tuple[str, tuple[Any, ...]]) -> None:
    recorded = _Recorded()
    with patch.object(app_tokens, 'app_tokens', return_value=recorded):
        answered = app_tokens.lambda_handler({**event, 'app_id': APP_ID, 'installation_id': INSTALLATION}, None)
    assert (recorded.calls, answered) == ([call], {'action': call[0]})
