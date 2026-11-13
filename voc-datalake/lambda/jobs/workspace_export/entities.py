"""What a workspace's export holds, read one page at a time, and its manifest (docs/multi-workspace.md, "Export and
delete", step 2).

Every read is a Query (``dynamodb:LeadingKeys`` cannot limit a Scan) of the workspace's own partitions, through the
workspace layer (shared/ws_repo.py):

* ``feedback``: voc-feedback's ``gsi1-by-date`` (every attribute projected), one partition per day,
  ``WS#{ws}#DATE#{yyyy-mm-dd}``, from the workspace's earliest date (``WS#{ws}#METRIC#meta`` / ``earliest_date``) to
  the day after the export started;
* from voc-aggregates (``ws_table``): ``plugin_configs`` (``WS#{ws}#PLUGIN_CONFIG``), ``feedback_forms``
  (``#FEEDBACK_FORM``), ``import_runs`` (each run's detail row ``#IMPORT_RUN#{run}``, found from its summary in
  ``#IMPORT_RUN``; the summary itself when the detail is gone) and ``erasure_jobs`` (``#JOB#erasure``, ``er_…`` rows,
  without ``value_hash``);
* from voc-workspaces (``control_query``): ``workspace`` (``WS#{ws}`` / ``META``), ``members`` (its ``MEMBER#``
  rows) and ``audit`` (``AUDIT#WS#{ws}``).

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
    plugin_config_pk,
)

__all__ = ['ENTITIES', 'FILE_CAP', 'ExportRefused', 'Source', 'encode_row', 'manifest']

#: The entities in the order the export writes them.
ENTITIES: Final = ('feedback', 'plugin_configs', 'feedback_forms', 'import_runs', 'erasure_jobs', 'workspace',
                   'members', 'audit')
#: The most one JSONL file holds (before compression): a longer entity continues in its next file.
FILE_CAP: Final = 256 * 1024 * 1024
#: The index key of a feedback row: its table key and gsi1's, the cursor that resumes after it.
_FEEDBACK_KEY: Final = ('pk', 'sk', 'gsi1pk', 'gsi1sk')
_TABLE_KEY: Final = ('pk', 'sk')
#: What an export never carries of a row: a hash of a person's value (it could confirm a guessed one): an erasure's
#: value hash, and an `account_created` audit row's email hash (shared/workspace_members.py).
_DROPPED: Final = {'erasure_jobs': ('value_hash',), 'audit': ('email_sha256',)}
#: At most this many rows a feedback page (a day may hold many: the page then continues within the day).
PAGE_LIMIT: Final = 500

#: What a later phase keys by workspace (docs/multi-workspace.md, Phases): nothing of it is the workspace's yet.
NOT_PER_WORKSPACE: Final = ('projects_documents', 'personas', 'memory', 'agents_workflows', 'conversations',
                            'settings')
#: Rows of the workspace an export leaves out, and why.
NOT_EXPORTED: Final = {
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
}
RAW_OBJECTS: Final = {'status': 'not_included_yet',
                      'note': 'The raw and Silver objects under ws/{ws}/ join the export in a later release.'}


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


def _key(item: Mapping[str, Any], attributes: tuple[str, ...]) -> dict[str, Any]:
    """The key a Query resumes after ``item`` from: every one of ``attributes`` (a key attribute: always there)."""
    return {attribute: item[attribute] for attribute in attributes}


def _start(cursor: Mapping[str, Any]) -> dict[str, Any]:
    start = cursor.get('start')
    return {'ExclusiveStartKey': dict(start)} if isinstance(start, Mapping) and start else {}


def _items(page: Mapping[str, Any]) -> list[dict[str, Any]]:
    items = page.get('Items')
    return [dict(item) for item in items if isinstance(item, Mapping)] if isinstance(items, list) else []


def _last_key(page: Mapping[str, Any]) -> dict[str, Any] | None:
    """A page's cursor: the job pages by hand (a time budget, a hand-over between rows, a checkpointed cursor)."""
    last = page.get('LastEvaluatedKey')
    return dict(last) if isinstance(last, Mapping) and last else None


