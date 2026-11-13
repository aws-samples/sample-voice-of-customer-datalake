"""The agents' memory store: every edit a new version (D1) with its author (D4), a learned memory a draft until it
is approved, forget = archived and restorable; a person's memories erased only for a legal obligation (D5).

Rows in the ``voc-engineering`` table, one partition per scope (``model.Scope.partition``), each memory's rows
keyed under the connection it applies to (``''`` for a person's own memory), so one connection's memories of a
person are read, and counted, apart from another's::

    WS#<ws>#AMEM#REPO#<connection>          / MEM#<connection>#<id>   the memory: its status, latest and approved
    WS#<ws>#AMEM#ROLE#<connection>#<role>   / MEM#<connection>#<id>   version, the approved statement, its
    WS#<ws>#AMEM#PERSON#<user>              / MEM#<connection>#<id>   confirmations, a revision (the lock)
                                            / VER#<id>#<version:06d>  a version (create-only): statement, provenance,
                                                                      confidence, review date, author, approver
                                            / LOG#<id>#<revision:06d> approved, forgotten or restored: who and when
                                                                      (create-only)
                                            / CONF#<id>#<source hash> one confirmation per run or person (the first:
                                                                      its own source), at most MAX_CONFIRMATIONS
    WS#<ws>#AMEM#PERSON#<user>              / REF#<partition>         a partition whose rows name the person (as an
                                                                      author, approver or confirmer), for erasure
    AUDIT#tombstone#agent_memory_person     / <sha256 of the user id> an erased person: legal basis, who, when
    AUDIT#delete                            / <iso>#<random>          the erasure's delete record (shared/delete_audit
                                                                      field names): what, who, when, why

Who does what (the routes, planned, check that the caller may read the connection; this store checks the rest).
An agent is always a ``RunContext``: its connection, run, role and the people on its task, from the run's record.

- **Learn** (an agent): only into its run's connection, a role's lessons only for its own role, a person's memory
  only for a person on its task who is a signed-in user of this deployment (``is_user``) and was never erased; with
  a provenance of its own run or a review comment on the connection's host, at the memory layer's confidence for
  an automated write. Always a draft. The same statement on the same subject already in the scope is a
  confirmation of that memory instead; one that matches a forgotten memory is refused (a person can restore it).
- **Write** (a person): a repository or role memory is approved at once when an administrator writes it, else a
  draft; a person's own memory is theirs, approved at once.
- **Approve**: a repository's or a role's draft by an administrator, a person's by that person (an administrator
  never approves, nor reads, a person's memory). One transaction marks the version approved, moves the approved
  version up (never down, never onto a version written on an older one than the approved) and writes the log row.
- **Edit** (a person who may write the scope): a new version on the latest one, approved at once when its author
  may approve, else a draft.
- **Forget / restore** (whoever approves the scope): archived, out of every recall, and back.
- **Confirm**: an agent from its own run only, a person as themselves only, each source once; a memory stops
  counting at ``MAX_CONFIRMATIONS``. An approved repository or role memory confirmed ``PACK_CONFIRMATIONS`` times is
  proposed for the knowledge pack (``PackProposal``, returned, never written).
- **Recall** (``recall_for_task``): the run's connection's repository memories, its role's lessons there and the
  memories of the people on its task that apply to that connection; approved, live, bounded and fenced.
- **Erase a person** (an administrator, for a legal obligation: ``erase_person_memories``): the tombstone and the
  delete record first, then every row naming them in other scopes de-identified (one random ``erased-…`` id for
  the whole erasure), then every row of their partition deleted. Nothing else is ever deleted.

Every read is bounded: a scope holds at most ``MAX_PER_SCOPE`` live and ``MAX_STORED_PER_SCOPE`` memories in all
per connection (a person's: per person and connection), and a memory at most ``MAX_CONFIRMATIONS`` + 1
confirmation rows. Only an erasure reads a partition whole.
"""
from __future__ import annotations

import json
import secrets
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, fields, replace
from datetime import UTC, date, datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from engineering.agent_memory.model import (
    LEARNED_CONFIDENCE_MIN,
    PACK_CONFIRMATIONS,
    PACK_DOCUMENT,
    SCOPE_KINDS,
    AgentMemoryError,
    MemoryInput,
    PackProposal,
    Provenance,
    RunContext,
    Scope,
    ScopeKind,
    check_confidence,
    check_feedback_ids,
    check_kind,
    check_subject,
    clean_statement,
    review_date,
    same_statement,
)
from engineering.agent_memory.recall import DEFAULT_MAX_CHARS, DEFAULT_MAX_MEMORIES, Candidate, Recall, assemble
from engineering.bus.schema import WS
from engineering.knowledge.notes import CitationRules
from engineering.knowledge.store import Actor
from engineering.rows import create_only as _put
from engineering.rows import get_row, partition_rows, transact_or_refuse, whole_partition
from engineering.rows import number_value as _number
from engineering.rows import text_value as _text
from shared.delete_audit import AUDIT_PK
from shared.digests import sha256_hex
from shared.ids import is_key_collision
from shared.legal_basis import required_legal_basis

