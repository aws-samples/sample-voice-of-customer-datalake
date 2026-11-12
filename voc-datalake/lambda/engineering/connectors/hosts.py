"""What the broker needs from a repository host, the run's record and the board, host-neutral.

The GitHub client is ``github.GitHubHost`` (docs/autonomous-engineering.md, "Repository connectors"); the run
records and the board's GO ledger are not built yet, so the deployed broker answers every permitted operation with
``NoConnection`` (``UNCONNECTED`` stands in for them) until they land.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal, Protocol

from engineering.connectors.write_policy import BrokerError, WriteRefused

ReadKind = Literal['file', 'history', 'issue', 'pull_request']
CommentTarget = Literal['issue', 'pull_request']
NO_CONNECTION: Final = 'no repository connection is configured'


class NoConnection(Exception):
    """The deployment has no repository connection for the call to use."""


class HostError(BrokerError):
    """The repository host failed or answered what the client did not expect; the reason names the operation and
    the host's status, never a token or what was sent."""


class HostBusy(HostError):
    """The host is rate limiting (or unreachable) for longer than the client waits: retry after ``retry_after``
    seconds."""

    def __init__(self, reason: str, retry_after: int) -> None:
        super().__init__(reason)
        self.retry_after = retry_after


class NotFound(HostError):
    """The file, issue or pull request a read names is not on the host."""


class InvalidTarget(HostError):
    """A read's target or cursor is not one the client asks the host for (a path outside the repository, a cursor
    it did not hand out)."""


class Conflict(WriteRefused):
    """The host's state is not the one the write was checked against: the branch moved (the lease), or its tree is
    not the checked one. Nothing was written to the branch."""


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
class FileChange:
    """One path a commit changes: its new content and git mode (``100644``, ``100755``, ``120000``), or
    ``content=None`` for a deletion."""

    path: str
    mode: str
    content: bytes | None


@dataclass(frozen=True)
class Commit:
    """One commit of a bundle: its message, the addresses of its author and committer, and what it changes against
    its parent (the previous commit, the bundle's ``base`` for the first)."""

    message: str
    author: str
    committer: str
    changes: tuple[FileChange, ...] = ()


@dataclass(frozen=True)
class BundleContents:
    """What a git bundle would push, as the broker reads it from the bundle itself (never from the request)."""

    #: The head refs the bundle carries (``refs/heads/...``); the broker pushes a bundle of exactly one.
    heads: tuple[str, ...]
    tree_hash: str
    #: Every path any commit of the bundle changes, and every line any of them adds (not only what differs between
    #: ``base`` and the final tree): the write rules read these. The bundle reader must derive both from git's own
    #: diff of every commit in the bundle, never from anything the agent sent; the client re-checks that no commit
    #: changes a path outside ``changed_paths`` (defence in depth).
    changed_paths: tuple[str, ...]
    commits: tuple[Commit, ...]
    added_lines: tuple[str, ...]
    #: The commit the bundle builds on (its prerequisite): the head the branch must still have when the push lands
    #: (the lease), or, for a branch not on the host yet, the commit the new branch starts from (the default
    #: branch's head or an ancestor of it).
    base: str


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
    or updates a pull request only after verifying that the branch's head has that tree. A pull request read
    returns the pull request, its conversation, its review comments and its reviews."""

    def read(self, connection_id: str, kind: ReadKind, target: str, cursor: str | None) -> ReadPage: ...

    def post_comment(self, connection_id: str, on: CommentTarget, number: int, body: str) -> str: ...

    def open_pull_request(self, connection_id: str, branch: str) -> PullRequestRef | None: ...

    def branch_tree_hash(self, connection_id: str, branch: str) -> str | None: ...

    def push_bundle(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str,
                    default_branch: str) -> None: ...

    def open_or_update_draft_pr(self, connection_id: str, branch: str, base: str, title: str, body: str,
                                tree_hash: str) -> PullRequestRef: ...


class BundleReader(Protocol):
    def contents(self, bundle: bytes) -> BundleContents: ...


class RunDirectory(Protocol):
    def run(self, run_id: str) -> RunRecord | None: ...


class GateLedger(Protocol):
    def has_go(self, run_id: str, tree_hash: str) -> bool: ...


class Unconnected:
    """The bundle reader, run records and GO ledger until they are built: every call is ``NoConnection``, so the
    broker refuses each permitted operation with 503 before it reaches the host."""

    def contents(self, bundle: bytes) -> BundleContents:  # noqa: ARG002 - the protocol's signature
        raise NoConnection(NO_CONNECTION)

    def run(self, run_id: str) -> RunRecord | None:  # noqa: ARG002 - the protocol's signature
        raise NoConnection(NO_CONNECTION)

    def has_go(self, run_id: str, tree_hash: str) -> bool:  # noqa: ARG002 - the protocol's signature
        raise NoConnection(NO_CONNECTION)


UNCONNECTED: Final = Unconnected()


@dataclass(frozen=True)
class Connector:
    """A configured connection's collaborators: the host client, the bundle reader, the runs and the board."""

    host: RepositoryHost
    bundles: BundleReader
    runs: RunDirectory
    ledger: GateLedger
