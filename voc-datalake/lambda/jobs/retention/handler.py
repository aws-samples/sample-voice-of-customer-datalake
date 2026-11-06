"""voc-retention: the opt-in per-source retention and erasure worker.

The only Lambda that deletes customer feedback (``shared/retention.py`` says
what and how), and only for a legal obligation (TENETS.md D5). Two modes:

- ``{"mode": "retention"}`` — the daily schedule (an event without ``mode``
  reads the same). Deletes items of every source whose profile sets
  ``retention_days`` and whose ``date`` is older than the cutoff, under the
  profile's ``retention_legal_basis`` (``shared/legal_basis.py``). Nothing is
  deleted when no profile sets one, or when the profiles cannot be read.
- ``{"mode": "erase", "job_id": "er_<12 hex>", "value": ...}`` — started by
  ``POST /settings/erasure`` (async invoke). The job row (``pk JOB#erasure``)
  holds the field, the optional source, the legal basis and the value's
  SHA-256; the value itself travels only in the invoke payload, is checked
  against that hash, and is never stored or logged.

A run walks its PHASES in order, each paged and time-budgeted:

1. ``items`` — voc-feedback;
2. ``radar`` — voc-radar (other brands' reviews), when ``RADAR_TABLE`` is set;
   then ``boards`` — an erasure by email only, when ``FEATURE_REQUESTS_TABLE`` is set:
   the person's board requests and +1s are de-identified and their raw copies deleted
   (``boards.py``);
3. ``raw`` — whole-source erasure only: every object version left under
   ``raw/{source}/`` and ``silver/{source}/`` (``shared/retention.delete_raw_prefix_page``);
4. ``lineage`` — when the run deleted anything and ``PROJECTS_TABLE`` is set:
   artifacts that cited a deleted item are marked (``lineage.py``).

Each deleted item first gets a tombstone (``copies.py``); its kept Silver versions
(``silver/{source}/{feedback_id}/``) are deleted with it (``shared/retention.delete_item``). Before the Lambda's
budget runs out the worker re-invokes itself with its phase, the phase's scan
cursor and its running state (``runs.py``). Deletes are idempotent, so a
duplicate delivery or an overlapping daily run only repeats no-ops. Every
finished run (and every failure) writes one audit row (``pk AUDIT#retention``).

Env: ``FEEDBACK_TABLE``, ``AGGREGATES_TABLE``, ``RAW_DATA_BUCKET``, ``RADAR_TABLE``, ``PROJECTS_TABLE``,
``FEATURE_REQUESTS_TABLE``.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from boto3.dynamodb.conditions import ConditionBase
from botocore.exceptions import BotoCoreError, ClientError

from jobs.retention import boards, lineage
from jobs.retention.copies import ItemDeleter, write_tombstones
from jobs.retention.runs import (
    BOARD_COUNTER,
    MODE_ERASE,
    MODE_RETENTION,
    board_count,
    carried_state,
    claim_erasure_job,
    finish_erasure_job,
    new_run,
    record_progress,
    write_audit,
)
from shared import retention
from shared.aws import get_dynamodb_resource, get_s3_client, invoke_lambda_async
from shared.data_version import bump_data_version, bump_radar_version
from shared.digests import sha256_hex
from shared.invocation_cost import instrumented_handler
from shared.jobs import has_time_left
from shared.legal_basis import legal_basis_or_legacy
from shared.logging import logger, metrics
from shared.retention import SOURCE_FIELD, STORE_FEEDBACK, STORE_RADAR
from shared.source_erasure import refresh_source_lock, release_source_lock
from shared.source_profiles import SOURCE_ID_RE, load_source_profiles
from shared.warm_init import warm_at_init

# Bundled beside `shared/` (no sys.path shim); tests import `jobs.retention.handler`.
FEEDBACK_TABLE, AGGREGATES_TABLE, RAW_DATA_BUCKET, RADAR_TABLE, PROJECTS_TABLE, FEATURE_REQUESTS_TABLE = (
    os.environ.get(name, '')
    for name in ('FEEDBACK_TABLE', 'AGGREGATES_TABLE', 'RAW_DATA_BUCKET', 'RADAR_TABLE', 'PROJECTS_TABLE',
                 'FEATURE_REQUESTS_TABLE'))

JOB_ID_RE: Final = re.compile(r'^er_[0-9a-f]{12}\Z')
STATUS_COMPLETED: Final = 'completed'
STATUS_FAILED: Final = 'failed'
PHASE_ITEMS: Final = 'items'
PHASE_RADAR: Final = 'radar'
PHASE_BOARDS: Final = 'boards'
PHASE_RAW: Final = 'raw'
PHASE_LINEAGE: Final = 'lineage'
_PHASE_STORES: Final = {PHASE_ITEMS: STORE_FEEDBACK, PHASE_RADAR: STORE_RADAR}

PAGE_SIZE: Final = 100
# Hand over to a fresh invocation when less than this remains of the budget.
TIME_RESERVE_MS: Final = 60 * 1000
# A runaway guard: a chain this long means something is wrong (the table would
# have to hold millions of matching items); it stops and fails loudly instead.
MAX_GENERATIONS: Final = 500

_AWS_ERRORS: Final = (ClientError, BotoCoreError)

# The scan filter of one store (shared.retention.STORE_*), built once per invocation by the mode's setup.
Filters = Callable[[str], ConditionBase]


@dataclass
class Walk:
    """One invocation's tables, clients and state, handed to every phase."""

    tables: dict[str, Any]
    context: Any
    event: dict[str, Any]
    run: dict[str, Any]
    filters: Filters
    s3: Any

    @property
    def aggregates(self) -> Any:
        return self.tables['aggregates']


