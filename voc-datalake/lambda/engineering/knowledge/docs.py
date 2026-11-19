"""A connection's agent docs as approved (7.52.00; docs/autonomous-engineering.md, "The knowledge docs pull request"):
what an approval records, what a preview shows and what the broker renders again before it writes.

**Knowledge.** The docs are every package's latest approved pack together (``render_docs.render_knowledge``), so an
approval of any package's version renders the connection's docs as they become with it: the overview's packages (the
root's approved pack lists them; the root's own version when it is the one approved) at their approved versions, this
one in its package's place. The approval (``PackStore.approve``) keeps that rendering's digest on the version and its
log row, and in the same transaction records it as the connection's next rendering::

    WS#<ws>#REPO#<connection> / KDOCS                   version (the rendering's number), digest, packages
                                                        (package -> its approved version), source, approved_by/at
    WS#<ws>#REPO#<connection> / KDOCSLOG#<version:06d>  the same, create-only (D1, D4)

held to the number read (two approvals racing: one is refused, read again). The rendering's number names its pull
request's branch (``voc-agent/docs/knowledge-v<n>``).

**Tenets.** The accepted version (``tenets.TenetsStore.accepted``), its ``TENETS.md`` digest recorded at its acceptance.

``ApprovedDocs.approved`` reads either back and renders it again from the stored records alone (the knowledge from
the versions the rendering names, each still marked approved): the broker's ``push_approved_docs`` holds the request's
digest and the approval's to it, and the preview shows it.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from engineering.knowledge.render_docs import KNOWLEDGE, ROOT, TENETS, RenderError, Rendering, render_knowledge
from engineering.knowledge.render_docs import render_tenets as render_tenets_md
from engineering.knowledge.store import (
    APPROVED,
    PACK_OBJECT,
    Actor,
    PackConflict,
    PackError,
    PackNotFound,
    PackStore,
    PackUnavailable,
    PackVersion,
    repo_key,
)
from engineering.knowledge.tenets import TenetsStore
from engineering.rows import create_only, get_row
from engineering.rows import number_value as _number
from engineering.rows import text_value as _text
from engineering.workspace.layout import LayoutError, knowledge_key

COUNTER: Final = 'KDOCS'
LOG_PREFIX: Final = 'KDOCSLOG#'


@dataclass(frozen=True)
class RecordedRendering:
    """A rendering as its approval recorded it: its number, its digest and, for the knowledge, each package's
    version."""

    kind: str
    version: int
    digest: str
    packages: Mapping[str, int] = field(default_factory=dict)
    approved_by: str = ''
    approved_at: str = ''
    #: What the approval approved: ``<package>@v<n>`` for the knowledge.
    source: str = ''

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> RecordedRendering:
        raw = item.get('packages', {}).get('M', {}) if isinstance(item.get('packages'), dict) else {}
        return cls(KNOWLEDGE, _number(item.get('version')), _text(item.get('digest')),
                   {str(package): _number(value) for package, value in raw.items() if _number(value) > 0},
                   _text(item.get('approved_by')), _text(item.get('approved_at')), _text(item.get('source')))

    def view(self) -> dict[str, Any]:
        return {'kind': self.kind, 'version': self.version, 'digest': self.digest,
                'packages': dict(sorted(self.packages.items())), 'approved_by': self.approved_by or None,
                'approved_at': self.approved_at or None, 'source': self.source or None}


@dataclass(frozen=True)
class Approved:
    """What was approved, rendered again: the recorded rendering, and the files it renders to now."""

    recorded: RecordedRendering
    rendering: Rendering

    @property
    def matches(self) -> bool:
        """The stored records still render to the digest their approval recorded."""
        return self.rendering.digest == self.recorded.digest


@dataclass(frozen=True)
class KnowledgeDocs:
    """The knowledge docs over the pack store (its client, table and workspace)."""

    packs: PackStore

    def recorded(self, ws: str, connection: str) -> RecordedRendering | None:
        item = get_row(self.packs.client, self.packs.table, repo_key(ws, connection, COUNTER))
        return None if item is None or not _number(item.get('version')) else RecordedRendering.from_item(item)

    def _pack_json(self, ws: str, connection: str, package: str, version: int, *, approved: bool) -> dict[str, Any]:
        row = self.packs.version(ws, connection, package, version)
        if approved and row.status != APPROVED:
            raise PackConflict(f'version {version} of {package[:80]!r} is not approved: approve the docs again')
        try:
            text = self.packs.workspace.read_text(knowledge_key(ws, connection, package, version, PACK_OBJECT))
        except LayoutError as exc:
            raise PackError(str(exc)) from exc
        if text is None:
            raise PackNotFound(f'version {version} of {package[:80]!r} has no {PACK_OBJECT}')
        try:
            loaded = json.loads(text)
        except ValueError as exc:
            raise PackUnavailable(f'version {version} of {package[:80]!r} is not a readable pack') from exc
        if not isinstance(loaded, dict):
            raise PackUnavailable(f'version {version} of {package[:80]!r} is not a readable pack')
        return loaded

    def _render(self, ws: str, connection: str, versions: Mapping[str, int], draft: tuple[str, int] | None = None
                ) -> Rendering:
        packs = {package: self._pack_json(ws, connection, package, version, approved=(package, version) != draft)
                 for package, version in versions.items()}
        try:
            return render_knowledge(packs, versions)
        except RenderError as exc:
            raise PackError(str(exc)) from exc

    def with_approved(self, ws: str, connection: str, package: str, version: int) -> tuple[Rendering, dict[str, int]]:
        """The connection's docs as they become with ``version`` of ``package`` approved, and the versions they are
        rendered from (the module's doc)."""
        root = version if package == ROOT else self.packs.approved_version(ws, connection, ROOT)
        listed: list[str] = []
        if root:
            overview = self._pack_json(ws, connection, ROOT, root, approved=package != ROOT)
            raw = overview.get('packages')
            listed = [str(item['path']) for item in raw if isinstance(item, dict) and isinstance(item.get('path'), str)] \
                if isinstance(raw, list) else []
        versions: dict[str, int] = {}
        for each in dict.fromkeys([ROOT, *listed, package]):
            found = version if each == package else self.packs.approved_version(ws, connection, each)
            if found:
                versions[each] = found
        return self._render(ws, connection, versions, draft=(package, version)), versions

    def approve(self, ws: str, connection: str, package: str, version: int,
                approver: Actor) -> tuple[PackVersion, RecordedRendering | None]:
        """An administrator's approval of ``version`` with the docs it renders recorded (the module's doc): the
        version as approved, and the connection's rendering (None only for a version approved before 7.52.00 and
        approved again, which records nothing new)."""
        current = self.packs.version(ws, connection, package, version)
        if current.status == APPROVED:
            return current, self.recorded(ws, connection)
        rendering, versions = self.with_approved(ws, connection, package, version)
        previous = self.recorded(ws, connection)
        number = (previous.version if previous else 0) + 1
        at = self.packs.now().isoformat()
        fields = {'version': {'N': str(number)}, 'digest': {'S': rendering.digest},
                  'packages': {'M': {name: {'N': str(value)} for name, value in sorted(versions.items())}},
                  'source': {'S': f'{package}@v{version}'}, 'approved_by': {'S': approver.id},
                  'approved_at': {'S': at}}
        counter = {'Put': {'TableName': self.packs.table, 'Item': {**repo_key(ws, connection, COUNTER), **fields},
                           'ConditionExpression': ('attribute_not_exists(pk)' if previous is None else '#v = :prev'),
                           **({} if previous is None else {
                               'ExpressionAttributeNames': {'#v': 'version'},
                               'ExpressionAttributeValues': {':prev': {'N': str(previous.version)}}})}}
        log = create_only({**repo_key(ws, connection, f'{LOG_PREFIX}{number:06d}'), **fields}, self.packs.table)
        approved = self.packs.approve(ws, connection, package, version, approver, rendering_digest=rendering.digest,
                                      also=(counter, log))
        return approved, RecordedRendering.from_item(fields)

    def approved(self, ws: str, connection: str) -> Approved | None:
        """The recorded rendering, rendered again from the versions it names (each still approved); None when the
        connection has none yet."""
        recorded = self.recorded(ws, connection)
        if recorded is None:
            return None
        return Approved(recorded, self._render(ws, connection, recorded.packages))


@dataclass(frozen=True)
class ApprovedDocs:
    """Either kind's approved docs, rendered again (the broker's and the preview's one read)."""

    knowledge: KnowledgeDocs
    tenets: TenetsStore

    def approved(self, ws: str, connection: str, kind: str) -> Approved | None:
        if kind == KNOWLEDGE:
            return self.knowledge.approved(ws, connection)
        if kind != TENETS:
            raise PackError('the docs are of knowledge or tenets')
        accepted = self.tenets.accepted(ws, connection)
        if accepted is None:
            return None
        row = accepted.version
        recorded = RecordedRendering(TENETS, row.version, accepted.digest, {}, row.decided_by, row.decided_at,
                                     f'tenets@v{row.version}')
        return Approved(recorded, render_tenets_md(row.record, row.version))
