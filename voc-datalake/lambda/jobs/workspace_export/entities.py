"""What a workspace's export holds, read one page at a time, and its manifest (docs/multi-workspace.md, "Export and
delete", step 2).

Every read is a Query (``dynamodb:LeadingKeys`` cannot limit a Scan) of the workspace's own partitions, through the
workspace layer (shared/ws_repo.py):

* ``feedback``: voc-feedback's ``gsi1-by-date`` (every attribute projected), one partition per day,
  ``WS#{ws}#DATE#{yyyy-mm-dd}``, from the workspace's earliest date (``WS#{ws}#METRIC#meta`` / ``earliest_date``) to
  the day after the export started;
* from voc-aggregates (``ws_table``): ``plugin_configs`` (``WS#{ws}#PLUGIN_CONFIG``), ``plugin_config_history``
  (``#PLUGIN_CONFIG#HISTORY``: every list a save replaced, who saved it and who replaced it), ``feedback_forms``
  (``#FEEDBACK_FORM``), ``import_runs`` (each run's detail row ``#IMPORT_RUN#{run}``, found from its summary in
  ``#IMPORT_RUN``; the summary itself when the detail is gone) and ``erasure_jobs`` (``#JOB#erasure``, ``er_…`` rows,
  without ``value_hash``);
* from voc-workspaces (``control_query``): ``workspace`` (``WS#{ws}`` / ``META``), ``members`` (its ``MEMBER#``
  rows) and ``audit`` (``AUDIT#WS#{ws}``);
* from voc-memory (slice 4c, jobs/workspace_export/memory.py): the company memory only, ``memory_company``,
  ``memory_imports`` and ``memory_events``; personal memories and the extraction cursors are their owners' and are
  only counted.

Each page's rows come with the cursor that resumes right after them, so an invocation that runs out of time stops
after any row and the next one carries on from it.
"""
from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Final

from jobs.workspace_export.memory import ENTITIES as MEMORY_ENTITIES
from jobs.workspace_export.memory import MemorySource
from jobs.workspace_export.pages import TABLE_KEY, items, key, last_key, start
from shared.dynamo_values import as_count, plain
from shared.earliest_date import EARLIEST_DATE_ATTRIBUTE, earliest_date_key, parse_iso_date
from shared.import_runs import DETAIL_SK, LIST_PK
from shared.indexes import FEEDBACK_BY_DATE_INDEX
from shared.metric_keys import DAILY_TOTAL_PK, metric_partition
from shared.onboarding import FEEDBACK_FORM_PK
from shared.retention import ERASURE_JOB_PREFIX
from shared.ws_repo import (
    WorkspaceScope,
    WorkspaceTable,
    control_query,
    date_pk,
    erasure_job_pk,
    plugin_config_history_pk,
    plugin_config_pk,
)

__all__ = ['ENTITIES', 'FILE_CAP', 'ExportRefused', 'Source', 'encode_row', 'manifest']

#: The entities in the order the export writes them, the first phases of a run (handler.py ``PHASES``: then the
#: objects, the memory counts and the completion). A checkpoint names its phase, so an entity added in any position
#: never shifts a running export onto another: one that was past it across a deploy finishes without it (its count
#: reads 0), one that was before it writes it. A checkpoint from before phases were named is read by the 4b order.
ENTITIES: Final = ('feedback', 'plugin_configs', 'feedback_forms', 'import_runs', 'erasure_jobs', 'workspace',
                   'members', 'audit', 'plugin_config_history', *MEMORY_ENTITIES)
#: The most one JSONL file holds (before compression): a longer entity continues in its next file.
FILE_CAP: Final = 256 * 1024 * 1024
#: The index key of a feedback row: its table key and gsi1's, the cursor that resumes after it.
_FEEDBACK_KEY: Final = ('pk', 'sk', 'gsi1pk', 'gsi1sk')
#: What an export never carries of a row: a hash of a person's value (it could confirm a guessed one): an erasure's
#: value hash, and an `account_created` audit row's email hash (shared/workspace_members.py).
_DROPPED: Final = {'erasure_jobs': ('value_hash',), 'audit': ('email_sha256',)}
#: At most this many rows a feedback page (a day may hold many: the page then continues within the day).
PAGE_LIMIT: Final = 500