def _tables() -> dict[str, Any]:
    dynamodb = get_dynamodb_resource()
    tables = {STORE_FEEDBACK: dynamodb.Table(FEEDBACK_TABLE), 'aggregates': dynamodb.Table(AGGREGATES_TABLE)}
    for name, table_name in ((STORE_RADAR, RADAR_TABLE), ('projects', PROJECTS_TABLE),
                             (boards.STORE_BOARDS, FEATURE_REQUESTS_TABLE)):
        if table_name:
            tables[name] = dynamodb.Table(table_name)
    return tables


# ============================================
# Run setup (one per mode)
# ============================================

def _retention_setup(aggregates_table: Any, run: dict[str, Any]) -> Filters | None:
    """The scan filters for today's retention run, or None when nothing is retained."""
    profiles = load_source_profiles(aggregates_table)
    cutoffs = retention.retention_cutoffs(profiles, datetime.now(UTC).date())
    if not cutoffs:
        return None
    run['cutoffs'] = cutoffs
    # Each retained source's basis; a profile saved before 6.00.00 reads "not recorded".
    run['legal_bases'] = {str(profile['id']): legal_basis_or_legacy(profile.get('retention_legal_basis'))
                          for profile in profiles if str(profile['id']) in cutoffs}
    return lambda store: retention.retention_filter(cutoffs, store)


def _erase_setup(aggregates_table: Any, event: dict[str, Any], run: dict[str, Any]) -> Filters | None:
    """The scan filters for an erasure job, or None when the job cannot (or need not) run."""
    job_id, value = event.get('job_id'), event.get('value')
    if not isinstance(job_id, str) or not JOB_ID_RE.match(job_id) or not isinstance(value, str) or not value:
        logger.error('Erasure event without a valid job_id and value')
        return None
    job = claim_erasure_job(aggregates_table, job_id)
    if job is None:
        logger.info('Erasure job is missing or already finished', extra={'job_id': job_id})
        return None
    run.update(job_id=job_id, field=job.get('field'), source=job.get('source') or None,
               value_hash=job.get('value_hash'), legal_basis=legal_basis_or_legacy(job.get('legal_basis')))
    if job.get('value_hash') != sha256_hex(value):
        raise ValueError('The erasure value does not match the job')
    if run['field'] == SOURCE_FIELD:
        _check_whole_source(run['source'], value)
    field, source = str(job.get('field')), run['source']
    return lambda store: retention.erase_filter(field, value, source, store)


