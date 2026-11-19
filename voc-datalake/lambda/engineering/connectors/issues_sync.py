"""The deployment's GitHub Issues source, configured from the repository connections (7.50.02; docs/github-issues.md,
"Configured by your GitHub connection"): connecting a repository through one of the deployment's GitHub Apps is what
makes its issues read, with no separate Data sources step.

**What changes.** The source's settings are the github_issues plugin's keys in the deployment's shared secret (what
Administration → Data sources writes and the ingestor reads): ``repos``, ``github_app_id`` and, written only by the
connections, ``repos_managed`` (the repositories they added, one ``owner/name`` per line). ``plan`` is the pure rule:

* a repository a connection reads is ADDED to ``repos`` (``MAX_REPOS`` at most: past it, skipped as ``limit``) and to
  ``repos_managed``; one already in ``repos`` (an administrator's entry, a URL included) is left as it is, never
  claimed;
* a source with no sign-in yet gets the connection's App as its ``github_app_id``;
* a source an administrator set to a token (``signs_in`` ``token``) is never touched: every add is skipped as
  ``token`` (the connection says so), and nothing is removed;
* a source signed in with another of the deployment's Apps keeps it: the add is skipped as ``other_app``;
* REMOVING a repository (its connection removed, or its switch turned off) takes it out of ``repos`` only when it is
  in ``repos_managed``: an administrator's own entry is never removed.

**Who writes it.** Only ``voc-engineering-issues-config`` (``issues_config.py``: the rule above, its own role, the
one function that reads and writes the shared secret for this and turns the source's schedule on when it added a
repository). The Agents API holds no grant on the secret or the rule: ``IssuesFollow`` asks that function
(``config``: ``follow``, ``unfollow``, ``status``) and reads its answer (``Status``: the source's repositories, those
the connections added, its App, how it signs in, whether a token is set and whether its schedule is on; never a
secret).

**Where it runs.** ``IssuesFollow``, in the Agents API: after an installation saved its connections and on **Check
installation** (``follow_app``), on a connection's "Read this repository's issues" switch (``set_read``, default on)
and on a connection's removal (``connection_removed``). Each also makes sure the ``voc-agent`` label is on the
connection's repository, through the token function's ``ensure_label`` (app_tokens.py: an ``{issues: write}`` token of
that one repository, created only when missing; up to ``LABEL_WORKERS`` at once). A failure of the follow never fails
the step that called it: the connections are saved, and the answer's ``issues`` block says what went wrong (Check
installation tries again).

**Any public repository (7.57.00).** A public repository connected read only (``public_read``) is followed like an
App's connection (its issues are read as feedback, through the token function's ``issues_token``, which reads a public
repository no installation covers with a ``metadata: read`` token naming none), but it never gets the label: a label
is a write, and nothing is written to a public repository read only. A fork is never followed: its issues are its
upstream's, which the upstream's own public connection reads.

**What is kept.** Each connection's switch and label state is one row of the connections' partition,
``CONNECTIONS#default`` / ``ISSUES#<connection_id>`` (``read``, ``label_state``: ``created`` | ``present`` |
``failed``), and every change is an audit row of the same ``LOG#`` shape as the connections' (``issues_source_added``,
``issues_source_removed``, ``issues_schedule_enabled``, ``issues_read_on`` / ``issues_read_off``,
``issues_label_created``), told from the function's answers before and after: never a secret.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final, Literal

from botocore.exceptions import BotoCoreError, ClientError

from engineering.connectors.connections import (
    ISSUE_LABEL,
    KIND_FORK,
    KIND_PUBLIC_READ,
    PARTITION,
    Actor,
    ConnectionRefused,
    audit_row,
    display_name,
    partition_rows,
)
from shared.github_metrics import GITHUB_SOURCE
from shared.github_rest import GITHUB_NUMBER, parse_repo
from shared.logging import logger
from shared.model_fallback import error_code

PLUGIN: Final = GITHUB_SOURCE
#: The plugin's keys in the shared secret (``<plugin>_<key>``: integrations_handler.py's namespace).
REPOS_KEY: Final = f'{PLUGIN}_repos'
APP_KEY: Final = f'{PLUGIN}_github_app_id'
TOKEN_KEY: Final = f'{PLUGIN}_token'
MANAGED_KEY: Final = f'{PLUGIN}_repos_managed'
#: The only keys a connection's follow ever writes (issues_config.py refuses to write any other).
WRITABLE_KEYS: Final = frozenset({REPOS_KEY, MANAGED_KEY, APP_KEY})
#: The most repositories the source reads (plugins/_shared/github_config.py MAX_REPOS).
MAX_REPOS: Final = 20
#: A connection's switch and label state (``CONNECTIONS#default`` / ``ISSUES#<connection_id>``).
ROW_PREFIX: Final = 'ISSUES#'
#: The label each connected repository gets (connections.py ISSUE_LABEL, app_tokens.py's only one).
LABEL: Final = ISSUE_LABEL
LABEL_STATES: Final = ('created', 'present', 'failed')
#: How many labels are ensured at once (each one token function call of four GitHub requests at most).
LABEL_WORKERS: Final = 8
NOT_DEPLOYED: Final = 'the GitHub Issues source is not deployed here (pluginStatus.github_issues)'
NOT_APP: Final = ('only a connection made through the deployment\'s GitHub App (Connect GitHub) can read its issues '
                  'automatically: add its repository under Administration → Data sources → GitHub Issues instead')
_AWS_ERRORS: Final = (ClientError, BotoCoreError)

SignIn = Literal['app', 'token', 'none']


def _entries(value: object) -> list[str]:
    """A stored list's entries: one per line or comma-separated, stripped (github_config.py ``_split``)."""
    if not isinstance(value, str):
        return []
    return [part.strip() for part in re.split(r'[\n,]', value) if part.strip()]


