"""What the broker needs from a repository host, the run's record, the board and the dial, host-neutral.

The host clients are ``github.GitHubHost`` and ``gitlab.GitLabHost``, and the broker reaches the one a connection's
credential names through ``router.HostRouter`` (docs/autonomous-engineering.md, "Repository connectors"); the run's
record and the board's GO ledger are ``records.RunRecords``, the submitted patch's reader ``patches.WorkspacePatches``
and the way of working ``dial.WaysOfWorking``. A deployment that names none of their stores gets ``UNCONNECTED`` in
their place, so every permitted operation answers ``NoConnection``.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Final, Literal, Protocol

from engineering.connectors.reactions import PullRequestReactions
from engineering.connectors.write_policy import BrokerError, WriteRefused
from engineering.run_links import PullRequestLink

ReadKind = Literal['file', 'history', 'issue', 'pull_request']
CommentTarget = Literal['issue', 'pull_request']
NO_CONNECTION: Final = 'no repository connection is configured'
#: A full git object id (a commit or a tree: SHA-1 or SHA-256).
OBJECT_ID: Final = re.compile(r'(?:[0-9a-f]{40}|[0-9a-f]{64})')
#: The git modes a pushed file may have: a file, an executable, a symbolic link (never a submodule or a tree).
FILE_MODES: Final = frozenset({'100644', '100755', '120000'})


#: When (epoch seconds) the current broker call must have finished what it reads before a write, so the write and its
#: read-back still fit in the invocation: set by the broker's handler from Lambda's remaining time
#: (``handler.lambda_handler``), ``None`` outside an invocation. A host client that reads much before a write (GitLab's
#: push) refuses, writing nothing, once it is past.
WRITE_READY_BY: Final[ContextVar[float | None]] = ContextVar('write_ready_by', default=None)
#: What a call keeps of Lambda's remaining time for a write and its read-back, after its reads before the write: the
#: invocation ends this long after ``WRITE_READY_BY``. GitLab's push needs the most: its first commit (10 s), a page
#: of its read-back (a read with its retry, 20 s) and a stop's undo and answer (35 s: ``gitlab.py``'s time model),
#: 10 + 20 + 35 = 65. On the broker's 120 s, the reads before a write keep 55 s.
WRITE_RESERVE_SECONDS: Final = 65
_NUMBER: Final = re.compile(r'[1-9][0-9]{0,9}')


def remaining_until(context: object, now: float, margin: float) -> float | None:
    """When, on the clock that reads ``now``, an invocation must be done less ``margin`` seconds: Lambda's remaining
    time (``context``'s ``get_remaining_time_in_millis``); ``None`` without a context that gives it."""
    remaining = getattr(context, 'get_remaining_time_in_millis', None)
    millis = remaining() if callable(remaining) else None
    if not isinstance(millis, (int, float)) or isinstance(millis, bool):
        return None
    return now + millis / 1000 - margin
#: A read's page number (the cursor the clients hand out).
PAGE_NUMBER: Final = re.compile(r'[1-9][0-9]{0,4}')


def keep[K, V](cache: dict[K, V], key: K, value: V, limit: int) -> None:
    """``cache[key] = value``, the oldest entries dropped first so it never holds more than ``limit``: the clients'
    bounded caches (default branches, confirmed branches, branch rules that passed)."""
    cache.pop(key, None)
    while len(cache) >= limit:
        del cache[next(iter(cache))]
    cache[key] = value


def fresh[K, V](cache: dict[K, tuple[V, float]], key: K, now: float) -> V | None:
    """What ``cache`` keeps for ``key`` while it is not yet due to be read again at ``now``, else ``None``."""
    held = cache.get(key)
    return held[0] if held is not None and now < held[1] else None


class NoConnection(Exception):
    """The deployment has no repository connection for the call to use."""


class HostError(BrokerError):
    """The repository host failed or answered what the client did not expect; the reason names the operation and
    the host's status, never a token or what was sent."""

    #: The host's HTTP status, when it answered one the client did not expect (0 otherwise).
    status: int = 0


class HostBusy(HostError):
    """The host is rate limiting (or unreachable) for longer than the client waits: retry after ``retry_after``
    seconds."""

    def __init__(self, reason: str, retry_after: int) -> None:
        super().__init__(reason)
        self.retry_after = retry_after


class Unavailable(HostError):
    """The run's records, the workspace or the way of working could not be read (a throttle, a lost connection):
    retry. The reason never names a key or a value."""


class NotFound(HostError):
    """The file, issue or pull request a read names is not on the host."""


class InvalidTarget(HostError):
    """A read's target or cursor is not one the client asks the host for (a path outside the repository, a cursor
    it did not hand out)."""


def repository_path(target: str) -> str:
    """``target`` when it is a path inside the repository (no empty, ``.`` or ``..`` part, no control character or
    backslash), never one that climbs out of it; ``InvalidTarget`` otherwise."""
    parts = target.split('/')
    if any(part in {'', '.', '..'} for part in parts) or any(ord(c) < 32 or c == '\\' for c in target):
        raise InvalidTarget('The target is a path inside the repository: no empty, "." or ".." part.')
    return target


def read_page(kind: ReadKind, target: str, cursor: str | None, file: Callable[[], ReadPage],
              history: Callable[[str], ReadPage], thread: Callable[[str, str], ReadPage]) -> ReadPage:
    """A read by its kind, on the client's own readers: a file (whole, no cursor), history (the page ``cursor``
    names), or an issue's or a pull (merge) request's thread (its number, the page)."""
    if kind == 'file':
        if cursor is not None:
            raise InvalidTarget('A file is read whole; it has no pages.')
        return file()
    page = cursor_page(cursor)
    return history(page) if kind == 'history' else thread(issue_number(target), page)


def file_page(found: bytes | None) -> ReadPage:
    """A file read's page: its whole text, ``NotFound`` when the branch has no such file (``None``), and a file that is
    not UTF-8 text refused rather than read lossily."""
    if found is None:
        raise NotFound("The repository has no such file on the run's default branch.")
    try:
        return ReadPage(content=found.decode('utf-8'), next_cursor=None)
    except UnicodeDecodeError:
        raise InvalidTarget('The file is not UTF-8 text; the broker reads text files only.') from None


def cursor_page(cursor: str | None) -> str:
    """The page a read's cursor names ('1' for none): only a page number the broker handed out."""
    if cursor is None:
        return '1'
    if not PAGE_NUMBER.fullmatch(cursor):
        raise InvalidTarget('The cursor is not one the broker handed out.')
    return cursor


def issue_number(target: str) -> str:
    """``target`` when it is an issue's or a pull (merge) request's number, ``InvalidTarget`` otherwise."""
    if not _NUMBER.fullmatch(target):
        raise InvalidTarget('The target is the number of an issue or a pull request.')
    return target


class OutcomeUnknown(HostError):
    """A write reached the host, or may have, and whether it was made is not known (a host error, a timeout): answered
    502, never made again for the same key (``WriteLedger``)."""


class Conflict(WriteRefused):
    """The host's state is not the one the write was checked against: the branch moved (the lease), or its tree is
    not the checked one. Nothing was written to the branch."""


class StoredBranchMissing(Conflict):
    """The connection's stored default branch (the one the run started with) is not on the repository: the broker
    refuses the run's every operation until an administrator corrects the connection (answered 409, nothing read or
    written)."""


#: The refusal's words: never the branch's name (the agent's own record already holds it).
STORED_BRANCH_MISSING: Final = ("The connection's default branch is not on the repository; an administrator "
                                'corrects it under Agents → Connections, then the run is started again.')


#: A write's claim (``WriteLedger``): taken before the host call, then closed with what came of it.
WRITE_CLAIMED: Final = 'claimed'
WRITE_DONE: Final = 'done'
#: Refused with nothing written (a write rule, the host's lease): the same key may be claimed again.
WRITE_REFUSED: Final = 'refused'
#: The host may or may not have made it: never made again for that key.
WRITE_UNKNOWN: Final = 'unknown'


@dataclass(frozen=True)
class WriteClaim:
    """An earlier claim of a write's key: its state, and a done write's answer (never a body or a patch)."""

    state: str
    result: dict[str, object] | None = None


@dataclass(frozen=True)
class ReadPage:
    """One page of what an agent read: file text, a window of history, an issue or a pull request with its thread."""

    content: str
    next_cursor: str | None


@dataclass(frozen=True)
class PullRequestRef:
    """A pull (merge) request as the host answered it: its number (GitLab's IID), its URL, and, as the host's answer
    names them (7.09.00: what the run's record keeps, ``run_links.py``), its head and base branches ('' when the answer
    did not say) and the host kind of the client that read it (``github`` or ``gitlab``; '' for none)."""

    number: int
    url: str
    head: str = ''
    base: str = ''
    host: str = ''


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
    """What a push would write, as the broker reads it from what the agent submitted itself (never from the
    request): today one commit, from the agent's submitted patch (``patches.py``)."""

    #: The head refs the push carries (``refs/heads/...``); the broker pushes exactly one.
    heads: tuple[str, ...]
    tree_hash: str
    #: Every path any commit changes, and every line any of them adds (not only what differs between ``base`` and
    #: the final tree): the write rules read these. The reader derives both from the submitted patch's own hunks,
    #: never from anything else the agent sent; the client re-checks that no commit changes a path outside
    #: ``changed_paths`` (defence in depth).
    changed_paths: tuple[str, ...]
    commits: tuple[Commit, ...]
    added_lines: tuple[str, ...]
    #: The commit the bundle builds on (its prerequisite): the head the branch must still have when the push lands
    #: (the lease), or, for a branch not on the host yet, the commit the new branch starts from (the default
    #: branch's head or an ancestor of it).
    base: str


#: The one status in which the broker serves a run (``runtime/runs.py``: ``needs_human`` waits for a person, and
#: ``done``, ``failed`` and ``stopped`` have ended it).
ACTIVE: Final = 'active'


@dataclass(frozen=True)
class RunRecord:
    """The run's record: its connection and what the broker checks against, never taken from the request."""

    connection_id: str
    #: The branch the broker holds the run to: worked out by the broker (``RepositoryHost.default_branch``) only after
    #: the repository check, from ``stored_default_branch``; '' until then.
    default_branch: str
    #: The run's status (META's): the broker serves only an ``ACTIVE`` run.
    status: str
    #: Whether an administrator's CI attestation holds for the run's repository (``RunDirectory.attested``: read at
    #: each push and pull request, never before), and its version (0 for none).
    ci_attested: bool
    #: The text of the reviews behind the run's feedback ids: what no write may quote.
    cited_reviews: tuple[str, ...]
    #: The issue and the pull request the run works on (``None``: it has none), the only ones its agents comment on.
    issue_number: int | None = None
    pull_request_number: int | None = None
    #: The connection's bot addresses: the only author, committer and trailer addresses a pushed commit may carry
    #: (none: every push is refused).
    bot_addresses: tuple[str, ...] = ()
    #: The commit the run works on (its agents' checkouts, the base of every patch they submit).
    commit: str = ''
    #: The person who started the run (their subject): whose way of working the dial reads ('' for none).
    started_by: str = ''
    #: The repository the run started on (META's ``repo``, the stored connection's ``owner/name`` at its start): the
    #: broker serves the run only while the connection's credential names that same repository.
    repository: str = ''
    #: META's ``default_branch``: the stored connection's at the start ('' for a run started before 7.03.01).
    stored_default_branch: str = ''
    ci_attestation: int = 0
    #: The host kind of the run's issue (META's ``issue``: ``github`` or ``gitlab``; '' for none), which says how its
    #: pull request names it (``Fixes #N`` / ``Closes #N``: broker.py ``closing_body``).
    issue_host: str = ''


@dataclass(frozen=True)
class CiProtection:
    """What the host's branch rules say, as the connection's read-only token reads them (``RepositoryHost
    .ci_protection``): whether the default branch is protected and the checks it requires, and whether the agent's
    branch is protected (it must not be: a protected branch gets the CI secrets and the cloud trust kept for
    protected branches, and an agent's branch runs code an agent wrote). ``checked_at``: when the host was read."""

    default_branch_protected: bool
    required_checks: tuple[str, ...]
    agent_branch_protected: bool
    checked_at: float = 0.0
    #: What else the host's own rules leave open, in the refusal's words (GitLab's: a force push or a Developer's
    #: push or merge allowed on the default branch, a push rule that refuses the agent's branch); empty when nothing.
    problems: tuple[str, ...] = ()

    @property
    def passes(self) -> bool:
        return (self.default_branch_protected and bool(self.required_checks) and not self.agent_branch_protected
                and not self.problems)


@dataclass
class BranchCaches:
    """A host client's bounded caches (``keep``), per connection and repository: its default branch and when it is read
    again; a stored default branch the host has and when it is looked up again; branch rules that passed the CI check
    (default branch, agent branch) and when they are read again."""

    default_branches: dict[tuple[str, str], tuple[str, float]] = field(default_factory=dict)
    confirmed_branches: dict[tuple[str, str, str], float] = field(default_factory=dict)
    ci_checks: dict[tuple[str, str, str, str], tuple[CiProtection, float]] = field(default_factory=dict)


def stray_changes(contents: BundleContents, writable: Callable[[FileChange], bool], refusal: str) -> list[str]:
    """Why a bundle's commits are not the ones the write rules checked, or cannot be written: a change outside
    ``changed_paths``, or a change the client does not write (``writable`` False: ``refusal``, with its path)."""
    listed = set(contents.changed_paths)
    changes = [change for commit in contents.commits for change in commit.changes]
    found = [f'A pushed commit changes a path the bundle does not list ({path}).'
             for path in sorted({c.path for c in changes} - listed)]
    found += [f'{refusal} ({path}).' for path in sorted({c.path for c in changes if not writable(c)})]
    return found


def require_pushable(contents: BundleContents, tree_hash: str, stray: list[str]) -> None:
    """A push's checks of its own bundle, before any request: at least one commit, nothing ``stray`` (the client's
    ``stray_changes``), and the head's tree the one the broker checked."""
    if not contents.commits:
        raise WriteRefused('A pushed bundle carries at least one commit.')
    if stray:
        raise WriteRefused(' '.join(stray))
    if contents.tree_hash != tree_hash:
        raise Conflict("The bundle's head does not have the tree the broker checked.")


def require_base(head: str | None, contents: BundleContents) -> None:
    """The lease: an existing branch's ``head`` must be the bundle's base (``None``: a new branch)."""
    if head is not None and head != contents.base:
        raise Conflict('The branch has moved since the bundle was made (its head is not the bundle\'s base); '
                       'fetch it and make the bundle again.')


def checked_after_write(ref: PullRequestRef, opened: bool, check: Callable[[], None],
                        close: Callable[[], None], noun: str = 'pull request') -> PullRequestRef:
    """``ref`` once ``check`` (its head has the checked tree) passes after the write. Whatever stops the check (the
    branch moved, a rate limit, a host error), one this call ``opened`` is closed, and since the write has gone out
    (opened, or its text updated) the outcome is unknown, never a refusal: the broker's claim is closed unknown and the
    write never made again."""
    try:
        check()
    except Exception as exc:
        if opened:
            close()
        why = exc.reason if isinstance(exc, BrokerError) else type(exc).__name__
        raise OutcomeUnknown(f'The {noun} was {"opened" if opened else "updated"}, but its check after the write did '
                             f'not pass ({why}); whether it stands as asked is not known.') from exc
    return ref


#: What a push or a pull request is refused with when the host's branch rules are not what the setup guide asks.
CI_DEFAULT_UNPROTECTED: Final = ("The repository's default branch is not protected: protect it, with the "
                                 "repository's own checks required, before the agents push.")
CI_NO_REQUIRED_CHECKS: Final = ("The repository's default branch requires no status check: require the repository's "
                                'own CI checks on it before the agents push.')
CI_AGENT_BRANCH_PROTECTED: Final = ("The agent's branch is protected by the repository's rules, so it would get what "
                                    'protected branches get (their CI secrets and cloud trust): leave voc-agent/* '
                                    'branches unprotected.')


def ci_refusal(found: CiProtection) -> str | None:
    """Why ``found`` refuses a push or a pull request, None when it passes."""
    if not found.default_branch_protected:
        return CI_DEFAULT_UNPROTECTED
    if found.problems:
        return found.problems[0]
    if not found.required_checks:
        return CI_NO_REQUIRED_CHECKS
    return CI_AGENT_BRANCH_PROTECTED if found.agent_branch_protected else None


@dataclass(frozen=True)
class FetchAccess:
    """What the checkout cache's fetch of a connection's repository uses (``cache.py``): the host (``github`` or
    ``gitlab``), the repository's path on it, and a read token (``repr`` leaves it out). ``revocable``: the token was
    minted for this fetch and is revoked after it (GitHub's installation token); a GitLab project access token is the
    connection's own long-lived credential, so no revocation call is made for it (it would cut the connection)."""

    repository: str
    token: str = field(repr=False)
    host: str = 'github'
    revocable: bool = True


@dataclass(frozen=True)
class Submission:
    """What the committer asks the broker to push: its patch's key in the workspace (under its own keys), the branch,
    the tree the board's GO names, and the commit's message. The run and the agent are the caller's own."""

    run_id: str
    agent_id: str
    run: RunRecord
    key: str
    branch: str
    tree_hash: str
    message: str


class RepositoryHost(Protocol):
    """A host client. ``tree_hash`` is the tree the broker checked (and, where the rules ask, the board's GO
    is for), which the client enforces: it pushes the bundle's head only when that head's tree is ``tree_hash``,
    with a lease on the branch's current head (so a concurrent push fails rather than being overwritten), and opens
    or updates a pull request only after verifying that the branch's head has that tree. A pull request read
    returns the pull request, its conversation, its review comments and its reviews."""

    def read(self, connection_id: str, kind: ReadKind, target: str, cursor: str | None, branch: str = '') -> ReadPage:
        """A page of what ``target`` names; a file and history on ``branch`` (the run's default branch, as the broker
        worked it out; '' for the repository's own)."""
        ...

    def ci_protection(self, connection_id: str, default_branch: str, branch: str) -> CiProtection:
        """The host's branch rules for ``default_branch`` and the agent's ``branch``, read with a read-only token."""
        ...

    def file_at(self, connection_id: str, commit: str, path: str) -> bytes | None:
        """The bytes of ``path`` at ``commit``, ``None`` when the commit has no such file (a patch's base)."""
        ...

    def default_branch(self, connection_id: str, stored: str = '') -> str:
        """``stored`` (the connection's default branch as the run recorded it) once the host confirms the repository
        has it, ``StoredBranchMissing`` when it does not; the repository's own default branch for ``stored=''``."""
        ...

    def repository(self, connection_id: str) -> str:
        """The repository (``owner/name``) the connection's stored credential is for."""
        ...

    def head_commit(self, connection_id: str, branch: str) -> str | None:
        """The head commit of ``branch`` (7.47.00, the start's ``head``), None when the repository has no such branch."""
        ...

    def issue_state(self, connection_id: str, number: int) -> str | None:
        """Issue ``number``'s state (``open`` or ``closed``; 7.47.00), None when the repository has no such issue (a
        pull or merge request's number included)."""
        ...

    def post_comment(self, connection_id: str, on: CommentTarget, number: int, body: str) -> str: ...

    def branch_tree_hash(self, connection_id: str, branch: str) -> str | None: ...

    def push_bundle(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str,
                    default_branch: str) -> None: ...

    def open_or_update_draft_pr(self, connection_id: str, branch: str, base: str, title: str, body: str,
                                tree_hash: str) -> PullRequestRef: ...

    def reactions(self, connection_id: str, number: int, url: str, branch: str) -> PullRequestReactions:
        """People's reactions to the pull request ``number`` (its record's address ``url``), the revert and the edits
        after its merge on ``branch`` (7.10.00, ``reactions.py``): reads only, bounded, trust-filtered, redacted."""
        ...


class BundleReader(Protocol):
    def contents(self, submission: Submission) -> BundleContents:
        """What pushing the submission would write, read from the submitted patch itself (never the request)."""
        ...


class RunDirectory(Protocol):
    def run(self, run_id: str) -> RunRecord | None: ...

    def attested(self, run: RunRecord) -> RunRecord:
        """``run`` with the CI attestation that holds for its connection and repository (``ci_attested``,
        ``ci_attestation``): what a push or a pull request needs, read when one is asked for."""
        ...


class GateLedger(Protocol):
    def has_go(self, run_id: str, tree_hash: str) -> bool:
        """The run's final go answered GO for exactly ``tree_hash`` (its latest verdict)."""
        ...

    def person_go(self, run_id: str) -> bool:
        """A person gave the run their go (AI-assisted: what a push or a pull request waits for)."""
        ...


class Dial(Protocol):
    def mode(self, person: str) -> str:
        """The way of working (``shared/ai_mode.py`` MODES) of ``person``; Human-driven for no person."""
        ...


class WriteLedger(Protocol):
    """Each write once per key (the caller's run, agent and attempt and the operation), so a repeat of a write whose
    outcome its caller never learnt answers the first outcome and is never made twice."""

    def claim(self, run_id: str, key: str, operation: str) -> WriteClaim | None:
        """None: claimed now (create-only, or again after a refusal); else the earlier claim as it stands."""
        ...

    def earlier(self, run_id: str, key: str) -> WriteClaim | None:
        """The claim of ``key`` as it stands (a consistent read; nothing claimed), None for none."""
        ...

    def close(self, run_id: str, key: str, state: str, result: dict[str, object] | None = None) -> None:
        """The claim's outcome (``WRITE_DONE`` with the answer, ``WRITE_REFUSED``, ``WRITE_UNKNOWN``)."""
        ...

    def record_pull_request(self, run_id: str, link: PullRequestLink) -> bool:
        """Keep ``link`` as the run's pull request, keyed on its head branch (``run_links.merged``): True when recorded
        (the first, the same one, or a new number on the same head, the earlier kept as superseded), False when the
        run's record names one on another head (never repointed); ``Unavailable`` when it cannot be written."""
        ...

    def pull_request(self, run_id: str, repository: str) -> PullRequestLink | None:
        """The run's recorded pull request (``run_links.run_pull_request``: its row, else its newest done write
        claim), None for none; ``Unavailable`` when it cannot be read."""
        ...


class Unconnected:
    """The patch reader, run records, GO ledger and dial where the deployment names none of their stores: every call
    is ``NoConnection``, so the broker refuses each permitted operation with 503 before it reaches the host."""

    def contents(self, submission: Submission) -> BundleContents:  # noqa: ARG002 - the protocol's signature
        raise NoConnection(NO_CONNECTION)

    def run(self, run_id: str) -> RunRecord | None:  # noqa: ARG002 - the protocol's signature
        raise NoConnection(NO_CONNECTION)

    def attested(self, run: RunRecord) -> RunRecord:  # noqa: ARG002 - the protocol's signature
        raise NoConnection(NO_CONNECTION)

    def has_go(self, run_id: str, tree_hash: str) -> bool:  # noqa: ARG002 - the protocol's signature
        raise NoConnection(NO_CONNECTION)

    def person_go(self, run_id: str) -> bool:  # noqa: ARG002 - the protocol's signature
        raise NoConnection(NO_CONNECTION)

    def mode(self, person: str) -> str:  # noqa: ARG002 - the protocol's signature
        raise NoConnection(NO_CONNECTION)

    def claim(self, run_id: str, key: str, operation: str) -> WriteClaim | None:  # noqa: ARG002 - the protocol's
        raise NoConnection(NO_CONNECTION)

    def earlier(self, run_id: str, key: str) -> WriteClaim | None:  # noqa: ARG002 - the protocol's signature
        raise NoConnection(NO_CONNECTION)

    def close(self, run_id: str, key: str, state: str,  # noqa: ARG002 - the protocol's signature
              result: dict[str, object] | None = None) -> None:  # noqa: ARG002 - the protocol's signature
        raise NoConnection(NO_CONNECTION)

    def record_pull_request(self, run_id: str, link: PullRequestLink) -> bool:  # noqa: ARG002 - the protocol's
        raise NoConnection(NO_CONNECTION)

    def pull_request(self, run_id: str, repository: str) -> PullRequestLink | None:  # noqa: ARG002 - the protocol's
        raise NoConnection(NO_CONNECTION)


UNCONNECTED: Final = Unconnected()


@dataclass(frozen=True)
class Connector:
    """A configured connection's collaborators: the host client, the patch reader, the runs, the board, the dial and
    the writes' claims."""

    host: RepositoryHost
    bundles: BundleReader
    runs: RunDirectory
    ledger: GateLedger
    dial: Dial
    writes: WriteLedger
