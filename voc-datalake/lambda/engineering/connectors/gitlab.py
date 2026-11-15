"""The GitLab client of the connector's broker (docs/autonomous-engineering.md, "Repository connectors": GitLab).

Credentials: the connection's GitLab project access token (``credentials.GitLabTokenCredential``), for exactly one
project, role Developer, scopes ``api``, ``read_repository`` and ``write_repository``, checked against the project
when an administrator saved it (``gitlab_api.check_token``). A project token is long-lived (it expires on its own
date, at most a year out): it is used as it is, never minted or revoked here, and travels only in the
``Authorization`` header (``gitlab_api.send``). Every request goes to ``gitlab.com`` through one ``Transport``.

Reads (``RepositoryHost``): a file and history on the run's default branch (``ref``, ``ref_name``), an issue or a
merge request with its notes (a merge request's diff notes as its review comments, its approvals as its reviews), a
patch's base file at the run's commit, and, for the CI attestation's check (``ci_protection``), the project's
protected branches, its "pipelines must succeed" setting and, where the API shows it to the token, its push rule.
Pages are bounded (``X-Next-Page``; the cursor is that page number, nothing else), and a read lost on the way or
answered 502, 503 or 504 is sent again once; a write never is.

GitLab's API answers no commit's tree id, which the board's GO names, so the client works it out from the tree
listings the way git does (``gitlab_tree``): a branch's tree from its head's root listing, a push's tree from the base
commit's listings of the directories it changes.

Writes, and how each holds the broker's ``tree_hash``:

* a note on an issue or a merge request;
* a push of a bundle (``BundleContents``), through the Commits API's actions (create, update, delete, chmod; base64
  content): refused before anything is written when a commit changes a path outside the bundle's ``changed_paths``, a
  symbolic link (the actions cannot write one), or a CI definition the project names (its CI file and every file it
  ``include``s from the project, ``ci_definitions``); when the branch's head is not the bundle's ``base`` (or, for a
  new branch, ``base`` is not on the default branch); and when the tree the changes give on ``base`` is not
  ``tree_hash``. A new branch is created by its first commit (``start_sha``: refused when the branch was created
  meanwhile). GitLab's Commits API has no lease on an existing branch's head, so after the write each new commit's
  parent and the last one's tree are read back: a commit that landed on another head, or with another tree, is an
  unknown outcome (``OutcomeUnknown``), and a branch this push created is deleted again;
* a draft merge request (its title ``Draft: …``), opened, or its title and description updated, only when the
  branch's head has ``tree_hash``, and checked again afterwards: when its head does not have it, or the check fails,
  one the client just opened is closed and the outcome is unknown, never refused, since the host already wrote.

Since 7.10.00 it also reads people's reactions to the run's merge request (``reactions``, ``gitlab_reactions.py``):
its notes, the commits on the default branch after its merge and its files' names, and a note author's access level
(the members API, read only).

The client has no method for a merge, an approval, settings, protected branches, a change of members, webhooks or
variables.
"""
from __future__ import annotations

import base64
import json
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Final
from urllib.parse import quote, urlencode

from engineering.connectors import gitlab_reactions
from engineering.connectors.credentials import GitLabTokenCredential
from engineering.connectors.gitlab_api import GITLAB_URL, READ_TRIES, gitlab_transport, next_page, project_ref, send
from engineering.connectors.gitlab_api import REQUEST_SECONDS as GITLAB_REQUEST_SECONDS
from engineering.connectors.gitlab_ci import CI_UNRESOLVED, pinned
from engineering.connectors.gitlab_tree import TreeEntry, algorithm_of, directories, rebuilt, tree_id
from engineering.connectors.hosts import (
    FILE_MODES,
    OBJECT_ID,
    STORED_BRANCH_MISSING,
    WRITE_READY_BY,
    WRITE_RESERVE_SECONDS,
    BranchCaches,
    BundleContents,
    CiProtection,
    CommentTarget,
    Commit,
    Conflict,
    FileChange,
    InvalidTarget,
    NoConnection,
    NotFound,
    OutcomeUnknown,
    PullRequestRef,
    ReadKind,
    ReadPage,
    StoredBranchMissing,
    checked_after_write,
    file_page,
    fresh,
    keep,
    read_page,
    repository_path,
    require_base,
    require_pushable,
    stray_changes,
)
from engineering.connectors.reactions import PullRequestReactions
from engineering.connectors.transport import (
    Response,
    Transport,
    dig,
    int_of,
    items_of,
    json_of,
    text_of,
    text_or_empty,
    text_unless_missing,
)
from engineering.connectors.write_policy import BrokerError, WriteRefused, check_ci_definitions
from shared.logging import logger