#: What a later phase keys by workspace (docs/multi-workspace.md, Phases): nothing of it is the workspace's yet.
NOT_PER_WORKSPACE: Final = ('projects_documents', 'personas', 'agents_workflows', 'settings')
#: Rows of the workspace an export leaves out, and why.
NOT_EXPORTED: Final = {
    # Per workspace since 7.15.00, not in the export yet: an open gap (docs/multi-workspace.md, 7.17.00). The
    # company memory is exported since 7.22.00 (memory.py); personal memories are only counted (EXCLUDED).
    'conversations': ("Not in this export yet: the members' assistant conversations in the workspace "
                      "(voc-conversations' WS#{ws}#USER#{sub} partitions) are per workspace since 7.15.00 and join "
                      'the export in a later release.'),
    'metrics': 'Derived: the METRIC# counters are rebuilt from the feedback (scripts/retention/rebuild_aggregates.py).',
    'runs': 'Operational: the source and scraper run records (SOURCE_RUN#, SCRAPER_RUN#).',
    'circuit_breaker': "Operational: the plugins' failure counts and breaker rows (FAILURES#, CIRCUIT#).",
    'logs': 'Operational: the validation and processing logs (LOGS#).',
    'watermarks': "Operational: each plugin's ingestion watermarks (voc-watermarks).",
    'idempotency': 'Operational: the processing claims (voc-idempotency).',
    'form_lookups': "Routing: each form's FORM# lookup row (the forms themselves are in feedback_forms).",
    'user_rows': "Routing: each member's USER# row behind their workspace list (the members are in members).",
}
#: What an export never holds, by design.
EXCLUDED: Final = {
    'credentials': ("A workspace's plugin credentials (SSM Parameter Store SecureStrings) are never exported: the "
                    'export job has no permission to read them. Save them again where the data is imported.'),
    'erasure_value_hash': "An erasure job's value hash is left out of erasure_jobs.",
    'email_hashes': "An audit row's email hash (a new account's) is left out of audit.",
    'memory_embeddings': ("A memory's embedding (a vector computed from its statement) is left out of memory_company: "
                          'it is derived, and is recomputed from the statement.'),
    'memory_derived': ("A memory's search_text (its statement in lower case, for search) and its status index keys "
                       '(gsi1pk, gsi1sk) are left out of memory_company: each is derived from the fields exported.'),
    'memory_people': ('Each memory entity exports only the fields it lists (any field added later stays out): a '
                      "company memory, the memory API's fields plus its key (pk, sk) and what a merge or an archive "
                      'writes (merged_from, archived_reason, archived_at); an import, the API\'s fields but '
                      'created_by_username, plus its key; an event, its key, action, at and detail. So never a '
                      "memory's supporter_set (hashes of its supporters' ids), an event's actor (a supporter's "
                      "hash), nor an import's created_by_hash or created_by_username. A company memory's "
                      "conflicts_with can hold a personal memory's id (an id only, never its content), and an "
                      "event's detail is exported whole."),
    'personal_memory': ("Personal memories and the extraction cursors are their owners' only (docs/memory.md): "
                        'never in the workspace export, only counted (memory.not_exported); personal memories\' '
                        'events are neither exported nor counted.'),
}
#: What a reader of the memory entities should know.
MEMORY_NOTE: Final = ("The workspace's company memory: every company memory (memory_company), the events of each "
                      '(memory_events) and the import rows (memory_imports; the imported files are among the '
                      'objects, under memory-imports/). Personal memories are their owners\' only (docs/memory.md) '
                      'and are not in the workspace export, nor are the extraction cursors (each points at a '
                      "member's session): those two are counted in memory.not_exported, approximately (the status "
                      "index is eventually consistent); personal memories' events are neither exported nor counted. "
                      'What every memory row leaves out is in excluded.')
#: The manifest's memory note for an export started before 7.22.00 and resumed past the memory entities.
MEMORY_NOT_RUN: Final = ('Not in this export: it was started by an earlier release and had already passed the point '
                         'where the memory entities are written when it resumed, so memory_company, memory_events '
                         'and memory_imports are empty here. Export again to include the company memory.')


def _shown(entity: str, item: Mapping[str, Any]) -> dict[str, Any]:
    """``item`` as the export writes it: without what ``_DROPPED`` leaves out of ``entity``."""
    dropped = _DROPPED.get(entity, ())
    return {name: value for name, value in item.items() if name not in dropped}


class ExportRefused(RuntimeError):
    """The export cannot be made complete; its message names no row and says what to do (the job row's error)."""


FEEDBACK_START_UNKNOWN: Final = ('The workspace counts feedback but records no first day for it (no earliest date '
                                 'and no daily counter): rebuild its counters, then export again.')


@dataclass(frozen=True)
class Row:
    """One row to export, and the cursor that resumes right after it."""

    item: dict[str, Any]
    after: dict[str, Any]


@dataclass(frozen=True)
class Page:
    """One page of an entity: its rows, and the cursor of the next page (None: the entity is done)."""

    rows: list[Row]
    following: dict[str, Any] | None