def _check_whole_source(source: object, value: str) -> None:
    """A whole-source job names the invoked source, and it is a source id (defence in depth).

    The settings route already insists on both; a job row written any other way
    must not turn into an erasure of something else.
    """
    if source != value or not SOURCE_ID_RE.match(value):
        raise ValueError('The whole-source erasure does not name one valid source')


# ============================================
# Hand-over and the source lock
# ============================================

def _hand_over(walk: Walk, phase: str, cursor: dict | None) -> dict:
    run = walk.run
    _whole_source_lock_call(walk.aggregates, run, refresh_source_lock, 'renew')
    payload = {**walk.event, 'mode': run['mode'], 'phase': phase, 'cursor': cursor, 'run': carried_state(run)}
    invoke_lambda_async(walk.context.function_name, payload)
    return {'status': 'continued', 'run_id': run['run_id']}


def _whole_source_lock_call(aggregates_table: Any, run: dict[str, Any],
                            operation: Callable[[Any, str, str, datetime], None], action: str) -> None:
    """Renew or release a whole-source erasure run's source lock (shared/source_erasure.py); best effort.

    At a hand-over (``refresh_source_lock``) a missed renewal only lets the
    lock read as stale sooner, and the live-job check still sees this job's
    ``progress_at``. At the finish (``release_source_lock``) a failed release
    must not fail the invocation: the job already reads completed, the audit
    row would be lost, and the lock goes stale after ``STALE_AFTER`` anyway.
    """
    if not (run.get('job_id') and run.get('field') == SOURCE_FIELD and run.get('source')):
        return
    try:
        operation(aggregates_table, str(run['source']), str(run['job_id']), datetime.now(UTC))
    except _AWS_ERRORS as e:
        logger.warning('Could not update the source erasure lock',
                       extra={'action': action, 'error_type': type(e).__name__})


# ============================================
# Phases
# ============================================

def _scan_page(table: Any, condition: ConditionBase, cursor: dict | None) -> dict:
    kwargs: dict[str, Any] = {'Limit': PAGE_SIZE, 'FilterExpression': condition}
    if cursor:
        kwargs['ExclusiveStartKey'] = cursor
    return table.scan(**kwargs)


@dataclass(frozen=True)
class _Resume:
    """A page left unfinished when the time ran out: resume the scan from ``cursor`` (None = the start)."""

    cursor: dict | None


def _walk(walk: Walk, phase: str, cursor: dict | None, scan: Callable[[dict | None], dict],
          handle: Callable[[dict, dict | None], _Resume | None]) -> dict | None:
    """The paged, time-budgeted loop every scanning phase shares; a hand-over result, or None when done.

    ``scan(cursor)`` reads one page; ``handle(page, cursor)`` works through it and
    returns ``_Resume`` when the time ran out mid-page. The cursor is checkpointed
    across self re-invocations.
    """
    while True:
        page = scan(cursor)
        resume = handle(page, cursor)
        if resume is not None:
            return _hand_over(walk, phase, resume.cursor)
        record_progress(walk.aggregates, walk.run, phase)
        cursor = page.get('LastEvaluatedKey') or None
        if cursor is None:
            return None
        if not has_time_left(walk.context, TIME_RESERVE_MS):
            return _hand_over(walk, phase, cursor)


def _erase_pages(walk: Walk, phase: str, cursor: dict | None, scan: Callable[[dict | None], dict],
                 tombstones: Callable[[list[dict]], None], erase: Callable[[dict], None]) -> dict | None:
    """Per page: every match's tombstone first, then each match erased, until the time runs low."""

    def handle(page: dict, start: dict | None) -> _Resume | None:
        walk.run['scanned'] += int(page.get('ScannedCount', 0))
        items = page.get('Items', [])
        tombstones(items)
        done = start
        for item in items:
            if not has_time_left(walk.context, TIME_RESERVE_MS):
                # After the last erased item (this page's start when none was).
                return _Resume(done)
            erase(item)
            done = {'pk': item['pk'], 'sk': item['sk']}
        return None

    return _walk(walk, phase, cursor, scan, handle)


