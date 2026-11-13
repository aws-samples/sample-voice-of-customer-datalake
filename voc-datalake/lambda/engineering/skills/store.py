"""Versioned skills: every change a new version (D1), used only once an administrator accepts it (D4).

Rows in the ``voc-engineering`` table, one partition per scope: the workspace, the connection (``''`` for the shared
skill every connection's agents fall back to) and the agent role::

    WS#<ws>#SKILL#<connection>#<role> / HEAD                       versions (the counter), current_version
    WS#<ws>#SKILL#<connection>#<role> / VER#<version:06d>          a version: its record, diff, why, status, who
    WS#<ws>#SKILL#<connection>#<role> / LOG#<version:06d>#<event>  accepted, rejected, rolled_back or promoted_from:
                                                                   who and when (create-only)
    WS#<ws>#SKILL#<connection>#<role> / RUN#<run>#<failure>        the coach's one proposal for a run's failure

- **Propose** (the coach after a failure, or a person): an atomic ``ADD`` on the counter gives the version, then
  its row (``attribute_not_exists``): status ``proposed``, the ``voc-skill/1`` record, its base (the version it was
  written on: the scope's current one, or the shared skill's for a connection that has none of its own), its diff
  from that base and the summary line, why (the run, the failure, a person's comment), the benchmark before and
  after when measured, and who proposed it. The coach (an agent) writes only the version of the connection its run
  is for (``Actor.connection``, from the run's record), from that run's failure, once per run and failure kind (the
  ``RUN#`` row, created in the same transaction), and never one that changes the tool policy, the model or the
  harness (``model.PERSON_ONLY_FIELDS``). The shared skill's versions are a person's; a run and its failure belong
  to a connection's version. A version row stays under ``MAX_ITEM_BYTES``, checked before it is written.
- **Promote**: an administrator writes a new shared version from what a connection's version taught. It is refused
  when it adds an instruction line or example text of at least ``MIN_COPIED_TEXT`` characters (case and spacing
  aside) that the connection's version adds to the shared skill too; anything else the administrator carries. The
  source is kept only in the version's ``promoted_from`` log row, which only an administrator reads
  (``promotion_source``): the shared version every connection reads does not name another connection.
- **Accept / reject**: an administrator only. Accepting moves the scope's ``current_version`` to the version in one
  transaction with its status, who and when, and its log row; it is refused when the base is no longer current
  (the scope, or for a connection with no version of its own the shared skill, moved meanwhile), checked before and
  again inside the transaction. A rejected version stays, as every version does.
- **Roll back**: an administrator only, within the version's own scope: a new version restoring an earlier
  accepted one's record, current at once and logged as ``rolled_back``, so the history stays whole.
- **Read**: ``current`` is the connection's own current version, else the shared skill's, else None (the role runs
  on the platform's own instructions); ``versions`` pages through a scope's history. A connection's versions are
  read only as the connection is (the routes check that access; this store does not).

Each change returns an ``Announcement``: the bus event (``skill.proposed``, ``skill.accepted``,
``skill.rolled_back``) the caller publishes, with the summary line made from the diff.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.bus.schema import WS
from engineering.connectors.identity import AGENT_ROLES
from engineering.knowledge.store import Actor
from engineering.rows import create_only as _put
from engineering.rows import get_row, transact_or_refuse
from engineering.rows import number_value as _number
from engineering.rows import text_value as _text
from engineering.skills.diff import Event, SkillDiff, diff, from_json, summary, to_json
from engineering.skills.model import Benchmark, Reason, Skill, SkillContent, SkillError
from engineering.workspace.layout import CONNECTION
from shared.ids import is_key_collision

PROPOSED, ACCEPTED, REJECTED = 'proposed', 'accepted', 'rejected'
#: The log events beside the statuses: a rollback's new version, and a promoted version's source.
ROLLED_BACK, PROMOTED_FROM = 'rolled_back', 'promoted_from'
SHARED: Final = ''
HEAD: Final = 'HEAD'
#: The bus types a change is announced as, by what happened.
ANNOUNCED: Final[Mapping[Event, str]] = {'proposed': 'skill.proposed', 'accepted': 'skill.accepted',
                                         'rolled_back': 'skill.rolled_back'}
#: A line or example text shorter than this (normalised) is too generic to count as a connection's own text.
MIN_COPIED_TEXT: Final = 20
#: A version row's size (DynamoDB's count: names and values), well below DynamoDB's 400 KB item limit. The worst
#: case (a 64 KB record whose diff removes and adds two full 64 KB records' text in 500 lines) stays under it.
MAX_ITEM_BYTES: Final = 256 * 1024
#: Versions a page of ``versions`` holds at most.
MAX_PAGE: Final = 100


class SkillNotFound(SkillError):
    kind = 'not_found'


class SkillForbidden(SkillError):
    kind = 'forbidden'


class SkillConflict(SkillError):
    kind = 'conflict'


@dataclass(frozen=True)
class SkillRef:
    """A version of a scope: ``connection`` is ``''`` for the shared skill."""

    connection: str
    version: int


def _label(ref: SkillRef, scope: str) -> str:
    return f'shared v{ref.version}' if ref.connection != scope and not ref.connection else f'v{ref.version}'


def _rate(value: Any) -> float | None:
    return float(value['N']) if isinstance(value, dict) and 'N' in value else None


def _ref(connection: Any, version: Any) -> SkillRef | None:
    number = _number(version)
    return SkillRef(_text(connection), number) if number else None


def item_bytes(item: Mapping[str, Any]) -> int:
    """A low-level item's size as DynamoDB counts it for its strings and numbers: each name and value's bytes."""
    size = 0
    for name, value in item.items():
        size += len(name.encode('utf-8'))
        if isinstance(value, dict):
            size += sum(len(str(v).encode('utf-8')) for v in value.values())
    return size


@dataclass(frozen=True)
class SkillVersion:
    role: str
    connection: str
    version: int
    status: str
    skill: Skill
    base: SkillRef | None
    reason: Reason
    benchmark: Benchmark
    diff: SkillDiff
    summary: str
    proposed_by: str
    proposed_by_kind: str
    created_at: str
    accepted_by: str = ''
    accepted_at: str = ''
    rejected_by: str = ''
    rejected_at: str = ''
    #: The earlier version a rollback restored (0 for any other version).
    restores: int = 0

    @property
    def ref(self) -> SkillRef:
        return SkillRef(self.connection, self.version)

    @property
    def label(self) -> str:
        """What a run records it used: ``<role>@<version>``, ``<role>@<connection>/<version>`` for a connection's."""
        return f'{self.role}@{self.connection}/{self.version}' if self.connection else self.skill.label

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> SkillVersion:
        try:
            skill = Skill.from_record(json.loads(_text(item.get('record'))))
            change = from_json(json.loads(_text(item.get('diff'))))
        except ValueError as exc:   # json.JSONDecodeError and SkillError are ValueErrors
            raise SkillError(f'a stored version is not a readable skill: {exc}') from exc
        return cls(role=skill.name, connection=_text(item.get('connection')), version=_number(item.get('version')),
                   status=_text(item.get('status')), skill=skill,
                   base=_ref(item.get('base_connection'), item.get('base_version')),
                   reason=Reason(_text(item.get('reason_run')), _text(item.get('reason_failure')),
                                 _text(item.get('reason_comment'))),
                   benchmark=Benchmark(_rate(item.get('benchmark_before')), _rate(item.get('benchmark_after'))),
                   diff=change, summary=_text(item.get('summary')), proposed_by=_text(item.get('proposed_by')),
                   proposed_by_kind=_text(item.get('proposed_by_kind')), created_at=_text(item.get('created_at')),
                   accepted_by=_text(item.get('accepted_by')), accepted_at=_text(item.get('accepted_at')),
                   rejected_by=_text(item.get('rejected_by')), rejected_at=_text(item.get('rejected_at')),
                   restores=_number(item.get('restores')))


