"""Any public repository on GitHub (7.57.00): a public repository's token holds metadata: read alone and names no
repository, whatever the operation asks; a fork's issue reads go to its upstream; the upstream's facts, template and
CONTRIBUTING are read with the fork's token; and the connection owner's user token is sent in one request alone, the
upstream pull request (github.py, github_upstream.py, credentials.py)."""
from __future__ import annotations

import json
from dataclasses import replace

import pytest

from engineering.connectors.credentials import CredentialUnusable, parse_credential
from engineering.connectors.github import GitHubHost
from engineering.connectors.github_upstream import GitHubUpstream, UpstreamHostRefused
from engineering.connectors.hosts import FORK, PUBLIC_READ, ForkFacts, InvalidTarget, OwnerToken
from engineering.connectors.test.app_keys import APP_ID, INSTALLATION_ID, credential, private_key
from engineering.connectors.test.test_github import TOKENS, Clock, FakeGitHub, answer

UPSTREAM = 'upstream-org/refund-service'
FORK_REPO = '/repos/example-org/refund-service'
OWNER_HASH = 'b' * 64
OWNER_GHU = 'ghu_ownersTokenForTests00000000001'
FACTS = ForkFacts(upstream=UPSTREAM, upstream_default_branch='main', owner=OWNER_HASH, licence='MIT', app_id=APP_ID,
                  repository='example-org/refund-service')


def public_client(api: FakeGitHub) -> GitHubHost:
    return GitHubHost(lambda _: replace(credential(), kind=PUBLIC_READ), api, clock=Clock())


def fork_credential():
    return replace(credential(), kind=FORK, fork=FACTS)


def test_a_public_repositorys_token_reads_what_is_public_and_names_no_repository() -> None:
    api = FakeGitHub().on('GET', f'{FORK_REPO}/issues/42', answer(200, {'number': 42, 'state': 'open'}))
    assert public_client(api).issue_state('conn-1', 42) == 'open'
    assert api.scopes() == [{'permissions': {'metadata': 'read'}}]   # (no ``repositories``: it is in no installation)


@pytest.mark.parametrize('operation', ['fetch', 'push', 'comment'])
def test_whatever_a_public_repositorys_operation_asks_its_token_holds_metadata_read_alone(operation: str) -> None:
    api = FakeGitHub()
    host = public_client(api)
    if operation == 'fetch':
        host.fetch_token('conn-1')
    else:
        api.on('POST', f'{FORK_REPO}/issues/42/comments', answer(403, {}))
        with pytest.raises(Exception):   # noqa: B017, PT011 - the host refuses; the token is what is pinned here
            host.post_comment('conn-1', 'issue', 42, 'Hello')
    assert api.scopes() == [{'permissions': {'metadata': 'read'}}]


def test_a_forks_issue_is_read_on_its_upstream_and_its_pull_request_on_the_fork() -> None:
    api = (FakeGitHub()
           .on('GET', f'/repos/{UPSTREAM}/issues/42', answer(200, {'number': 42, 'state': 'open'}))
           .on('GET', f'/repos/{UPSTREAM}/issues/42/comments?per_page=30&page=1', answer(200, []))
           .on('GET', f'{FORK_REPO}/pulls/7', answer(200, {'number': 7, 'state': 'open'}))
           .on('GET', f'{FORK_REPO}/issues/7/comments?per_page=30&page=1', answer(200, []))
           .on('GET', f'{FORK_REPO}/pulls/7/comments?per_page=30&page=1', answer(200, []))
           .on('GET', f'{FORK_REPO}/pulls/7/reviews?per_page=30&page=1', answer(200, [])))
    host = GitHubHost(lambda _: fork_credential(), api, clock=Clock())
    assert host.issue_state('conn-1', 42) == 'open'
    host.read('conn-1', 'issue', '42', None)
    host.read('conn-1', 'pull_request', '7', None)
    assert all(scope['repositories'] == ['refund-service'] for scope in api.scopes())   # (the fork's own token)


def test_a_public_read_is_of_a_repository_alone() -> None:
    host = GitHubHost(lambda _: fork_credential(), FakeGitHub(), clock=Clock())
    with pytest.raises(InvalidTarget):
        host.public_get('conn-1', '/user', 'a read')
    with pytest.raises(InvalidTarget):
        host.open_upstream_pull_request(OWNER_GHU, 'not a repository', 'o:b', 'main', 't', 'b')


