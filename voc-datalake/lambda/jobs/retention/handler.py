"""voc-retention: the opt-in per-source retention and erasure worker.

The only Lambda that deletes customer feedback (``shared/retention.py`` says
what and how). Two modes, one scan loop:

- ``{"mode": "retention"}`` — the daily schedule (an event without ``mode``
  reads the same). Deletes items of every source whose profile sets
  ``retention_days`` and whose ``date`` is older than the cutoff. Nothing is
  deleted when no profile sets one, or when the profiles cannot be read.
- ``{"mode": "erase", "job_id": "er_<12 hex>", "value": ...}`` — started by
  ``POST /settings/erasure`` (async invoke). The job row (``pk JOB#erasure``)
  holds the field, the optional source and the value's SHA-256; the value
  itself travels only in the invoke payload, is checked against that hash, and
  is never stored or logged. ``field = 'source'`` erases a whole source: the
  scan deletes every item of that ``source_platform``, then a second phase
  (``phase: 'raw'``) deletes every object version left under ``raw/{source}/``
  (``shared/retention.delete_raw_prefix_page``), one listing page at a time.

The scan is paged and time-budgeted: before the Lambda's budget runs out the
worker re-invokes itself with the scan cursor and its running counters, like
the category reprocess worker. Deletes are idempotent, so a duplicate delivery
or an overlapping daily run only repeats no-ops. Every finished run (and every
failure) writes one audit row (``pk AUDIT#retention``) with the counts — never
the erased value.

Env: ``FEEDBACK_TABLE``, ``AGGREGATES_TABLE``, ``RAW_DATA_BUCKET``.
"""

from __future__ import annotations

import os
import re
import time
import uuid
from datetime import UTC, datetime
from typing import Any, Final

from boto3.dynamodb.conditions import ConditionBase
from botocore.exceptions import BotoCoreError, ClientError

from shared import retention
from shared.aws import get_dynamodb_resource, get_s3_client, invoke_lambda_async, is_conditional_check_failure
from shared.data_version import bump_data_version
from shared.digests import sha256_hex
from shared.invocation_cost import instrumented_handler
from shared.logging import logger, metrics
from shared.retention import ERASURE_JOB_PK, SOURCE_FIELD
from shared.source_erasure import release_source_lock
from shared.source_profiles import SOURCE_ID_RE, load_source_profiles
from shared.timestamps import now_iso
from shared.warm_init import warm_at_init

# Bundled beside `shared/` (no sys.path shim); tests import `jobs.retention.handler`.
FEEDBACK_TABLE, AGGREGATES_TABLE, RAW_DATA_BUCKET = (
    os.environ.get(name, '') for name in ('FEEDBACK_TABLE', 'AGGREGATES_TABLE', 'RAW_DATA_BUCKET'))

MODE_RETENTION: Final = 'retention'
MODE_ERASE: Final = 'erase'
AUDIT_PK: Final = 'AUDIT#retention'
JOB_ID_RE: Final = re.compile(r'^er_[0-9a-f]{12}\Z')
STATUS_QUEUED: Final = 'queued'
STATUS_RUNNING: Final = 'running'
STATUS_COMPLETED: Final = 'completed'
STATUS_FAILED: Final = 'failed'
PHASE_ITEMS: Final = 'items'
PHASE_RAW: Final = 'raw'
# A running job's row is refreshed when its counts move, and at least this often.
PROGRESS_EVERY_SECONDS: Final = 60

PAGE_SIZE: Final = 100
# Hand over to a fresh invocation when less than this remains of the budget.
TIME_RESERVE_MS: Final = 60 * 1000
# A runaway guard: a chain this long means something is wrong (the table would
# have to hold millions of matching items); it stops and fails loudly instead.
MAX_GENERATIONS: Final = 500

_AWS_ERRORS: Final = (ClientError, BotoCoreError)


def _tables() -> tuple[Any, Any]:
    dynamodb = get_dynamodb_resource()
    return dynamodb.Table(FEEDBACK_TABLE), dynamodb.Table(AGGREGATES_TABLE)


# ============================================
# Audit + erasure job rows
# ============================================

