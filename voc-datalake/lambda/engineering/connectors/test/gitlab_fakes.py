"""GitLab's API as the connectors see it, for tests: the GitHub fake's canned answers per (method, path), every request
recorded, and an exception as a reply (a request lost on the way)."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from engineering.connectors.credentials import GitLabTokenCredential
from engineering.connectors.gitlab import GitLabHost
from engineering.connectors.test.test_github import NOW, Clock, FakeGitHub, Sent, answer
from engineering.connectors.transport import Response

__all__ = ['NOW', 'Clock', 'answer']

PROJECT_ID = 4242
PROJECT = 'example-org/payments/refund-service'
#: A stand-in for a project access token, of its shape (``glpat-`` and twenty or more characters; written in two parts
#: so no secret scanner takes the source for a token).
TOKEN = 'glpat-' + 'exampleTokenForTests0123'
API = '/api/v4'
P = f'{API}/projects/{PROJECT_ID}'

Reply = Response | Exception | Callable[[Sent], Response]


def _raising(error: Exception) -> Callable[[Sent], Response]:
    def reply(_: Sent) -> Response:
        raise error
    return reply


class FakeGitLab(FakeGitHub):
    """Answers ``method path`` with its replies in turn (the last one from then on); an exception reply is raised."""

    def __post_init__(self) -> None:   # (no token route: a GitLab token is the connection's own)
        pass

    def on(self, method: str, path: str, *replies: Reply) -> FakeGitLab:
        super().on(method, path, *(_raising(r) if isinstance(r, Exception) else r for r in replies))
        return self

    def bodies(self, method: str, path: str) -> list[Any]:
        return [s.body for s in self.sent if (s.method, s.path) == (method, path)]


def credential(repository: str = PROJECT) -> GitLabTokenCredential:
    return GitLabTokenCredential(project_id=PROJECT_ID, repository=repository, token=TOKEN, expires_at='2027-11-01')


def client(api: FakeGitLab, clock: Clock | None = None) -> GitLabHost:
    return GitLabHost(lambda _: credential(), api, clock=clock or Clock())
