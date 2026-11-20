"""A fork connection's upstream on GitHub (7.57.00; docs/autonomous-engineering.md, "Any public repository": the
fork workflow). The broker's ``UpstreamHost`` over the GitHub client (``github.GitHubHost``).

Reads, with the fork's own installation token for ``metadata: read`` (the upstream and the fork are public, so any
reader reads them: ``GitHubHost.public_get``): the upstream's facts (archived, licence, topics), its opt-out labels,
its CONTRIBUTING file and pull request template (``upstream.CONTRIBUTING_PATHS``, ``upstream.TEMPLATE_PATHS``, each at
most ``upstream.MAX_FILE_BYTES``), an open upstream pull request from the fork's branch, and the run's pull request on
the fork. At most ``1 + 2 + 3 + 6`` requests for the facts. No write: the person opens the upstream pull request on
GitHub from its one-click link (7.58.00; ``upstream_pr.py``).
"""
from __future__ import annotations

from collections.abc import Callable
from urllib.parse import quote

from engineering.connectors.credentials import Credential, GitHubAppCredential
from engineering.connectors.github import RAW_ACCEPT, GitHubHost, first_pull_request, open_from
from engineering.connectors.hosts import (
    FORK,
    REPOSITORY_KIND,
    ForkFacts,
    ForkPullRequest,
    HostError,
    NotFound,
    PullRequestRef,
    UpstreamFacts,
)
from engineering.connectors.transport import dig, json_of, text_or_empty
from engineering.connectors.upstream import (
    CONTRIBUTING_PATHS,
    MAX_FILE_BYTES,
    OPT_OUT_MARKERS,
    TEMPLATE_PATHS,
    ContributingAsks,
    contributing_asks,
    facts_of,
    opt_out,
)


class GitHubUpstream:
    """``UpstreamHost`` over the connections' credentials (``credentials``: either host's) and the GitHub client."""

    def __init__(self, credentials: Callable[[str], Credential], github: GitHubHost) -> None:
        self._credentials = credentials
        self._github = github

    def _github_credential(self, connection_id: str) -> GitHubAppCredential | None:
        found = self._credentials(connection_id)
        return found if isinstance(found, GitHubAppCredential) else None

    def kind(self, connection_id: str) -> str:
        credential = self._github_credential(connection_id)
        return REPOSITORY_KIND if credential is None else credential.kind

    def fork(self, connection_id: str) -> ForkFacts | None:
        credential = self._github_credential(connection_id)
        return credential.fork if credential is not None and credential.kind == FORK else None

    def _fork(self, connection_id: str) -> tuple[GitHubAppCredential, ForkFacts]:
        credential = self._github_credential(connection_id)
        if credential is None or credential.fork is None:
            raise NotFound('The connection is not a fork.')
        return credential, credential.fork

    def _file(self, connection_id: str, repository: str, paths: tuple[str, ...]) -> tuple[str, str]:
        """The first of ``paths`` the repository has, and its text (at most ``MAX_FILE_BYTES``); ('', '') for none."""
        for path in paths:
            response = self._github.public_get(connection_id, f'/repos/{repository}/contents/{quote(path, safe="/")}',
                                               'the upstream read', accept=RAW_ACCEPT, ok=(200, 404))
            if response.status == 200:
                return path, response.body[:MAX_FILE_BYTES].decode('utf-8', errors='replace')
        return '', ''

    def facts(self, connection_id: str) -> UpstreamFacts:
        _, fork = self._fork(connection_id)
        repository = fork.upstream
        found = facts_of(json_of(self._github.public_get(connection_id, f'/repos/{repository}', 'the upstream read')))
        if found is None:
            raise HostError('GitHub answered the upstream\'s read off its shape.')
        labels = [marker for marker in OPT_OUT_MARKERS if self._github.public_get(
            connection_id, f'/repos/{repository}/labels/{quote(marker, safe="")}', 'the upstream read',
            ok=(200, 404)).status == 200]
        contributing_path, contributing = self._file(connection_id, repository, CONTRIBUTING_PATHS)
        _, template = self._file(connection_id, repository, TEMPLATE_PATHS)
        asks = contributing_asks(contributing_path, contributing) if contributing_path else ContributingAsks()
        return UpstreamFacts(facts=found, opt_out=opt_out(found.topics, labels, contributing), template=template,
                             contributing=asks)

    def existing(self, connection_id: str, branch: str) -> PullRequestRef | None:
        credential, fork = self._fork(connection_id)
        return first_pull_request(self._github.public_get(
            connection_id, f'/repos/{fork.upstream}/pulls?{open_from(credential.owner, branch)}',
            'the upstream pull request lookup'))

    def fork_pull_request(self, connection_id: str, number: int) -> ForkPullRequest:
        credential, _ = self._fork(connection_id)
        response = self._github.public_get(connection_id, f'/repos/{credential.owner}/{credential.repository}/pulls/'
                                           f'{int(number)}', 'the fork pull request read', ok=(200, 404))
        if response.status == 404:
            raise NotFound(f'The fork has no pull request {int(number)}.')
        data = json_of(response)
        return ForkPullRequest(title=text_or_empty(data, 'title'), body=text_or_empty(data, 'body'),
                               open=dig(data, 'state') == 'open' and dig(data, 'merged') is not True)
