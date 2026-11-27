"""What the broker needs from a repository host, the run's record, the board and the dial, host-neutral.

The host clients are ``github.GitHubHost`` and ``gitlab.GitLabHost``, and the broker reaches the one a connection's
credential names through ``router.HostRouter`` (docs/autonomous-engineering.md, "Repository connectors"); the run's
record and the board's GO ledger are ``records.RunRecords``, the submitted patch's reader ``patches.WorkspacePatches``
and the way of working ``dial.WaysOfWorking``. A deployment that names none of their stores gets ``UNCONNECTED`` in
their place, so every permitted operation answers ``NoConnection``. Since 7.52.00 the approved docs' reader
(``records.ApprovedDocsRecords``: the knowledge docs and the tenets as an administrator approved them) and their writes'
claims (``records.DocsClaims``), for voc-engineering-start's ``push_approved_docs`` and the agents' ``tenets`` read.
Since 7.57.00 a connection is of a kind (a repository of one's own, ``REPOSITORY_KIND``; a public repository read
only, ``PUBLIC_READ``; or a fork whose upstream gets the run's pull request, ``FORK``), and the broker offers that upstream
pull request, one click away, through two more collaborators (``UpstreamHost``, ``UpstreamLedger``: ``upstream_pr.py``).
Since 7.60.00 a public repository connected with a fine-grained token limited to it (``FINE_GRAINED``): read as a public
one is, written only by a run's push and pull request with the token (``WriteTokenReader``, ``TokenWrites``).
"""
from __future__ import annotations

import re
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Final, Literal, Protocol

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


class NotNow(WriteRefused):
    """The run, the dial or the board does not allow the operation now (an unknown or inactive run, Human-driven,
    no person's go, no GO, no attestation; since 7.57.00 a write on a public repository read only, and the upstream
    pull request's safeguards): the broker's, here so the upstream pull request's step (upstream_pr.py) raises it."""


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
#: The host may or may not have made it: never made again for that key (but a write on the run's issue, 7.71.03,
#: ``WriteLedger.claim``'s ``stale_after``).
WRITE_UNKNOWN: Final = 'unknown'


@dataclass(frozen=True)
class WriteClaim:
    """An earlier claim of a write's key: its state, a done write's answer (never a body or a patch) and when it was
    claimed (epoch seconds; 0 when not read)."""

    state: str
    result: dict[str, object] | None = None
    at: int = 0


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
    #: The run's upstream pull request's outcome (7.57.00, a fork connection's: ``UpstreamRecord.view``), which the
    #: broker's open of the fork's pull request goes on to; None on any other connection.
    upstream: dict[str, object] | None = None


#: A connection's kinds (7.57.00): a repository the App is installed on (``repository``, as before), a public repository
#: read through a read-only token (``public_read``: the broker refuses every write on it), and a fork of a public
#: repository, whose upstream gets the run's pull request (``fork``).
REPOSITORY_KIND: Final = 'repository'
PUBLIC_READ: Final = 'public_read'
FORK: Final = 'fork'
#: (7.60.00) A public repository connected with a fine-grained personal access token limited to it: read with the
#: deployment's App's read-only token, as ``PUBLIC_READ``; its run's push and pull request only are made with the token
#: (``TokenWrites``), after every gate and the token owner's own go (``broker.py``).
FINE_GRAINED: Final = 'fine_grained'


@dataclass(frozen=True)
class ForkFacts:
    """A fork connection's upstream, as its credential names it (written by the Agents API: ``connections.py``): the
    upstream ``owner/name`` and its default branch (as stored when it was connected), the connection's owner (``owner``:
    the sha256 of their subject) and the licence they acknowledged (its SPDX id)."""

    upstream: str
    upstream_default_branch: str
    owner: str
    licence: str
    #: The fork itself (``owner/name``): the head of the upstream pull request's compare link.
    repository: str = ''


@dataclass(frozen=True)
class UpstreamFacts:
    """What the broker reads of a fork's upstream before its pull request (``UpstreamHost.facts``), read only: the
    repository's facts (``upstream.RepositoryFacts``), the marker it opts out of bot pull requests with (None: none),
    its pull request template ('' for none) and what its CONTRIBUTING file asks (``upstream.ContributingAsks``)."""

    facts: Any
    opt_out: str | None
    template: str
    contributing: Any


@dataclass(frozen=True)
class ForkPullRequest:
    """The run's pull request on the fork as the host reads it now: its title and body, and whether it is open."""

    title: str
    body: str
    open: bool


