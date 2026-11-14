"""A workspace's memory in its export (slice 4c; docs/multi-workspace.md, "Export and delete", step 2).

Personal data is its owner's only (docs/memory.md: admins never see its content), and decision 11's export does not
override that. So the export holds the workspace's company memory only, and counts what it leaves out:

* ``memory_company``: the table's ``WS#{ws}#MEM#company``, read by ``sk``: every company memory once, whatever its
  status;
* ``memory_imports``: ``WS#{ws}#MEMIMPORT``, the import rows (the imported files under ``ws/{ws}/memory-imports/``
  are among the workspace's objects), without who started them;
* ``memory_events``: ``WS#{ws}#MEMEVT#{memory id}`` of each company memory, one Query per memory, the ids re-derived
  by reading the company partition again, one page of at most ``ID_PAGE`` ids projected to ``memory_id``. The cursor
  carries where that read is, the ids of its page still to do and the event page's key, so a hand-over never carries
  more than one page of ids (about 2 KB) and never a work object.

A company memory's sources are shown as the memory API shows them: type and time, and the ref only for an import or
an agent run (a chat source's ref is a session id, which names one person's conversation).

Not exported, only counted for the manifest (``count``; ``Select COUNT`` only, the one read the job's role may make
there, approximate, checkpointed across hand-overs): the personal memories (the four ``WS#{ws}#MEMSTATUS#personal#*``
partitions of the status index, where each sits once) and the extraction cursors (``WS#{ws}#MEMCURSOR``: each points
at a member's chat session). The personal memories' events are neither exported nor counted.

Each memory entity exports only the fields it lists (``FIELDS``, from what the memory API shows), so what names or
could confirm a person never leaves, nor any field added to memory rows later: a memory's ``supporter_set`` (hashes
of its supporters' subs) and ``embedding`` (derived from the statement), an event's ``actor`` (a supporter hash), an
import's ``created_by_hash`` and ``created_by_username``.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Final

from jobs.workspace_export.pages import TABLE_KEY, items, key, last_key, start
from shared.indexes import MEMORY_BY_STATUS_INDEX
from shared.memory_policy import SCOPE_PERSONAL, STATUSES
from shared.ws_repo import (
    WorkspaceScope,
    WorkspaceTable,
    memory_company_pk,
    memory_cursor_pk,
    memory_event_pk,
    memory_import_pk,
    memory_status_pk,
)

__all__ = ['COUNTED', 'ENTITIES', 'MemorySource']

#: The memory entities, in the export's order (after plugin_config_history; a checkpoint names its phase).
ENTITIES: Final = ('memory_company', 'memory_imports', 'memory_events')
#: The fields each memory entity exports, and no other (an allowlist: a field added to memory rows later never
#: reaches the export by default). Each is what the memory API shows (shared/memory_store.py), plus the row's key.
#: A company memory: the store's public fields (``_PUBLIC_FIELDS`` / ``public_view``) and its sources, shown as
#: ``_public_sources`` shows them; never its embedding, its supporters' hashes or its owner.
COMPANY_FIELDS: Final = (
    'pk', 'sk', 'memory_id', 'scope', 'status', 'kind', 'statement', 'categories', 'confidence', 'source_kind',
    'supporters', 'created_at', 'last_reinforced_at', 'last_used_at', 'retention', 'expires_at', 'conflicts_with',
    'tombstoned', 'merged_into', 'aligned_objective_ids', 'updated_at', 'sources',
    # What a merge (shared/memory_store.py ``merge_memories``) and an archive write, which a restore needs.
    'merged_from', 'archived_reason', 'archived_at',
)
#: An event, as ``append_event`` writes it (the API shows no event): its action, time and detail; never its actor.
EVENT_FIELDS: Final = ('pk', 'sk', 'action', 'at', 'detail')
#: An import: the store's ``public_import`` fields but who started it (``created_by_username``).
IMPORT_FIELDS: Final = (
    'pk', 'sk', 'import_id', 'title', 'url', 'status', 'chunks_total', 'chunks_done', 'created', 'reinforced',
    'proposed', 'conflicts', 'dropped', 'created_at', 'updated_at', 'error', 'resolved_tier', 'flex_fallback',
    'content_chars',
)
FIELDS: Final = {'memory_company': COMPANY_FIELDS, 'memory_events': EVENT_FIELDS, 'memory_imports': IMPORT_FIELDS}
#: The memory ids one item page of the events' re-read yields, at most (the cursor carries them).
ID_PAGE: Final = 100
#: A page's rows (each ``(item, the cursor right after it)``) and the cursor of the next page (None: done).
_Page = tuple[list[tuple[dict[str, Any], dict[str, Any]]], dict[str, Any] | None]
#: The company partition's memory rows (``sk`` ``MEM#{memory id}``, shared/memory_store.py ``memory_key``).
_MEMORY_ROWS: Final = {'sort_condition': 'begins_with(#sk, :memory)', 'ExpressionAttributeNames': {'#sk': 'sk'},
                       'ExpressionAttributeValues': {':memory': 'MEM#'}}


#: The source types whose ``ref`` is shared (an import's id, an agent run's). A memory mined from a chat has
#: ``{'type': 'session', 'ref': <session id>}`` (lambda/memory/extractor), and a session id is never shared.
_SHARED_REF_TYPES: Final = frozenset({'import', 'agent_run'})
#: The things counted for the manifest, never exported.
COUNTED: Final = ('personal_memories', 'cursors')


def _shared_source(source: Mapping[str, Any]) -> dict[str, Any]:
    """A source as it may be shared: its type and time, and its ref only for an import or an agent run."""
    shared = {'type': source.get('type'), 'at': source.get('at')}
    if source.get('type') in _SHARED_REF_TYPES and source.get('ref'):
        shared['ref'] = source.get('ref')
    return shared


def _with_shared_sources(item: dict[str, Any]) -> dict[str, Any]:
    """``item`` with its sources as the memory API shows them (shared/memory_store.py ``_public_sources``'s allowlist:
    type and time, plus the ref only for imports and agent runs; a session id names one person's conversation and is
    not shared; a value that is not a list is no source, ``[]``), written here rather than imported: that function is
    the store's own."""
    if 'sources' not in item:
        return item
    sources = item['sources']
    shown = [_shared_source(source) for source in sources if isinstance(source, Mapping)] \
        if isinstance(sources, list) else []
    return {**item, 'sources': shown}