PAGE_SIZE: Final = 30
#: How long a project member's access level, and the connection's own token's user, are kept (the reactions read's
#: trust filter, ``gitlab_reactions.py``).
MEMBER_SECONDS: Final = 600
#: How long a connection's default branch (the host's, or the stored one the host confirmed) is kept.
DEFAULT_BRANCH_SECONDS: Final = 300
#: How long branch rules that passed the CI check are kept before they are read again.
CI_CHECK_SECONDS: Final = 300
#: The most entries each cache keeps (the oldest goes first).
MAX_CACHED: Final = 256
#: A tree listing's page, and the most pages of one directory read (a directory with more is refused for a push).
TREE_PAGE: Final = 100
MAX_TREE_PAGES: Final = 20
#: The most directories one push's tree is worked out from (each changed path's directory and its parents).
MAX_TREE_DIRECTORIES: Final = 200
#: The protected branches' page, and the most pages read (a project with more rules is refused: its rules unread).
PROTECTED_PAGE: Final = 100
MAX_PROTECTED_PAGES: Final = 5
#: The access levels that keep a push or a merge to the default branch from a Developer: no one (0), Maintainers
#: (40), administrators (60).
_RESTRICTED_LEVELS: Final = frozenset({0, 40, 60})
#: The check the default branch requires, as a write's claim records it: GitLab's "Pipelines must succeed".
PIPELINE_CHECK: Final = 'pipelines must succeed'
DRAFT_PREFIX: Final = 'Draft: '
#: One page of the open merge requests from the agent's branch (forks' of the same name filtered out after).
MERGE_REQUEST_PAGE: Final = 20
MAX_MERGE_REQUEST_PAGES: Final = 5
SYMLINK: Final = '120000'

GITLAB_FORCE_PUSH: Final = ("The repository's default branch allows a force push: turn Allowed to force push off on "
                            'its protected branch before the agents push.')
GITLAB_PUSH_OPEN: Final = ("Developers may push to the repository's default branch: allow push (and merge) for "
                           'Maintainers only, or no one, on its protected branch before the agents push.')
GITLAB_MERGE_OPEN: Final = ("Developers may merge into the repository's default branch: allow merge for Maintainers "
                            'only on its protected branch before the agents push.')
GITLAB_NO_PIPELINE: Final = ("The project lets a merge request merge without a passing pipeline: turn on Pipelines "
                             'must succeed (the repository\'s own checks) before the agents push.')
GITLAB_SKIPPED_PIPELINE: Final = ("The project lets a merge request merge when its pipeline was skipped: turn off "
                                  'Skipped pipelines are considered successful before the agents push.')
GITLAB_PUSH_RULE: Final = ("The project's push rule for branch names refuses the agent's branch: let it take "
                           'voc-agent/ branches before the agents push.')
GITLAB_RULES_UNREAD: Final = ("The connection's token cannot read the project's protected branches, so the broker "
                              'cannot check them: the agents push nothing until it can.')
GITLAB_TOO_MANY_RULES: Final = ('The project has more protected branch rules than the broker reads: it pushes '
                                'nothing until there are fewer.')

_NOTE_FIELDS: Final[Mapping[str, tuple[str, ...]]] = {
    'id': ('id',), 'author': ('author', 'username'), 'created_at': ('created_at',), 'body': ('body',)}
_DIFF_NOTE_FIELDS: Final[Mapping[str, tuple[str, ...]]] = {
    **_NOTE_FIELDS, 'path': ('position', 'new_path'), 'line': ('position', 'new_line')}
_THREADS: Final[Mapping[str, str]] = {'issue': 'issues', 'pull_request': 'merge_requests'}


def _quoted(path: str) -> str:
    """A repository path or a branch as one path segment of the API (every ``/`` encoded)."""
    return quote(path, safe='')


def wildcard_match(rule: str, branch: str) -> bool:
    """Whether a protected branch rule's name (``*`` matching any run of characters, ``/`` included) covers
    ``branch``."""
    return re.fullmatch('.*'.join(re.escape(part) for part in rule.split('*')), branch) is not None


def _restricted(levels: object) -> bool:
    """A rule's push or merge access keeps a Developer out: only role levels no lower than Maintainer (or none), and
    no user, group or deploy key let in by name."""
    if not isinstance(levels, list) or not levels:
        return False
    return all(isinstance(level, dict) and dig(level, 'access_level') in _RESTRICTED_LEVELS
               and not any(dig(level, key) for key in ('user_id', 'group_id', 'deploy_key_id')) for level in levels)


def _rule_problems(rules: list[object]) -> list[str]:
    """What the protected branch rules that cover the default branch leave open (GitLab applies the most permissive
    of them, so each one is held to the setup guide)."""
    found: list[str] = []
    if any(dig(rule, 'allow_force_push') is not False for rule in rules):
        found.append(GITLAB_FORCE_PUSH)
    if not all(_restricted(dig(rule, 'push_access_levels')) for rule in rules):
        found.append(GITLAB_PUSH_OPEN)
    if not all(_restricted(dig(rule, 'merge_access_levels')) for rule in rules):
        found.append(GITLAB_MERGE_OPEN)
    return found


def _push_rule_refuses(rule: object, branch: str) -> bool:
    """Whether a push rule's branch name pattern (``branch_name_regex``, when the API shows it) refuses ``branch``; a
    pattern Python's ``re`` cannot read refuses it (failing closed)."""
    pattern = dig(rule, 'branch_name_regex')
    if not isinstance(pattern, str) or not pattern:
        return False
    try:
        return re.search(pattern, branch) is None
    except re.error:
        return True


def draft_title(title: str) -> str:
    """``title`` as a draft merge request's: ``Draft: `` in front, once."""
    return title if title.startswith(DRAFT_PREFIX) else f'{DRAFT_PREFIX}{title}'


def _stray_changes(contents: BundleContents) -> list[str]:
    """Why a bundle's commits cannot be pushed as checked: a change outside ``changed_paths``, a file mode the client
    does not write, or a symbolic link (the Commits API's actions write none)."""
    return stray_changes(
        contents, lambda c: c.mode in FILE_MODES and not (c.mode == SYMLINK and c.content is not None),
        "A pushed file must be a regular file or an executable: GitLab's commits write no symbolic link")