#: The run's upstream pull request's states on its record: found open from the run's branch (the person opened it);
#: offered as a one-click link the person opens on GitHub (``link``); refused by a safety check (no link).
UPSTREAM_OPENED: Final = 'opened'
UPSTREAM_LINK: Final = 'link'
UPSTREAM_REFUSED: Final = 'refused'


@dataclass(frozen=True)
class UpstreamRecord:
    """The run's upstream pull request as its record keeps it (``UpstreamLedger``): ``opened``, ``link``, ``refused``
    or ``unknown``, the upstream, its number and address once opened, the login it was opened as, and why not; and the
    one-click link to GitHub's compare page that opens it (``compare_url``, with its prefilled ``title``; when the link's
    body had to be shortened, the full text, ``description``, for "Copy the description")."""

    state: str
    upstream: str
    number: int | None = None
    url: str | None = None
    login: str | None = None
    reason: str | None = None
    compare_url: str | None = None
    title: str | None = None
    description: str | None = None

    def view(self) -> dict[str, object]:
        return {'state': self.state, 'upstream': self.upstream, 'number': self.number, 'url': self.url,
                'as': self.login, 'reason': self.reason, 'compare_url': self.compare_url, 'title': self.title,
                'description': self.description}


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
    #: Whether the run's pull request opens as a draft (7.50.00: META's ``pull_request``, the flow's ``pr``: ``ready``
    #: by default, so a person can approve it without a "Ready for review" click; ``draft`` only when the flow says
    #: so). Read at the open only: an update never changes it either way.
    draft_pr: bool = False


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
#: (7.71.03) It names the pattern that works and why: a run's branch is one level under ``voc-agent/``
#: (``outputs.run_branch``), the only level a GitHub ruleset's ``refs/heads/voc-agent/*`` matches.
CI_AGENT_BRANCH_PROTECTED: Final = ("The agent's branch is protected by the repository's rules, so it would get what "
                                    'protected branches get (their CI secrets and cloud trust): leave voc-agent/* '
                                    'branches unprotected (on GitHub, exclude refs/heads/voc-agent/* from every ruleset '
                                    'and branch protection rule that covers them; on GitLab, protect no branch name '
                                    "that matches them). A run's branch is one level under it, voc-agent/<run id>-fix, "
                                    "the only level GitHub's voc-agent/* matches: its * stops at a /.")


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

    def issue_comment(self, connection_id: str, number: int, marker: str) -> str | None:
        """The URL of issue ``number``'s comment that is the run's own (7.71.03, ``broker.issue_marker``): since
        7.71.04 one the connection itself wrote (its GitHub App's own bot, 7.104.00; its GitLab token's user's, never
        a system note) whose body ends with ``marker``, among the newest comments, as far as ``transport.FIND_PAGES``
        pages of them reach; None for none. A read: whether an issue comment whose outcome was unknown was made after
        all."""
        ...

    def label_issue(self, connection_id: str, number: int, labels: tuple[str, ...]) -> tuple[str, ...]:
        """Add ``labels`` to issue ``number`` (7.50.00, the understander's triage labels; the broker checks the
        allowlist first): the labels added, as asked. Adds only: nothing is removed or renamed."""
        ...

    def branch_tree_hash(self, connection_id: str, branch: str) -> str | None: ...

    def push_bundle(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str,
                    default_branch: str) -> None: ...

    def open_or_update_draft_pr(self, connection_id: str, branch: str, base: str, title: str, body: str,
                                tree_hash: str, *, draft: bool = True) -> PullRequestRef:
        """Open the run's pull request from ``branch`` (``draft``: as a draft, else ready for review), or update an
        open one's title and body only: an update never marks one ready nor turns one back into a draft."""
        ...

    def tree_with(self, connection_id: str, base: str, changes: tuple[FileChange, ...]) -> str:
        """The tree id commit ``base``'s tree becomes with ``changes`` (7.52.00, the approved docs' write: the tree its
        push is held to), worked out without moving any branch."""
        ...

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

    def person_go_by(self, run_id: str) -> str:
        """The subject of the person who gave the run its go ('' for none): a fine-grained connection's push waits for
        its token owner's own (7.60.00)."""
        ...


class Dial(Protocol):
    def mode(self, person: str) -> str:
        """The way of working (``shared/ai_mode.py`` MODES) of ``person``; Human-driven for no person."""
        ...


class WriteLedger(Protocol):
    """Each write once per key (the caller's run, agent and attempt and the operation), so a repeat of a write whose
    outcome its caller never learnt answers the first outcome and is never made twice."""

    def claim(self, run_id: str, key: str, operation: str, stale_after: int | None = None) -> WriteClaim | None:
        """None: claimed now (create-only, or again after a refusal); else the earlier claim as it stands.
        ``stale_after`` (7.71.03, a write on the run's issue): a claim whose outcome is unknown, or that is still
        claimed, taken that many seconds ago or more is claimed again too (its broker call ended, or crashed, long
        ago), in one conditional write, so two callers never both take it."""
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