def repository_of(entry: str) -> str | None:
    """``owner/name`` of a stored entry, as the ingestor reads it (shared/github_rest.py ``parse_repo``, which
    plugins/_shared/github_config.py reads it with): a GitHub URL by its first two path segments, else exactly
    ``owner/name``; None for anything else."""
    return parse_repo(entry)


def _app_id(value: object) -> str | None:
    text = value.strip() if isinstance(value, str) else ''
    return text if GITHUB_NUMBER.fullmatch(text) else None


@dataclass(frozen=True)
class SourceState:
    """The source's settings as stored: its ``repos`` entries (as an administrator typed them), the ones this
    automation added (``managed``), its App and whether a token is stored."""

    entries: tuple[str, ...] = ()
    managed: tuple[str, ...] = ()
    app_id: str | None = None
    token: bool = False

    @classmethod
    def of(cls, secrets: Mapping[str, Any]) -> SourceState:
        token = secrets.get(TOKEN_KEY)
        return cls(entries=tuple(_entries(secrets.get(REPOS_KEY))),
                   managed=tuple(entry for entry in _entries(secrets.get(MANAGED_KEY)) if repository_of(entry)),
                   app_id=_app_id(secrets.get(APP_KEY)), token=isinstance(token, str) and token.strip() != '')

    @property
    def signs_in(self) -> SignIn:
        """How the ingestor signs in (githubSignIn.ts reads it the same way): an App's id wins, then a token."""
        if self.app_id is not None:
            return 'app'
        return 'token' if self.token else 'none'

    @property
    def repositories(self) -> tuple[str, ...]:
        """The repositories ``repos`` names, in order, each once (its first spelling)."""
        found: dict[str, str] = {}
        for entry in self.entries:
            repository = repository_of(entry)
            if repository is not None:
                found.setdefault(repository.lower(), repository)
        return tuple(found.values())

    def lists(self, repository: str) -> bool:
        return repository.lower() in {listed.lower() for listed in self.repositories}

    def manages(self, repository: str) -> bool:
        """Whether the connections added ``repository`` (``repos_managed``): only then may they take it out."""
        return repository.lower() in {managed.lower() for managed in self.managed}

    def reads(self, app_id: str, repository: str) -> bool:
        """Whether a run of the source reads ``repository`` with ``app_id``'s token."""
        return self.signs_in == 'app' and self.app_id == app_id and self.lists(repository)


@dataclass(frozen=True)
class Plan:
    """What a sync writes (``changes``: the secret's keys, empty for nothing) and what it did and skipped."""

    changes: Mapping[str, str]
    added: tuple[str, ...] = ()
    removed: tuple[str, ...] = ()
    skipped: tuple[tuple[str, str], ...] = ()
    app_set: bool = False


