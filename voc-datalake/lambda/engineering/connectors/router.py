"""The host client a connection's credential names (docs/autonomous-engineering.md, "Repository connectors").

The broker and the checkout cache's writer hold one ``HostRouter``: each call goes to the GitHub client
(``github.GitHubHost``) for a connection whose stored credential is a GitHub App's, and to the GitLab client
(``gitlab.GitLabHost``) for one whose credential is a GitLab project access token, read from the same SSM parameter
(``credentials.ParameterStoreCredentials.stored``, kept five minutes). A connection with no usable credential is
``NoConnection`` before any host is asked.
"""
from __future__ import annotations

from collections.abc import Callable

from engineering.connectors.credentials import Credential, GitLabTokenCredential
from engineering.connectors.github import GitHubHost
from engineering.connectors.gitlab import GitLabHost
from engineering.connectors.hosts import (
    BundleContents,
    CiProtection,
    CommentTarget,
    FetchAccess,
    PullRequestRef,
    ReadKind,
    ReadPage,
    RepositoryHost,
)


class HostRouter:
    """``RepositoryHost`` over both clients: each call on the client of the connection's own host."""

    def __init__(self, credentials: Callable[[str], Credential], github: GitHubHost, gitlab: GitLabHost) -> None:
        self._credentials = credentials
        self._github = github
        self._gitlab = gitlab

    def _host(self, connection_id: str) -> RepositoryHost:
        return self._gitlab if isinstance(self._credentials(connection_id), GitLabTokenCredential) else self._github

    def read(self, connection_id: str, kind: ReadKind, target: str, cursor: str | None, branch: str = '') -> ReadPage:
        return self._host(connection_id).read(connection_id, kind, target, cursor, branch)

    def ci_protection(self, connection_id: str, default_branch: str, branch: str) -> CiProtection:
        return self._host(connection_id).ci_protection(connection_id, default_branch, branch)

    def file_at(self, connection_id: str, commit: str, path: str) -> bytes | None:
        return self._host(connection_id).file_at(connection_id, commit, path)

    def default_branch(self, connection_id: str, stored: str = '') -> str:
        return self._host(connection_id).default_branch(connection_id, stored)

    def repository(self, connection_id: str) -> str:
        return self._host(connection_id).repository(connection_id)

    def post_comment(self, connection_id: str, on: CommentTarget, number: int, body: str) -> str:
        return self._host(connection_id).post_comment(connection_id, on, number, body)

    def branch_tree_hash(self, connection_id: str, branch: str) -> str | None:
        return self._host(connection_id).branch_tree_hash(connection_id, branch)

    def push_bundle(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str,
                    default_branch: str) -> None:
        self._host(connection_id).push_bundle(connection_id, branch, contents, tree_hash, default_branch)

    def open_or_update_draft_pr(self, connection_id: str, branch: str, base: str, title: str, body: str,
                                tree_hash: str) -> PullRequestRef:
        return self._host(connection_id).open_or_update_draft_pr(connection_id, branch, base, title, body, tree_hash)

    def fetch_access(self, connection_id: str) -> FetchAccess:
        """The checkout cache's fetch of the connection's repository: GitHub's installation token for ``contents:
        read``, minted for it and revoked after; or the GitLab connection's own project token, never revoked."""
        if isinstance(self._credentials(connection_id), GitLabTokenCredential):
            repository, token = self._gitlab.fetch_token(connection_id)
            return FetchAccess(repository=repository, token=token, host='gitlab', revocable=False)
        repository, token = self._github.fetch_token(connection_id)
        return FetchAccess(repository=repository, token=token)

    def revoke_fetch_token(self, token: str) -> None:
        """Revoke a GitHub fetch token (``GitHubHost.revoke_fetch_token``)."""
        self._github.revoke_fetch_token(token)
