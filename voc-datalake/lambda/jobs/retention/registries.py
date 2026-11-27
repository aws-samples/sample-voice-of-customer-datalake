"""voc-retention: the ``registries`` phase, and the deployment lineage it owes (7.93.00, projects 3g-d2;
docs/multi-workspace.md, the project plan's 3g-d2).

The deployment's own links, commented series and projects are found through their registries (``DOCSHARE_IDS``,
``COMMENT_SERIES_IDS``, ``PROJECT_IDS``; shared/review_registries.py), and since 7.93.00 only through them: the Scans
that found the same rows until the backfill had run are the backfill's alone. So every run that names no workspace and can delete or replay
starts with this phase:

* the backfill's marker, one strongly consistent Query (``marker_present``); without a complete one the result is
  ``REGISTRIES_NOT_BACKFILLED`` and nothing else is read;
* the gap check, a bounded walk of its own (``step``, cursor ``{gap_from, gap_checked}``, handed over like the other
  phases): one page of the live projects on ``gsi1-by-type`` (``TYPE#PROJECT``, ``ID_PAGE`` rows, the keys only,
  ``INDEX_ATTRIBUTES``; an index answers eventually consistent, but a project's create lists it in ``PROJECT_IDS``
  before its ``META`` reaches the index, so one being created never reads as a gap) and one strongly consistent
  BatchGetItem of their ``PROJECT_IDS`` rows (their keys only), a step; a live project missing there makes the result
  ``REGISTRIES_INCOMPLETE``, the walk's end ``REGISTRIES_COMPLETE``. A verification fixture's project (shared/project_writes.py
  ``is_verification_fixture_project``: no person's data, never listed) and the persona library are passed.

The result is the run's (``RESULT``, carried across hand-overs, on the job and audit rows). What it cannot see: an
unlisted review link and an unlisted comment series (no index names either) and an unlisted deleted or half-deleted
project (the delete's fence takes its ``META`` off the index); those stay guarded by the backfill's ``--unmark``.

What a run does with it (handler.py):

* the deployment's erasure by email without a source: its walk of the deployment's people is the erasure itself, and
  the address is not stored, so it cannot be owed: without ``REGISTRIES_COMPLETE`` it fails in this phase, by name, before it
  deletes anything (``refusal``: ``ReviewRegistriesNotBackfilled``, ``ReviewRegistriesIncomplete``);
* every other run (a retention window, an erasure by author, source, id or row) deletes as usual; its deployment
  lineage pass needs the registries, so without ``REGISTRIES_COMPLETE`` it OWES that pass (``owe``): one durable row,
  ``OWED_KEY`` in voc-aggregates, holding the sources whose tombstones are owed and the runs that owed them (at most
  ``MAX_OWED_RUNS``, then ``runs_more``); the run says so on its rows (``lineage_owed``, ``incomplete_reason``, the
  text for its mode) and prints the ``RetentionLineageOwed`` metric;
* any later run of the deployment whose registries are complete reads that row (``load_owed``), runs its lineage pass
  over those sources too, whether it deleted anything or not (the marks are idempotent and keyed by the tombstones),
  and clears the row once its pass ended (``clear_owed``: a conditional put on the version it read, so anything owed
  after it read the row stays for the next run). Retention is opt-in, so a daily window that retains nothing still
  runs this phase and the lineage pass while the row names a source (``owes``; handler.py ``Walk.owed_only``).

The marker is read again at each invocation's start (handler.py ``_recheck_marker``), so an ``--unmark`` during a run
is seen. Round 2: the phase resumed with a cursor reads it again before its next page; a run that fails
after it deleted, before its lineage pass ended, owes too (handler.py ``_owe_after_failure``, every failure path), its
reason saying it failed before its marks (``owed_reason``); a run whose ``owe`` itself fails still says its marks are
owed, that they could not be recorded (``OWE_FAILED_REASON``, the metric's ``OWE_FAILED``); and every run that cannot
replay what is owed says so (``note_owed``). A failed run, and a run that owes, print an EMF line (``emit``: namespace ``VoC``, dimension sets
``[service]`` and ``[service, error_type]``) that shared/ops_alerts.py alarms on once alerting is on.
"""
from __future__ import annotations

import json
import os
import sys
import time
from collections.abc import Mapping
from decimal import Decimal
from typing import Any, ClassVar, Final