def _listed(entity: str, item: Mapping[str, Any]) -> dict[str, Any]:
    """``item`` with only the fields ``entity`` exports (``FIELDS``)."""
    return {name: item[name] for name in FIELDS[entity] if name in item}


class MemorySource:
    """One workspace's company memory entities (``page``) and the counts of what is left out, through its view of
    voc-memory."""

    def __init__(self, scope: WorkspaceScope, memory: WorkspaceTable) -> None:
        self.scope = scope
        self._memory = memory

    def _query(self, partition: str, cursor_start: object, **kwargs: Any) -> dict[str, Any]:
        return self._memory.query('pk', partition, **start(cursor_start), **kwargs)

    def _company(self, cursor_start: object, **kwargs: Any) -> dict[str, Any]:
        """One page of the company memories: the company partition's ``MEM#`` rows, by ``sk``."""
        return self._query(memory_company_pk(self.scope), cursor_start, **_MEMORY_ROWS, **kwargs)

    def page(self, entity: str, cursor: Mapping[str, Any]) -> _Page:
        if entity == 'memory_events':
            return self._events_page(cursor)
        if entity == 'memory_company':
            page = self._company(cursor.get('start'))
            found = [_with_shared_sources(item) for item in items(page)]
        else:
            page = self._query(memory_import_pk(self.scope), cursor.get('start'))
            found = items(page)
        rows = [(_listed(entity, item), {'start': key(item, TABLE_KEY)}) for item in found]
        last = last_key(page)
        return rows, ({'start': last} if last else None)

    def _events_page(self, cursor: Mapping[str, Any]) -> _Page:
        """One page of events of the first id still to do; or, with no id left, the next company page's ids (no
        rows)."""
        items_start, ids = cursor.get('items'), cursor.get('ids')
        if not ids:
            if cursor.get('done'):
                return [], None
            page = self._company(items_start, Limit=ID_PAGE, ProjectionExpression='memory_id')
            found = [str(item['memory_id']) for item in items(page)
                     if isinstance(item.get('memory_id'), str) and item['memory_id']]
            last = last_key(page)
            return [], {'items': last, 'done': last is None, 'ids': found, 'start': None}
        here = {'items': items_start, 'done': bool(cursor.get('done'))}
        page = self._query(memory_event_pk(self.scope, str(ids[0])), cursor.get('start'))
        rows = [(_listed('memory_events', item), {**here, 'ids': list(ids), 'start': key(item, TABLE_KEY)})
                for item in items(page)]
        last = last_key(page)
        if last is not None:
            return rows, {**here, 'ids': list(ids), 'start': last}
        return rows, {**here, 'ids': list(ids[1:]), 'start': None}

    def _counted_partitions(self, what: str) -> list[tuple[str, str, dict[str, str]]]:
        """Where ``what`` (``COUNTED``) is counted: (partition attribute, partition, index), in order."""
        if what == 'personal_memories':
            index = {'IndexName': MEMORY_BY_STATUS_INDEX}
            return [('gsi1pk', memory_status_pk(self.scope, SCOPE_PERSONAL, status), index) for status in STATUSES]
        return [('pk', memory_cursor_pk(self.scope), {})]

    def count(self, what: str, state: dict[str, Any], time_left: Callable[[], bool]) -> bool:
        """Go on counting ``what`` from ``state`` (the run's checkpoint: ``part``, the partition it is in, ``cursor``,
        ``total`` and ``done``), ``Select COUNT`` only (the job's grant there allows nothing else: no row is ever
        read), a page at a time (a page counts up to 1 MB of rows). True once done; False when ``time_left`` says no
        after a page with more to count, ``state`` then where the next invocation goes on."""
        partitions = self._counted_partitions(what)
        state.setdefault('total', 0)
        while int(state.get('part') or 0) < len(partitions) and not state.get('done'):
            attribute, partition, index = partitions[int(state.get('part') or 0)]
            page = self._memory.query(attribute, partition, Select='COUNT', **index, **start(state.get('cursor')))
            state['total'] = int(state['total']) + int(page.get('Count') or 0)
            state['cursor'] = last_key(page)
            if state['cursor'] is None:
                state['part'] = int(state.get('part') or 0) + 1
            if int(state.get('part') or 0) < len(partitions) and not time_left():
                return False
        state['done'] = True
        return True