def write_audit(aggregates_table: Any, run: dict[str, Any], status: str, error: str | None = None) -> None:
    """One audit row for a finished (or failed) run: mode, counts, never the erased value."""
    now = now_iso()
    item = {
        'pk': AUDIT_PK, 'sk': f"{now}#{run['run_id']}", 'run_id': run['run_id'], 'mode': run['mode'],
        'status': status, 'deleted_items': run['deleted_items'], 'deleted_objects': run['deleted_objects'],
        'scanned': run['scanned'], 'started_at': run['started_at'], 'finished_at': now,
        **{key: run[key] for key in ('job_id', 'field', 'source', 'value_hash', 'cutoffs') if run.get(key)},
        **({'error': error} if error else {}),
    }
    aggregates_table.put_item(Item=item)


def _job_key(job_id: str) -> dict[str, str]:
    return {'pk': ERASURE_JOB_PK, 'sk': job_id}


def claim_erasure_job(aggregates_table: Any, job_id: str) -> dict[str, Any] | None:
    """The job, marked running; None when it is missing or already finished."""
    try:
        response = aggregates_table.update_item(
            Key=_job_key(job_id),
            UpdateExpression='SET #status = :running, started_at = if_not_exists(started_at, :now)',
            ConditionExpression='attribute_exists(pk) AND #status IN (:queued, :running)',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':running': STATUS_RUNNING, ':queued': STATUS_QUEUED, ':now': now_iso()},
            ReturnValues='ALL_NEW',
        )
    except ClientError as e:
        if is_conditional_check_failure(e):
            return None
        raise
    return response.get('Attributes')


def finish_erasure_job(aggregates_table: Any, run: dict[str, Any], status: str, error: str | None = None) -> None:
    """Record the job's outcome and counts (the row keeps its value_hash, never the value)."""
    names = {'#status': 'status'}
    values: dict[str, Any] = {
        ':status': status, ':items': run['deleted_items'], ':objects': run['deleted_objects'], ':now': now_iso(),
    }
    expression = 'SET #status = :status, deleted_items = :items, deleted_objects = :objects, finished_at = :now'
    if error:
        expression += ', #error = :error'
        names['#error'] = 'error'
        values[':error'] = error
    aggregates_table.update_item(
        Key=_job_key(run['job_id']), UpdateExpression=expression,
        ExpressionAttributeNames=names, ExpressionAttributeValues=values,
    )


def record_progress(aggregates_table: Any, run: dict[str, Any], phase: str, *, force: bool = False) -> None:
    """Write a running erasure job's counts and phase (no-op for retention runs).

    Throttled: only when the counts moved since the last write or
    ``PROGRESS_EVERY_SECONDS`` passed, so a long scan with few matches still
    shows it is alive without one write per page.
    """
    if not run.get('job_id'):
        return
    counts = (run['deleted_items'], run['deleted_objects'], phase)
    last = run.get('_progress')
    if not force and isinstance(last, tuple) and last[0] == counts \
            and time.monotonic() - last[1] < PROGRESS_EVERY_SECONDS:
        return
    try:
        aggregates_table.update_item(
            Key=_job_key(run['job_id']),
            UpdateExpression='SET deleted_items = :items, deleted_objects = :objects, phase = :phase, progress_at = :now',
            ConditionExpression='#status = :running',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':items': run['deleted_items'], ':objects': run['deleted_objects'],
                                       ':phase': phase, ':now': now_iso(), ':running': STATUS_RUNNING},
        )
    except ClientError as e:
        # A row that is gone or no longer running is never recreated; the outcome write still runs.
        if not is_conditional_check_failure(e):
            raise
    run['_progress'] = (counts, time.monotonic())


# ============================================
# Run setup (one per mode)
# ============================================

def _new_run(event: dict[str, Any], mode: str) -> dict[str, Any]:
    """The run's running state: carried across hand-overs in the event."""
    raw = event.get('run')
    carried: dict[str, Any] = raw if isinstance(raw, dict) else {}
    return {
        'mode': mode,
        'run_id': carried.get('run_id') or uuid.uuid4().hex[:12],
        'started_at': carried.get('started_at') or now_iso(),
        'generation': int(carried.get('generation', 0)),
        'scanned': int(carried.get('scanned', 0)),
        'deleted_items': int(carried.get('deleted_items', 0)),
        'deleted_objects': int(carried.get('deleted_objects', 0)),
    }