#: A memory's status, as the memory layer names them: a draft (no approved version yet), active, or forgotten.
PROPOSED, ACTIVE, ARCHIVED = 'proposed', 'active', 'archived'
#: A version's status.
DRAFT, APPROVED = 'draft', 'approved'
FORGOTTEN, RESTORED = 'forgotten', 'restored'
#: Per scope and connection (a person's: per person and connection): live memories, and memories in all.
MAX_PER_SCOPE: Final = 200
MAX_STORED_PER_SCOPE: Final = 500
#: Distinct sources a memory counts, beyond the one it was learned from; past it, it is confirmed enough.
MAX_CONFIRMATIONS: Final = 20
TOMBSTONE_PK: Final = 'AUDIT#tombstone#agent_memory_person'
ERASED_KIND: Final = 'agent_memory_person'
#: The attributes of a version, log or memory row that name a person.
_PERSON_ATTRS: Final = ('author', 'prov_person', 'approved_by', 'by')


class AgentMemoryNotFound(AgentMemoryError):
    kind = 'not_found'


class AgentMemoryForbidden(AgentMemoryError):
    kind = 'forbidden'


class AgentMemoryConflict(AgentMemoryError):
    kind = 'conflict'


_SCOPE_KIND_OF: Final[Mapping[str, ScopeKind]] = {kind: kind for kind in SCOPE_KINDS}


def _fraction(value: Any) -> float:
    """A low-level number attribute as a float, 0 when it is absent or not one."""
    return float(value['N']) if isinstance(value, dict) and 'N' in value else 0.0


_READ_ATTR: Final[Mapping[str, Callable[[Any], Any]]] = {'str': _text, 'int': _number, 'float': _fraction}


def _plain_fields(cls: type, item: Mapping[str, Any]) -> dict[str, Any]:
    """Each ``str``, ``int`` and ``float`` field of the dataclass ``cls``, read from the low-level item's attribute
    of the same name (``''``, 0 or 0.0 when it is absent)."""
    return {f.name: _READ_ATTR[str(f.type)](item.get(f.name)) for f in fields(cls) if str(f.type) in _READ_ATTR}


def _scope_of(item: Mapping[str, Any]) -> Scope:
    kind = _SCOPE_KIND_OF.get(_text(item.get('scope_kind')))
    if kind is None:
        raise AgentMemoryError('a stored memory names no scope')
    return Scope(kind, _text(item.get('connection')), _text(item.get('role')), _text(item.get('person')))


@dataclass(frozen=True)
class MemoryVersion:
    memory_id: str
    version: int
    status: str
    statement: str
    confidence: float
    review_by: str
    provenance: Provenance
    feedback_ids: tuple[str, ...]
    author: str
    author_kind: str
    base_version: int
    created_at: str
    approved_by: str = ''
    approved_at: str = ''

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> MemoryVersion:
        provenance = Provenance(_text(item.get('prov_run')), _text(item.get('prov_comment')),
                                _text(item.get('prov_person')))
        return cls(**_plain_fields(cls, item), provenance=provenance,
                   feedback_ids=tuple(json.loads(_text(item.get('feedback_ids')) or '[]')))


@dataclass(frozen=True)
class AgentMemory:
    """A memory as it stands: ``statement``, ``confidence`` and ``review_by`` are its approved version's (``''``,
    0 and ``''`` before one is approved); ``latest_statement`` is its latest version's."""

    memory_id: str
    scope: Scope
    subject: str
    kind: str
    status: str
    latest_version: int
    approved_version: int
    statement: str
    latest_statement: str
    confidence: float
    review_by: str
    confirmations: int
    revision: int
    created_at: str
    updated_at: str

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> AgentMemory:
        return cls(**_plain_fields(cls, item), scope=_scope_of(item))


@dataclass(frozen=True)
class Learned:
    memory: AgentMemory
    #: True when the statement was in the scope already: that memory was confirmed, none was created.
    confirmed: bool
    proposal: PackProposal | None = None


@dataclass(frozen=True)
class Confirmation:
    memory: AgentMemory
    #: False when this source had confirmed the memory already, or the memory counts no more sources.
    counted: bool
    proposal: PackProposal | None = None


@dataclass(frozen=True)
class Erasure:
    """What an erasure did: the person's rows deleted, the rows elsewhere de-identified, and in how many
    partitions."""

    deleted: int
    deidentified: int
    partitions: int


def _check_ws(ws: str) -> None:
    if not WS.fullmatch(ws):
        raise AgentMemoryError('not a workspace id')


