"""What the broker needs from a repository host, the run's record and the board, host-neutral.

No GitHub or GitLab client yet (docs/autonomous-engineering.md, "Repository connectors"): until one lands, the
broker has no ``Connector`` and refuses every operation (``NoConnection``).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal, Protocol

ReadKind = Literal['file', 'history', 'issue', 'pull_request']
CommentTarget = Literal['issue', 'pull_request']
NO_CONNECTION: Final = 'no repository connection is configured'


class NoConnection(Exception):
    """The deployment has no repository connection for the call to use."""


@dataclass(frozen=True)
class ReadPage:
    """One page of what an agent read: file text, a window of history, an issue or a pull request with its thread."""

    content: str
    next_cursor: str | None


@dataclass(frozen=True)
class PullRequestRef:
    number: int
    url: str


@dataclass(frozen=True)
class Commit:
    """One commit of a bundle: its message and the addresses of its author and committer."""

    message: str
    author: str
    committer: str


@dataclass(frozen=True)
class BundleContents:
    """What a git bundle would push, as the broker reads it from the bundle itself (never from the request)."""

    #: The head refs the bundle carries (``refs/heads/...``); the broker pushes a bundle of exactly one.
    heads: tuple[str, ...]
    tree_hash: str
    changed_paths: tuple[str, ...]
    commits: tuple[Commit, ...]
    added_lines: tuple[str, ...]


@dataclass(frozen=True)
class RunRecord:
    """The run's record: its connection and what the broker checks against, never taken from the request."""

    connection_id: str
    default_branch: str
    stopped: bool
    ci_attested: bool
    #: The text of the reviews behind the run's feedback ids: what no write may quote.
    cited_reviews: tuple[str, ...]
    #: The issue and the pull request the run works on (``None``: it has none), the only ones its agents comment on.
    issue_number: int | None = None
    pull_request_number: int | None = None
    #: The connection's bot addresses: the only author, committer and trailer addresses a pushed commit may carry
    #: (none: every push is refused).
    bot_addresses: tuple[str, ...] = ()


class RepositoryHost(Protocol):
    """A host client. ``tree_hash`` is the tree the broker checked (and, where the rules ask, the board's GO
    is for), which the client enforces: it pushes the bundle's head only when that head's tree is ``tree_hash``,
    with a lease on the branch's current head (so a concurrent push fails rather than being overwritten), and opens
    or updates a pull request only after verifying that the branch's head has that tree."""

    def read(self, connection_id: str, kind: ReadKind, target: str, cursor: str | None) -> ReadPage: ...

    def post_comment(self, connection_id: str, on: CommentTarget, number: int, body: str) -> str: ...

    def open_pull_request(self, connection_id: str, branch: str) -> PullRequestRef | None: ...

    def branch_tree_hash(self, connection_id: str, branch: str) -> str | None: ...

    def push_bundle(self, connection_id: str, branch: str, bundle: bytes, tree_hash: str) -> None: ...

    def open_or_update_draft_pr(self, connection_id: str, branch: str, base: str, title: str, body: str,
                                tree_hash: str) -> PullRequestRef: ...


class BundleReader(Protocol):
    def contents(self, bundle: bytes) -> BundleContents: ...


class RunDirectory(Protocol):
    def run(self, run_id: str) -> RunRecord | None: ...


class GateLedger(Protocol):
    def has_go(self, run_id: str, tree_hash: str) -> bool: ...


@dataclass(frozen=True)
class Connector:
    """A configured connection's collaborators: the host client, the bundle reader, the runs and the board."""

    host: RepositoryHost
    bundles: BundleReader
    runs: RunDirectory
    ledger: GateLedger