def _retention_setup(aggregates_table: Any, run: dict[str, Any]) -> ConditionBase | None:
    """The scan filter for today's retention run, or None when nothing is retained."""
    cutoffs = retention.retention_cutoffs(load_source_profiles(aggregates_table), datetime.now(UTC).date())
    if not cutoffs:
        return None
    run['cutoffs'] = cutoffs
    return retention.retention_filter(cutoffs)


def _erase_setup(aggregates_table: Any, event: dict[str, Any], run: dict[str, Any]) -> ConditionBase | None:
    """The scan filter for an erasure job, or None when the job cannot (or need not) run."""
    job_id, value = event.get('job_id'), event.get('value')
    if not isinstance(job_id, str) or not JOB_ID_RE.match(job_id) or not isinstance(value, str) or not value:
        logger.error('Erasure event without a valid job_id and value')
        return None
    job = claim_erasure_job(aggregates_table, job_id)
    if job is None:
        logger.info('Erasure job is missing or already finished', extra={'job_id': job_id})
        return None
    run.update(job_id=job_id, field=job.get('field'), source=job.get('source') or None,
               value_hash=job.get('value_hash'))
    if job.get('value_hash') != sha256_hex(value):
        raise ValueError('The erasure value does not match the job')
    if run['field'] == SOURCE_FIELD:
        _check_whole_source(run['source'], value)
    return retention.erase_filter(str(job.get('field')), value, run['source'])


def _check_whole_source(source: object, value: str) -> None:
    """A whole-source job names the invoked source, and it is a source id (defence in depth).

    The settings route already insists on both; a job row written any other way
    must not turn into an erasure of something else.
    """
    if source != value or not SOURCE_ID_RE.match(value):
        raise ValueError('The whole-source erasure does not name one valid source')


# ============================================
# Scan loop
# ============================================

def _scan_page(feedback_table: Any, condition: ConditionBase, cursor: dict | None) -> dict:
    kwargs: dict[str, Any] = {'Limit': PAGE_SIZE, 'FilterExpression': condition}
    if cursor:
        kwargs['ExclusiveStartKey'] = cursor
    return feedback_table.scan(**kwargs)


def _time_left(context: Any) -> bool:
    return context.get_remaining_time_in_millis() > TIME_RESERVE_MS


def _hand_over(context: Any, event: dict[str, Any], run: dict[str, Any], cursor: dict | None,
               **extra: Any) -> dict:
    carried = {key: run[key] for key in ('run_id', 'started_at', 'scanned', 'deleted_items', 'deleted_objects')}
    payload = {**event, 'mode': run['mode'], 'cursor': cursor, **extra,
               'run': {**carried, 'generation': run['generation'] + 1}}
    invoke_lambda_async(context.function_name, payload)
    return {'status': 'continued', 'run_id': run['run_id']}


def _walk(tables: tuple[Any, Any], context: Any, event: dict[str, Any], run: dict[str, Any],
          condition: ConditionBase) -> dict | None:
    """Delete every match from the event's cursor on; a hand-over result, or None when done."""
    feedback_table, aggregates_table = tables
    s3 = get_s3_client()
    cursor = event.get('cursor') or None
    while True:
        page = _scan_page(feedback_table, condition, cursor)
        run['scanned'] += int(page.get('ScannedCount', 0))
        for item in page.get('Items', []):
            if not _time_left(context):
                return _hand_over(context, event, run, cursor)
            items, objects = retention.delete_item(feedback_table, s3, RAW_DATA_BUCKET, item)
            run['deleted_items'] += items
            run['deleted_objects'] += objects
            cursor = {'pk': item['pk'], 'sk': item['sk']}
        record_progress(aggregates_table, run, PHASE_ITEMS)
        cursor = page.get('LastEvaluatedKey') or None
        if cursor is None:
            return None
        if not _time_left(context):
            return _hand_over(context, event, run, cursor)