@dataclass(frozen=True)
class VersionPage:
    """A page of a scope's versions, oldest first; ``next_after`` is the ``after`` of the next page (None: the
    last page)."""

    versions: Sequence[SkillVersion]
    next_after: int | None


@dataclass(frozen=True)
class Announcement:
    """A change for the bus to carry: ``id`` is the same for the same change, so publishing it twice is one."""

    id: str
    type: str
    ws: str
    role: str
    connection: str
    from_version: SkillRef | None
    to_version: SkillRef
    summary: str


@dataclass(frozen=True)
class Change:
    version: SkillVersion
    #: None when nothing changed (accepting the accepted version again).
    announcement: Announcement | None


def _pk(ws: str, connection: str, role: str) -> str:
    if not WS.fullmatch(ws):
        raise SkillError('not a workspace id')
    if connection and not CONNECTION.fullmatch(connection):
        raise SkillError('not a connection id')
    if role not in AGENT_ROLES:
        raise SkillError('not an agent role')
    return f'WS#{ws}#SKILL#{connection}#{role}'


def _admin(actor: Actor, what: str) -> None:
    if not (actor.kind == 'person' and actor.admin):
        raise SkillForbidden(f'only an administrator {what} a skill version')


def _normalised(text: str) -> str:
    return ' '.join(text.split()).casefold()