def plan(state: SourceState, app_id: str, add: Iterable[str] = (), remove: Iterable[str] = ()) -> Plan:
    """The source's new settings when ``app_id``'s connections read ``add`` and no longer read ``remove`` (the
    module's rules): merged, never overwritten."""
    adding = list(dict.fromkeys(add))
    if state.signs_in == 'token':
        return Plan({}, skipped=tuple((repository, 'token') for repository in adding))
    entries, managed = list(state.entries), list(state.managed)
    removed: list[str] = []
    for repository in remove:
        key = repository.lower()
        if key not in {entry.lower() for entry in managed}:
            continue   # (an administrator's entry, or one already taken out)
        entries = [entry for entry in entries if (repository_of(entry) or '').lower() != key]
        managed = [entry for entry in managed if entry.lower() != key]
        removed.append(repository)
    other = state.app_id is not None and state.app_id != app_id
    added: list[str] = []
    skipped: list[tuple[str, str]] = []
    after = SourceState(tuple(entries), tuple(managed), state.app_id, state.token)
    wanted = False
    for repository in adding:
        if other:
            skipped.append((repository, 'other_app'))
            continue
        wanted = True
        if after.lists(repository):
            continue   # (already read: an administrator's entry stays theirs)
        if len(after.repositories) >= MAX_REPOS:
            skipped.append((repository, 'limit'))
            continue
        entries.append(repository)
        managed.append(repository)
        added.append(repository)
        after = SourceState(tuple(entries), tuple(managed), state.app_id, state.token)
    app_set = state.signs_in == 'none' and wanted
    changes: dict[str, str] = {}
    if tuple(entries) != state.entries:
        changes[REPOS_KEY] = '\n'.join(entries)
    if tuple(managed) != state.managed:
        changes[MANAGED_KEY] = '\n'.join(managed)
    if app_set:
        changes[APP_KEY] = app_id
    return Plan(changes, tuple(added), tuple(removed), tuple(skipped), app_set)


def merged(secrets: Mapping[str, Any], changes: Mapping[str, str]) -> dict[str, Any]:
    """The whole secret with ``changes`` applied (every other plugin's keys as they were)."""
    return {**secrets, **changes}


def _code(error: Exception) -> str:
    return error_code(error) if isinstance(error, ClientError) else type(error).__name__


# --- the function's answer -----------------------------------------------------------------------------------------------


def _texts(value: object) -> tuple[str, ...]:
    return tuple(item for item in value if isinstance(item, str) and item) if isinstance(value, list) else ()


@dataclass(frozen=True)
class Status:
    """The source as ``voc-engineering-issues-config`` answers it (issues_config.py ``answer``): its settings as a
    ``SourceState`` (never the token, only whether one is set) and whether its schedule is on (None: not known)."""

    state: SourceState
    schedule: bool | None = None

    @classmethod
    def of(cls, answer: object) -> Status:
        if not isinstance(answer, Mapping):
            raise ConnectionRefused('unavailable', 'the GitHub Issues source\'s answer was unreadable: try again')
        state = SourceState(entries=_texts(answer.get('repos')), managed=_texts(answer.get('repos_managed')),
                            app_id=_app_id(answer.get('github_app_id')), token=answer.get('token_set') is True)
        schedule = answer.get('schedule_enabled')
        return cls(state, schedule if isinstance(schedule, bool) else None)

    @property
    def schedule_view(self) -> str:
        return 'unknown' if self.schedule is None else 'on' if self.schedule else 'off'


def _lower(names: Iterable[str]) -> set[str]:
    return {name.lower() for name in names}


# --- the connections' follow ---------------------------------------------------------------------------------------------


def app_of(connection: Mapping[str, Any]) -> tuple[str, int] | None:
    """The deployment's App and installation a connection uses (``app_reference``, or since 7.57.00 a public
    repository read through one, ``public_read``), or None for any other (a fork included: its issues are its
    upstream's)."""
    credential = connection.get('credential')
    if (not isinstance(credential, Mapping) or credential.get('kind') not in ('app_reference', KIND_PUBLIC_READ)
            or connection.get('kind') == KIND_FORK):
        return None
    app_id, installation = str(credential.get('app_id') or ''), str(credential.get('installation_id') or '')
    if connection.get('host', 'github') != 'github' or not (GITHUB_NUMBER.fullmatch(app_id) and installation.isdigit()):
        return None
    return app_id, int(installation)