def upstream_api() -> FakeGitHub:
    contributing = b'Thanks for contributing!'
    return (FakeGitHub()
            .on('GET', f'/repos/{UPSTREAM}', answer(200, {'full_name': UPSTREAM, 'private': False, 'topics': [],
                                                          'license': {'spdx_id': 'MIT', 'name': 'MIT'},
                                                          'default_branch': 'main'}))
            .on('GET', f'/repos/{UPSTREAM}/labels/no-bot-prs', answer(404, {}))
            .on('GET', f'/repos/{UPSTREAM}/labels/no-ai-prs', answer(200, {'name': 'no-ai-prs'}))
            .on('GET', f'/repos/{UPSTREAM}/contents/CONTRIBUTING.md',
                lambda _: replace(answer(200), body=contributing))
            .on('GET', f'/repos/{UPSTREAM}/contents/.github/pull_request_template.md', answer(404, {}))
            .on('GET', f'/repos/{UPSTREAM}/contents/.github/PULL_REQUEST_TEMPLATE.md',
                lambda _: replace(answer(200), body=b'## Description\n'))
            .on('POST', f'/repos/{UPSTREAM}/pulls', answer(201, {
                'number': 314, 'html_url': f'https://github.com/{UPSTREAM}/pull/314',
                'head': {'ref': 'voc-agent/x'}, 'base': {'ref': 'main'}})))


def test_the_upstreams_facts_template_and_contributing_are_read_with_the_forks_token() -> None:
    api = upstream_api()
    github = GitHubHost(lambda _: fork_credential(), api, clock=Clock())
    found = GitHubUpstream(lambda _: fork_credential(), github).facts('conn-1')
    assert (found.opt_out, found.template, found.contributing.path) == ('no-ai-prs', '## Description\n',
                                                                       'CONTRIBUTING.md')
    assert all(not sent.headers['Authorization'].endswith(OWNER_GHU) for sent in api.sent)


def test_the_owners_token_is_sent_in_the_upstream_pull_request_alone() -> None:
    api = upstream_api()
    github = GitHubHost(lambda _: fork_credential(), api, clock=Clock())
    upstream = GitHubUpstream(lambda _: fork_credential(), github)
    upstream.facts('conn-1')
    ref = upstream.open('conn-1', OwnerToken(token=OWNER_GHU, login='casey-dev'), 'voc-agent/x', 'Fix', 'Body')
    assert ref.number == 314
    carrying = [(sent.method, sent.path) for sent in api.sent if sent.headers['Authorization'] == f'Bearer {OWNER_GHU}']
    assert carrying == [('POST', f'/repos/{UPSTREAM}/pulls')]
    [sent] = [sent for sent in api.sent if sent.method == 'POST' and sent.path.endswith('/pulls')]
    assert sent.body == {'title': 'Fix', 'body': 'Body', 'head': 'example-org:voc-agent/x', 'base': 'main',
                         'draft': False, 'maintainer_can_modify': True}
    assert TOKENS not in [path for _, path in carrying]


@pytest.mark.parametrize('status', [403, 404, 422])
def test_a_refusal_github_answers_wrote_nothing_and_says_so(status: int) -> None:
    api = FakeGitHub().on('POST', f'/repos/{UPSTREAM}/pulls', answer(status, {'message': 'Resource not accessible'}))
    upstream = GitHubUpstream(lambda _: fork_credential(), GitHubHost(lambda _: fork_credential(), api, clock=Clock()))
    with pytest.raises(UpstreamHostRefused) as refused:
        upstream.open('conn-1', OwnerToken(token=OWNER_GHU, login='c'), 'voc-agent/x', 'Fix', 'Body')
    assert str(status) in refused.value.reason
    assert 'Resource not accessible' not in refused.value.reason


def _value(**change: object) -> str:
    value: dict[str, object] = {'kind': FORK, 'app_id': APP_ID, 'installation_id': INSTALLATION_ID,
                                'repository': 'example-org/refund-service', 'key': 'app', 'upstream': UPSTREAM,
                                'upstream_default_branch': 'main', 'owner': OWNER_HASH, 'licence': 'MIT',
                                'upstream_pr_assisted': False, **change}
    return json.dumps({name: item for name, item in value.items() if item is not None})


def test_a_fork_and_a_public_credential_are_read_with_their_kind() -> None:
    def keys(app_id: str):
        assert app_id == APP_ID
        return private_key()

    fork = parse_credential(_value(), keys)
    assert (fork.kind, fork.fork) == (FORK, FACTS)
    public = parse_credential(_value(kind=PUBLIC_READ, upstream=None, upstream_default_branch=None, owner=None,
                                     licence=None, upstream_pr_assisted=None), keys)
    assert (public.kind, public.fork) == (PUBLIC_READ, None)


@pytest.mark.parametrize('change', [
    {'kind': 'admin'}, {'key': None, 'private_key': 'x'}, {'owner': 'person-sub-1'}, {'upstream': '../x'},
    {'licence': ''}, {'upstream_pr_assisted': 'yes'}, {'upstream_default_branch': ''},
])
def test_a_fork_credential_off_its_shape_is_unusable_failing_closed(change: dict[str, object]) -> None:
    with pytest.raises(CredentialUnusable):
        parse_credential(_value(**change), lambda _: private_key())