def may_approve(scope: Scope, actor: Actor) -> bool:
    """A repository's or a role's memory: an administrator; a person's: that person (never an agent)."""
    if actor.kind != 'person':
        return False
    return actor.id == scope.person if scope.kind == 'person' else actor.admin


def _approver(scope: Scope, actor: Actor, what: str) -> None:
    if not may_approve(scope, actor):
        who = 'the person it is about' if scope.kind == 'person' else 'an administrator'
        raise AgentMemoryForbidden(f'only {who} {what} a {scope.kind} memory')


def _writer(scope: Scope, actor: Actor) -> None:
    if actor.kind != 'person':
        raise AgentMemoryForbidden('an agent learns a memory; only a person writes or edits one')
    if scope.kind == 'person' and actor.id != scope.person:
        raise AgentMemoryForbidden("a person's memory is written and edited only by that person")


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _new_id() -> str:
    return f'amem_{secrets.token_hex(8)}'


@dataclass(frozen=True)
class AgentMemoryStore:
    #: A low-level DynamoDB client on ``voc-engineering``.
    client: Any
    table: str
    #: Whether a user id is a signed-in user of this deployment (its user directory): a person memory is never kept
    #: for anyone else, such as someone who exists only on the repository host.
    is_user: Callable[[str], bool]
    now: Callable[[], datetime] = _utc_now
    new_id: Callable[[], str] = _new_id

    # ── reads ────────────────────────────────────────────────────────────────
    def _key(self, ws: str, scope: Scope, sk: str) -> dict[str, Any]:
        _check_ws(ws)
        return {'pk': {'S': scope.partition(ws)}, 'sk': {'S': sk}}

    def _heads(self, ws: str, scope: Scope) -> list[AgentMemory]:
        """The memories of the scope that apply to its connection (bounded: ``MAX_STORED_PER_SCOPE``)."""
        _check_ws(ws)
        items = partition_rows(self.client, self.table, scope.partition(ws), f'MEM#{scope.connection}#',
                               max_items=MAX_STORED_PER_SCOPE)
        return [AgentMemory.from_item(item) for item in items]

    def _row(self, ws: str, scope: Scope, sk: str, what: str) -> dict[str, Any]:
        found = get_row(self.client, self.table, self._key(ws, scope, sk))
        if found is None:
            raise AgentMemoryNotFound(f'no such {what}')
        return found

    def _head(self, ws: str, scope: Scope, memory_id: str) -> AgentMemory:
        found = AgentMemory.from_item(self._row(ws, scope, f'MEM#{scope.connection}#{memory_id}', 'memory'))
        if found.scope != scope:
            raise AgentMemoryNotFound('no such memory')
        return found

    def _version(self, ws: str, scope: Scope, memory_id: str, version: int) -> MemoryVersion:
        return MemoryVersion.from_item(self._row(ws, scope, f'VER#{memory_id}#{version:06d}', 'version'))

    def agent_memory_history(self, ws: str, scope: Scope, memory_id: str, *, by: Actor) -> list[MemoryVersion]:
        """Every version of a memory, oldest first (D1: none is replaced). A person's are read by that person only."""
        _writer(scope, by)
        head = self._head(ws, scope, memory_id)
        return [self._version(ws, scope, memory_id, n) for n in range(1, head.latest_version + 1)]

    def pending_agent_memories(self, ws: str, scope: Scope, *,
                               by: Actor) -> list[tuple[AgentMemory, MemoryVersion]]:
        """What waits for its approver: each live memory whose latest version is a draft, with that version."""
        _approver(scope, by, 'reviews')
        return [(head, self._version(ws, scope, head.memory_id, head.latest_version))
                for head in self._heads(ws, scope)
                if head.status != ARCHIVED and head.latest_version > head.approved_version]

    def _erased(self, ws: str, person: str) -> bool:
        _check_ws(ws)
        return get_row(self.client, self.table, {'pk': {'S': TOMBSTONE_PK}, 'sk': {'S': sha256_hex(person)}}) is not None

    # ── checks ───────────────────────────────────────────────────────────────
    def _check_run(self, ws: str, scope: Scope, run: RunContext, *, learning: bool) -> None:
        """An agent acts only within its run: its connection, its own role's lessons, the people on its task. A
        learned person memory applies to the run's connection; a person's own one is read and confirmed only."""
        allowed = {run.connection} if learning or scope.kind != 'person' else {run.connection, ''}
        if scope.connection not in allowed:
            raise AgentMemoryForbidden('an agent remembers only for the connection its run is for')
        if scope.kind == 'role' and scope.role != run.role:
            raise AgentMemoryForbidden("an agent learns and confirms its own role's lessons only")
        if scope.kind == 'person':
            if scope.person not in run.people:
                raise AgentMemoryForbidden("an agent remembers only the people on its task")
            if not self.is_user(scope.person) or self._erased(ws, scope.person):
                raise AgentMemoryForbidden('a person memory is kept only for a signed-in user of this deployment')

    def _check_provenance(self, provenance: Provenance, by: Actor | RunContext, rules: CitationRules | None) -> None:
        if provenance.comment_url and (rules is None or not rules.valid(provenance.comment_url)):
            raise AgentMemoryError("a comment's provenance is a review comment on the connection's own host")
        if isinstance(by, RunContext):
            if provenance.person:
                raise AgentMemoryError("an agent's provenance is its run or a review comment, never a person")
            if provenance.run_id and provenance.run_id != by.run_id:
                raise AgentMemoryForbidden("an agent's provenance is its own run")
        elif provenance.run_id:
            raise AgentMemoryError("a person's provenance is themselves or a review comment, never a run")
        elif provenance.person and (provenance.person != by.id or not self.is_user(provenance.person)):
            raise AgentMemoryForbidden('a person speaks only for themselves, as a signed-in user of this deployment')

    # ── writes ───────────────────────────────────────────────────────────────
    def _transact(self, items: list[dict[str, Any]], conflict: str) -> None:
        transact_or_refuse(self.client, items, AgentMemoryConflict(conflict))

    def _reference(self, ws: str, scope: Scope, person: str) -> list[dict[str, Any]]:
        """The person's ``REF#`` row for ``scope``'s partition (an unconditional Put: the same row each time), so an
        erasure finds every partition naming them; none for their own partition, which an erasure deletes."""
        own = Scope('person', person=person)
        if own.partition(ws) == scope.partition(ws):
            return []
        if self._erased(ws, person):
            # Never a REF# row in an erased person's deleted partition: whatever path got here, they are refused.
            raise AgentMemoryForbidden('this person was erased: nothing is remembered of them again')
        return [{'Put': {'TableName': self.table, 'Item': {
            **self._key(ws, own, f'REF#{scope.partition(ws)}'), 'partition': {'S': scope.partition(ws)}}}}]

    def _log(self, ws: str, scope: Scope, memory_id: str, revision: int, event: str, by: Actor, at: str,
             version: int) -> list[dict[str, Any]]:
        """The create-only log row, and the actor's reference when a person writes it."""
        row = _put({**self._key(ws, scope, f'LOG#{memory_id}#{revision:06d}'), 'event': {'S': event},
                    'by': {'S': by.id}, 'by_kind': {'S': by.kind}, 'at': {'S': at},
                    'version': {'N': str(version)}}, self.table)
        return [row, *(self._reference(ws, scope, by.id) if by.kind == 'person' else [])]

    def _version_item(self, ws: str, scope: Scope, memory_id: str, version: int, *, approved: bool, statement: str,
                      confidence: float, review_by: str, provenance: Provenance, feedback_ids: Sequence[str],
                      by: Actor, base_version: int, at: str) -> dict[str, Any]:
        item: dict[str, Any] = {
            **self._key(ws, scope, f'VER#{memory_id}#{version:06d}'), 'memory_id': {'S': memory_id},
            'version': {'N': str(version)}, 'status': {'S': APPROVED if approved else DRAFT},
            'statement': {'S': statement}, 'confidence': {'N': repr(confidence)}, 'review_by': {'S': review_by},
            'prov_run': {'S': provenance.run_id}, 'prov_comment': {'S': provenance.comment_url},
            'prov_person': {'S': provenance.person}, 'feedback_ids': {'S': json.dumps(list(feedback_ids))},
            'author': {'S': by.id}, 'author_kind': {'S': by.kind}, 'base_version': {'N': str(base_version)},
            'created_at': {'S': at}}
        if approved:
            item.update({'approved_by': {'S': by.id}, 'approved_at': {'S': at}})
        return item

    def learn_agent_memory(self, ws: str, scope: Scope, memory: MemoryInput, *, run: RunContext,
                           review_texts: Iterable[str], rules: CitationRules | None = None) -> Learned:
        """An agent's learned memory, a draft (or a confirmation of the same statement already in the scope).
        ``review_texts``: the reviews the run cited (required: the review-quote check is never skipped);
        ``rules``: the connection's host, for a comment's provenance."""
        self._check_run(ws, scope, run, learning=True)
        self._check_provenance(memory.provenance, run, rules)
        if check_confidence(memory.confidence) < LEARNED_CONFIDENCE_MIN:
            raise AgentMemoryError(f'a learned memory needs a confidence of {LEARNED_CONFIDENCE_MIN} or more; '
                                   'this one is not kept')
        return self._create(ws, scope, memory, by=run.agent, review_texts=review_texts, learned=True)

    def write_agent_memory(self, ws: str, scope: Scope, memory: MemoryInput, *, by: Actor,
                           review_texts: Iterable[str], rules: CitationRules | None = None) -> Learned:
        """A person's memory: approved at once when they may approve the scope (an administrator for a repository
        or a role, the person for their own), else a draft."""
        _writer(scope, by)
        if not self.is_user(by.id) or self._erased(ws, by.id):
            raise AgentMemoryForbidden('only a signed-in user of this deployment writes a memory')
        self._check_provenance(memory.provenance, by, rules)
        # A person's memory is theirs to state: its confidence is 1.
        return self._create(ws, scope, replace(memory, confidence=1.0), by=by, review_texts=review_texts,
                            learned=False)

    def _create(self, ws: str, scope: Scope, memory: MemoryInput, *, by: Actor, review_texts: Iterable[str],
                learned: bool) -> Learned:
        subject, kind = check_subject(memory.subject), check_kind(scope, memory.kind)
        statement = clean_statement(memory.statement, review_texts)
        feedback_ids = check_feedback_ids(memory.feedback_ids)
        now = self.now()
        review_by = review_date(now.date(), memory.review_by).isoformat()
        heads = self._heads(ws, scope)
        for head in heads:
            said = [s for s in (head.statement, head.latest_statement) if s]
            if head.subject != subject or not any(same_statement(s, statement) for s in said):
                continue
            if head.status != ARCHIVED:
                confirmed = self._confirm(ws, head, memory.provenance, by)
                return Learned(confirmed.memory, True, confirmed.proposal)
            if learned:
                raise AgentMemoryConflict('this memory was forgotten: automation never learns it again '
                                          '(a person can restore it)')
        if sum(head.status != ARCHIVED for head in heads) >= MAX_PER_SCOPE:
            raise AgentMemoryConflict(f'this scope holds {MAX_PER_SCOPE} memories already: forget some first')
        if len(heads) >= MAX_STORED_PER_SCOPE:
            raise AgentMemoryConflict(f'this scope holds {MAX_STORED_PER_SCOPE} memories, forgotten ones included: '
                                      'restore and edit a forgotten one instead')
        approved = not learned and may_approve(scope, by)
        memory_id, at = self.new_id(), now.isoformat()
        confidence = check_confidence(memory.confidence)
        head_item: dict[str, Any] = {
            **self._key(ws, scope, f'MEM#{scope.connection}#{memory_id}'), 'memory_id': {'S': memory_id},
            'scope_kind': {'S': scope.kind}, 'connection': {'S': scope.connection}, 'role': {'S': scope.role},
            'person': {'S': scope.person}, 'subject': {'S': subject}, 'kind': {'S': kind},
            'status': {'S': ACTIVE if approved else PROPOSED}, 'latest_version': {'N': '1'},
            'approved_version': {'N': '1' if approved else '0'}, 'latest_statement': {'S': statement},
            'statement': {'S': statement if approved else ''},
            'confidence': {'N': repr(confidence if approved else 0.0)},
            'review_by': {'S': review_by if approved else ''}, 'confirmations': {'N': '0'},
            'revision': {'N': '1'}, 'created_at': {'S': at}, 'updated_at': {'S': at}}
        items = [_put(head_item, self.table),
                 _put(self._version_item(ws, scope, memory_id, 1, approved=approved, statement=statement,
                                         confidence=confidence, review_by=review_by, provenance=memory.provenance,
                                         feedback_ids=feedback_ids, by=by, base_version=0, at=at), self.table),
                 # The source it was learned from never confirms it again.
                 _put(self._confirmation_item(ws, scope, memory_id, memory.provenance, at), self.table)]
        if approved:
            items += self._log(ws, scope, memory_id, 1, APPROVED, by, at, 1)
        elif by.kind == 'person':
            items += self._reference(ws, scope, by.id)
        self._transact(items, 'a memory with this id exists already: try again')
        return Learned(AgentMemory.from_item(head_item), False)

    def _confirmation_item(self, ws: str, scope: Scope, memory_id: str, provenance: Provenance,
                           at: str) -> dict[str, Any]:
        return {**self._key(ws, scope, f'CONF#{memory_id}#{sha256_hex(provenance.source)[:24]}'),
                'source': {'S': provenance.source}, 'comment_url': {'S': provenance.comment_url}, 'at': {'S': at}}

    def _confirm(self, ws: str, head: AgentMemory, provenance: Provenance, by: Actor) -> Confirmation:
        scope = head.scope
        if head.confirmations >= MAX_CONFIRMATIONS:
            return Confirmation(head, False, self._proposal(ws, head))
        conf = self._confirmation_item(ws, scope, head.memory_id, provenance, self.now().isoformat())
        try:
            self.client.transact_write_items(TransactItems=[
                _put(conf, self.table),
                {'Update': {'TableName': self.table, 'Key': self._key(ws, scope, f'MEM#{scope.connection}#'
                                                                                   f'{head.memory_id}'),
                            'UpdateExpression': 'ADD confirmations :one',
                            'ConditionExpression': '#s <> :archived AND confirmations < :cap',
                            'ExpressionAttributeNames': {'#s': 'status'},
                            'ExpressionAttributeValues': {':one': {'N': '1'}, ':archived': {'S': ARCHIVED},
                                                          ':cap': {'N': str(MAX_CONFIRMATIONS)}}}},
                *(self._reference(ws, scope, by.id) if provenance.person else [])])
        except ClientError as exc:
            if is_key_collision(exc, put_index=0):
                return Confirmation(self._head(ws, scope, head.memory_id), False)
            if is_key_collision(exc, put_index=1):
                found = self._head(ws, scope, head.memory_id)
                if found.status == ARCHIVED:
                    raise AgentMemoryConflict('the memory was forgotten meanwhile') from exc
                return Confirmation(found, False)
            raise
        found = self._head(ws, scope, head.memory_id)
        return Confirmation(found, True, self._proposal(ws, found))

    def confirm_agent_memory(self, ws: str, scope: Scope, memory_id: str, *,
                             by: Actor | RunContext) -> Confirmation:
        """One more source saying a memory still holds: an agent's own run (from its ``RunContext``, within its
        run as ``learn_agent_memory`` is), or a person as themselves; each source counts once."""
        if isinstance(by, RunContext):
            self._check_run(ws, scope, by, learning=False)
            provenance, actor = Provenance(run_id=by.run_id), by.agent
        else:
            if by.kind != 'person' or not self.is_user(by.id) or self._erased(ws, by.id):
                raise AgentMemoryForbidden('an agent confirms from its run; a person as a signed-in user')
            if scope.kind == 'person' and by.id != scope.person:
                raise AgentMemoryForbidden("a person's memory is confirmed by its agents and by that person only")
            provenance, actor = Provenance(person=by.id), by
        head = self._head(ws, scope, memory_id)
        if head.status == ARCHIVED:
            raise AgentMemoryConflict('a forgotten memory is not confirmed: restore it first')
        return self._confirm(ws, head, provenance, actor)

    def _proposal(self, ws: str, head: AgentMemory) -> PackProposal | None:
        if head.scope.kind == 'person' or head.status != ACTIVE or head.confirmations < PACK_CONFIRMATIONS:
            return None
        version = self._version(ws, head.scope, head.memory_id, head.approved_version)
        confirmations = partition_rows(self.client, self.table, head.scope.partition(ws), f'CONF#{head.memory_id}#',
                                       max_items=MAX_CONFIRMATIONS + 1)
        urls = {version.provenance.comment_url, *(_text(item.get('comment_url')) for item in confirmations)}
        return PackProposal(connection=head.scope.connection, memory_id=head.memory_id, version=version.version,
                            document=PACK_DOCUMENT[head.kind], subject=head.subject, claim=head.statement,
                            confirmations=head.confirmations, citations=tuple(sorted(urls - {''})),
                            feedback_ids=version.feedback_ids)

    def approve_agent_memory(self, ws: str, scope: Scope, memory_id: str, version: int, *, by: Actor) -> AgentMemory:
        """The approver makes a draft version the memory's approved one (approving it again answers it as it is)."""
        _approver(scope, by, 'approves')
        head = self._head(ws, scope, memory_id)
        row = self._version(ws, scope, memory_id, version)
        if row.status == APPROVED:
            return head
        if head.status == ARCHIVED:
            raise AgentMemoryConflict('a forgotten memory is restored before a version of it is approved')
        if version < head.approved_version or row.base_version < head.approved_version:
            raise AgentMemoryConflict(f'version {version} was written on version {row.base_version}, and version '
                                      f'{head.approved_version} is approved since: edit that one instead')
        at, revision = self.now().isoformat(), head.revision + 1
        self._transact([
            {'Update': {'TableName': self.table, 'Key': self._key(ws, scope, f'VER#{memory_id}#{version:06d}'),
                        'UpdateExpression': 'SET #s = :approved, approved_by = :by, approved_at = :at',
                        'ConditionExpression': '#s = :draft', 'ExpressionAttributeNames': {'#s': 'status'},
                        'ExpressionAttributeValues': {':approved': {'S': APPROVED}, ':draft': {'S': DRAFT},
                                                      ':by': {'S': by.id}, ':at': {'S': at}}}},
            self._head_update(ws, head, revision, at, approved=row),
            *self._log(ws, scope, memory_id, revision, APPROVED, by, at, version),
        ], 'the memory changed meanwhile: read it again')
        return self._head(ws, scope, memory_id)

    def _head_update(self, ws: str, head: AgentMemory, revision: int, at: str, *, approved: MemoryVersion | None = None,
                     status: str = '', latest: MemoryVersion | None = None) -> dict[str, Any]:
        """The memory row's change, conditioned on the revision it was read at."""
        sets = ['revision = :rev', 'updated_at = :at']
        values: dict[str, Any] = {':rev': {'N': str(revision)}, ':was': {'N': str(head.revision)}, ':at': {'S': at}}
        if approved is not None:
            sets += ['approved_version = :av', 'statement = :st', 'confidence = :c', 'review_by = :rb']
            values.update({':av': {'N': str(approved.version)}, ':st': {'S': approved.statement},
                           ':c': {'N': repr(approved.confidence)}, ':rb': {'S': approved.review_by}})
            status = status or ACTIVE
        if latest is not None:
            sets += ['latest_version = :lv', 'latest_statement = :ls']
            values.update({':lv': {'N': str(latest.version)}, ':ls': {'S': latest.statement}})
        names: dict[str, str] = {}
        if status:
            sets.append('#s = :status')
            names['#s'] = 'status'
            values[':status'] = {'S': status}
        key = self._key(ws, head.scope, f'MEM#{head.scope.connection}#{head.memory_id}')
        update: dict[str, Any] = {'TableName': self.table, 'Key': key, 'UpdateExpression': 'SET ' + ', '.join(sets),
                                  'ConditionExpression': 'revision = :was', 'ExpressionAttributeValues': values}
        if names:
            update['ExpressionAttributeNames'] = names
        return {'Update': update}

    def edit_agent_memory(self, ws: str, scope: Scope, memory_id: str, *, base_version: int, by: Actor,
                          review_texts: Iterable[str], statement: str | None = None,
                          review_by: date | None = None) -> AgentMemory:
        """A person's edit: a new version on the latest one, ``base_version`` (the statement, else the base's, and
        the review date, else ``DEFAULT_REVIEW_DAYS`` ahead: an unchanged edit is a person's "still true").
        Approved at once when its author may approve the scope, else a draft."""
        _writer(scope, by)
        head = self._head(ws, scope, memory_id)
        if head.status == ARCHIVED:
            raise AgentMemoryConflict('a forgotten memory is restored before it is edited')
        if base_version != head.latest_version:
            raise AgentMemoryConflict(f'version {head.latest_version} is the latest now: edit that one')
        base = self._version(ws, scope, memory_id, base_version)
        text = clean_statement(base.statement if statement is None else statement, review_texts)
        now = self.now()
        at, number, revision = now.isoformat(), base_version + 1, head.revision + 1
        approved = may_approve(scope, by)
        item = self._version_item(ws, scope, memory_id, number, approved=approved, statement=text, confidence=1.0,
                                  review_by=review_date(now.date(), review_by).isoformat(),
                                  provenance=Provenance(person=by.id), feedback_ids=base.feedback_ids, by=by,
                                  base_version=base_version, at=at)
        row = MemoryVersion.from_item(item)
        items = [_put(item, self.table),
                 self._head_update(ws, head, revision, at, latest=row, approved=row if approved else None)]
        if approved:
            items += self._log(ws, scope, memory_id, revision, APPROVED, by, at, number)
        else:
            items += self._reference(ws, scope, by.id)
        self._transact(items, 'the memory changed meanwhile: read it again')
        return self._head(ws, scope, memory_id)

    def _set_status(self, ws: str, scope: Scope, memory_id: str, by: Actor, *, forget: bool) -> AgentMemory:
        _approver(scope, by, 'forgets' if forget else 'restores')
        head = self._head(ws, scope, memory_id)
        if (head.status == ARCHIVED) == forget:
            return head
        status = ARCHIVED if forget else (ACTIVE if head.approved_version else PROPOSED)
        at, revision = self.now().isoformat(), head.revision + 1
        self._transact([self._head_update(ws, head, revision, at, status=status),
                        *self._log(ws, scope, memory_id, revision, FORGOTTEN if forget else RESTORED, by, at,
                                   head.latest_version)], 'the memory changed meanwhile: read it again')
        return self._head(ws, scope, memory_id)

    def forget_agent_memory(self, ws: str, scope: Scope, memory_id: str, *, by: Actor) -> AgentMemory:
        """Archived: out of every recall and never learned again by automation; restorable, never deleted."""
        return self._set_status(ws, scope, memory_id, by, forget=True)

    def restore_agent_memory(self, ws: str, scope: Scope, memory_id: str, *, by: Actor) -> AgentMemory:
        """A forgotten memory back as it was: active when it has an approved version, else a draft again."""
        return self._set_status(ws, scope, memory_id, by, forget=False)

    # ── recall ───────────────────────────────────────────────────────────────
    def recall_for_task(self, ws: str, run: RunContext, *, max_memories: int = DEFAULT_MAX_MEMORIES,
                        max_chars: int = DEFAULT_MAX_CHARS) -> Recall:
        """The memories an agent's prompt takes for its task, as its run's record names it: the connection's
        repository memories, the run's role's lessons there, and the memories of the people on the task
        (signed-in users of this deployment) that apply to the connection (their own, and those learned in it);
        approved, live, bounded, flagged and fenced (``recall.assemble``)."""
        connection = run.connection
        scopes = [Scope('repository', connection), Scope('role', connection, run.role)]
        for person in dict.fromkeys(run.people):
            if self.is_user(person):
                scopes += [Scope('person', '', person=person), Scope('person', connection, person=person)]
        candidates = [
            Candidate(head.memory_id, head.approved_version, head.scope.label, head.kind, head.subject, head.statement,
                      head.confidence, head.confirmations, head.review_by)
            for scope in scopes for head in self._heads(ws, scope)
            if head.status == ACTIVE and head.approved_version]
        return assemble(candidates, self.now().date(), max_memories=max_memories, max_chars=max_chars)

    # ── erasure (D5) ─────────────────────────────────────────────────────────
    def erase_person_memories(self, ws: str, person: str, *, by: Actor, legal_basis: str) -> Erasure:
        """Erase a person, for a legal obligation (an erasure request): the tombstone and the delete record are
        written first (who, what, when, the legal basis; the person only as a hash), then every row naming them in
        another scope is de-identified (one random ``erased-…`` id for this erasure), then every row of their own
        partition is deleted. Re-running it after a failure finishes it."""
        if not (by.kind == 'person' and by.admin):
            raise AgentMemoryForbidden("only an administrator erases a person's memories")
        try:
            basis = required_legal_basis(legal_basis)
        except ValueError as exc:
            raise AgentMemoryError(str(exc)) from exc
        own = Scope('person', person=person)
        _check_ws(ws)
        rows = whole_partition(self.client, self.table, own.partition(ws))
        partitions = sorted({_text(row.get('partition')) for row in rows if _text(row.get('sk')).startswith('REF#')})
        at, hashed = self.now().isoformat(), sha256_hex(person)
        actor = {'M': {'sub': {'S': by.id}, 'kind': {'S': 'admin'}}}
        try:
            self.client.put_item(TableName=self.table, ConditionExpression='attribute_not_exists(pk)', Item={
                'pk': {'S': TOMBSTONE_PK}, 'sk': {'S': hashed}, 'legal_basis': {'S': basis}, 'actor': actor,
                'deleted_at': {'S': at}})
        except ClientError as exc:
            if not is_key_collision(exc):
                raise   # an erasure re-run keeps the first tombstone
        self.client.put_item(TableName=self.table, ConditionExpression='attribute_not_exists(pk)', Item={
            'pk': {'S': AUDIT_PK}, 'sk': {'S': f'{at}#{secrets.token_hex(16)}'}, 'kind': {'S': ERASED_KIND},
            'target': {'M': {'ws': {'S': ws}, 'person_hash': {'S': hashed}, 'rows': {'S': str(len(rows))},
                             'partitions': {'S': str(len(partitions))}}},
            'actor': actor, 'reason': {'S': basis}, 'deleted_at': {'S': at}})
        alias = f'erased-{secrets.token_hex(8)}'
        deidentified = sum(self._deidentify(partition, person, alias) for partition in partitions)
        for row in rows:
            self.client.delete_item(TableName=self.table, Key={'pk': row['pk'], 'sk': row['sk']})
        return Erasure(len(rows), deidentified, len(partitions))

    def _deidentify(self, partition: str, person: str, alias: str) -> int:
        """Every row of ``partition`` naming ``person`` names ``alias`` instead; their confirmation rows are
        re-keyed (the key is a hash of the source). Returns how many rows changed."""
        changed = 0
        for item in whole_partition(self.client, self.table, partition):
            if _text(item.get('source')) == f'person:{person}':
                source = f'person:{alias}'
                memory_id = _text(item.get('sk')).split('#')[1]
                self.client.put_item(TableName=self.table, Item={
                    **item, 'sk': {'S': f'CONF#{memory_id}#{sha256_hex(source)[:24]}'}, 'source': {'S': source}})
                self.client.delete_item(TableName=self.table, Key={'pk': item['pk'], 'sk': item['sk']})
                changed += 1
                continue
            named = [attr for attr in _PERSON_ATTRS if _text(item.get(attr)) == person]
            if named:
                self.client.update_item(
                    TableName=self.table, Key={'pk': item['pk'], 'sk': item['sk']},
                    UpdateExpression='SET ' + ', '.join(f'#a{i} = :alias' for i in range(len(named))),
                    ExpressionAttributeNames={f'#a{i}': attr for i, attr in enumerate(named)},
                    ExpressionAttributeValues={':alias': {'S': alias}})
                changed += 1
        return changed
