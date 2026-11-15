"""Versioned knowledge packs: a new version per refresh or edit (D1), a draft until an administrator approves it (D4).

Rows in the ``voc-engineering`` table, one partition per connection (``<package>`` encoded as the workspace's
layout encodes it, so it holds no ``#``)::

    WS#<ws>#REPO#<connection> / KPACK#<package>                        versions (the counter), approved_version
    WS#<ws>#REPO#<connection> / KPACK#<package>#<version:06d>          a version: status, author, built_from, …
    WS#<ws>#REPO#<connection> / KPACKLOG#<package>#<version:06d>#approved   who approved it and when (create-only)

The content is in the workspace bucket, written once (``If-None-Match``) before its row:
``ws/<ws>/knowledge/<connection>/<package>/v<version:06d>/pack.json`` and one ``<document>.md`` per document.

- **Publish** (a refresh by the Understand flow, or a person's edit): an atomic ``ADD`` on the counter gives the
  version (two writers racing get two), the objects are created, then the version row (``attribute_not_exists``):
  status ``draft``, with its author (an agent or a person), the reason, the commit it was built from and the version
  it started from. Nothing is overwritten; an object already there means the counter is behind the bucket, and the
  publish stops rather than hand an older document on as this version.
- **Approve**: an administrator only (a person; an agent never approves, whatever it asks). One transaction moves the
  draft to ``approved`` with who and when, moves the counter's ``approved_version`` up (never down: approving a
  version older than the approved one is refused, and so is one built on an older version than the approved one,
  which would drop what that one added), and writes the approval's log row. Approving the approved version
  again answers it as it is.
- **Read**: agents read only ``for_agent``: the counter's ``approved_version`` and its documents, each inside a DATA
  block (the pack is mined from text anyone with access can write: data, never instructions); a package with no
  approved version has no pack to read. ``latest_approved`` gives the same version as a pack, for the reduce.
- **Edit**: an administrator's claims on top of a version (``reduce.apply_edits``) are a new draft with them as its
  author; the next refresh starts from the latest approved version and keeps its edits (``reduce``).
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from botocore.exceptions import ClientError

from engineering.bus.schema import WS
from engineering.knowledge.notes import KINDS, CitationRules
from engineering.knowledge.reduce import Edit, Pack, apply_edits, from_json, render, to_json
from engineering.quality_gate.text import data_block, nonce
from engineering.rows import get_row, partition_rows
from engineering.rows import number_value as _number
from engineering.rows import text_value as _text
from engineering.workspace.layout import CONNECTION, SHA, LayoutError, encode_package, knowledge_key
from engineering.workspace.store import WorkspaceStore
from shared.aws import is_conditional_check_failure
from shared.ids import is_key_collision

DRAFT, APPROVED = 'draft', 'approved'
PACK_OBJECT = 'pack.json'


class PackError(Exception):
    """A pack operation refused: ``kind`` is invalid here, and not_found, forbidden, conflict or unavailable in the
    subclasses (what a REST route answers 400, 404, 403, 409 or 503)."""

    kind = 'invalid'


class PackNotFound(PackError):
    kind = 'not_found'


class PackForbidden(PackError):
    kind = 'forbidden'


class PackConflict(PackError):
    kind = 'conflict'


class PackUnavailable(PackError):
    """The store's own fault, not the caller's: a stored version it cannot read (a 5xx; try again, or fix the store)."""

    kind = 'unavailable'


@dataclass(frozen=True)
class Actor:
    """Who acts: an agent (``agent``: the run's agent id) or a person (their user id; ``admin`` from their
    role, as the API's admin check reads it). ``connection``: for an agent, the connection its run is for (from
    the run's record, never from the agent), so a store can hold it to that connection."""

    id: str
    kind: Literal['agent', 'person']
    admin: bool = False
    connection: str = ''

    def __post_init__(self) -> None:
        if not self.id or len(self.id) > 200 or (self.admin and self.kind != 'person'):
            raise ValueError('an actor has an id, and only a person can be an administrator')
        if self.connection and self.kind != 'agent':
            raise ValueError("only an agent acts for its run's connection")


@dataclass(frozen=True)
class PackVersion:
    package: str
    version: int
    status: str
    author: str
    author_kind: str
    reason: str
    built_from: str
    base_version: int
    created_at: str
    approved_by: str = ''
    approved_at: str = ''

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> PackVersion:
        return cls(package=_text(item.get('package')), version=_number(item.get('version')),
                   status=_text(item.get('status')), author=_text(item.get('author')),
                   author_kind=_text(item.get('author_kind')), reason=_text(item.get('reason')),
                   built_from=_text(item.get('built_from')), base_version=_number(item.get('base_version')),
                   created_at=_text(item.get('created_at')), approved_by=_text(item.get('approved_by')),
                   approved_at=_text(item.get('approved_at')))


@dataclass(frozen=True)
class AgentPack:
    """What an agent's prompt takes from a pack: its approved version and its documents, fenced as data."""

    version: int
    text: str


@dataclass(frozen=True)
class ApprovedPack:
    version: PackVersion
    pack: Pack
    #: Each document's Markdown, by kind.
    documents: Mapping[str, str]


def _pk(ws: str, connection: str) -> str:
    if not CONNECTION.fullmatch(connection):
        raise PackError('not a connection id')
    if not WS.fullmatch(ws):
        raise PackError('not a workspace id')
    return f'WS#{ws}#REPO#{connection}'


def _segment(package: str) -> str:
    try:
        return encode_package(package)
    except LayoutError as exc:
        raise PackError(str(exc)) from exc


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class PackStore:
    #: A low-level DynamoDB client on ``voc-engineering``.
    client: Any
    table: str
    workspace: WorkspaceStore
    now: Callable[[], datetime] = _utc_now

    def _key(self, ws: str, connection: str, sk: str) -> dict[str, Any]:
        return {'pk': {'S': _pk(ws, connection)}, 'sk': {'S': sk}}

    def publish(self, ws: str, connection: str, pack: Pack, *, author: Actor, reason: Literal['refresh', 'edit'],
                built_from: str, base_version: int = 0) -> PackVersion:
        """``pack`` as the package's next version, a draft. ``built_from``: the full sha the refresh read."""
        if not SHA.fullmatch(built_from):
            raise PackError('a version names the full commit sha it was built from')
        if reason == 'edit' and not (author.kind == 'person' and author.admin):
            raise PackForbidden('only an administrator edits a knowledge pack')
        segment = _segment(pack.package)
        counted = self.client.update_item(
            TableName=self.table, Key=self._key(ws, connection, f'KPACK#{segment}'), UpdateExpression='ADD versions :one',
            ExpressionAttributeValues={':one': {'N': '1'}}, ReturnValues='UPDATED_NEW')
        version = int(counted['Attributes']['versions']['N'])
        objects = [(PACK_OBJECT, json.dumps(to_json(pack), sort_keys=True, indent=1), 'application/json')]
        objects += [(f'{kind}.md', render(pack, kind), 'text/markdown') for kind in KINDS]
        for name, body, content_type in objects:
            key = knowledge_key(ws, connection, pack.package, version, name)
            if not self.workspace.put_once(key, body, content_type):
                raise PackConflict(f'{key} already exists: the version counter is behind the bucket')
        at = self.now().isoformat()
        item = {**self._key(ws, connection, f'KPACK#{segment}#{version:06d}'),
                'package': {'S': pack.package}, 'version': {'N': str(version)}, 'status': {'S': DRAFT},
                'author': {'S': author.id}, 'author_kind': {'S': author.kind}, 'reason': {'S': reason},
                'built_from': {'S': built_from}, 'base_version': {'N': str(base_version)}, 'created_at': {'S': at},
                'flagged': {'N': str(len(pack.flagged))}}
        try:
            self.client.put_item(TableName=self.table, Item=item, ConditionExpression='attribute_not_exists(pk)')
        except ClientError as exc:
            if not is_conditional_check_failure(exc):
                raise
            raise PackConflict(f'version {version} already has a row: the counter is behind') from exc
        return PackVersion.from_item(item)

    def version(self, ws: str, connection: str, package: str, version: int) -> PackVersion:
        item = get_row(self.client, self.table, self._key(ws, connection, f'KPACK#{_segment(package)}#{version:06d}'))
        if item is None:
            raise PackNotFound('no such version')
        return PackVersion.from_item(item)

    def versions(self, ws: str, connection: str, package: str) -> list[PackVersion]:
        """Every version of the package, oldest first (D1: none is ever replaced)."""
        items = partition_rows(self.client, self.table, _pk(ws, connection), f'KPACK#{_segment(package)}#')
        return [PackVersion.from_item(item) for item in items]

    def _approved_version(self, ws: str, connection: str, package: str) -> int:
        counter = get_row(self.client, self.table, self._key(ws, connection, f'KPACK#{_segment(package)}')) or {}
        return int(counter.get('approved_version', {}).get('N', '0'))

    def approve(self, ws: str, connection: str, package: str, version: int, approver: Actor) -> PackVersion:
        if not (approver.kind == 'person' and approver.admin):
            raise PackForbidden('only an administrator approves a knowledge pack')
        current = self.version(ws, connection, package, version)
        if current.status == APPROVED:
            return current
        approved = self._approved_version(ws, connection, package)
        if version < approved:
            raise PackConflict('a later version is approved already: approve a newer draft instead')
        if current.base_version < approved:
            # Built on an older version than the approved one: approving it would drop what the approved one added
            # (a person's later edit above all).
            raise PackConflict(f'version {version} was built on version {current.base_version}, and version '
                               f'{approved} is approved since: refresh or edit from version {approved} instead')
        segment, at = _segment(package), self.now().isoformat()
        values = {':approved': {'S': APPROVED}, ':draft': {'S': DRAFT}, ':by': {'S': approver.id}, ':at': {'S': at}}
        try:
            self.client.transact_write_items(TransactItems=[
                {'Update': {'TableName': self.table, 'Key': self._key(ws, connection, f'KPACK#{segment}#{version:06d}'),
                            'UpdateExpression': 'SET #s = :approved, approved_by = :by, approved_at = :at',
                            'ConditionExpression': '#s = :draft', 'ExpressionAttributeNames': {'#s': 'status'},
                            'ExpressionAttributeValues': values}},
                {'Update': {'TableName': self.table, 'Key': self._key(ws, connection, f'KPACK#{segment}'),
                            'UpdateExpression': 'SET approved_version = :v',
                            'ConditionExpression': 'attribute_not_exists(approved_version) OR '
                                                   '(approved_version < :v AND approved_version <= :base)',
                            'ExpressionAttributeValues': {':v': {'N': str(version)},
                                                          ':base': {'N': str(current.base_version)}}}},
                {'Put': {'TableName': self.table, 'ConditionExpression': 'attribute_not_exists(pk)', 'Item': {
                    **self._key(ws, connection, f'KPACKLOG#{segment}#{version:06d}#approved'),
                    'by': {'S': approver.id}, 'at': {'S': at}, 'version': {'N': str(version)}}}},
            ])
        except ClientError as exc:
            if not any(is_key_collision(exc, put_index=i) for i in range(3)):
                raise
            raise PackConflict('the version or the approved one changed meanwhile: read it again') from exc
        return self.version(ws, connection, package, version)

    def _load(self, ws: str, connection: str, version: PackVersion) -> ApprovedPack:
        def read(name: str) -> str:
            text = self.workspace.read_text(knowledge_key(ws, connection, version.package, version.version, name))
            if text is None:
                raise PackNotFound(f'version {version.version} has no {name}')
            return text

        try:
            pack = from_json(json.loads(read(PACK_OBJECT)))
        except ValueError as exc:   # json.JSONDecodeError is a ValueError
            raise PackUnavailable(f'version {version.version} is not a readable pack') from exc
        return ApprovedPack(version, pack, {kind: read(f'{kind}.md') for kind in KINDS})

    def latest_approved(self, ws: str, connection: str, package: str) -> ApprovedPack | None:
        """The latest approved version as a pack (for the reduce and the administrators' reads), None when no
        version is approved. An agent's prompt never takes it: it takes ``for_agent``."""
        approved = self._approved_version(ws, connection, package)
        if not approved:
            return None
        row = self.version(ws, connection, package, approved)
        if row.status != APPROVED:
            raise PackConflict('the approved version is not marked approved')
        return self._load(ws, connection, row)

    def for_agent(self, ws: str, connection: str, package: str) -> AgentPack | None:
        """The one read for an agent: the latest approved version's documents, each inside a DATA block with one
        random fence (``quality_gate.text.data_block``: redacted, and closable only by that fence), so the pack
        informs the work and can never instruct the agent. None when no version is approved."""
        approved = self.latest_approved(ws, connection, package)
        if approved is None:
            return None
        fence = nonce()
        blocks = [data_block(f'knowledge-pack-{kind}', approved.documents[kind], fence) for kind in KINDS]
        return AgentPack(approved.version.version, '\n\n'.join(blocks))

    def edit(self, ws: str, connection: str, package: str, base_version: int, edits: Sequence[Edit],
             editor: Actor, rules: CitationRules) -> PackVersion:
        """An administrator's edit of ``base_version``: a new draft authored by them, built from the same commit.
        ``rules``: what a person's citation may name (the repository's paths, commits and review comments)."""
        if not (editor.kind == 'person' and editor.admin):
            raise PackForbidden('only an administrator edits a knowledge pack')
        if any(edit.note.author != editor.id for edit in edits):
            raise PackError('every edited claim is authored by the editor')
        base = self.version(ws, connection, package, base_version)
        try:
            edited = apply_edits(self._load(ws, connection, base).pack, edits, rules=rules)
        except ValueError as exc:
            raise PackError(str(exc)) from exc
        return self.publish(ws, connection, edited, author=editor, reason='edit', built_from=base.built_from,
                            base_version=base_version)