def _walk_store(walk: Walk, phase: str, cursor: dict | None) -> dict | None:
    """Tombstone, then delete, every match of the phase's store from ``cursor`` on; a hand-over or None."""
    store = _PHASE_STORES[phase]
    table, condition, run = walk.tables[store], walk.filters(store), walk.run
    deleter = ItemDeleter(run, walk.s3, RAW_DATA_BUCKET, walk.tables)
    return _erase_pages(walk, phase, cursor, lambda at: _scan_page(table, condition, at),
                        lambda items: write_tombstones(walk.aggregates, run, items, store),
                        lambda item: deleter.delete(item, store))


def _sweep_raw(walk: Walk, _cursor: dict | None) -> dict | None:
    """A whole-source erasure's raw phase: every object left under ``raw/{source}/`` and ``silver/{source}/``.

    The per-item archives and kept Silver versions went with their items; this
    removes what no item points at any more (an archive whose item failed
    processing, an older copy). Each page lists from the start of the prefix
    (what was listed is gone), so a hand-over carries no cursor.
    """
    source = str(walk.run.get('source') or '')
    raw_prefix, silver_prefix = retention.raw_source_prefix(source), retention.silver_source_prefix(source)
    if raw_prefix is None or silver_prefix is None or not RAW_DATA_BUCKET:
        return None
    for prefix in (raw_prefix, silver_prefix):
        more = True
        while more:
            if not has_time_left(walk.context, TIME_RESERVE_MS):
                return _hand_over(walk, PHASE_RAW, None)
            objects, more = retention.delete_raw_prefix_page(walk.s3, RAW_DATA_BUCKET, prefix)
            walk.run['deleted_objects'] += objects
            record_progress(walk.aggregates, walk.run, PHASE_RAW)
    return None


def _erase_from_boards(walk: Walk, cursor: dict | None) -> dict | None:
    """Tombstone, then de-identify, every board request and +1 of the erased email (``boards.py``)."""
    table, value = walk.tables[boards.STORE_BOARDS], str(walk.event.get('value') or '')
    eraser = boards.BoardEraser(walk.run, walk.tables, walk.s3, RAW_DATA_BUCKET)
    return _erase_pages(walk, PHASE_BOARDS, cursor, lambda at: boards.scan_page(table, value, at),
                        eraser.tombstones, eraser.erase)


def _mark_lineage(walk: Walk, cursor: dict | None) -> dict | None:
    """Mark the workspace artifacts that cited a deleted item (``lineage.py``), page by page."""
    projects = walk.tables['projects']

    def handle(page: dict, _start: dict | None) -> _Resume | None:
        lineage.mark_rows(projects, walk.aggregates, walk.run, page.get('Items', []))
        return None

    return _walk(walk, PHASE_LINEAGE, cursor, lambda at: lineage.scan_page(projects, at), handle)


def _phases(walk: Walk) -> list[str]:
    """The phases this run walks, in order (the lineage one is decided when it is reached)."""
    phases = [PHASE_ITEMS]
    if STORE_RADAR in walk.tables:
        phases.append(PHASE_RADAR)
    if boards.STORE_BOARDS in walk.tables and boards.applies(walk.run):
        phases.append(PHASE_BOARDS)
    if walk.run.get('field') == SOURCE_FIELD:
        phases.append(PHASE_RAW)
    if 'projects' in walk.tables:
        phases.append(PHASE_LINEAGE)
    return phases


def _deleted_anything(run: dict[str, Any]) -> bool:
    return run['deleted_items'] + run['deleted_radar_items'] + int(run.get(BOARD_COUNTER) or 0) > 0


def _walk_phases(walk: Walk) -> dict | None:
    """Every phase from the event's on; a hand-over result or None.

    A hand-over names its phase; one without (from before 6.00.00) was in the item
    scan. The event's cursor belongs to that first phase only.
    """
    phases = _phases(walk)
    resumed = walk.event.get('phase') or PHASE_ITEMS
    remaining = phases[phases.index(resumed):] if resumed in phases else phases
    cursor = (walk.event.get('cursor') or None) if resumed in phases else None
    for phase in remaining:
        if phase == PHASE_LINEAGE and not _deleted_anything(walk.run):
            continue
        handed_over = _PHASE_RUNNERS[phase](walk, cursor)
        if handed_over is not None:
            return handed_over
        cursor = None
    return None


