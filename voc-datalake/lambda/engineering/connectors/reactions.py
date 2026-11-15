"""People's reactions on the host to a run's pull request (7.10.00; docs/autonomous-engineering.md, "Getting better":
people's reactions). Host-neutral and pure: the read's model, its bounds, the trust filter, the redaction, the revert
and the edits after the merge, which both clients (``github_reactions.py``, ``gitlab_reactions.py``) hold their
answers to.

What a read answers (``PullRequestReactions``, the broker's ``reactions`` operation, ``voc-reactions/1``):

- the pull request's state: ``open``, ``closed`` or ``merged``, and when it merged;
- its reviews (approved, changes requested or commented, with the reviewer's handle and time), their review comments
  and the general comments on it, newest first, at most ``MAX_ITEMS`` in all, each body cut to ``MAX_BODY``;
- whether it was merged and later reverted: a commit on the default branch after the merge whose message names
  "Revert" and the merge's commit id, among at most ``MAX_COMMITS_AFTER`` commits after the merge;
- people's commits after the merge (``EditsAfterMerge.people_commits``): the commits on the default branch that touched
  the pull request's files within ``EDIT_WINDOW_DAYS`` days of the merge, leaving out the merge itself, bots' commits
  (the App's or the project token's own user included) and an agent's (one that names an agent branch,
  ``voc-agent/…``: a later run's pull request merged since), as a count and the files (at most ``MAX_LISTED_FILES``),
  never a diff.

**Trust.** On a public repository anyone can comment, and these texts become evidence a model reads (the coach). So a
reaction is kept only when its author has write access and is not a bot (the App's or the project token's own user
included). GitHub: ``author_association`` OWNER, MEMBER or COLLABORATOR is only the first cut (MEMBER is any member of
the organisation, COLLABORATOR any collaborator, read and triage included); each such author's permission on the
repository is then read (GitHub's "Get repository permissions for a user", ``writer_permission``),
at most ``MAX_AUTHORS`` a read, and a lookup that fails drops the author. GitLab: a project member at Developer
(access level 30) or above. Every kept body has its credential-shaped strings replaced (the gate's ``redact``, as the
coach's evidence does), then email addresses, phone numbers and payment card numbers
(``shared.memory_policy.redact_personal_data``, as agent memory does); names and handles written in the text are not
replaced. What was dropped is counted, never kept.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Final, Literal
from urllib.parse import urlencode

from engineering.quality_gate.text import redact
from engineering.runtime.outputs import AGENT_BRANCH_PREFIX
from shared.memory_policy import redact_personal_data

SCHEMA: Final = 'voc-reactions/1'
#: The reactions one read keeps, newest first (reviews, review comments and comments together).
MAX_ITEMS: Final = 50
#: Each kept body, at most (cut, and marked so).
MAX_BODY: Final = 2_000
#: One page of each list a read asks the host for (reviews, review comments, comments, notes, files, commits).
PAGE_SIZE: Final = 100
#: The commits after the merge a revert is looked for in, at most (one page).
MAX_COMMITS_AFTER: Final = 100
#: How long after the merge a commit touching the pull request's files counts as an edit after the merge.
EDIT_WINDOW_DAYS: Final = 14
#: The pull request's files whose history after the merge is read (one request each), and the files a read lists.
MAX_EDIT_PATHS: Final = 20
MAX_LISTED_FILES: Final = 20
#: A handle as the read keeps it.
MAX_HANDLE: Final = 100
#: GitHub's author associations that may have write access to the repository (the first cut: each such author's
#: permission is read before a reaction is kept).
GITHUB_WRITERS: Final = frozenset({'OWNER', 'MEMBER', 'COLLABORATOR'})
#: GitHub's answer to "Get repository permissions for a user" (REST, collaborators): ``permission`` is one of
#: ``admin``, ``write``, ``read`` or ``none`` (a maintain role answers ``write``, triage ``read``). Kept: these, and
#: only by ``permission``: ``role_name`` is never read, since a custom role may be named anything.
GITHUB_WRITE_PERMISSIONS: Final = frozenset({'admin', 'write'})
#: The distinct authors whose write access one read looks up, at most (any other is dropped as unchecked).
MAX_AUTHORS: Final = 20
#: GitLab's access level from which a member may write (Developer).
GITLAB_WRITER_LEVEL: Final = 30

ItemKind = Literal['review', 'review_comment', 'comment']
PullRequestState = Literal['open', 'closed', 'merged']
ITEM_KINDS: Final[frozenset[str]] = frozenset({'review', 'review_comment', 'comment'})
REVIEW_STATES: Final[frozenset[str]] = frozenset({'approved', 'changes_requested', 'commented'})
STATES: Final[frozenset[str]] = frozenset({'open', 'closed', 'merged'})
_CUT: Final = ' [cut]'
_HANDLE: Final = re.compile(rf'[\w.\[\]-]{{1,{MAX_HANDLE}}}', re.ASCII)
_REVERT: Final = re.compile(r'\brevert', re.IGNORECASE)


def writer_permission(answer: object) -> bool:
    """GitHub's permission answer for a user says they may write: its ``permission`` is in
    ``GITHUB_WRITE_PERMISSIONS`` (``role_name`` is not read)."""
    return isinstance(answer, dict) and answer.get('permission') in GITHUB_WRITE_PERMISSIONS


def verified(candidates: Sequence[Candidate], writes: Callable[[str], bool]) -> list[Candidate]:
    """``candidates`` with each first-cut writer's access checked (``writes``, by handle): at most ``MAX_AUTHORS``
    distinct authors, looked up newest first across every kind of reaction, so past the bound the oldest authors are
    the ones left unchecked, and so not writers."""
    checked: dict[str, bool] = {}
    for candidate in sorted(candidates, key=lambda found: found.at, reverse=True):
        author = candidate.author
        if candidate.writer and not candidate.bot and author and author not in checked and len(checked) < MAX_AUTHORS:
            checked[author] = writes(author)
    return [replace(candidate, writer=candidate.writer and checked.get(candidate.author, False))
            for candidate in candidates]


def agent_change(message: str) -> bool:
    """A commit message that names an agent branch (``voc-agent/…``: a later run's pull request merged since)."""
    return AGENT_BRANCH_PREFIX in message


def people_commits(commits: Iterable[tuple[object, bool, object]]) -> list[str]:
    """The ids of ``commits`` (``(id, by a bot, message)``, as a host's history page answers them) that people made:
    no bot's, none naming an agent branch."""
    return [sha for sha, bot, message in commits
            if isinstance(sha, str) and not bot and not agent_change(message if isinstance(message, str) else '')]


def page_query(per_page: int = PAGE_SIZE, **fields: object) -> str:
    """A read's query: ``fields`` and one page of ``per_page``."""
    return urlencode({**fields, 'per_page': per_page})


def clean_body(text: object) -> str:
    """A kept body: its credential-shaped strings, then its personal data, replaced, NUL and control characters but
    line breaks and tabs dropped, cut to ``MAX_BODY`` (marked)."""
    raw = text if isinstance(text, str) else ''
    clean = redact_personal_data(redact(raw))
    clean = ''.join(c for c in clean if c in '\n\t' or c.isprintable())
    return clean if len(clean) <= MAX_BODY else clean[:MAX_BODY - len(_CUT)] + _CUT


def handle(value: object) -> str:
    """A host user's handle as the read keeps it ('' when it is not one)."""
    return value if isinstance(value, str) and _HANDLE.fullmatch(value) else ''


def moment(value: object) -> datetime | None:
    """An ISO 8601 time as a host answers it (``Z`` or an offset), in UTC; None when it is not one."""
    if not isinstance(value, str) or not 10 <= len(value) <= 40:
        return None
    try:
        found = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return found.astimezone(UTC) if found.tzinfo is not None else None


def iso(value: object) -> str:
    """``value`` as ``YYYY-MM-DDTHH:MM:SSZ``, '' when it is not a time."""
    found = moment(value)
    return '' if found is None else found.strftime('%Y-%m-%dT%H:%M:%SZ')


def window_end(merged_at: str) -> str:
    """The end of the edits' window: ``EDIT_WINDOW_DAYS`` after ``merged_at``."""
    found = moment(merged_at)
    return '' if found is None else (found + timedelta(days=EDIT_WINDOW_DAYS)).strftime('%Y-%m-%dT%H:%M:%SZ')


@dataclass(frozen=True)
class Candidate:
    """A reaction as the host answered it, before the trust filter: ``writer`` whether its author has write access,
    ``bot`` whether it is a bot (or the connection's own user)."""

    kind: ItemKind
    state: str
    author: str
    at: str
    body: str
    writer: bool
    bot: bool


@dataclass(frozen=True)
class ReactionItem:
    """A kept reaction: its kind, a review's state ('' for a comment), its author's handle, when, its body (redacted
    and cut)."""

    kind: ItemKind
    state: str
    author: str
    at: str
    body: str

    def view(self) -> dict[str, str]:
        return {'kind': self.kind, 'state': self.state, 'author': self.author, 'at': self.at, 'body': self.body}


@dataclass(frozen=True)
class Dropped:
    """What the trust filter left out, counted: authors without write access, and bots (the connection's own user
    among them)."""

    outsiders: int = 0
    bots: int = 0


def kept(candidates: Iterable[Candidate]) -> tuple[tuple[ReactionItem, ...], Dropped]:
    """The reactions the trust filter keeps (by a writer who is not a bot, with an author and a time), newest first,
    at most ``MAX_ITEMS``, each body cleaned (``clean_body``); and what it dropped."""
    items: list[ReactionItem] = []
    outsiders = bots = 0
    for found in candidates:
        if found.bot:
            bots += 1
        elif not found.writer or not found.author or not found.at:
            outsiders += 1
        else:
            items.append(ReactionItem(kind=found.kind, state=found.state, author=found.author, at=found.at,
                                      body=clean_body(found.body)))
    items.sort(key=lambda item: (item.at, item.kind), reverse=True)
    return tuple(items[:MAX_ITEMS]), Dropped(outsiders=outsiders, bots=bots)


def revert_of(commits: Iterable[tuple[str, str]], merge_commit: str) -> str:
    """The first of ``commits`` (``(id, message)``, the default branch's after the merge) that reverts the merge: its
    message names "Revert" and the merge's full commit id; '' for none (or no merge commit)."""
    wanted = merge_commit.lower()
    if not wanted:
        return ''
    for sha, message in commits:
        if sha.lower() != wanted and _REVERT.search(message) and wanted in message.lower():
            return sha
    return ''


@dataclass(frozen=True)
class EditsAfterMerge:
    """People's commits that touched the pull request's files within the window after its merge (``people_commits``,
    distinct; the merge itself, bots' and agents' commits left out by the host's reader), the files they touched (at
    most ``MAX_LISTED_FILES``), and how many of the pull request's files were read (``paths_read`` of
    ``paths_total``)."""

    people_commits: int = 0
    files: tuple[str, ...] = ()
    paths_read: int = 0
    paths_total: int = 0

    def view(self) -> dict[str, Any]:
        return {'people_commits': self.people_commits, 'files': list(self.files), 'paths_read': self.paths_read,
                'paths_total': self.paths_total}


def edits_after(per_path: Mapping[str, Sequence[str]], merge_commit: str, paths_total: int) -> EditsAfterMerge:
    """The edits after the merge from each read path's people's commit ids in the window (``per_path``)."""
    merge = merge_commit.lower()
    commits = {sha.lower() for shas in per_path.values() for sha in shas if sha.lower() != merge}
    files = sorted(path for path, shas in per_path.items() if any(sha.lower() != merge for sha in shas))
    return EditsAfterMerge(people_commits=len(commits), files=tuple(files[:MAX_LISTED_FILES]),
                           paths_read=len(per_path), paths_total=paths_total)


def after_merge(found: PullRequestReactions, merged_at: str, merge_commit: str, commits: Sequence[tuple[str, str]],
                paths: Sequence[str], touched: Callable[[str], Sequence[str]], more: bool) -> PullRequestReactions:
    """``found`` once merged at ``merged_at`` as ``merge_commit``: the revert among the default branch's ``commits``
    after it (``(id, message)``), and the edits after it to the pull request's ``paths``, the people's commit ids
    ``touched`` reads for each of the first ``MAX_EDIT_PATHS`` (sorted); ``more`` when a list had another page."""
    per_path = {path: list(touched(path)) for path in sorted(paths)[:MAX_EDIT_PATHS]}
    return replace(found, state='merged', merged_at=merged_at, merge_commit=merge_commit,
                   revert_commit=revert_of(commits, merge_commit), edits=edits_after(per_path, merge_commit, len(paths)),
                   more=found.more or more or len(paths) > MAX_EDIT_PATHS)


@dataclass(frozen=True)
class PullRequestReactions:
    """One read of the reactions to the run's pull request (``voc-reactions/1``)."""

    host: str
    number: int
    url: str
    state: PullRequestState
    merged_at: str = ''
    merge_commit: str = ''
    items: tuple[ReactionItem, ...] = ()
    dropped: Dropped = field(default_factory=Dropped)
    revert_commit: str = ''
    edits: EditsAfterMerge = field(default_factory=EditsAfterMerge)
    #: Some list had more than the read's one page (older reactions or commits were not read).
    more: bool = False

    def view(self) -> dict[str, Any]:
        """The broker's answer: the record's link, the state, the kept reactions, what was dropped, the revert and the
        edits after the merge."""
        return {
            'schema': SCHEMA,
            'pull_request': {'host': self.host, 'number': self.number, 'url': self.url},
            'state': self.state, 'merged_at': self.merged_at, 'merge_commit': self.merge_commit,
            'items': [item.view() for item in self.items],
            'dropped': {'outsiders': self.dropped.outsiders, 'bots': self.dropped.bots},
            'reverted': bool(self.revert_commit), 'revert_commit': self.revert_commit,
            'edits_after_merge': self.edits.view(), 'more': self.more,
        }