#: The most commits one push writes (each is one Commits API call after the first is on the host): more is refused
#: before anything is written.
MAX_COMMITS_PER_PUSH: Final = 20
# The time model of the work after the first commit, each step by its worst case. One request waits at most the
# transport's 10 s (``REQUEST_SECONDS``); a read is sent at most ``gitlab_api.READ_TRIES`` (2) times, so 20 s; a write
# is sent once, 10 s. The final read-back of the tree is one read per page, up to ``MAX_TREE_PAGES``: it is bounded
# by time, not by a count (no page starts that would end inside the stop's reserve; past it the read-back is cut
# short and the outcome unknown). Undoing a new branch is a read of its head and a delete: 20 + 10 = 30 s; answering
# the caller after it, 5 s. So:
#   DELETE_RESERVE_SECONDS = UNDO_SECONDS + ANSWER_SECONDS                     = 30 + 5  = 35
#   LATER_COMMIT_SECONDS   = WRITE_SECONDS + READ_SECONDS (a commit, then a page) = 10 + 20 = 30
#   hosts.WRITE_RESERVE_SECONDS >= WRITE_SECONDS + READ_SECONDS + DELETE_RESERVE_SECONDS = 10 + 20 + 35 = 65
#   (the first commit, a page of its read-back, and the stop: pinned by the tests).
# Every read before the write starts only if it, with its retry, ends before the line (``_PreWrite.spend``), and the
# first commit starts only if it, a page of its read-back and the stop's reserve fit, so the 65 s hold as written.
# These are assumptions, not guarantees: http.client's timeout is per socket operation (a slow trickle of bytes can
# outlast it) and the name lookup is not covered; closing the write's claim is a DynamoDB write under boto3's default
# timeouts and retries. Past them, Lambda's own timeout ends the call: the claim is left open, a repeat is answered
# unknown (``broker.EARLIER_UNKNOWN``), and the write is never made twice.
REQUEST_SECONDS: Final = GITLAB_REQUEST_SECONDS
READ_SECONDS: Final = REQUEST_SECONDS * READ_TRIES
WRITE_SECONDS: Final = REQUEST_SECONDS
UNDO_SECONDS: Final = READ_SECONDS + WRITE_SECONDS
ANSWER_SECONDS: Final = 5
#: What a stop still needs of the invocation's time: the undo of the branch it created and the answer.
DELETE_RESERVE_SECONDS: Final = UNDO_SECONDS + ANSWER_SECONDS
#: What a later commit needs before the stop's reserve: its own request and at least one page of the read-back.
LATER_COMMIT_SECONDS: Final = WRITE_SECONDS + READ_SECONDS
#: The most requests a push makes before it writes (its CI files, branch, listings): more is refused, nothing written.
MAX_PREWRITE_REQUESTS: Final = 400
PREWRITE_SPENT: Final = ('The push read more of the repository host than it may before writing (its requests or its '
                         'time ran out): nothing was pushed; push fewer changes at once, or try again.')


@dataclass
class _PreWrite:
    """A push's reads before its write: at most ``MAX_PREWRITE_REQUESTS``, none after ``ends_by`` (the invocation's
    ``hosts.WRITE_READY_BY``). Past either the push is refused (``WriteRefused``: nothing written, so the broker's
    claim is closed refused, never left open or unknown)."""

    ends_by: float
    used: int = 0

    def spend(self, now: float) -> None:
        """Count one request about to start: refused unless its worst case (a read and its retry, ``READ_SECONDS``)
        ends by ``ends_by``, so no read in flight runs past the line."""
        self.used += 1
        if self.used > MAX_PREWRITE_REQUESTS or now + READ_SECONDS > self.ends_by:
            raise WriteRefused(PREWRITE_SPENT)


@dataclass
class _Tree:
    """One commit's tree listings as a push reads them, each directory once: its entries by name."""

    read: Callable[[str], dict[str, TreeEntry]]
    seen: dict[str, dict[str, TreeEntry]]

    def __call__(self, directory: str) -> dict[str, TreeEntry]:
        if directory not in self.seen:
            if len(self.seen) >= MAX_TREE_DIRECTORIES:
                raise WriteRefused(f'The push changes files in more than {MAX_TREE_DIRECTORIES} directories: push '
                                   'fewer at once.')
            self.seen[directory] = self.read(directory)
        return self.seen[directory]