def _own_text(change: SkillDiff) -> set[str]:
    """What a diff adds, normalised, without the lines too short to be anybody's own."""
    texts = [line for op, line in change.instructions if op == '+']
    texts += [part for op, example in change.examples if op == '+' for part in (example.situation, example.action)]
    return {norm for norm in map(_normalised, texts) if len(norm) >= MIN_COPIED_TEXT}


def _found(item: dict[str, Any] | None) -> dict[str, Any]:
    if item is None:
        raise SkillNotFound('no such skill version')
    return item


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class SkillStore:
    #: A low-level DynamoDB client on ``voc-engineering``.
    client: Any
    table: str
    now: Callable[[], datetime] = _utc_now

    def _key(self, ws: str, connection: str, role: str, sk: str) -> dict[str, Any]:
        return {'pk': {'S': _pk(ws, connection, role)}, 'sk': {'S': sk}}

    def _current(self, ws: str, connection: str, role: str) -> int:
        head = get_row(self.client, self.table, self._key(ws, connection, role, HEAD)) or {}
        return _number(head.get('current_version'))

    def resolved(self, ws: str, connection: str, role: str) -> SkillRef | None:
        """The version ``current`` reads: the connection's own current one, else the shared skill's."""
        own = self._current(ws, connection, role)
        if own:
            return SkillRef(connection, own)
        shared = self._current(ws, SHARED, role) if connection else 0
        return SkillRef(SHARED, shared) if shared else None

    def version(self, ws: str, connection: str, role: str, version: int) -> SkillVersion:
        found = get_row(self.client, self.table, self._key(ws, connection, role, f'VER#{version:06d}'))
        return SkillVersion.from_item(_found(found))

    def versions(self, ws: str, connection: str, role: str, *, after: int = 0, limit: int = 50) -> VersionPage:
        """The scope's versions after version ``after``, oldest first, at most ``limit`` (1 to ``MAX_PAGE``) of
        them (D1: none is ever replaced or removed)."""
        if isinstance(limit, bool) or not 0 < limit <= MAX_PAGE or after < 0:
            raise SkillError(f'a page holds 1-{MAX_PAGE} versions, after a version number')
        answer = self.client.query(
            TableName=self.table, ConsistentRead=True, Limit=limit,
            KeyConditionExpression='pk = :pk AND sk BETWEEN :first AND :last',
            ExpressionAttributeValues={':pk': {'S': _pk(ws, connection, role)},
                                       ':first': {'S': f'VER#{after + 1:06d}'}, ':last': {'S': 'VER#999999'}})
        page = [SkillVersion.from_item(item) for item in answer.get('Items', [])]
        more = bool(page) and 'LastEvaluatedKey' in answer
        return VersionPage(page, page[-1].version if more else None)

    def current(self, ws: str, connection: str, role: str) -> SkillVersion | None:
        """The skill the role's agents run for ``connection`` (``''``: the shared one), None when there is none."""
        ref = self.resolved(ws, connection, role)
        if ref is None:
            return None
        found = self.version(ws, ref.connection, role, ref.version)
        if found.status != ACCEPTED:
            raise SkillConflict('the current version is not marked accepted')
        return found

    def promotion_source(self, ws: str, role: str, version: int, by: Actor) -> SkillRef | None:
        """The connection's version a shared version was promoted from (None: it was not promoted), for an
        administrator only: no connection's reader learns another connection's name from the shared skill."""
        _admin(by, 'reads the source of')
        item = get_row(self.client, self.table, self._key(ws, SHARED, role, f'LOG#{version:06d}#{PROMOTED_FROM}'))
        return _ref(item.get('source_connection'), item.get('source_version')) if item else None

    def _announce(self, ws: str, event: Event, row: SkillVersion, from_version: SkillRef | None) -> Announcement:
        digest = hashlib.sha256(f'{ws}#{row.connection}#{row.role}#{row.version}#{event}'.encode()).hexdigest()
        return Announcement(id=f'skill-{event}-{digest[:24]}', type=ANNOUNCED[event], ws=ws, role=row.role,
                            connection=row.connection, from_version=from_version, to_version=row.ref,
                            summary=row.summary if event == 'proposed' else summary(
                                row.role, event, _label(from_version, row.connection) if from_version else '',
                                _label(row.ref, row.connection), row.diff, restores=row.restores,
                                scope=row.connection))

    def _next_version(self, ws: str, connection: str, role: str) -> int:
        counted = self.client.update_item(
            TableName=self.table, Key=self._key(ws, connection, role, HEAD), UpdateExpression='ADD versions :one',
            ExpressionAttributeValues={':one': {'N': '1'}}, ReturnValues='UPDATED_NEW')
        return int(counted['Attributes']['versions']['N'])

    def _item(self, ws: str, connection: str, skill: Skill, *, status: str, base: SkillRef | None, reason: Reason,
              benchmark: Benchmark, change: SkillDiff, line: str, by: Actor, restores: int = 0) -> dict[str, Any]:
        item: dict[str, Any] = {
            **self._key(ws, connection, skill.name, f'VER#{skill.version:06d}'),
            'role': {'S': skill.name}, 'connection': {'S': connection}, 'version': {'N': str(skill.version)},
            'status': {'S': status}, 'record': {'S': json.dumps(skill.to_record(), sort_keys=True)},
            'diff': {'S': json.dumps(to_json(change), sort_keys=True)}, 'summary': {'S': line},
            'base_connection': {'S': base.connection if base else ''},
            'base_version': {'N': str(base.version if base else 0)},
            'reason_run': {'S': reason.run_id}, 'reason_failure': {'S': reason.failure},
            'reason_comment': {'S': reason.comment}, 'proposed_by': {'S': by.id},
            'proposed_by_kind': {'S': by.kind}, 'created_at': {'S': self.now().isoformat()},
            'restores': {'N': str(restores)}}
        for name, rate in (('benchmark_before', benchmark.before), ('benchmark_after', benchmark.after)):
            if rate is not None:
                item[name] = {'N': repr(rate)}
        size = item_bytes(item)
        if size > MAX_ITEM_BYTES:
            raise SkillError(f'the version row would be {size} bytes, over its {MAX_ITEM_BYTES}-byte cap: '
                             'write a shorter skill or a smaller change')
        return item

    def _base(self, ws: str, connection: str, role: str, base: SkillRef | None) -> SkillContent | None:
        if base is None:
            return None
        if base.connection not in {connection, SHARED}:
            raise SkillError("a version is written on its own scope's version, or the shared skill's")
        found = self.version(ws, base.connection, role, base.version)
        if found.status != ACCEPTED:
            raise SkillConflict('a version is written on an accepted version')
        return found.skill.content

    def propose_version(self, ws: str, connection: str, role: str, content: SkillContent, *, proposer: Actor,
                        reason: Reason, base: SkillRef | None, benchmark: Benchmark | None = None) -> Change:
        """``content`` as the scope's next version, proposed. ``base``: the version it was written on, as
        ``resolved`` named it then (None for the first one); accepting it needs that one still current."""
        return self._propose(ws, connection, role, content, proposer=proposer, reason=reason, base=base,
                             benchmark=benchmark or Benchmark())

    def _coach_guard(self, ws: str, connection: str, role: str, proposer: Actor, reason: Reason) -> dict[str, Any]:
        """The coach's checks; its ``RUN#<run>#<failure>`` row, the one proposal for that run's failure."""
        if not connection:
            raise SkillForbidden("the coach writes a connection's version only: the shared skill is a person's")
        if proposer.connection != connection:
            raise SkillForbidden("the coach writes only the skill of the connection its run is for")
        if not (reason.run_id and reason.failure):
            raise SkillError("the coach's version names the run and the failure it came from")
        guard = self._key(ws, connection, role, f'RUN#{reason.run_id}#{reason.failure}')
        if get_row(self.client, self.table, guard) is not None:
            raise SkillConflict(f"the coach has proposed a version for this run's {reason.failure} already")
        return {**guard, 'by': {'S': proposer.id}}

    def _propose(self, ws: str, connection: str, role: str, content: SkillContent, *, proposer: Actor,
                 reason: Reason, base: SkillRef | None, benchmark: Benchmark,
                 promoted_from: SkillRef | None = None) -> Change:
        _pk(ws, connection, role)
        guard = self._coach_guard(ws, connection, role, proposer, reason) if proposer.kind == 'agent' else None
        if not connection and reason.from_a_run:
            raise SkillError("the shared skill's why is a person's comment: a run and its failure belong to a "
                             "connection's version (promote one by writing it again without its text)")
        base_content = self._base(ws, connection, role, base)
        changed = content.person_fields_changed(base_content)
        if proposer.kind == 'agent' and changed:
            raise SkillForbidden(f'only a person changes {", ".join(changed)}: the coach proposes instructions '
                                 'and examples only')
        Skill(role, 1, content)   # refused before a version number is spent
        change = diff(base_content, content)
        line = summary(role, 'proposed', _label(base, connection) if base else '', 'v?', change, scope=connection)
        self._item(ws, connection, Skill(role, 999_999, content), status=PROPOSED, base=base, reason=reason,
                   benchmark=benchmark, change=change, line=line, by=proposer)   # the size, before a number
        version = self._next_version(ws, connection, role)
        skill = Skill(role, version, content)
        line = summary(role, 'proposed', _label(base, connection) if base else '',
                       _label(SkillRef(connection, version), connection), change, scope=connection)
        item = self._item(ws, connection, skill, status=PROPOSED, base=base, reason=reason, benchmark=benchmark,
                          change=change, line=line, by=proposer)
        puts = [_put(item, self.table)]
        if guard is not None:
            puts.append(_put({**guard, 'version': {'N': str(version)}}, self.table))
        if promoted_from is not None:
            puts.append(_put({**self._key(ws, connection, role, f'LOG#{version:06d}#{PROMOTED_FROM}'),
                              'event': {'S': PROMOTED_FROM}, 'by': {'S': proposer.id}, 'at': {'S': self.now().isoformat()},
                              'version': {'N': str(version)}, 'source_connection': {'S': promoted_from.connection},
                              'source_version': {'N': str(promoted_from.version)}}, self.table))
        try:
            self.client.transact_write_items(TransactItems=puts)
        except ClientError as exc:
            if is_key_collision(exc, put_index=0):
                raise SkillConflict(f'version {version} already has a row: the counter is behind') from exc
            if guard is not None and is_key_collision(exc, put_index=1):
                raise SkillConflict(f"the coach has proposed a version for this run's {reason.failure} "
                                    'already') from exc
            raise
        row = SkillVersion.from_item(item)
        return Change(row, self._announce(ws, 'proposed', row, base))

    def promote_version(self, ws: str, role: str, source: SkillRef, content: SkillContent, *, by: Actor,
                        reason: Reason, base: SkillRef | None) -> Change:
        """An administrator's new shared version, written from ``source`` (a connection's accepted version):
        refused when it adds an instruction line or example text of ``MIN_COPIED_TEXT`` characters or more (case
        and spacing aside) that ``source`` adds to the shared skill too. ``base``: the shared version it is
        written on."""
        _admin(by, 'promotes')
        if not source.connection:
            raise SkillError("a promotion is written from a connection's version")
        if base is not None and base.connection:
            raise SkillError("a promoted version is written on the shared skill's version")
        found = self.version(ws, source.connection, role, source.version)
        if found.status != ACCEPTED:
            raise SkillConflict('only an accepted version is promoted')
        shared = self._base(ws, SHARED, role, base)
        copied = _own_text(diff(shared, found.skill.content)) & _own_text(diff(shared, content))
        if copied:
            raise SkillError(f'the shared skill is written without {source.connection}\'s text: {len(copied)} '
                             'line(s) or example text(s) are copied from its version; write them in general terms')
        return self._propose(ws, SHARED, role, content, proposer=by, reason=reason, base=base,
                             benchmark=Benchmark(), promoted_from=source)

    def _transact(self, items: list[dict[str, Any]], conflict: str) -> None:
        transact_or_refuse(self.client, items, SkillConflict(conflict))

    def _log(self, ws: str, connection: str, role: str, version: int, event: str, by: Actor, at: str,
             comment: str = '') -> dict[str, Any]:
        item = {**self._key(ws, connection, role, f'LOG#{version:06d}#{event}'), 'by': {'S': by.id},
                'at': {'S': at}, 'version': {'N': str(version)}, 'event': {'S': event}}
        if comment:
            item['comment'] = {'S': comment}
        return _put(item, self.table)

    def accept_version(self, ws: str, connection: str, role: str, version: int, by: Actor) -> Change:
        """An administrator accepts a proposed version: it becomes the scope's current one."""
        _admin(by, 'accepts')
        found = self.version(ws, connection, role, version)
        if found.status == ACCEPTED:
            return Change(found, None)
        if found.status != PROPOSED:
            raise SkillConflict(f'version {version} is {found.status}')
        resolved = self.resolved(ws, connection, role)
        if resolved != found.base:
            now = _label(resolved, connection) if resolved else 'none'
            raise SkillConflict(f'version {version} was written on '
                                f'{_label(found.base, connection) if found.base else "no version"}, and {now} '
                                'is current now: propose it again on the current version')
        at = self.now().isoformat()
        base = found.base
        own = base is not None and base.connection == connection
        head: dict[str, Any] = {'TableName': self.table, 'Key': self._key(ws, connection, role, HEAD),
                                'UpdateExpression': 'SET current_version = :v',
                                'ExpressionAttributeValues': {':v': {'N': str(version)}}}
        if own and base:
            head['ConditionExpression'] = 'current_version = :base'
            head['ExpressionAttributeValues'][':base'] = {'N': str(base.version)}
        else:
            head['ConditionExpression'] = 'attribute_not_exists(current_version)'
        items: list[dict[str, Any]] = [
            {'Update': {'TableName': self.table, 'Key': self._key(ws, connection, role, f'VER#{version:06d}'),
                        'UpdateExpression': 'SET #s = :accepted, accepted_by = :by, accepted_at = :at',
                        'ConditionExpression': '#s = :proposed', 'ExpressionAttributeNames': {'#s': 'status'},
                        'ExpressionAttributeValues': {':accepted': {'S': ACCEPTED}, ':proposed': {'S': PROPOSED},
                                                      ':by': {'S': by.id}, ':at': {'S': at}}}},
            {'Update': head},
            self._log(ws, connection, role, version, ACCEPTED, by, at),
        ]
        if connection and not own:
            # Written on the shared skill (or on nothing): the shared skill must not have moved either.
            check: dict[str, Any] = {'TableName': self.table, 'Key': self._key(ws, SHARED, role, HEAD)}
            if base:
                check['ConditionExpression'] = 'current_version = :base'
                check['ExpressionAttributeValues'] = {':base': {'N': str(base.version)}}
            else:
                check['ConditionExpression'] = 'attribute_not_exists(current_version)'
            items.append({'ConditionCheck': check})
        self._transact(items, 'the version or the current one changed meanwhile: read them again')
        row = self.version(ws, connection, role, version)
        return Change(row, self._announce(ws, 'accepted', row, base))

    def reject_version(self, ws: str, connection: str, role: str, version: int, by: Actor,
                       comment: str = '') -> SkillVersion:
        """An administrator rejects a proposed version (it stays, marked rejected, with who, when and why)."""
        _admin(by, 'rejects')
        if comment:
            Reason(comment=comment)
        found = self.version(ws, connection, role, version)
        if found.status == REJECTED:
            return found
        if found.status != PROPOSED:
            raise SkillConflict(f'version {version} is {found.status}')
        at = self.now().isoformat()
        self._transact([
            {'Update': {'TableName': self.table, 'Key': self._key(ws, connection, role, f'VER#{version:06d}'),
                        'UpdateExpression': 'SET #s = :rejected, rejected_by = :by, rejected_at = :at',
                        'ConditionExpression': '#s = :proposed', 'ExpressionAttributeNames': {'#s': 'status'},
                        'ExpressionAttributeValues': {':rejected': {'S': REJECTED}, ':proposed': {'S': PROPOSED},
                                                      ':by': {'S': by.id}, ':at': {'S': at}}}},
            self._log(ws, connection, role, version, REJECTED, by, at, comment),
        ], 'the version changed meanwhile: read it again')
        return self.version(ws, connection, role, version)

    def roll_back_to(self, ws: str, connection: str, role: str, to_version: int, by: Actor,
                     comment: str = '') -> Change:
        """An administrator's one click: a new version of the same scope restoring ``to_version`` (an earlier
        accepted one), current at once and logged as ``rolled_back``; every version before it stays."""
        _admin(by, 'rolls back')
        target = self.version(ws, connection, role, to_version)
        if target.status != ACCEPTED:
            raise SkillConflict(f'version {to_version} was never accepted: only an accepted version is restored')
        current = self._current(ws, connection, role)
        if current == to_version:
            raise SkillConflict(f'version {to_version} is current already')
        if not current:
            raise SkillConflict('this scope has no current version of its own to roll back')
        base = SkillRef(connection, current)
        change = diff(self.version(ws, connection, role, current).skill.content, target.skill.content)
        reason = Reason(comment=comment or f'rolled back to v{to_version}')
        version = self._next_version(ws, connection, role)
        skill = Skill(role, version, target.skill.content)
        at = self.now().isoformat()
        line = summary(role, 'rolled_back', _label(base, connection), _label(SkillRef(connection, version), connection),
                       change, restores=to_version, scope=connection)
        item = self._item(ws, connection, skill, status=ACCEPTED, base=base, reason=reason,
                          benchmark=Benchmark(), change=change, line=line, by=by, restores=to_version)
        item.update({'accepted_by': {'S': by.id}, 'accepted_at': {'S': at}})
        self._transact([
            _put(item, self.table),
            {'Update': {'TableName': self.table, 'Key': self._key(ws, connection, role, HEAD),
                        'UpdateExpression': 'SET current_version = :v', 'ConditionExpression': 'current_version = :cur',
                        'ExpressionAttributeValues': {':v': {'N': str(version)}, ':cur': {'N': str(current)}}}},
            self._log(ws, connection, role, version, ROLLED_BACK, by, at, reason.comment),
        ], 'the current version changed meanwhile: read it again')
        row = SkillVersion.from_item(item)
        return Change(row, self._announce(ws, 'rolled_back', row, base))