class Source:
    """One workspace's entities, through its views of voc-feedback and voc-aggregates (``ws_table``) and voc-workspaces
    (read by ``control_query`` only)."""

    def __init__(self, scope: WorkspaceScope, feedback: WorkspaceTable, aggregates: WorkspaceTable,
                 workspaces: Any, memory: WorkspaceTable) -> None:
        self.scope = scope
        self._feedback = feedback
        self._aggregates = aggregates
        self._workspaces = workspaces
        self.memory = MemorySource(scope, memory)

    # ── Where each entity starts ────────────────────────────────────────────────────────────────────────────

    def first_cursor(self, entity: str, started: date) -> dict[str, Any] | None:
        """The cursor of ``entity``'s first page, or None when it holds nothing to read (no feedback yet)."""
        if entity != 'feedback':
            return {'start': None}
        known = [day for day in (self._earliest_date(), self._first_counted_day()) if day is not None]
        if not known:
            # No feedback, or feedback with no first day on record: never an export that quietly holds none of it.
            if self.daily_total() > 0:
                raise ExportRefused(FEEDBACK_START_UNKNOWN)
            return None
        last = started + timedelta(days=1)
        return {'day': min(*known, last).isoformat(), 'last': last.isoformat(), 'start': None}

    def _earliest_date(self) -> date | None:
        item = self._aggregates.get_item(earliest_date_key(self.scope), ConsistentRead=True).get('Item')
        return parse_iso_date(item.get(EARLIEST_DATE_ATTRIBUTE)) if isinstance(item, Mapping) else None

    def _first_counted_day(self) -> date | None:
        """The first day of the workspace's ``daily_total`` counters (their ``sk``), a check on the watermark."""
        page = self._aggregates.query('pk', metric_partition(self.scope, DAILY_TOTAL_PK), Limit=1)
        first = items(page)
        return parse_iso_date(first[0].get('sk')) if first else None

    # ── One page ────────────────────────────────────────────────────────────────────────────────────────────

    def page(self, entity: str, cursor: Mapping[str, Any]) -> Page:
        if entity == 'feedback':
            return self._feedback_page(cursor)
        if entity == 'import_runs':
            return self._import_runs_page(cursor)
        if entity in MEMORY_ENTITIES:
            rows, following = self.memory.page(entity, cursor)
            # Already only the fields each memory entity lists (memory.py ``FIELDS``).
            return Page([Row(item, after) for item, after in rows], following)
        if entity in _AGGREGATE_PARTITIONS:
            partition, condition, values = _AGGREGATE_PARTITIONS[entity](self.scope)
            page = self._aggregates.query('pk', partition, sort_condition=condition, **_condition_values(values),
                                          **start(cursor.get('start')))
            return self._rows(entity, page)
        which, condition, values = _CONTROL_PARTITIONS[entity]
        page = control_query(self.scope, self._workspaces, which, sort_condition=condition,
                             **_condition_values(values), **start(cursor.get('start')))
        return self._rows(entity, page)

    def _rows(self, entity: str, page: Mapping[str, Any]) -> Page:
        rows = [Row(_shown(entity, item), {'start': key(item, TABLE_KEY)}) for item in items(page)]
        last = last_key(page)
        return Page(rows, {'start': last} if last else None)

    def _feedback_page(self, cursor: Mapping[str, Any]) -> Page:
        day, last_day = str(cursor['day']), str(cursor['last'])
        page = self._feedback.query('gsi1pk', date_pk(self.scope, day), IndexName=FEEDBACK_BY_DATE_INDEX,
                                    Limit=PAGE_LIMIT, **start(cursor.get('start')))
        rows = [Row(item, {'day': day, 'last': last_day, 'start': key(item, _FEEDBACK_KEY)})
                for item in items(page)]
        following = last_key(page)
        if following is not None:
            return Page(rows, {'day': day, 'last': last_day, 'start': following})
        next_day = date.fromisoformat(day) + timedelta(days=1)
        if next_day > date.fromisoformat(last_day):
            return Page(rows, None)
        return Page(rows, {'day': next_day.isoformat(), 'last': last_day, 'start': None})

    def _import_runs_page(self, cursor: Mapping[str, Any]) -> Page:
        """Each run's detail row (its summary's fields and its warnings and errors), the summary when it is gone."""
        page = self._aggregates.query('pk', self.scope.key(LIST_PK), **start(cursor.get('start')))
        rows = []
        for summary in items(page):
            run_id = summary.get('run_id')
            detail = None
            if isinstance(run_id, str) and run_id:
                found = self._aggregates.get_item({'pk': self.scope.key(LIST_PK, run_id), 'sk': DETAIL_SK})
                detail = found.get('Item')
            rows.append(Row(dict(detail) if isinstance(detail, Mapping) else summary,
                            {'start': key(summary, TABLE_KEY)}))
        last = last_key(page)
        return Page(rows, {'start': last} if last else None)

    # ── The counts check ────────────────────────────────────────────────────────────────────────────────────

    def daily_total(self) -> int:
        """The sum of the workspace's ``daily_total`` counters (``WS#{ws}#METRIC#daily_total``, every day)."""
        rows = self._aggregates.iter_query('pk', metric_partition(self.scope, DAILY_TOTAL_PK))
        return sum(as_count(row.get('count')) for row in rows)


