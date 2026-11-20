"""A fork connection's upstream reads (7.57.00, github_upstream.py): the connection's kind and fork facts, an open
upstream pull request from the fork's branch, the run's pull request on the fork, the upstream's facts without a
CONTRIBUTING file or template, and the refusals that are not GitHub's known three, all with the fork's own token."""
from __future__ import annotations

from dataclasses import replace

import pytest

from engineering.connectors.credentials import Credential
from engineering.connectors.github import GitHubHost, open_from
from engineering.connectors.github_upstream import GitHubUpstream
from engineering.connectors.hosts import FORK, PUBLIC_READ, REPOSITORY_KIND, HostError, NotFound
from engineering.connectors.test.app_keys import credential
from engineering.connectors.test.gitlab_fakes import credential as gitlab_credential
from engineering.connectors.test.test_github import Clock, FakeGitHub, answer
from engineering.connectors.test.test_github_upstream import FACTS, UPSTREAM, fork_credential

FORK_PULLS = '/repos/example-org/refund-service/pulls'


def _upstream(api: FakeGitHub, found: Credential | None = None) -> GitHubUpstream:
    held = fork_credential() if found is None else found
    return GitHubUpstream(lambda _: held, GitHubHost(lambda _: fork_credential(), api, clock=Clock()))


def test_a_connections_kind_and_fork_are_its_credentials() -> None:
    api = FakeGitHub()
    assert (_upstream(api).kind('conn-1'), _upstream(api).fork('conn-1')) == (FORK, FACTS)
    public = replace(credential(), kind=PUBLIC_READ)
    assert (_upstream(api, public).kind('conn-1'), _upstream(api, public).fork('conn-1')) == (PUBLIC_READ, None)
    # (another host's credential, a GitLab project's: a repository of the deployment's own kind, never a fork)
    other = gitlab_credential()
    assert (_upstream(api, other).kind('conn-1'), _upstream(api, other).fork('conn-1')) == (REPOSITORY_KIND, None)


def test_a_connection_that_is_not_a_fork_has_no_upstream() -> None:
    upstream = _upstream(FakeGitHub(), replace(credential(), kind=PUBLIC_READ))
    with pytest.raises(NotFound, match='not a fork'):
        upstream.existing('conn-1', 'voc-agent/x')


def test_an_open_upstream_pull_request_from_the_forks_branch_is_found_and_none_otherwise() -> None:
    lookup = f'/repos/{UPSTREAM}/pulls?{open_from(fork_credential().owner, "voc-agent/x")}'
    api = FakeGitHub().on('GET', lookup, answer(200, [{'number': 9, 'html_url': f'https://github.com/{UPSTREAM}/pull/9',
                                                       'head': {'ref': 'voc-agent/x'}, 'base': {'ref': 'main'}}]),
                          answer(200, []))
    found = _upstream(api).existing('conn-1', 'voc-agent/x')
    assert found is not None
    assert (found.number, found.head, found.base) == (9, 'voc-agent/x', 'main')
    assert _upstream(api).existing('conn-1', 'voc-agent/x') is None


def test_the_runs_pull_request_on_the_fork_is_read_and_a_missing_one_is_not_found() -> None:
    api = (FakeGitHub()
           .on('GET', f'{FORK_PULLS}/7', answer(200, {'title': 'Fix the refund', 'body': 'Why', 'state': 'open',
                                                      'merged': False}))
           .on('GET', f'{FORK_PULLS}/8', answer(200, {'title': 'Old', 'body': None, 'state': 'closed', 'merged': True}))
           .on('GET', f'{FORK_PULLS}/9', answer(404, {})))
    upstream = _upstream(api)
    seven, eight = upstream.fork_pull_request('conn-1', 7), upstream.fork_pull_request('conn-1', 8)
    assert (seven.title, seven.body, seven.open) == ('Fix the refund', 'Why', True)
    assert (eight.title, eight.body, eight.open) == ('Old', '', False)
    with pytest.raises(NotFound, match='no pull request 9'):
        upstream.fork_pull_request('conn-1', 9)


def test_an_upstream_with_no_contributing_file_or_template_asks_nothing() -> None:
    api = (FakeGitHub()
           .on('GET', f'/repos/{UPSTREAM}', answer(200, {'full_name': UPSTREAM, 'private': False, 'topics': ['no-bot-prs'],
                                                         'default_branch': 'main'}))
           .on('GET', f'/repos/{UPSTREAM}/labels/no-bot-prs', answer(404, {}))
           .on('GET', f'/repos/{UPSTREAM}/labels/no-ai-prs', answer(404, {})))
    for path in ('CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', '.github/pull_request_template.md',
                 '.github/PULL_REQUEST_TEMPLATE.md', 'PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md',
                 'docs/pull_request_template.md', 'docs/PULL_REQUEST_TEMPLATE.md'):
        api.on('GET', f'/repos/{UPSTREAM}/contents/{path}', answer(404, {}))
    found = _upstream(api).facts('conn-1')
    assert (found.opt_out, found.template, found.contributing.path) == ('no-bot-prs', '', '')


def test_an_upstream_read_off_its_shape_is_a_host_error() -> None:
    api = FakeGitHub().on('GET', f'/repos/{UPSTREAM}', answer(200, {'full_name': 'not a repository'}))
    with pytest.raises(HostError, match='off its shape'):
        _upstream(api).facts('conn-1')