class Source:
    """One workspace's entities, through its views of voc-feedback and voc-aggregates (``ws_table``) and voc-workspaces
    (read by ``control_query`` only)."""

    def __init__(self, scope: WorkspaceScope, feedback: WorkspaceTable, aggregates: WorkspaceTable,
                 workspaces: Any) -> None:
        self.scope = scope
        self._feedback = feedback
        self._aggregates = aggregates
        self._workspaces = workspaces

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
        items = _items(page)
        return parse_iso_date(items[0].get('sk')) if items else None

    # ── One page ────────────────────────────────────────────────────────────────────────────────────────────

    def page(self, entity: str, cursor: Mapping[str, Any]) -> Page:
        if entity == 'feedback':
            return self._feedback_page(cursor)
        if entity == 'import_runs':
            return self._import_runs_page(cursor)
        if entity in _AGGREGATE_PARTITIONS:
            partition, condition, values = _AGGREGATE_PARTITIONS[entity](self.scope)
            page = self._aggregates.query('pk', partition, sort_condition=condition, **_condition_values(values),
                                          **_start(cursor))
            return self._rows(entity, page)
        which, condition, values = _CONTROL_PARTITIONS[entity]
        page = control_query(self.scope, self._workspaces, which, sort_condition=condition,
                             **_condition_values(values), **_start(cursor))
        return self._rows(entity, page)

    def _rows(self, entity: str, page: Mapping[str, Any]) -> Page:
        dropped = _DROPPED.get(entity, ())
        rows = [Row({name: value for name, value in item.items() if name not in dropped},
                    {'start': _key(item, _TABLE_KEY)}) for item in _items(page)]
        last = _last_key(page)
        return Page(rows, {'start': last} if last else None)

    def _feedback_page(self, cursor: Mapping[str, Any]) -> Page:
        day, last_day = str(cursor['day']), str(cursor['last'])
        page = self._feedback.query('gsi1pk', date_pk(self.scope, day), IndexName=FEEDBACK_BY_DATE_INDEX,
                                    Limit=PAGE_LIMIT, **_start(cursor))
        rows = [Row(item, {'day': day, 'last': last_day, 'start': _key(item, _FEEDBACK_KEY)})
                for item in _items(page)]
        following = _last_key(page)
        if following is not None:
            return Page(rows, {'day': day, 'last': last_day, 'start': following})
        next_day = date.fromisoformat(day) + timedelta(days=1)
        if next_day > date.fromisoformat(last_day):
            return Page(rows, None)
        return Page(rows, {'day': next_day.isoformat(), 'last': last_day, 'start': None})

    def _import_runs_page(self, cursor: Mapping[str, Any]) -> Page:
        """Each run's detail row (its summary's fields and its warnings and errors), the summary when it is gone."""
        page = self._aggregates.query('pk', self.scope.key(LIST_PK), **_start(cursor))
        rows = []
        for summary in _items(page):
            run_id = summary.get('run_id')
            detail = None
            if isinstance(run_id, str) and run_id:
                found = self._aggregates.get_item({'pk': self.scope.key(LIST_PK, run_id), 'sk': DETAIL_SK})
                detail = found.get('Item')
            rows.append(Row(dict(detail) if isinstance(detail, Mapping) else summary,
                            {'start': _key(summary, _TABLE_KEY)}))
        last = _last_key(page)
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
             daily_total: int) -> bytes:
    """``manifest.json``: every entity with its files and count, the counts check against the workspace's
    ``daily_total`` counters, what is not per workspace yet, not exported or excluded, and the raw objects' status."""
    feedback = int(counts.get('feedback', 0))
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
        'not_per_workspace': {name: {'status': 'not_per_workspace', 'phase': 3, 'count': 0}
                              for name in NOT_PER_WORKSPACE},
        'not_exported': dict(NOT_EXPORTED),
        'excluded': dict(EXCLUDED),
        'raw_objects': dict(RAW_OBJECTS),
    }
    return (json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')