class DocsReader(Protocol):
    """What an administrator approved (7.52.00): the docs of a kind rendered again from the stored records, and the
    accepted tenets an agent reads."""

    def approved(self, connection_id: str, kind: str) -> Any:
        """``knowledge/docs.py`` ``Approved`` (its recorded rendering and the files it renders to now), None when
        nothing is approved yet; ``Unavailable`` when the records cannot be read."""
        ...

    def accepted_tenets(self, connection_id: str) -> dict[str, object] | None:
        """The accepted tenets version ``{version, summary, tenets}``, None when none is accepted."""
        ...


class UpstreamHost(Protocol):
    """A connection's kind and, for a fork, its upstream (7.57.00, ``github_upstream.py``): reads only, with the fork's
    installation token (the upstream is public)."""

    def kind(self, connection_id: str) -> str:
        """The connection's kind (``REPOSITORY_KIND``, ``PUBLIC_READ`` or ``FORK``), from its credential."""
        ...

    def fork(self, connection_id: str) -> ForkFacts | None:
        """A fork connection's upstream (``ForkFacts``), None for any other kind."""
        ...

    def facts(self, connection_id: str) -> UpstreamFacts:
        """The fork's upstream as GitHub answers it now: its facts, opt-out marker, template and CONTRIBUTING."""
        ...

    def existing(self, connection_id: str, branch: str) -> PullRequestRef | None:
        """The open upstream pull request from the fork's ``branch``, None for none."""
        ...

    def fork_pull_request(self, connection_id: str, number: int) -> ForkPullRequest:
        """The fork's pull request ``number`` (the run's): its title, body and whether it is open."""
        ...


class UpstreamLedger(Protocol):
    """The run's upstream pull request's record (7.57.00, ``upstream_records.UpstreamRecords``)."""

    def recorded(self, run_id: str) -> UpstreamRecord | None:
        """The run's upstream pull request record, None for none."""
        ...

    def record(self, run_id: str, record: UpstreamRecord) -> None:
        """Keep ``record`` as the run's (an opened one is never replaced by a later refusal)."""
        ...


class WriteTokenReader(Protocol):
    """A fine-grained connection's write token (7.60.00, ``credentials.WriteTokens``): the broker's alone."""

    def token(self, connection_id: str) -> Any:
        """``fine_grained.WriteToken`` (its repository, login, expiry, owner and the token), ``NoConnection`` when it
        is not stored or not one this reader takes."""
        ...


class TokenWrites(Protocol):
    """The two writes a fine-grained connection's token makes (7.60.00, ``github.GitHubHost``): the run's push and its
    pull request, each request with the token pinned to the repository's Git Data and pull request paths
    (``fine_grained.token_request_allowed``); every read with the App's read-only token."""

    def push_bundle_as(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str,
                       default_branch: str, write_token: str) -> None: ...

    def open_or_update_pr_as(self, connection_id: str, branch: str, base: str, title: str, body: str, tree_hash: str,
                             write_token: str, *, draft: bool = True) -> PullRequestRef: ...


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

    def person_go_by(self, run_id: str) -> str:  # noqa: ARG002 - the protocol's signature
        raise NoConnection(NO_CONNECTION)

    def mode(self, person: str) -> str:  # noqa: ARG002 - the protocol's signature
        raise NoConnection(NO_CONNECTION)

    def claim(self, run_id: str, key: str, operation: str, stale_after: int | None = None) -> WriteClaim | None:
        del run_id, key, operation, stale_after   # (the protocol's signature)
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
    #: The approved docs and their writes' claims (7.52.00; None where the deployment names no store for them: the
    #: docs write and the tenets read are refused, ``NoConnection``).
    docs: DocsReader | None = None
    docs_writes: WriteLedger | None = None
    #: A connection's kind and a fork's upstream, and the upstream pull requests' records (7.57.00; None where the
    #: deployment names none: every connection is a ``repository``, and a fork's upstream pull request is refused,
    #: ``NoConnection``).
    upstream: UpstreamHost | None = None
    upstream_ledger: UpstreamLedger | None = None
    #: (7.60.00) A fine-grained connection's write token and the writes made with it (None where the deployment names
    #: no token path: every push and pull request on such a connection is refused, ``NoConnection``).
    write_tokens: WriteTokenReader | None = None
    token_writes: TokenWrites | None = None