class GitLabHost:
    """``RepositoryHost`` over the GitLab REST API (gitlab.com), with each connection's project access token."""

    def __init__(self, credentials: Callable[[str], GitLabTokenCredential], transport: Transport | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self._credentials = credentials
        self._transport = transport or gitlab_transport()
        self._clock = clock
        #: By (connection, project, ...): the default branches, the stored ones confirmed, the rules passed.
        self._cached = BranchCaches()
        #: The reads a push makes before it writes, counted and timed while they run (``_PreWrite``).
        self._budget: _PreWrite | None = None
        #: By (connection, project[, user]): the token's own user's id, a member's access level; and when each is read
        #: again (``MEMBER_SECONDS``, at most ``MAX_CACHED`` each).
        self._own_users: dict[tuple[str, int], tuple[int, float]] = {}
        self._levels: dict[tuple[str, int, int], tuple[int, float]] = {}

    # --- HTTP -------------------------------------------------------------------------------------------------

    def _api(self, connection_id: str, method: str, path: str, what: str, *, body: object = None,
             ok: tuple[int, ...] = (200,)) -> Response:
        """``path`` (after ``/projects/<id>``) with the connection's token, on its one project."""
        credential = self._credentials(connection_id)
        if self._budget is not None:
            self._budget.spend(self._clock())
        return send(self._transport, self._clock, method, f'/projects/{project_ref(credential.project_id)}{path}',
                    credential.token, what, body=body, ok=ok)

    # --- reads ------------------------------------------------------------------------------------------------

    def repository(self, connection_id: str) -> str:
        """The project's path (``group[/subgroup]/project``) the connection's credential is for (no request)."""
        return self._credentials(connection_id).repository

    def fetch_token(self, connection_id: str) -> tuple[str, str]:
        """The project's path and the connection's token, for the checkout cache's fetch (``cache.py``), which hands
        it to git only through its environment. Nothing is minted, so nothing is revoked after."""
        credential = self._credentials(connection_id)
        return credential.repository, credential.token

    def read(self, connection_id: str, kind: ReadKind, target: str, cursor: str | None, branch: str = '') -> ReadPage:
        """A file or history on ``branch`` (the run's default branch, as the broker worked it out; '' for the
        project's own), an issue or a merge request with its notes."""
        return read_page(kind, target, cursor,
                         lambda: file_page(self._raw(connection_id, target, branch or 'HEAD', 'the file read')),
                         lambda page: self._read_history(connection_id, target, page, branch),
                         lambda number, page: self._read_thread(connection_id, kind, number, page))

    def _raw(self, connection_id: str, path: str, ref: str, what: str) -> bytes | None:
        response = self._api(connection_id, 'GET',
                             f'/repository/files/{_quoted(repository_path(path))}/raw?{urlencode({"ref": ref})}', what,
                             ok=(200, 404))
        return None if response.status == 404 else response.body

    def file_at(self, connection_id: str, commit: str, path: str) -> bytes | None:
        """The bytes of ``path`` at ``commit`` (a full object id), ``None`` when the commit has no such file."""
        if not OBJECT_ID.fullmatch(commit):
            raise InvalidTarget('The commit is a full object id.')
        return self._raw(connection_id, path, commit, 'the base file read')

    def _read_history(self, connection_id: str, target: str, page: str, branch: str) -> ReadPage:
        fields: dict[str, object] = {'per_page': PAGE_SIZE, 'page': page}
        if branch:
            fields['ref_name'] = branch
        if target != '.':
            fields['path'] = repository_path(target)
        response = self._api(connection_id, 'GET', f'/repository/commits?{urlencode(fields)}', 'the history read')
        commits = items_of(json_of(response), {'sha': ('id',), 'date': ('committed_date',), 'message': ('message',)})
        return ReadPage(content=json.dumps({'commits': commits}), next_cursor=next_page(response.headers))

    def _read_thread(self, connection_id: str, kind: ReadKind, number: str, page: str) -> ReadPage:
        """An issue or a merge request, with a page of its notes (a merge request's diff notes as review comments,
        and, on the first page, its approvals as reviews); the next cursor while the notes have another page."""
        what = 'the issue read' if kind == 'issue' else 'the merge request read'
        base = f'/{_THREADS[kind]}/{number}'
        content: dict[str, object] = {}
        if page == '1':
            item = self._api(connection_id, 'GET', base, what, ok=(200, 404))
            if item.status == 404:
                raise NotFound(f'The repository has no {kind.replace("_", " ")} {number}.')
            data = json_of(item)
            content[kind] = {'number': dig(data, 'iid'), 'title': dig(data, 'title'), 'state': dig(data, 'state'),
                             'body': dig(data, 'description'),
                             **({'draft': dig(data, 'draft')} if kind == 'pull_request' else {})}
        query = urlencode({'per_page': PAGE_SIZE, 'page': page, 'sort': 'asc', 'order_by': 'created_at'})
        response = self._api(connection_id, 'GET', f'{base}/notes?{query}', what)
        notes = [note for note in (json_of(response) or []) if isinstance(note, dict) and note.get('system') is not True]
        diff_notes = [note for note in notes if note.get('type') == 'DiffNote']
        content['comments'] = items_of([note for note in notes if note.get('type') != 'DiffNote'], _NOTE_FIELDS)
        if kind == 'pull_request':
            content['review_comments'] = items_of(diff_notes, _DIFF_NOTE_FIELDS)
            if page == '1':
                approvals = json_of(self._api(connection_id, 'GET', f'{base}/approvals', what))
                approved = dig(approvals, 'approved_by')
                content['reviews'] = [{'author': dig(entry, 'user', 'username'), 'state': 'approved'}
                                      for entry in (approved if isinstance(approved, list) else [])]
        return ReadPage(content=json.dumps(content), next_cursor=next_page(response.headers))

    def reactions(self, connection_id: str, number: int, url: str, branch: str) -> PullRequestReactions:
        """People's reactions to merge request ``number`` (7.10.00, ``gitlab_reactions.py``): reads only, with the
        connection's token, its authors' access levels read through the members API (cached ``MEMBER_SECONDS``)."""
        return gitlab_reactions.read(
            lambda path: self._api(connection_id, 'GET', path, 'the reactions read', ok=(200, 404)), url, number,
            branch, lambda: self._own_user(connection_id), lambda user: self._member_level(connection_id, user))

    def _own_user(self, connection_id: str) -> int:
        """The id of the connection's token's own user (``GET /user``), kept ``MEMBER_SECONDS``."""
        credential = self._credentials(connection_id)
        key, now = (connection_id, credential.project_id), self._clock()
        held = fresh(self._own_users, key, now)
        if held is not None:
            return held
        user = int_of(json_of(send(self._transport, self._clock, 'GET', '/user', credential.token,
                                   'the reactions read')), 'id')
        keep(self._own_users, key, (user, now + MEMBER_SECONDS), MAX_CACHED)
        return user

    def _member_level(self, connection_id: str, user: int) -> int:
        """``user``'s access level on the project, inherited ones included (``/members/all/<id>``; 0 for no member),
        kept ``MEMBER_SECONDS``."""
        credential = self._credentials(connection_id)
        key, now = (connection_id, credential.project_id, user), self._clock()
        held = fresh(self._levels, key, now)
        if held is not None:
            return held
        response = self._api(connection_id, 'GET', f'/members/all/{user}', 'the reactions read', ok=(200, 404))
        level = dig(json_of(response), 'access_level') if response.status == 200 else 0
        found = level if isinstance(level, int) and not isinstance(level, bool) else 0
        keep(self._levels, key, (found, now + MEMBER_SECONDS), MAX_CACHED)
        return found

    def default_branch(self, connection_id: str, stored: str = '') -> str:
        """``stored`` once the project has it (one branch lookup, kept ``DEFAULT_BRANCH_SECONDS``;
        ``StoredBranchMissing`` when it has none, never kept); for ``stored=''`` the project's own default branch."""
        project = self.repository(connection_id)
        now = self._clock()
        if stored:
            key = (connection_id, project, stored)
            if now < self._cached.confirmed_branches.get(key, 0.0):
                return stored
            if self._head(connection_id, stored) is None:
                raise StoredBranchMissing(STORED_BRANCH_MISSING)
            keep(self._cached.confirmed_branches, key, now + DEFAULT_BRANCH_SECONDS, MAX_CACHED)
            return stored
        held = fresh(self._cached.default_branches, (connection_id, project), now)
        if held is not None:
            return held
        branch = text_of(json_of(self._api(connection_id, 'GET', '', 'the project read')), 'default_branch')
        keep(self._cached.default_branches, (connection_id, project), (branch, now + DEFAULT_BRANCH_SECONDS),
             MAX_CACHED)
        return branch

    def _head(self, connection_id: str, branch: str) -> str | None:
        return text_unless_missing(self._api(connection_id, 'GET', f'/repository/branches/{_quoted(branch)}',
                                             'the branch lookup', ok=(200, 404)), 'commit', 'id')

    def _listing(self, connection_id: str, ref: str, directory: str,
                 pages_by: float | None = None) -> dict[str, TreeEntry]:
        """The entries of ``directory`` ('' for the root) at ``ref`` by name: empty for a directory it does not have.
        At most ``MAX_TREE_PAGES`` pages: a directory with more is refused. ``pages_by``: no page read starts unless
        its worst case (``READ_SECONDS``) ends by then; past it, the read is cut short (``Conflict``)."""
        entries: dict[str, TreeEntry] = {}
        page: str | None = '1'
        for _ in range(MAX_TREE_PAGES):
            if pages_by is not None and self._clock() + READ_SECONDS > pages_by:
                raise Conflict('The read-back of the pushed tree was cut short: the invocation had no time left for '
                               'its next page.')
            fields = {'ref': ref, 'per_page': TREE_PAGE, 'page': page, **({'path': directory} if directory else {})}
            response = self._api(connection_id, 'GET', f'/repository/tree?{urlencode(fields)}', 'the tree read',
                                 ok=(200, 404))
            if response.status == 404:
                return entries
            for item in json_of(response) or []:
                entry = TreeEntry(text_of(item, 'name'), text_of(item, 'mode'), text_of(item, 'id'))
                entries[entry.name] = entry
            page = next_page(response.headers)
            if page is None:
                return entries
        raise WriteRefused(f'A directory the push reads holds more than {MAX_TREE_PAGES * TREE_PAGE} entries: the '
                           'broker does not work out its tree.')

    def _tree_of(self, connection_id: str, commit: str, pages_by: float | None = None) -> str:
        """The tree id of ``commit``: its root listing's entries, hashed as git does (``pages_by``: ``_listing``'s)."""
        return tree_id(self._listing(connection_id, commit, '', pages_by).values(), algorithm_of(commit))

    def branch_tree_hash(self, connection_id: str, branch: str) -> str | None:
        head = self._head(connection_id, branch)
        return None if head is None else self._tree_of(connection_id, head)

    # --- the branch rules (the CI attestation's check) ------------------------------------------------------------

    def ci_protection(self, connection_id: str, default_branch: str, branch: str) -> CiProtection:
        """What the project's own rules say of ``default_branch`` and the agent's ``branch``: the protected branch
        rules that cover each (exact names and wildcards; at most ``MAX_PROTECTED_PAGES`` pages), whether the project
        requires a passing pipeline to merge, and, where the API shows it to the token, the push rule's branch name
        pattern. The default branch must be covered, with no force push and push and merge for Maintainers only; the
        agent's branch must be covered by none. A pass is kept ``CI_CHECK_SECONDS``; a failure is read again."""
        key = (connection_id, self.repository(connection_id), default_branch, branch)
        now = self._clock()
        held = fresh(self._cached.ci_checks, key, now)
        if held is not None:
            return held
        rules = self._protected_rules(connection_id)
        if isinstance(rules, str):
            return CiProtection(default_branch_protected=True, required_checks=(), agent_branch_protected=False,
                                checked_at=now, problems=(rules,))
        covering = [rule for rule in rules if wildcard_match(str(dig(rule, 'name')), default_branch)]
        problems = _rule_problems(covering) if covering else []
        project = json_of(self._api(connection_id, 'GET', '', 'the branch rules read'))
        pipeline = dig(project, 'only_allow_merge_if_pipeline_succeeds') is True
        if not pipeline:
            problems.append(GITLAB_NO_PIPELINE)
        if dig(project, 'allow_merge_on_skipped_pipeline') is not False:   # (on, or not said: failing closed)
            problems.append(GITLAB_SKIPPED_PIPELINE)
        push_rule = self._api(connection_id, 'GET', '/push_rule', 'the branch rules read', ok=(200, 403, 404))
        if push_rule.status == 200 and _push_rule_refuses(json_of(push_rule), branch):
            problems.append(GITLAB_PUSH_RULE)
        found = CiProtection(default_branch_protected=bool(covering),
                             required_checks=(PIPELINE_CHECK,) if pipeline else (),
                             agent_branch_protected=any(wildcard_match(str(dig(rule, 'name')), branch)
                                                        for rule in rules),
                             checked_at=now, problems=tuple(problems))
        if found.passes:
            keep(self._cached.ci_checks, key, (found, now + CI_CHECK_SECONDS), MAX_CACHED)
        return found

    def _protected_rules(self, connection_id: str) -> list[object] | str:
        """The project's protected branch rules, or why they cannot be checked (the token may not read them, 403; more
        than ``MAX_PROTECTED_PAGES`` pages of them): the refusal's words, failing closed."""
        rules: list[object] = []
        page: str | None = '1'
        for _ in range(MAX_PROTECTED_PAGES):
            response = self._api(connection_id, 'GET',
                                 f'/protected_branches?{urlencode({"per_page": PROTECTED_PAGE, "page": page})}',
                                 'the branch rules read', ok=(200, 403))
            if response.status == 403:
                return GITLAB_RULES_UNREAD
            data = json_of(response)
            rules += data if isinstance(data, list) else []
            page = next_page(response.headers)
            if page is None:
                return rules
        return GITLAB_TOO_MANY_RULES

    # --- writes -----------------------------------------------------------------------------------------------

    def post_comment(self, connection_id: str, on: CommentTarget, number: int, body: str) -> str:
        response = self._api(connection_id, 'POST', f'/{_THREADS[on]}/{number}/notes', 'the comment',
                             body={'body': body}, ok=(201,))
        note = int_of(json_of(response), 'id')
        kind = 'issues' if on == 'issue' else 'merge_requests'
        return f'{GITLAB_URL}{self.repository(connection_id)}/-/{kind}/{number}#note_{note}'

    def ci_definitions(self, connection_id: str, commit: str) -> tuple[str, ...]:
        """The project's CI definitions at ``commit``, pinned or refused (``gitlab_ci.pinned``): its CI file and every
        local file its includes reach, each file parsed and walked; GitLab's CI lint there a cross-check. A lint the
        host does not answer refuses the push (nothing written)."""
        project = json_of(self._api(connection_id, 'GET', '', 'the push'))

        def lint() -> object:
            response = self._api(connection_id, 'GET', f'/ci/lint?{urlencode({"content_ref": commit})}', 'the push',
                                 ok=(200, 400, 403, 404))
            if response.status != 200:
                raise WriteRefused(CI_UNRESOLVED)
            return json_of(response)

        return pinned(project if isinstance(project, dict) else {}, lint,
                      lambda path: self._raw(connection_id, path, commit, 'the push')).paths

    def _require_on_default_branch(self, connection_id: str, default_branch: str, base: str) -> None:
        query = urlencode([('refs[]', default_branch), ('refs[]', base)])
        response = self._api(connection_id, 'GET', f'/repository/merge_base?{query}', 'the push', ok=(200, 400, 404))
        if response.status != 200 or dig(json_of(response), 'id') != base:
            raise Conflict("A new branch starts on the default branch: the bundle's base is not its head or an "
                           'ancestor of it.')

    def _check_bundle(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str,
                      default_branch: str) -> tuple[str | None, _Tree]:
        """Every check before a push writes anything: the branch's head (``None``: a new branch) and the base's
        listings the push reads."""
        require_pushable(contents, tree_hash, _stray_changes(contents))
        if len(contents.commits) > MAX_COMMITS_PER_PUSH:
            raise WriteRefused(f'A push writes at most {MAX_COMMITS_PER_PUSH} commits: push fewer at once.')
        check_ci_definitions(contents.changed_paths, self.ci_definitions(connection_id, contents.base))
        head = self._head(connection_id, branch)
        require_base(head, contents)
        if head is None:
            self._require_on_default_branch(connection_id, default_branch, contents.base)
        listing = _Tree(lambda directory: self._listing(connection_id, contents.base, directory), {})
        final = {change.path: change for commit in contents.commits for change in commit.changes}
        for directory in sorted(directories(final)):
            listing(directory)
        if rebuilt(listing, final, algorithm_of(contents.base)) != tree_hash:
            raise Conflict("The bundle's changes on its base give another tree than the one the broker checked; "
                           'nothing was pushed.')
        return head, listing

    def push_bundle(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str,
                    default_branch: str) -> None:
        ends_by = WRITE_READY_BY.get()
        if ends_by is None:   # (the broker's handler always sets it from Lambda's context: never run uncapped by time)
            raise WriteRefused(PREWRITE_SPENT)
        self._budget = _PreWrite(ends_by=ends_by)
        try:
            head, listing = self._check_bundle(connection_id, branch, contents, tree_hash, default_branch)
            present = {f'{d}/{name}'.lstrip('/'): entry.mode for d, names in listing.seen.items()
                       for name, entry in names.items() if not entry.is_tree}
            leases = self._file_leases(connection_id, contents, present)
        finally:
            self._budget = None
        call_ends = ends_by + WRITE_RESERVE_SECONDS
        if self._clock() + LATER_COMMIT_SECONDS + DELETE_RESERVE_SECONDS > call_ends:
            # (the first commit, a page of its read-back and a stop must all fit: else nothing is written)
            raise WriteRefused(PREWRITE_SPENT)
        first = self._commit(connection_id, branch, contents.commits[0], present,
                             contents.base if head is None else None, leases)
        if first.status == 400:
            raise Conflict('The host refused the commit (the branch changed, or a file is not as the bundle has it); '
                           'nothing was pushed: fetch it and make the bundle again.')
        written: list[str] = []
        try:
            self._land(connection_id, branch, contents, tree_hash, present, first, written, call_ends)
        except Exception as exc:
            # (the first commit is on the host: whatever stops the rest, a rate limit, a lost read-back or the time
            # left included, the outcome is unknown, never a refusal with nothing written)
            undone = self._undo_new_branch(connection_id, branch, head is None, written, call_ends)
            why = exc.reason if isinstance(exc, BrokerError) else type(exc).__name__
            raise OutcomeUnknown(f'The push wrote its first commit, but what followed did not pass ({why}); '
                                 f'{len(written)} of its {len(contents.commits)} commit(s) landed as checked; {undone}; '
                                 'whether the branch stands as asked is not known.') from exc

    def _file_leases(self, connection_id: str, contents: BundleContents, present: dict[str, str]) -> dict[str, str]:
        """The first commit's partial lease: for each file it updates or deletes, its last commit at the base (GitLab's
        ``X-Gitlab-Last-Commit-Id``, one HEAD each), which the Commits API's ``last_commit_id`` holds the action to
        (a file changed meanwhile refuses the commit, 400: nothing written)."""
        leases: dict[str, str] = {}
        for change in contents.commits[0].changes:
            if change.path not in present:
                continue
            response = self._api(connection_id, 'HEAD', f'/repository/files/{_quoted(change.path)}?'
                                 f'{urlencode({"ref": contents.base})}', 'the push', ok=(200, 404))
            last = response.headers.get('x-gitlab-last-commit-id', '')
            if response.status == 200 and OBJECT_ID.fullmatch(last):
                leases[change.path] = last
        return leases

    def _commit(self, connection_id: str, branch: str, commit: Commit, present: dict[str, str],
                start: str | None, leases: Mapping[str, str] | None = None) -> Response:
        """One Commits API call for ``commit`` on ``branch`` (``start``: the new branch's first commit's base;
        ``leases``: its files' last commits, ``_file_leases``)."""
        body: dict[str, object] = {'branch': branch, 'commit_message': commit.message,
                                   'actions': _actions(commit.changes, present, leases or {})}
        if start is not None:
            body['start_sha'] = start
        return self._api(connection_id, 'POST', '/repository/commits', 'the push', body=body, ok=(201, 400))

    def _land(self, connection_id: str, branch: str, contents: BundleContents, tree_hash: str,
              present: dict[str, str], first: Response, written: list[str], ends_by: float) -> None:
        """The rest of a push once its first commit is written: each commit on the one before it (the parent read
        back: the Commits API has no lease), the later commits, and the last one's tree read back. ``written``: the
        ids of the commits this push made, as it makes them. No later commit starts unless it and a page of the
        read-back (``LATER_COMMIT_SECONDS``), and what a stop then needs to delete the branch and answer
        (``DELETE_RESERVE_SECONDS``), still fit before ``ends_by``, the invocation's end; and no page of the read-back
        starts that would end inside that reserve (the read-back is cut short instead)."""
        parent, made = contents.base, first
        for index, commit in enumerate(contents.commits):
            if index:
                if self._clock() + LATER_COMMIT_SECONDS + DELETE_RESERVE_SECONDS > ends_by:
                    raise Conflict('The invocation ran out of time before the next commit of the push.')
                made = self._commit(connection_id, branch, commit, present, None)
                if made.status == 400:
                    raise Conflict('The host refused a later commit of the push.')
            made_id = text_of(json_of(made), 'id')
            if dig(json_of(made), 'parent_ids') != [parent]:
                # (not this push's own line: a branch whose head it is, on someone's push, is never deleted)
                raise Conflict('A commit of the push landed on another head than the one checked (the branch moved '
                               'meanwhile).')
            written.append(made_id)
            parent = made_id
        if self._tree_of(connection_id, parent, ends_by - DELETE_RESERVE_SECONDS) != tree_hash:
            raise Conflict('The pushed commit has another tree than the one checked.')

    def _undo_new_branch(self, connection_id: str, branch: str, created: bool, ours: list[str],
                         ends_by: float) -> str:
        """Delete the branch this push created, its commits not as checked, but only while its head, read just before,
        is still one of this push's commits (``ours``): someone else's push since is never deleted. No undo starts
        unless its read and its delete (``UNDO_SECONDS``) and the answer fit before ``ends_by``. What became of the
        branch, in words."""
        if not created:
            return 'the branch, there before the push, was left as it is'
        if self._clock() + UNDO_SECONDS + ANSWER_SECONDS > ends_by:
            return 'the branch this push created was left: no time remained to delete it'
        try:
            head = self._head(connection_id, branch)
            if head is None:
                return 'the branch is not on the host'
            if head not in ours:
                return "the branch was not deleted: its head is no longer one of this push's commits"
            self._api(connection_id, 'DELETE', f'/repository/branches/{_quoted(branch)}', 'the branch removal',
                      ok=(204, 404))
        except (BrokerError, NoConnection, ValueError, OSError):
            logger.warning('engineering branch not removed', extra={'branch': branch})
            return 'the branch this push created could not be deleted'
        return 'the branch this push created was deleted'

    def _require_merge_request_tree(self, connection_id: str, number: int, tree_hash: str) -> None:
        response = self._api(connection_id, 'GET', f'/merge_requests/{number}', 'the merge request check')
        if self._tree_of(connection_id, text_of(json_of(response), 'sha')) != tree_hash:
            raise Conflict("The branch moved while the merge request was written: its head does not have the tree "
                           "the board's GO is for.")

    def _open_merge_request(self, connection_id: str, branch: str, base: str) -> PullRequestRef | None:
        """The open merge request from this project's ``branch`` into ``base`` (a fork's of the same branch name, or
        one into another branch, is not the run's), paging up to ``MAX_MERGE_REQUEST_PAGES``: past them it is
        refused, nothing written, rather than open a second one."""
        project_id = self._credentials(connection_id).project_id
        page: str | None = '1'
        for _ in range(MAX_MERGE_REQUEST_PAGES):
            query = urlencode({'state': 'opened', 'source_branch': branch, 'target_branch': base,
                               'per_page': MERGE_REQUEST_PAGE, 'page': page})
            response = self._api(connection_id, 'GET', f'/merge_requests?{query}', 'the merge request lookup')
            found = json_of(response)
            ours = [item for item in (found if isinstance(found, list) else [])
                    if dig(item, 'source_project_id') == project_id and dig(item, 'target_branch') == base]
            if ours:
                return _merge_request_ref(ours[0])
            page = next_page(response.headers)
            if page is None:
                return None
        raise WriteRefused('The open merge requests from the agent\'s branch are more than the broker reads: nothing '
                           'was opened.')

    def open_or_update_draft_pr(self, connection_id: str, branch: str, base: str, title: str, body: str,
                                tree_hash: str) -> PullRequestRef:
        if self.branch_tree_hash(connection_id, branch) != tree_hash:
            raise Conflict("The branch's head does not have the tree the board's GO is for.")
        ref = self._open_merge_request(connection_id, branch, base)
        opened = ref is None
        text = {'title': draft_title(title), 'description': body}
        if ref is not None:
            self._api(connection_id, 'PUT', f'/merge_requests/{ref.number}', 'the merge request update', body=text)
        else:
            created = json_of(self._api(connection_id, 'POST', '/merge_requests', 'the draft merge request',
                                        ok=(201,), body={**text, 'source_branch': branch, 'target_branch': base,
                                                         'remove_source_branch': False}))
            ref = _merge_request_ref(created)
        number = ref.number
        return checked_after_write(
            ref, opened, lambda: self._require_merge_request_tree(connection_id, number, tree_hash),
            lambda: self._close(connection_id, number), 'merge request')

    def _close(self, connection_id: str, number: int) -> None:
        try:
            self._api(connection_id, 'PUT', f'/merge_requests/{number}', 'the merge request close',
                      body={'state_event': 'close'})
        except (BrokerError, NoConnection, ValueError, OSError):
            logger.warning('engineering merge request not closed', extra={'pull_request': number})


def _merge_request_ref(found: object) -> PullRequestRef:
    """A merge request as GitLab answers it (its create, its lookup): the IID, the URL, its source and target
    branches."""
    return PullRequestRef(number=int_of(found, 'iid'), url=text_of(found, 'web_url'),
                          head=text_or_empty(found, 'source_branch'), base=text_or_empty(found, 'target_branch'),
                          host='gitlab')


def _actions(changes: tuple[FileChange, ...], present: dict[str, str],
             leases: Mapping[str, str]) -> list[dict[str, object]]:
    """The Commits API's actions for one commit's changes, ``present`` (path -> mode, of the commit before it, as far
    as the push read it) kept up to date: a deletion, a file created or updated (base64), and a ``chmod`` where the
    mode is not the one GitLab would leave (a new file is 100644; an update keeps its mode). An update or a deletion
    of a file in ``leases`` carries its ``last_commit_id``."""
    actions: list[dict[str, object]] = []
    for change in changes:
        before = present.get(change.path)
        lease = {'last_commit_id': leases[change.path]} if before is not None and change.path in leases else {}
        if change.content is None:
            actions.append({'action': 'delete', 'file_path': change.path, **lease})
            present.pop(change.path, None)
            continue
        actions.append({'action': 'update' if before is not None else 'create', 'file_path': change.path,
                        'encoding': 'base64', 'content': base64.b64encode(change.content).decode('ascii'), **lease})
        if change.mode != (before or '100644'):
            actions.append({'action': 'chmod', 'file_path': change.path,
                            'execute_filemode': change.mode == '100755'})
        present[change.path] = change.mode
    return actions