from botocore.exceptions import ClientError

from shared import project_walk, review_registries
from shared.aws import is_conditional_check_failure
from shared.batch_get import batch_get_all
from shared.company_personas import COMPANY_PERSONAS_CONTAINER
from shared.indexes import PROJECTS_BY_TYPE_INDEX
from shared.ingest_tables import table_view
from shared.project_keys import (
    DEPLOYMENT_LINK_REGISTRY_PK,
    DEPLOYMENT_PROJECT_REGISTRY_PK,
    REVIEW_REGISTRIES_MARKER_SK,
    project_id_of,
    project_type_pk,
)
from shared.project_walk import checked_key, is_project_id, merged, query_page, sort_key
from shared.project_writes import is_verification_fixture_project
from shared.retention import MALFORMED_ID_COUNTER
from shared.scoped_query import SK_EQUALS
from shared.timestamps import now_iso

#: The phase's name (handler.py), the run's field that holds its result, and the results.
PHASE: Final = 'registries'
RESULT: Final = 'review_registries'
REGISTRIES_COMPLETE: Final = 'complete'
REGISTRIES_NOT_BACKFILLED: Final = 'not_backfilled'
REGISTRIES_INCOMPLETE: Final = 'incomplete'
RESULTS: Final = (REGISTRIES_COMPLETE, REGISTRIES_NOT_BACKFILLED, REGISTRIES_INCOMPLETE)
#: The run's fields when it owes its lineage pass, and when it replayed what was owed.
LINEAGE_OWED: Final = 'lineage_owed'
INCOMPLETE_REASON: Final = 'incomplete_reason'
REPLAYED: Final = 'lineage_owed_replayed'
#: Set once the run's deployment lineage pass ended (carried): a failure after it owes nothing (handler.py).
LINEAGE_DONE: Final = 'lineage_done'
#: The ``error_type`` a run that owes because it failed prints (its registries were complete).
FAILED_BEFORE_LINEAGE: Final = 'failed_before_lineage'
#: The ``error_type`` a failed run prints when its owed row could not be written (``owe`` failed: round 2, q-1).
OWE_FAILED: Final = 'owe_failed'
#: What a run read of the owed row: the sources it replays, and the row's version (its clear is conditioned on it).
OWED_SOURCES: Final = 'owed_sources'
OWED_VERSION: Final = 'owed_version'
#: The owed row, in voc-aggregates (the worker's GetItem and PutItem there; never an ``AUDIT#`` row).
OWED_KEY: Final = {'pk': 'JOB#retention', 'sk': 'LINEAGE_OWED'}
MAX_OWED_RUNS: Final = 50
#: The sources a row may owe: a deployment's configured sources, far fewer (past it ``owe`` raises
#: ``TooManyOwedSources`` and the run says its marks could not be recorded, ``OWE_FAILED_REASON``).
MAX_OWED_SOURCES: Final = 1000
_OWE_TRIES: Final = 3
#: What the gap check reads of ``gsi1-by-type``: the table's and the index's keys (lib/stacks/retention-worker.ts holds
#: its Query to ``PROJECTS_INDEX_ATTRIBUTES``, a test the two together), and of a ``PROJECT_IDS`` row its key.
INDEX_ATTRIBUTES: Final = ('pk', 'sk', 'gsi1pk', 'gsi1sk')
#: A projection to the table's key (the first two of ``INDEX_ATTRIBUTES``): the index page's and the registry rows'.
_KEYS_ONLY: Final = {'ProjectionExpression': ', '.join(f'#{name}' for name in INDEX_ATTRIBUTES[:2]),
                     'ExpressionAttributeNames': {f'#{name}': name for name in INDEX_ATTRIBUTES[:2]}}
#: The metrics a failed run and a run that owes print (shared/ops_alerts.py ``RETENTION_ALARM_METRICS``).
FAILED_METRIC: Final = 'RetentionRunFailed'
OWED_METRIC: Final = 'RetentionLineageOwed'
METRICS_NAMESPACE: Final = 'VoC'
_BACKFILL: Final = 'scripts/projects/backfill_review_registries.py'
_OPERATOR: Final = "ask the deployment's operator to run"
#: The operator's fix for each result that is not complete: one copy, in the erasure's failure (``what_to_do``) and in
#: an owing run's reason (``owed_reason``).
_NOT_BACKFILLED_FIX: Final = f'the review registries are not backfilled: {_OPERATOR} {_BACKFILL} --apply'
_INCOMPLETE_FIX: Final = (f'a live project is missing from the project registry: {_OPERATOR} {_BACKFILL} --unmark, '
                          'then --apply')
