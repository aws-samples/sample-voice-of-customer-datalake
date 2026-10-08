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
  is never stored or logged.

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
import uuid
from datetime import UTC, datetime
from typing import Any, Final

from boto3.dynamodb.conditions import ConditionBase
from botocore.exceptions import BotoCoreError, ClientError

from shared import retention
from shared.aws import get_dynamodb_resource, get_s3_client, invoke_lambda_async, is_conditional_check_failure
from shared.invocation_cost import instrumented_handler
from shared.logging import logger, metrics
from shared.source_profiles import load_source_profiles

# Bundled beside `shared/` (no sys.path shim); tests import `jobs.retention.handler`.
FEEDBACK_TABLE, AGGREGATES_TABLE, RAW_DATA_BUCKET = (
    os.environ.get(name, '') for name in ('FEEDBACK_TABLE', 'AGGREGATES_TABLE', 'RAW_DATA_BUCKET'))

MODE_RETENTION: Final = 'retention'
MODE_ERASE: Final = 'erase'
ERASURE_JOB_PK: Final = 'JOB#erasure'
AUDIT_PK: Final = 'AUDIT#retention'
JOB_ID_RE: Final = re.compile(r'^er_[0-9a-f]{12}\Z')
STATUS_QUEUED: Final = 'queued'
STATUS_RUNNING: Final = 'running'
STATUS_COMPLETED: Final = 'completed'
STATUS_FAILED: Final = 'failed'

PAGE_SIZE: Final = 100
# Hand over to a fresh invocation when less than this remains of the budget.
TIME_RESERVE_MS: Final = 60 * 1000
# A runaway guard: a chain this long means something is wrong (the table would
# have to hold millions of matching items); it stops and fails loudly instead.
MAX_GENERATIONS: Final = 500

_AWS_ERRORS: Final = (ClientError, BotoCoreError)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _tables() -> tuple[Any, Any]:
    dynamodb = get_dynamodb_resource()
    return dynamodb.Table(FEEDBACK_TABLE), dynamodb.Table(AGGREGATES_TABLE)


# ============================================
# Audit + erasure job rows
# ============================================

def write_audit(aggregates_table: Any, run: dict[str, Any], status: str, error: str | None = None) -> None:
    """One audit row for a finished (or failed) run: mode, counts, never the erased value."""
    now = _now()
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
            ExpressionAttributeValues={':running': STATUS_RUNNING, ':queued': STATUS_QUEUED, ':now': _now()},
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
        ':status': status, ':items': run['deleted_items'], ':objects': run['deleted_objects'], ':now': _now(),
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
        'started_at': carried.get('started_at') or _now(),
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
    if job.get('value_hash') != retention.value_hash(value):
        raise ValueError('The erasure value does not match the job')
    return retention.erase_filter(str(job.get('field')), value, run['source'])


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


def _hand_over(context: Any, event: dict[str, Any], run: dict[str, Any], cursor: dict | None) -> dict:
    carried = {key: run[key] for key in ('run_id', 'started_at', 'scanned', 'deleted_items', 'deleted_objects')}
    payload = {**{k: v for k, v in event.items() if k not in ('cursor', 'run')},
               'mode': run['mode'], 'cursor': cursor, 'run': {**carried, 'generation': run['generation'] + 1}}
    invoke_lambda_async(context.function_name, payload)
    return {'status': 'continued', 'run_id': run['run_id']}


def _walk(feedback_table: Any, context: Any, event: dict[str, Any], run: dict[str, Any],
          condition: ConditionBase) -> dict | None:
    """Delete every match from the event's cursor on; a hand-over result, or None when done."""
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
        cursor = page.get('LastEvaluatedKey') or None
        if cursor is None:
            return None
        if not _time_left(context):
            return _hand_over(context, event, run, cursor)


def _finish(aggregates_table: Any, run: dict[str, Any], status: str, error: str | None = None) -> dict:
    if run.get('job_id'):
        finish_erasure_job(aggregates_table, run, status, error)
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
    try:
        condition = (_retention_setup(aggregates_table, state) if mode == MODE_RETENTION
                     else _erase_setup(aggregates_table, event, state))
        if condition is None:
            # Retention with no retained source still audits its (empty) run;
            # an erase event that cannot run leaves its job as it was.
            return (_finish(aggregates_table, state, STATUS_COMPLETED) if mode == MODE_RETENTION
                    else {'status': 'nothing_to_do'})
        handed_over = _walk(feedback_table, context, event, state, condition)
    except (*_AWS_ERRORS, ValueError, RuntimeError) as e:
        failure = type(e).__name__
    else:
        return handed_over or _finish(aggregates_table, state, STATUS_COMPLETED)
    # The error TYPE only: a message (or a traceback) could quote the erased value back.
    logger.error('Retention run failed', extra={'mode': mode, 'error_type': failure})
    return _finish(aggregates_table, state, STATUS_FAILED, f'Run failed ({failure})')


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return handle_event(event, context)