def _sweep_raw(aggregates_table: Any, context: Any, event: dict[str, Any], run: dict[str, Any]) -> dict | None:
    """A whole-source erasure's second phase: every object left under ``raw/{source}/``.

    The per-item archives went with their items; this removes what no item
    points at any more (an archive whose item failed processing, an older
    copy). Each page lists from the start of the prefix (what was listed is
    gone), so a hand-over carries only ``phase: 'raw'``.
    """
    prefix = retention.raw_source_prefix(str(run.get('source') or ''))
    if prefix is None or not RAW_DATA_BUCKET:
        return None
    s3 = get_s3_client()
    more = True
    while more:
        if not _time_left(context):
            return _hand_over(context, event, run, None, phase=PHASE_RAW)
        objects, more = retention.delete_raw_prefix_page(s3, RAW_DATA_BUCKET, prefix)
        run['deleted_objects'] += objects
        record_progress(aggregates_table, run, PHASE_RAW)
    return None


def _finish(aggregates_table: Any, run: dict[str, Any], status: str, error: str | None = None) -> dict:
    run.pop('_progress', None)
    if run.get('job_id'):
        finish_erasure_job(aggregates_table, run, status, error)
        if run.get('field') == SOURCE_FIELD and run.get('source'):
            # Completed or failed: the next erasure of this source may start (shared/source_erasure.py).
            release_source_lock(aggregates_table, str(run['source']), run['job_id'], datetime.now(UTC))
    write_audit(aggregates_table, run, status, error)
    metrics.add_metric(name='RetentionItemsDeleted', unit='Count', value=run['deleted_items'])
    return {'status': status, 'run_id': run['run_id'],
            'deleted_items': run['deleted_items'], 'deleted_objects': run['deleted_objects']}


def handle_event(event: dict[str, Any], context: Any) -> dict:
    """One invocation of either mode (see the module docstring)."""
    mode = event.get('mode') or MODE_RETENTION
    if mode not in (MODE_RETENTION, MODE_ERASE):
        logger.error('Retention event with an unknown mode', extra={'mode': str(mode)[:32]})
        return {'status': 'ignored'}
    feedback_table, aggregates_table = _tables()
    state = _new_run(event, mode)
    if state['generation'] >= MAX_GENERATIONS:
        return _finish(aggregates_table, state, STATUS_FAILED, 'Stopped after too many hand-overs')
    deleted_before = state['deleted_items']
    try:
        return _run(feedback_table, aggregates_table, context, event, state)
    finally:
        # After deletes (a hand-over, completion or failure): cached reads move on.
        if state['deleted_items'] > deleted_before:
            bump_data_version(aggregates_table)


def _run(feedback_table: Any, aggregates_table: Any, context: Any, event: dict[str, Any],
         state: dict[str, Any]) -> dict:
    """Set the run up for its mode, walk it, and record the outcome."""
    mode = state['mode']
    try:
        condition = (_retention_setup(aggregates_table, state) if mode == MODE_RETENTION
                     else _erase_setup(aggregates_table, event, state))
        if condition is None:
            # Retention with no retained source still audits its (empty) run;
            # an erase event that cannot run leaves its job as it was.
            return (_finish(aggregates_table, state, STATUS_COMPLETED) if mode == MODE_RETENTION
                    else {'status': 'nothing_to_do'})
        handed_over = _erase_walks((feedback_table, aggregates_table), context, event, state, condition)
    except (*_AWS_ERRORS, ValueError, RuntimeError) as e:
        failure = type(e).__name__
    else:
        return handed_over or _finish(aggregates_table, state, STATUS_COMPLETED)
    # The error TYPE only: a message (or a traceback) could quote the erased value back.
    logger.error('Retention run failed', extra={'mode': mode, 'error_type': failure})
    return _finish(aggregates_table, state, STATUS_FAILED, f'Run failed ({failure})')


def _erase_walks(tables: tuple[Any, Any], context: Any, event: dict[str, Any], state: dict[str, Any],
                 condition: ConditionBase) -> dict | None:
    """The item scan, then (whole-source erasure only) the raw sweep; a hand-over result or None."""
    whole_source = state.get('field') == SOURCE_FIELD
    if not (whole_source and event.get('phase') == PHASE_RAW):
        handed_over = _walk(tables, context, event, state, condition)
        if handed_over is not None or not whole_source:
            return handed_over
    return _sweep_raw(tables[1], context, event, state)


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource, get_s3_client)


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return handle_event(event, context)
