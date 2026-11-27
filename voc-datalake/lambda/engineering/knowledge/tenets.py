"""A repository's tenets, versioned (7.52.00; docs/autonomous-engineering.md, "Tenets"): a draft per Tenets run (D1),
which an administrator accepts or rejects (D4).

Rows in ``voc-engineering``, in the connection's partition beside its knowledge packs::

    WS#<ws>#REPO#<connection> / TENETS                      versions (the counter); accepted_version, accepted_digest,
                                                            accepted_ids, accepted_by, accepted_at
    WS#<ws>#REPO#<connection> / TENETS#<version:06d>        a version: status, its voc-tenets/1 record, its author (the
                                                            run's agent), the run, the version accepted when it was
                                                            drafted; once decided, who, when and why
    WS#<ws>#REPO#<connection> / TENETSLOG#<version:06d>#<event>   drafted, accepted or rejected: who, when, why
    WS#<ws>#REPO#<connection> / TENETSRUN#<run>             the run that drafted a version (one draft per run)

- **Draft** (``draft``: a Tenets run's end, ``runtime/tenets_end.py``): one transaction moves the counter from ``n``
  to ``n + 1`` (held to ``n``, tried again when another draft took it), and writes the version (``draft``), its
  ``drafted`` log row and the run's row, each create-only: a run drafts once, and nothing is ever replaced. The
  runtime writes only these attributes (``DRAFT_ATTRIBUTES``, pinned by its IAM grant), so it can never accept one.
- **Accept** (an administrator only; an agent never accepts, whatever it asks): one transaction marks the draft
  ``accepted`` with who, when, why and the digest of its ``TENETS.md`` rendering (``render_docs.render_tenets``), moves
  the counter's ``accepted_version`` up (never down: a version older than the accepted one is refused) with that
  digest and the accepted tenet ids, and writes the ``accepted`` log row. Accepting the accepted version again answers
  it as it is.
- **Reject** (an administrator only): the draft marked ``rejected``, with its log row. A rejected version stays.
- **Read**: ``accepted_ids`` (the counter's ids: what a triage may cite, ``outputs.unaccepted_tenets``; none accepted:
  empty, so a triage cites none) and ``accepted`` (the accepted version, its record checked against the digest its
  acceptance recorded, so a row changed since is never rendered as accepted).
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.knowledge.render_docs import RenderError, render_tenets
from engineering.knowledge.store import (
    Actor,
    PackConflict,
    PackError,
    PackForbidden,
    PackNotFound,
    PackUnavailable,
    repo_key,
    repo_pk,
)
from engineering.rows import create_only, get_row, partition_rows
from engineering.rows import number_value as _number
from engineering.rows import text_value as _text
from engineering.runtime.outputs import TenetsError, tenets_record
from engineering.workspace.layout import ID
from shared.aws import cancelled_by_condition

DRAFT, ACCEPTED, REJECTED = 'draft', 'accepted', 'rejected'
COUNTER: Final = 'TENETS'
VERSION_PREFIX: Final = 'TENETS#'
LOG_PREFIX: Final = 'TENETSLOG#'
RUN_PREFIX: Final = 'TENETSRUN#'
#: Every attribute a draft writes (its counter's, its version's, its log's and its run's rows): all the runtime's grant
#: lets it write (lib/stacks/engineering-runtime-grants.ts ``TENETS_DRAFT_ATTRIBUTES``; a test holds the two equal).
DRAFT_ATTRIBUTES: Final = ('pk', 'sk', 'versions', 'version', 'status', 'record', 'author', 'author_kind', 'run_id',
                           'base_version', 'created_at', 'event', 'by', 'at')
#: How many times a draft takes the next number when another draft took it meanwhile.
DRAFT_TRIES: Final = 3
MAX_REASON: Final = 500
MAX_VERSIONS: Final = 1_000


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _reason(reason: str) -> str:
    text = ' '.join(str(reason or '').split())
    if len(text) > MAX_REASON:
        raise PackError(f'a reason is at most {MAX_REASON} characters')
    return text


@dataclass(frozen=True)
class TenetsVersion:
    version: int
    status: str
    record: Mapping[str, Any]
    author: str
    author_kind: str
    run_id: str
    base_version: int
    created_at: str
    decided_by: str = ''
    decided_at: str = ''
    reason: str = ''
    rendering_digest: str = ''

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> TenetsVersion:
        try:
            record = json.loads(_text(item.get('record')) or '{}')
        except ValueError:
            record = {}
        return cls(version=_number(item.get('version')), status=_text(item.get('status')),
                   record=record if isinstance(record, dict) else {}, author=_text(item.get('author')),
                   author_kind=_text(item.get('author_kind')), run_id=_text(item.get('run_id')),
                   base_version=_number(item.get('base_version')), created_at=_text(item.get('created_at')),
                   decided_by=_text(item.get('decided_by')), decided_at=_text(item.get('decided_at')),
                   reason=_text(item.get('reason')), rendering_digest=_text(item.get('rendering_digest')))

    @property
    def ids(self) -> tuple[str, ...]:
        tenets = self.record.get('tenets')
        return tuple(str(t.get('id')) for t in tenets if isinstance(t, Mapping)) if isinstance(tenets, list) else ()

    def view(self, accepted_version: int = 0) -> dict[str, Any]:
        return {'version': self.version, 'status': self.status, 'current': self.version == accepted_version,
                'record': dict(self.record), 'ids': list(self.ids), 'author': self.author,
                'author_kind': self.author_kind, 'run_id': self.run_id or None, 'base_version': self.base_version,
                'created_at': self.created_at, 'decided_by': self.decided_by or None,
                'decided_at': self.decided_at or None, 'reason': self.reason or None,
                'rendering_digest': self.rendering_digest or None}


@dataclass(frozen=True)
class TenetsHead:
    """The counter: how many versions, and the accepted one with its digest and ids."""

    versions: int
    accepted_version: int
    accepted_digest: str
    accepted_ids: frozenset[str]
    accepted_by: str
    accepted_at: str

    @classmethod
    def from_item(cls, item: Mapping[str, Any] | None) -> TenetsHead:
        item = item or {}
        ids = item.get('accepted_ids', {}).get('L', []) if isinstance(item.get('accepted_ids'), dict) else []
        return cls(versions=_number(item.get('versions')), accepted_version=_number(item.get('accepted_version')),
                   accepted_digest=_text(item.get('accepted_digest')),
                   accepted_ids=frozenset(_text(value) for value in ids if _text(value)),
                   accepted_by=_text(item.get('accepted_by')), accepted_at=_text(item.get('accepted_at')))

    def view(self) -> dict[str, Any]:
        return {'versions': self.versions, 'accepted_version': self.accepted_version or None,
                'accepted_ids': sorted(self.accepted_ids), 'accepted_digest': self.accepted_digest or None,
                'accepted_by': self.accepted_by or None, 'accepted_at': self.accepted_at or None}


@dataclass(frozen=True)
class AcceptedTenets:
    version: TenetsVersion
    #: The digest of its TENETS.md rendering, as its acceptance recorded it.
    digest: str


def _held_to_the_grant(items: Sequence[Mapping[str, Any]]) -> None:
    """A draft writes only ``DRAFT_ATTRIBUTES`` (the runtime's IAM grant allows those alone): one off the list is a
    refusal here, before the write, rather than an access denied from DynamoDB."""
    written = set()
    for item in items:
        if 'Put' in item:
            written |= set(item['Put']['Item'])
        else:
            written |= {'pk', 'sk', *(name.strip() for name in
                                      item['Update']['UpdateExpression'].removeprefix('SET ').split(' = ')[0:1])}
    if not written <= set(DRAFT_ATTRIBUTES):
        raise PackError(f'a draft writes no {", ".join(sorted(written - set(DRAFT_ATTRIBUTES)))}')


def _held(head: TenetsHead, expected: int | None) -> None:
    """The accepted version the screen showed is the one accepted now (``PackConflict`` otherwise)."""
    if expected is not None and head.accepted_version != expected:
        shown = f'v{expected}' if expected else 'none'
        now = f'v{head.accepted_version}' if head.accepted_version else 'none'
        raise PackConflict(f'the accepted version was {shown} and is {now} now: read it again')


def _counter_condition(expected: int | None) -> str:
    """The counter's condition at an acceptance: the accepted version only moves up, and (with ``expected``) from
    the one the screen showed."""
    if expected is None:
        return 'attribute_not_exists(accepted_version) OR accepted_version < :v'
    return 'attribute_not_exists(accepted_version)' if expected == 0 else \
        'accepted_version = :e AND accepted_version < :v'


@dataclass(frozen=True)
class TenetsStore:
    #: A low-level DynamoDB client on ``voc-engineering``.
    client: Any
    table: str
    now: Callable[[], datetime] = _utc_now

    def head(self, ws: str, connection: str) -> TenetsHead:
        return TenetsHead.from_item(get_row(self.client, self.table, repo_key(ws, connection, COUNTER)))

    def accepted_ids(self, ws: str, connection: str) -> frozenset[str]:
        """The tenet ids of the accepted version (empty: none accepted), as its acceptance recorded them."""
        return self.head(ws, connection).accepted_ids

    def version(self, ws: str, connection: str, version: int) -> TenetsVersion:
        if not 0 < version < 1_000_000:
            raise PackNotFound('no such version')
        item = get_row(self.client, self.table, repo_key(ws, connection, f'{VERSION_PREFIX}{version:06d}'))
        if item is None:
            raise PackNotFound('no such version')
        return TenetsVersion.from_item(item)

    def versions(self, ws: str, connection: str) -> list[TenetsVersion]:
        """Every version, oldest first (D1: none is ever replaced), at most ``MAX_VERSIONS``."""
        items = partition_rows(self.client, self.table, repo_pk(ws, connection), VERSION_PREFIX,
                               max_items=MAX_VERSIONS)
        return [TenetsVersion.from_item(item) for item in items]

    def log(self, ws: str, connection: str, version: int) -> list[dict[str, Any]]:
        """A version's events, in order: ``{event, by, at, reason}``."""
        items = partition_rows(self.client, self.table, repo_pk(ws, connection), f'{LOG_PREFIX}{version:06d}#')
        return [{'event': _text(item.get('event')), 'by': _text(item.get('by')), 'at': _text(item.get('at')),
                 'reason': _text(item.get('reason')) or None} for item in items]

    def accepted(self, ws: str, connection: str) -> AcceptedTenets | None:
        """The accepted version (None: none accepted), checked against its acceptance: it is marked accepted and its
        record renders to the digest the acceptance recorded (``PackUnavailable`` otherwise: never rendered as
        accepted)."""
        head = self.head(ws, connection)
        if not head.accepted_version:
            return None
        row = self.version(ws, connection, head.accepted_version)
        try:
            digest = render_tenets(row.record, row.version).digest
        except RenderError as exc:
            raise PackUnavailable('the accepted tenets version cannot be rendered') from exc
        if row.status != ACCEPTED or digest != head.accepted_digest or digest != row.rendering_digest:
            raise PackUnavailable('the accepted tenets version is not as its acceptance recorded it')
        return AcceptedTenets(row, digest)

    def draft(self, ws: str, connection: str, record: Mapping[str, Any], *, author: Actor,
              run_id: str = '') -> TenetsVersion | None:
        """``record`` as the next version, a draft by ``author`` (an agent of ``run_id``); None when the run drafted
        one already (its ``TENETSRUN#`` row)."""
        try:
            checked = tenets_record(dict(record))
        except TenetsError as exc:
            raise PackError(str(exc)) from exc
        if run_id and not ID.fullmatch(run_id):
            raise PackError('not a run id')
        for _ in range(DRAFT_TRIES):
            head = self.head(ws, connection)
            version, at = head.versions + 1, self.now().isoformat()
            item = {**repo_key(ws, connection, f'{VERSION_PREFIX}{version:06d}'), 'version': {'N': str(version)},
                    'status': {'S': DRAFT}, 'record': {'S': json.dumps(checked, sort_keys=True)},
                    'author': {'S': author.id}, 'author_kind': {'S': author.kind}, 'run_id': {'S': run_id},
                    'base_version': {'N': str(head.accepted_version)}, 'created_at': {'S': at}}
            items = [
                {'Update': {'TableName': self.table, 'Key': repo_key(ws, connection, COUNTER),
                            'UpdateExpression': 'SET versions = :v',
                            'ConditionExpression': ('attribute_not_exists(versions)' if not head.versions
                                                    else 'versions = :prev'),
                            'ExpressionAttributeValues': {':v': {'N': str(version)},
                                                          **({':prev': {'N': str(head.versions)}}
                                                             if head.versions else {})}}},
                create_only(item, self.table),
                create_only({**repo_key(ws, connection, f'{LOG_PREFIX}{version:06d}#drafted'),
                             'version': {'N': str(version)}, 'event': {'S': 'drafted'}, 'by': {'S': author.id},
                             'at': {'S': at}, 'run_id': {'S': run_id}}, self.table),
            ]
            if run_id:
                items.append(create_only({**repo_key(ws, connection, f'{RUN_PREFIX}{run_id}'),
                                          'version': {'N': str(version)}, 'at': {'S': at}}, self.table))
            _held_to_the_grant(items)
            try:
                self.client.transact_write_items(TransactItems=items)
            except ClientError as exc:
                if run_id and cancelled_by_condition(exc, 3):
                    return None
                if cancelled_by_condition(exc, 0):
                    continue   # (another draft took the number: the next one)
                if any(cancelled_by_condition(exc, index) for index in (1, 2)):
                    raise PackConflict(f'version {version} already has a row: the counter is behind') from exc
                raise
            return TenetsVersion.from_item(item)
        raise PackConflict('other drafts took the next numbers meanwhile: draft again')

    def _decision(self, ws: str, connection: str, version: int, by: Actor, event: str, reason: str,
                  more: Sequence[Mapping[str, Any]] = (), digest: str = '') -> None:
        """The draft marked ``event`` (accepted, rejected) with who, when and why (and, accepted, its rendering's
        ``digest``), ``more`` (the counter's move) and the event's log row, in one transaction."""
        at = self.now().isoformat()
        update = 'SET #s = :to, decided_by = :by, decided_at = :at, reason = :reason'
        values: dict[str, Any] = {':to': {'S': event}, ':draft': {'S': DRAFT}, ':by': {'S': by.id}, ':at': {'S': at},
                                  ':reason': {'S': reason}}
        if digest:
            update += ', rendering_digest = :digest'
            values[':digest'] = {'S': digest}
        items = [
            {'Update': {'TableName': self.table, 'Key': repo_key(ws, connection, f'{VERSION_PREFIX}{version:06d}'),
                        'UpdateExpression': update, 'ConditionExpression': '#s = :draft',
                        'ExpressionAttributeNames': {'#s': 'status'}, 'ExpressionAttributeValues': values}},
            *more,
            create_only({**repo_key(ws, connection, f'{LOG_PREFIX}{version:06d}#{event}'),
                         'version': {'N': str(version)}, 'event': {'S': event}, 'by': {'S': by.id},
                         'at': {'S': at}, 'reason': {'S': reason}}, self.table),
        ]
        try:
            self.client.transact_write_items(TransactItems=items)
        except ClientError as exc:
            if cancelled_by_condition(exc):
                raise PackConflict('the version or the accepted one changed meanwhile: read it again') from exc
            raise

    def accept(self, ws: str, connection: str, version: int, by: Actor, reason: str = '', *,
               expected_accepted: int | None = None) -> TenetsVersion:
        """An administrator's acceptance of a draft (the module's doc); the version as it stands after.
        ``expected_accepted`` (7.52.00): the accepted version the screen showed (0 for none), held in the counter's
        own update, so a draft read against another accepted version is ``PackConflict`` (None: not checked)."""
        if not (by.kind == 'person' and by.admin):
            raise PackForbidden('only an administrator accepts the tenets')
        current = self.version(ws, connection, version)
        if current.status == ACCEPTED:
            return current
        if current.status != DRAFT:
            raise PackConflict(f'version {version} is {current.status}: only a draft is accepted')
        head = self.head(ws, connection)
        _held(head, expected_accepted)
        if version < head.accepted_version:
            raise PackConflict('a later version is accepted already: accept a newer draft instead')
        try:
            digest = render_tenets(current.record, version).digest
        except RenderError as exc:
            raise PackError(str(exc)) from exc
        at = self.now().isoformat()
        counter = {'Update': {
            'TableName': self.table, 'Key': repo_key(ws, connection, COUNTER),
            'UpdateExpression': ('SET accepted_version = :v, accepted_digest = :d, accepted_ids = :ids, '
                                 'accepted_by = :by, accepted_at = :at'),
            'ConditionExpression': _counter_condition(expected_accepted),
            'ExpressionAttributeValues': {':v': {'N': str(version)}, ':d': {'S': digest},
                                          **({':e': {'N': str(expected_accepted)}} if expected_accepted else {}),
                                          ':ids': {'L': [{'S': tenet_id} for tenet_id in current.ids]},
                                          ':by': {'S': by.id}, ':at': {'S': at}}}}
        self._decision(ws, connection, version, by, ACCEPTED, _reason(reason), (counter,), digest)
        return self.version(ws, connection, version)

    def reject(self, ws: str, connection: str, version: int, by: Actor, reason: str = '', *,
               expected_accepted: int | None = None) -> TenetsVersion:
        """An administrator's rejection of a draft: it stays, marked rejected. ``expected_accepted`` (7.52.00): the
        accepted version the screen showed, read before the write (a rejection moves no accepted version, and the
        Agents API's role has no ConditionCheckItem on these rows); None: not checked."""
        if not (by.kind == 'person' and by.admin):
            raise PackForbidden('only an administrator rejects the tenets')
        current = self.version(ws, connection, version)
        if current.status != DRAFT:
            raise PackConflict(f'version {version} is {current.status}: only a draft is rejected')
        _held(self.head(ws, connection), expected_accepted)
        self._decision(ws, connection, version, by, REJECTED, _reason(reason))
        return self.version(ws, connection, version)