#: Why a failed run owes its marks when the owed row could not be written (``note_owed`` after ``owe`` failed): no
#: later run replays them, so the reason says where its sources are.
OWE_FAILED_REASON: Final = ("this run's lineage marks are owed but could not be recorded, so no later run makes them "
                            "on its own: the sources it erased from are on its audit row; ask the deployment's "
                            "operator to read the worker's logs for the cause")


class NeedsAnAdmin(RuntimeError):
    """A failure fixed outside the job: its row says what to do (``what_to_do``, each subclass's fixed text that never
    quotes the erased value), beside the failure's name (handler.py)."""

    what_to_do: ClassVar[str]


class ReviewRegistriesNotBackfilled(NeedsAnAdmin):
    """An erasure by email found no complete marker: it fails before it deletes anything, and Scans nothing."""

    what_to_do: ClassVar[str] = f'{_NOT_BACKFILLED_FIX}, then run the erasure again'


class ReviewRegistriesIncomplete(NeedsAnAdmin):
    """An erasure by email found a live project the project registry does not list: it fails before it deletes."""

    what_to_do: ClassVar[str] = f'{_INCOMPLETE_FIX}; then run the erasure again'


class TooManyOwedSources(RuntimeError):
    """The owed row would name more than ``MAX_OWED_SOURCES`` sources (the run fails rather than drop one)."""


def refusal(result: object) -> NeedsAnAdmin:
    """The named failure of an erasure by email whose registries are ``result`` (not ``REGISTRIES_COMPLETE``)."""
    return ReviewRegistriesIncomplete() if result == REGISTRIES_INCOMPLETE else ReviewRegistriesNotBackfilled()


def owed_reason(run: Mapping[str, Any]) -> str:
    """Why a run owes its lineage marks, and what happens next, for its mode (``incomplete_reason``): its registries
    were not complete (what the deployment's operator runs), or it failed before its lineage pass (round 2, R2-1)."""
    then = ('the next daily retention window makes them on its own' if run.get('mode') == 'retention' else
            'the next erasure of the deployment, or the next daily retention window, makes them on its own')
    if run.get(RESULT) == REGISTRIES_COMPLETE:
        return f"this run failed before its lineage marks, which are owed; {then}"
    fix = _INCOMPLETE_FIX if run.get(RESULT) == REGISTRIES_INCOMPLETE else _NOT_BACKFILLED_FIX
    return f"this run's lineage marks are owed, {fix}; then {then}"


def marker_present(projects_table: Any) -> bool:
    """Whether the backfill's marker is there and complete (one strongly consistent Query, projected to what
    ``review_registries.marker_complete`` judges)."""
    rows, _ = query_page(table_view(None, projects_table), DEPLOYMENT_LINK_REGISTRY_PK, None, ConsistentRead=True,
                         **merged(sort_key(SK_EQUALS, {':sk': REVIEW_REGISTRIES_MARKER_SK}),
                                  review_registries.MARKER_PROJECTION))
    return bool(rows) and review_registries.marker_complete(rows[0])


class _RegistryUnreadable(RuntimeError):
    """The registry lookup left keys unprocessed (the run fails and says so)."""