def _condition_values(values: Mapping[str, Any]) -> dict[str, Any]:
    if not values:
        return {}
    return {'ExpressionAttributeNames': {'#sk': 'sk'}, 'ExpressionAttributeValues': dict(values)}


def _erasure_jobs(scope: WorkspaceScope) -> tuple[str, str | None, dict[str, str]]:
    return erasure_job_pk(scope), 'begins_with(#sk, :prefix)', {':prefix': ERASURE_JOB_PREFIX}


#: An aggregates entity: its partition, and the sort condition and values that keep its own rows (a lock row out).
_AGGREGATE_PARTITIONS: Final = {
    'plugin_configs': lambda scope: (plugin_config_pk(scope), None, {}),
    'plugin_config_history': lambda scope: (plugin_config_history_pk(scope), None, {}),
    'feedback_forms': lambda scope: (scope.key(FEEDBACK_FORM_PK), None, {}),
    'erasure_jobs': _erasure_jobs,
}
#: A control-plane entity: its partition (``control_query``), sort condition and values.
_CONTROL_PARTITIONS: Final = {
    'workspace': ('meta', '#sk = :meta', {':meta': 'META'}),
    'members': ('meta', 'begins_with(#sk, :member)', {':member': 'MEMBER#'}),
    'audit': ('audit', None, {}),
}


def _bytes(value: object) -> str:
    """A binary attribute as base64 text (json cannot carry bytes)."""
    raw = getattr(value, 'value', value)
    if isinstance(raw, bytes | bytearray):
        return base64.b64encode(bytes(raw)).decode('ascii')
    raise TypeError(f'not exportable: {type(value).__name__}')


def encode_row(item: Mapping[str, Any]) -> bytes:
    """One JSONL line: the row as stored (numbers as numbers, sets as sorted lists, binary as base64), keys sorted."""
    return (json.dumps(plain(item), ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=_bytes)
            + '\n').encode('utf-8')


def manifest(*, export_id: str, scope: WorkspaceScope, workspace: Mapping[str, Any], created_at: str,
             completed_at: str, files: Mapping[str, list[str]], counts: Mapping[str, int],
             daily_total: int, objects: Mapping[str, Any], memory_left_out: Mapping[str, tuple[int, bool]],
             memory_exported: bool = True) -> bytes:
    """``manifest.json``: every entity with its files and count, the counts check against the workspace's
    ``daily_total`` counters, what is not per workspace yet, not exported or excluded, the workspace's objects
    (``objects``: jobs/workspace_export/objects.py ``manifest_section``), and the memory left out (``memory_left_out``:
    ``{what: (count, complete)}``, counted by jobs/workspace_export/memory.py). ``memory_exported`` False (a run
    resumed from an earlier release's checkpoint past the memory entities) lists ``memory`` as not exported."""
    feedback = int(counts.get('feedback', 0))
    not_exported = dict(NOT_EXPORTED) if memory_exported else {**NOT_EXPORTED, 'memory': MEMORY_NOT_RUN}
    document = {
        'format': 'voc-workspace-export',
        'version': 1,
        'export_id': export_id,
        'workspace': {'id': scope.ws, 'name': workspace.get('name'), 'slug': workspace.get('slug')},
        'created_at': created_at,
        'completed_at': completed_at,
        'entities': {entity: {'files': list(files.get(entity, [])), 'count': int(counts.get(entity, 0))}
                     for entity in ENTITIES},
        'counts_check': {
            'feedback': feedback, 'daily_total': daily_total, 'matches': feedback == daily_total,
            'note': ('The feedback exported, against the sum of the daily_total counters. A difference means items '
                     'without a date, counters that expired, or items that arrived while the export ran.'),
        },
        'memory': {
            'note': MEMORY_NOTE if memory_exported else MEMORY_NOT_RUN,
            'not_exported': {what: {'count': count, 'complete': complete, 'approximate': True}
                             for what, (count, complete) in memory_left_out.items()},
        },
        'not_per_workspace': {name: {'status': 'not_per_workspace', 'phase': 3, 'count': 0}
                              for name in NOT_PER_WORKSPACE},
        'not_exported': not_exported,
        'excluded': dict(EXCLUDED),
        'objects': dict(objects),
    }
    return (json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')