_PHASE_RUNNERS: Final[dict[str, Callable[[Walk, dict | None], dict | None]]] = {
    PHASE_ITEMS: lambda walk, cursor: _walk_store(walk, PHASE_ITEMS, cursor),
    PHASE_RADAR: lambda walk, cursor: _walk_store(walk, PHASE_RADAR, cursor),
    PHASE_BOARDS: _erase_from_boards,
    PHASE_RAW: _sweep_raw,
    PHASE_LINEAGE: _mark_lineage,
}


# ============================================
# Entry
# ============================================

def _finish(aggregates_table: Any, run: dict[str, Any], status: str, error: str | None = None) -> dict:
    run.pop('_progress', None)
    if run.get('job_id'):
        finish_erasure_job(aggregates_table, run, status, error)
        # Completed or failed: the next erasure of this source may start.
        _whole_source_lock_call(aggregates_table, run, release_source_lock, 'release')
    write_audit(aggregates_table, run, status, error)
    metrics.add_metric(name='RetentionItemsDeleted', unit='Count',
                       value=run['deleted_items'] + run['deleted_radar_items'])
    return {'status': status, 'run_id': run['run_id'], 'deleted_items': run['deleted_items'],
            'deleted_radar_items': run['deleted_radar_items'], 'deleted_objects': run['deleted_objects'],
            'artifacts_marked': run['artifacts_marked'], **board_count(run)}


def handle_event(event: dict[str, Any], context: Any) -> dict:
    """One invocation of either mode (see the module docstring)."""
    mode = event.get('mode') or MODE_RETENTION
    if mode not in (MODE_RETENTION, MODE_ERASE):
        logger.error('Retention event with an unknown mode', extra={'mode': str(mode)[:32]})
        return {'status': 'ignored'}
    tables = _tables()
    state = new_run(event, mode)
    if state['generation'] >= MAX_GENERATIONS:
        return _finish(tables['aggregates'], state, STATUS_FAILED, 'Stopped after too many hand-overs')
    before = (state['deleted_items'], state['deleted_radar_items'])
    try:
        return _run(tables, context, event, state)
    finally:
        # After deletes (a hand-over, completion or failure): cached reads move on.
        if state['deleted_items'] > before[0]:
            bump_data_version(tables['aggregates'])
        if state['deleted_radar_items'] > before[1] and STORE_RADAR in tables:
            bump_radar_version(tables[STORE_RADAR])


def _run(tables: dict[str, Any], context: Any, event: dict[str, Any], state: dict[str, Any]) -> dict:
    """Set the run up for its mode, walk its phases, and record the outcome."""
    mode, aggregates_table = state['mode'], tables['aggregates']
    try:
        filters = (_retention_setup(aggregates_table, state) if mode == MODE_RETENTION
                   else _erase_setup(aggregates_table, event, state))
        if filters is None:
            # Retention with no retained source still audits its (empty) run;
            # an erase event that cannot run leaves its job as it was.
            return (_finish(aggregates_table, state, STATUS_COMPLETED) if mode == MODE_RETENTION
                    else {'status': 'nothing_to_do'})
        handed_over = _walk_phases(Walk(tables, context, event, state, filters, get_s3_client()))
    except (*_AWS_ERRORS, ValueError, RuntimeError) as e:
        failure = type(e).__name__
    else:
        return handed_over or _finish(aggregates_table, state, STATUS_COMPLETED)
    # The error TYPE only: a message (or a traceback) could quote the erased value back.
    logger.error('Retention run failed', extra={'mode': mode, 'error_type': failure})
    return _finish(aggregates_table, state, STATUS_FAILED, f'Run failed ({failure})')


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource, get_s3_client)


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return handle_event(event, context)