def follow_stored(issues: IssuesFollow | None, app_id: str, connections: Any, actor: Actor) -> dict[str, Any] | None:
    """``issues``' follow of App ``app_id``'s stored connections (``connections``: a ``ConnectionStore``), after an
    installation, a check or a public connection (7.57.00): never raises; None where the source is not deployed or no
    follow is wired; a store that cannot be read is said in the answer's ``error``."""
    if issues is None:
        return None
    try:
        stored = connections.list()
    except ConnectionRefused as refused:
        return {'signs_in': 'none', 'added': [], 'reading': [], 'skipped': [], 'labels': [], 'schedule': 'unknown',
                'error': str(refused)}
    return issues.follow_app(app_id, stored, actor)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def _id(connection: Mapping[str, Any]) -> str:
    return str(connection.get('connection_id', ''))


def _repository(connection: Mapping[str, Any]) -> str:
    return str(connection.get('repository', ''))


class IssuesFollow:
    """The source's follow of the connections (the module's rules) over ``config`` (voc-engineering-issues-config:
    its request in, its answer out, a ``ConnectionRefused`` for its failures; None where it is not deployed), the
    connections' partition of voc-agents (``table``: the switch and label rows and the audit rows) and the token
    function (``tokens``, the same shape)."""

    def __init__(self, config: Callable[[dict[str, Any]], dict[str, Any]] | None, table: Any,
                 tokens: Callable[[dict[str, Any]], dict[str, Any]],
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._config = config
        self._table = table
        self._tokens = tokens
        self._clock = clock

    @property
    def deployed(self) -> bool:
        return self._config is not None

    # --- the rows ---------------------------------------------------------------------------------------------------

    def rows(self) -> dict[str, dict[str, Any]]:
        """Each connection's switch and label row, by its id (removed connections' rows left out)."""
        try:
            found = partition_rows(self._table, ROW_PREFIX)
        except _AWS_ERRORS as error:
            raise ConnectionRefused('unavailable', 'the connections\' issues settings could not be read: retry') \
                from error
        return {str(row.get('connection_id')): row for row in found if row.get('removed') is not True}

    def _put_row(self, connection: Mapping[str, Any], before: Mapping[str, Any] | None, actor: Actor,
                 **change: Any) -> dict[str, Any]:
        connection_id = _id(connection)
        at = _iso(self._clock())
        row = {'read': True, **(dict(before) if before else {}), **change, 'pk': PARTITION,
               'sk': f'{ROW_PREFIX}{connection_id}', 'connection_id': connection_id,
               'repository': _repository(connection), 'updated_at': at, 'updated_by': display_name(actor.name)}
        try:
            self._table.put_item(Item=row)
        except _AWS_ERRORS as error:
            logger.warning('engineering issues row not written',
                           extra={'connection_id': connection_id, 'error_code': _code(error)})
            raise ConnectionRefused('unavailable', 'the connection\'s issues setting could not be saved: try again') \
                from None
        return row

    def _audit(self, about: Mapping[str, str], action: str, changes: Mapping[str, Any], actor: Actor) -> None:
        """One create-only audit row (best effort once the change is made: a lost one is logged)."""
        row = audit_row(about, action, changes, actor, _iso(self._clock()), 0)
        try:
            self._table.put_item(Item=row, ConditionExpression='attribute_not_exists(sk)')
        except _AWS_ERRORS as error:
            logger.warning('engineering issues audit row not written', extra={'action': action,
                                                                              'error_code': _code(error)})

    # --- the function ---------------------------------------------------------------------------------------------------

    def _ask(self, request: dict[str, Any]) -> Status:
        if self._config is None:
            raise ConnectionRefused('conflict', NOT_DEPLOYED)
        return Status.of(self._config(request))

    def status(self) -> Status:
        return self._ask({'action': 'status'})

    def _change(self, request: dict[str, Any], before: Status, actor: Actor) -> tuple[Status, list[str]]:
        """``request`` (``follow`` or ``unfollow``) asked of the function, and what it changed audited, told from the
        answers before and after: the repositories added (and the App set), those taken out, the schedule turned on.
        The answer and the repositories added."""
        after = self._ask(request)
        about = {'connection_id': str(request.get('connection_id', ''))}
        kept, now = _lower(before.state.managed), _lower(after.state.managed)
        added = [name for name in after.state.managed if name.lower() not in kept]
        removed = [name for name in before.state.managed if name.lower() not in now]
        app_set = before.state.app_id is None and after.state.app_id is not None
        if added or app_set:
            self._audit(about, 'issues_source_added', {
                'repositories': added, **({'github_app_id': after.state.app_id} if app_set else {})}, actor)
        if removed:
            self._audit(about, 'issues_source_removed', {'repositories': removed}, actor)
        if before.schedule is False and after.schedule is True:
            self._audit(about, 'issues_schedule_enabled', {'schedule': 'on'}, actor)
        return after, added

    def _follow(self, connection: Mapping[str, Any], app_id: str, before: Status, actor: Actor) -> tuple[Status, list]:
        if before.state.reads(app_id, _repository(connection)):
            return before, []   # (already read: nothing to ask)
        return self._change({'action': 'follow', 'connection_id': _id(connection), 'repository': _repository(connection),
                             'app_id': app_id}, before, actor)

    def _unfollow(self, connection: Mapping[str, Any], before: Status, actor: Actor) -> Status:
        if not before.state.manages(_repository(connection)):
            return before   # (not the connections' to take out)
        return self._change({'action': 'unfollow', 'connection_id': _id(connection),
                             'repositories': [_repository(connection)]}, before, actor)[0]

    # --- the label --------------------------------------------------------------------------------------------------

    def _ensure_label(self, connection: Mapping[str, Any]) -> str:
        app = app_of(connection)
        if app is None:
            return 'failed'
        try:
            answer = self._tokens({'action': 'ensure_label', 'app_id': app[0], 'installation_id': app[1],
                                   'repository': _repository(connection), 'label': LABEL})
        except ConnectionRefused as refused:
            logger.warning('engineering issues label not ensured', extra={
                'connection_id': connection.get('connection_id'), 'kind': refused.kind})
            return 'failed'
        return 'created' if answer.get('created') is True else 'present'

    def _labels(self, connections: Sequence[Mapping[str, Any]], rows: Mapping[str, Mapping[str, Any]],
                actor: Actor) -> list[dict[str, str]]:
        """The label on each of ``connections`` whose row has none recorded (``created`` or ``present``), ensured up
        to ``LABEL_WORKERS`` at once, each recorded on its row (and audited when created). Never on a public
        repository read only (7.57.00: a label is a write)."""
        due = [c for c in connections if rows.get(_id(c), {}).get('label_state') not in ('created', 'present')
               and c.get('kind') != KIND_PUBLIC_READ]
        if not due:
            return []
        with ThreadPoolExecutor(max_workers=min(LABEL_WORKERS, len(due))) as pool:
            states = list(pool.map(self._ensure_label, due))
        found: list[dict[str, str]] = []
        for connection, state in zip(due, states, strict=True):
            connection_id = _id(connection)
            with suppress(ConnectionRefused):   # (the label is there either way; the next check records it)
                self._put_row(connection, rows.get(connection_id), actor, label_state=state,
                              label_at=_iso(self._clock()))
            if state == 'created':
                self._audit({'connection_id': connection_id}, 'issues_label_created',
                            {'repository': connection.get('repository'), 'label': LABEL}, actor)
            found.append({'repository': _repository(connection), 'state': state})
        return found

    # --- the answers ----------------------------------------------------------------------------------------------------

    @staticmethod
    def _reason(connection: Mapping[str, Any], state: SourceState | None, row: Mapping[str, Any] | None) -> str | None:
        """Why the source does not read a connection's repository (None: it does): its switch is ``off``, the source
        signs in with a ``token`` or another App (``other_app``), it is full (``limit``), the connection is not one of
        the deployment's Apps' (``not_app``), the plugin is not deployed here (``not_deployed``), or it is due on the
        next sync (``pending``: a connection made before 7.50.02, or one whose last sync failed)."""
        app = app_of(connection)
        if state is None:
            return 'not_deployed'
        if app is None:
            return 'not_app'
        if (row or {}).get('read') is False:
            return 'off'
        if state.reads(app[0], _repository(connection)):
            return None
        if state.signs_in == 'token':
            return 'token'
        if state.app_id is not None and state.app_id != app[0]:
            return 'other_app'
        if not state.lists(_repository(connection)) and len(state.repositories) >= MAX_REPOS:
            return 'limit'
        return 'pending'

    def view(self, connections: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        """The source as the connections see it (``GET /agents/engineering/issues-source``): never a secret."""
        status = self.status() if self.deployed else None
        state = status.state if status is not None else None
        rows = self.rows()
        listed = []
        for connection in connections:
            row = rows.get(_id(connection))
            reason = self._reason(connection, state, row)
            label = (row or {}).get('label_state')
            listed.append({'connection_id': _id(connection), 'repository': _repository(connection),
                           'read': (row or {}).get('read') is not False, 'reading': reason is None,
                           'reason': reason, 'label': label if label in LABEL_STATES else None})
        return {'deployed': state is not None, 'signs_in': state.signs_in if state else 'none',
                'app_id': state.app_id if state else None,
                'repositories': list(state.repositories) if state else [],
                'managed': list(state.managed) if state else [],
                'schedule': status.schedule_view if status is not None else 'unknown', 'label': LABEL,
                'connections': listed}

    # --- the steps that call it -----------------------------------------------------------------------------------------

    def follow_app(self, app_id: str, connections: Sequence[Mapping[str, Any]], actor: Actor) -> dict[str, Any] | None:
        """After an installation of ``app_id`` (or its check): every stored connection of that App whose switch is on
        is read by the source, and each gets the label. The answer's ``issues`` block (None: not deployed here); a
        failure is said in its ``error``, never raised."""
        if not self.deployed:
            return None
        mine = [c for c in connections if (app_of(c) or ('',))[0] == app_id]
        try:
            rows = self.rows()
            off = [c for c in mine if rows.get(_id(c), {}).get('read') is False]
            status, added = self.status(), []
            for connection in mine:
                if connection not in off:
                    status, new = self._follow(connection, app_id, status, actor)
                    added += new
            labels = self._labels(mine, rows, actor)
        except ConnectionRefused as refused:
            logger.warning('engineering issues follow failed', extra={'app_id': app_id, 'kind': refused.kind})
            return {'signs_in': 'none', 'added': [], 'reading': [], 'skipped': [], 'labels': [], 'schedule': 'unknown',
                    'error': str(refused)}
        reasons = [(_repository(c), self._reason(c, status.state, rows.get(_id(c)))) for c in mine]
        return {'signs_in': status.state.signs_in, 'added': added,
                'reading': [repository for repository, reason in reasons if reason is None],
                'skipped': [{'repository': repository, 'reason': reason} for repository, reason in reasons
                            if reason in ('token', 'other_app', 'limit', 'off')],
                'labels': labels, 'schedule': status.schedule_view, 'error': None}

    def set_read(self, connection: Mapping[str, Any], read: bool, actor: Actor) -> None:
        """A connection's "Read this repository's issues" switch: its row, then the source (added or taken out as
        ``plan`` allows), and on, the label. ``ConnectionRefused`` for a source not deployed here, or a connection that
        is not one of the deployment's Apps' turned on."""
        if not self.deployed:
            raise ConnectionRefused('conflict', NOT_DEPLOYED)
        app = app_of(connection)
        if read and app is None:
            raise ConnectionRefused('conflict', NOT_APP)
        rows = self.rows()
        before = rows.get(_id(connection))
        if (before or {}).get('read', True) is not read:
            self._put_row(connection, before, actor, read=read)
            self._audit({'connection_id': _id(connection)}, 'issues_read_on' if read else 'issues_read_off',
                        {'repository': connection.get('repository'), 'read': read}, actor)
        if app is None:
            return
        if read:
            self._follow(connection, app[0], self.status(), actor)
            self._labels([connection], self.rows(), actor)
        else:
            self._unfollow(connection, self.status(), actor)

    def connection_removed(self, connection: Mapping[str, Any], actor: Actor) -> list[str]:
        """A connection removed: its repository out of the source when the connections added it (``plan``), its row
        marked removed. Best effort: a failure is logged (the connection is removed either way). The repositories
        taken out."""
        if not self.deployed:
            return []
        connection_id = _id(connection)
        try:
            rows = self.rows()
            if connection_id in rows:
                self._put_row(connection, rows[connection_id], actor, removed=True)
            if app_of(connection) is None:
                return []
            before = self.status()
            after = self._unfollow(connection, before, actor)
        except ConnectionRefused as refused:
            logger.warning('engineering issues removal not synced',
                           extra={'connection_id': connection_id, 'kind': refused.kind})
            return []
        now = _lower(after.state.managed)
        return [name for name in before.state.managed if name.lower() not in now]