def step(projects_table: Any, run: dict[str, Any], cursor: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """One step of the phase (the module docstring): from the start (``cursor`` None) the marker, then a page; else
    the next page. None once the run's result is set (``RESULT``), else the next step's cursor."""
    if cursor is None:
        if not marker_present(projects_table):
            run[RESULT] = REGISTRIES_NOT_BACKFILLED
            return None
        # ``gap_checked`` (the live projects looked up so far) is diagnostic only: carried and validated, read by no
        # decision; the walk's end is the index's last page.
        at: dict[str, Any] = {'gap_from': None, 'gap_checked': 0}
    else:
        at = dict(cursor)
    checked = at.get('gap_checked')
    if not isinstance(checked, int) or isinstance(checked, bool) or checked < 0:
        raise ValueError('a carried gap count is not one')
    rows, following = query_page(table_view(None, projects_table), project_type_pk(), checked_key(at.get('gap_from')),
                                 partition_attribute='gsi1pk', IndexName=PROJECTS_BY_TYPE_INDEX,
                                 Limit=project_walk.ID_PAGE,
                                 **_KEYS_ONLY)
    live = _live_ids(run, rows)
    if live and not _all_listed(projects_table, live):
        run[RESULT] = REGISTRIES_INCOMPLETE
        return None
    if following is None:
        run[RESULT] = REGISTRIES_COMPLETE
        return None
    return {'gap_from': following, 'gap_checked': checked + len(live)}


def _live_ids(run: dict[str, Any], rows: list[dict[str, Any]]) -> list[str]:
    """The page's live project ids to look up: a project's ``META`` shaped like one, the persona library and a
    verification fixture's project passed, a row of another shape counted (``project_ids_malformed``)."""
    ids: list[str] = []
    for row in rows:
        project_id = project_id_of(row.get('pk')) if row.get('sk') == 'META' else None
        if project_id == COMPANY_PERSONAS_CONTAINER or is_verification_fixture_project(project_id):
            continue
        if is_project_id(project_id):
            ids.append(str(project_id))
        else:
            run[MALFORMED_ID_COUNTER] = int(run.get(MALFORMED_ID_COUNTER) or 0) + 1
    return ids


def _all_listed(projects_table: Any, ids: list[str]) -> bool:
    """Whether ``PROJECT_IDS`` holds every one of ``ids`` (one BatchGetItem a page: ``ID_PAGE`` keys at most)."""
    keys = [{'pk': DEPLOYMENT_PROJECT_REGISTRY_PK, 'sk': project_id} for project_id in ids]
    rows = batch_get_all(projects_table, keys, failure=_RegistryUnreadable('The project registry could not be read'),
                         read_options={'ConsistentRead': True, **_KEYS_ONLY,
                                       'ExpressionAttributeNames': dict(_KEYS_ONLY['ExpressionAttributeNames'])})
    return {str(row.get('sk')) for row in rows} >= set(ids)


# ── The owed lineage ─────────────────────────────────────────────────────────────────────────────────────────────

def _owed_row(aggregates_table: Any) -> dict[str, Any] | None:
    item = aggregates_table.get_item(Key=dict(OWED_KEY), ConsistentRead=True).get('Item')
    return dict(item) if isinstance(item, Mapping) else None


def _strings(value: object) -> list[str]:
    """A stored list of strings (the owed row's ``sources`` and ``runs``); none for any other value."""
    return list(map(str, value)) if isinstance(value, list) else []


def _version(row: Mapping[str, Any] | None) -> int:
    value = (row or {}).get('version')
    # DynamoDB answers numbers as Decimal.
    return int(value) if isinstance(value, int | Decimal) and not isinstance(value, bool) else 0


def _put_versioned(aggregates_table: Any, item: dict[str, Any], read: Mapping[str, Any] | None) -> bool:
    """The row put only while it is the version read (or still absent); False when it moved meanwhile."""
    condition = ({'ConditionExpression': '#v = :v', 'ExpressionAttributeNames': {'#v': 'version'},
                  'ExpressionAttributeValues': {':v': _version(read)}} if read is not None
                 else {'ConditionExpression': 'attribute_not_exists(pk)'})
    try:
        aggregates_table.put_item(Item=item, **condition)
    except ClientError as error:
        if is_conditional_check_failure(error):
            return False
        raise
    return True


def owe(aggregates_table: Any, run: dict[str, Any]) -> None:
    """Record that the run's deployment lineage pass is owed (the module docstring): its sources added to the row's,
    its run added to the row's runs (the latest ``MAX_OWED_RUNS``); then the run says so (``LINEAGE_OWED``,
    ``INCOMPLETE_REASON``) and prints ``OWED_METRIC``."""
    sources = _strings(run.get('erased_sources')) + _strings(run.get(OWED_SOURCES))
    who = str(run.get('job_id') or run.get('run_id') or '')
    for _try in range(_OWE_TRIES):
        read = _owed_row(aggregates_table)
        owed = sorted({*_strings((read or {}).get('sources')), *sources})
        if len(owed) > MAX_OWED_SOURCES:
            raise TooManyOwedSources(f'more than {MAX_OWED_SOURCES} sources owe their lineage marks')
        listed = [each for each in _strings((read or {}).get('runs')) if each != who] + ([who] if who else [])
        item = {**OWED_KEY, 'sources': owed, 'runs': listed[-MAX_OWED_RUNS:],
                'runs_more': bool((read or {}).get('runs_more')) or len(listed) > MAX_OWED_RUNS,
                'version': _version(read) + 1, 'updated_at': now_iso()}
        if _put_versioned(aggregates_table, item, read):
            break
    else:
        raise RuntimeError('The owed lineage row kept changing')
    note_owed(run)


def note_owed(run: dict[str, Any], *, reason: str | None = None, error_type: str | None = None) -> None:
    """The run says the deployment's lineage is owed (``LINEAGE_OWED``, ``INCOMPLETE_REASON``) and prints
    ``OWED_METRIC`` once: after it owed its own pass (``owe``), when it could not replay what an earlier run owes
    because its registries are not complete (round 2, R2-3: the daily runs that only replay too), or when its ``owe``
    failed (handler.py ``_owe_after_failure``: ``reason`` ``OWE_FAILED_REASON``, ``error_type`` ``OWE_FAILED``)."""
    if run.get(LINEAGE_OWED) is True:
        return
    run[LINEAGE_OWED] = True
    run[INCOMPLETE_REASON] = reason or owed_reason(run)
    result = run.get(RESULT)
    emit(OWED_METRIC, error_type or (FAILED_BEFORE_LINEAGE if result == REGISTRIES_COMPLETE
                                     else str(result or REGISTRIES_NOT_BACKFILLED)))


def owes(aggregates_table: Any) -> bool:
    """Whether an earlier run owes a lineage pass (the row names a source): a daily window that retains nothing then
    still runs its registries and lineage phases (handler.py ``owed_only``)."""
    return bool(_strings((_owed_row(aggregates_table) or {}).get('sources')))


def load_owed(aggregates_table: Any, run: dict[str, Any]) -> None:
    """Read the owed row once a run (its registries complete) reaches its lineage pass: the sources to replay, and the
    version its clear is conditioned on (both carried across hand-overs). Read once per run."""
    if OWED_VERSION in run:
        return
    read = _owed_row(aggregates_table)
    run[OWED_SOURCES] = _strings((read or {}).get('sources'))
    run[OWED_VERSION] = _version(read) if read is not None else -1


def clear_owed(aggregates_table: Any, run: dict[str, Any]) -> None:
    """Once the lineage pass ended: the owed row emptied, but only while it is the version the run read (anything owed
    since stays, and the next complete run replays it all again: the marks are idempotent)."""
    version = run.get(OWED_VERSION)
    if not run.get(OWED_SOURCES) or not isinstance(version, int) or version < 0:
        return
    item = {**OWED_KEY, 'sources': [], 'runs': [], 'runs_more': False, 'version': version + 1, 'updated_at': now_iso()}
    if _put_versioned(aggregates_table, item, {'version': version}):
        run[REPLAYED] = True


# ── The alarm's metric ───────────────────────────────────────────────────────────────────────────────────────────

def emit(metric: str, error_type: str) -> None:
    """One EMF line: ``metric`` = 1 in ``METRICS_NAMESPACE``, by ``service`` (the alarm's) and by ``service`` and
    ``error_type`` (which failure, for the console); the value of ``error_type`` is a class or result name, never a
    message."""
    service = os.environ.get('POWERTOOLS_SERVICE_NAME') or 'voc-retention'
    document = {
        '_aws': {'Timestamp': int(time.time() * 1000), 'CloudWatchMetrics': [{
            'Namespace': METRICS_NAMESPACE, 'Dimensions': [['service'], ['service', 'error_type']],
            'Metrics': [{'Name': metric, 'Unit': 'Count'}]}]},
        'service': service, 'error_type': error_type[:64], metric: 1,
    }
    sys.stdout.write(json.dumps(document) + '\n')
    sys.stdout.flush()


def fields(run: Mapping[str, Any]) -> dict[str, Any]:
    """What the job and audit rows say of the phase: its result, and, when owed or replayed, that."""
    result = run.get(RESULT)
    out: dict[str, Any] = {RESULT: result} if result in RESULTS else {}
    if run.get(LINEAGE_OWED) is True:
        out.update({LINEAGE_OWED: True, INCOMPLETE_REASON: str(run.get(INCOMPLETE_REASON) or owed_reason(run))})
    if run.get(REPLAYED) is True:
        out[REPLAYED] = True
    return out
