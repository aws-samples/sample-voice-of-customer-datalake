"""
Category-reprocess job records — shared by the settings API (start / read /
cancel) and the worker Lambda (progress, completion).

Storage (aggregates table):
  * job rows   ``pk='JOB#category_reprocess'``, ``sk=job_id``
  * lock row   ``pk='JOB#category_reprocess'``, ``sk='LOCK'``, ``active_job_id``

``job_id`` is ``'rp_' + 12 hex`` where the hex is the creation time in
milliseconds, so job ids sort by creation and "latest" is one descending query.

The lock row makes "at most one queued/running job" atomic: a start claims it
with a conditional write, and a terminal transition releases it. A lock whose
job is terminal, missing, or has not checkpointed for STALE_AFTER_SECONDS
(the worker crashed or its async invoke was lost) is reclaimed by the next
start, which records the stale job as failed.

Exactly one worker owns a job at a time. Each invocation claims the job with a
compare-and-set on ``worker_token``: the first delivery requires no token, a
hand-over requires the predecessor's token (carried in the event). Every
checkpoint and terminal write is conditional on the claimant's token, so a
duplicate async delivery (Lambda retries, at-least-once) fails its claim — or
its first checkpoint — and exits without further work.
"""
import re
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from boto3.dynamodb.conditions import Key

from shared.aws import is_conditional_check_failure

JOB_PK = 'JOB#category_reprocess'
LOCK_SK = 'LOCK'
JOB_ID_PREFIX = 'rp_'
JOB_ID_PATTERN = re.compile(r'^rp_[0-9a-f]{12}$')

MODE_PROCESSED = 'processed'
MODE_RAW = 'raw'
# Re-infer the AI-sourced dimensions only (never a source / profile / manual value).
MODE_DIMENSIONS = 'dimensions'
MODES = (MODE_PROCESSED, MODE_RAW, MODE_DIMENSIONS)

STATUS_QUEUED = 'queued'
STATUS_RUNNING = 'running'
STATUS_COMPLETED = 'completed'
STATUS_FAILED = 'failed'
STATUS_CANCELLED = 'cancelled'
ACTIVE_STATUSES = (STATUS_QUEUED, STATUS_RUNNING)

COUNTERS = ('scanned', 'updated', 'unchanged', 'skipped_manual', 'failed')

# A job's `days` window is the platform's: 0 (ALL_TIME_DAYS) = all time, up to
# MAX_FEEDBACK_WINDOW_DAYS — both imported from shared/api.py, never restated.

# The worker checkpoints every page and re-invokes itself before ~12 minutes,
# so an active job silent for this long has no live worker.
STALE_AFTER_SECONDS = 20 * 60

MAX_ERROR_CHARS = 500

# Cost ceiling: each examined review can cost one model call, so a job stops
# (as 'completed', with ``stopped_at_ceiling``) once it has scanned this many.
MAX_REPROCESS_ITEMS = 50000


def now_iso(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).isoformat()


def new_job_id(now: datetime) -> str:
    """``rp_`` + creation time in ms as 12 hex digits (sortable, unique per ms)."""
    return f"{JOB_ID_PREFIX}{int(now.timestamp() * 1000):012x}"


def new_worker_token() -> str:
    """A per-invocation claim token (never shown in the API)."""
    return uuid.uuid4().hex


def is_job_id(value: object) -> bool:
    return isinstance(value, str) and bool(JOB_ID_PATTERN.fullmatch(value))


def _as_int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, Decimal)):
        return int(value)
    return 0


def job_view(item: dict) -> dict:
    """The API's ``Job`` shape (internal fields such as the cursor stay private)."""
    view = {
        'job_id': item.get('sk'),
        'status': item.get('status'),
        'mode': item.get('mode'),
        'days': _as_int(item.get('days')),
        'include_manual': item.get('include_manual') is True,
        **{name: _as_int(item.get(name)) for name in COUNTERS},
        'started_by': item.get('started_by', ''),
        'created_at': item.get('created_at'),
        'updated_at': item.get('updated_at'),
        'stopped_at_ceiling': item.get('stopped_at_ceiling') is True,
    }
    for optional in ('finished_at', 'error'):
        if item.get(optional):
            view[optional] = item[optional]
    return view


def get_job(table: Any, job_id: str) -> dict | None:
    return table.get_item(Key={'pk': JOB_PK, 'sk': job_id}, ConsistentRead=True).get('Item')


def get_latest_job(table: Any) -> dict | None:
    response = table.query(
        KeyConditionExpression=Key('pk').eq(JOB_PK) & Key('sk').begins_with(JOB_ID_PREFIX),
        ScanIndexForward=False,
        Limit=1,
        ConsistentRead=True,
    )
    items = response.get('Items') or []
    return items[0] if items else None


def is_stale(job: dict, now: datetime) -> bool:
    updated_at = job.get('updated_at')
    if not isinstance(updated_at, str):
        return True
    try:
        last = datetime.fromisoformat(updated_at)
    except ValueError:
        return True
    return (now - last).total_seconds() > STALE_AFTER_SECONDS


def _claim_lock(table: Any, job_id: str, now: datetime) -> bool:
    try:
        table.update_item(
            Key={'pk': JOB_PK, 'sk': LOCK_SK},
            UpdateExpression='SET active_job_id = :id, updated_at = :now',
            ConditionExpression='attribute_not_exists(active_job_id)',
            ExpressionAttributeValues={':id': job_id, ':now': now_iso(now)},
        )
    except Exception as e:
        if is_conditional_check_failure(e):
            return False
        raise
    else:
        return True


def release_lock(table: Any, job_id: str) -> None:
    """Release the lock if (and only if) ``job_id`` holds it."""
    try:
        table.update_item(
            Key={'pk': JOB_PK, 'sk': LOCK_SK},
            UpdateExpression='REMOVE active_job_id',
            ConditionExpression='active_job_id = :id',
            ExpressionAttributeValues={':id': job_id},
        )
    except Exception as e:
        if not is_conditional_check_failure(e):
            raise


def _reclaim_lock_if_dead(table: Any, now: datetime) -> bool:
    """Free a lock whose holder can no longer make progress. True if freed."""
    lock = table.get_item(Key={'pk': JOB_PK, 'sk': LOCK_SK}, ConsistentRead=True).get('Item') or {}
    holder = lock.get('active_job_id')
    if not isinstance(holder, str):
        return True  # released between our claim and this read
    job = get_job(table, holder)
    if job and job.get('status') in ACTIVE_STATUSES:
        if not is_stale(job, now):
            return False
        finish_job(table, holder, STATUS_FAILED, error='Job stopped making progress', now=now)
    release_lock(table, holder)
    return True


def start_job(
    table: Any, *, mode: str, days: int, include_manual: bool, started_by: str, now: datetime,
) -> dict | None:
    """Create a queued job holding the lock. None when another job is active."""
    job_id = new_job_id(now)
    claimed = _claim_lock(table, job_id, now) or (
        _reclaim_lock_if_dead(table, now) and _claim_lock(table, job_id, now)
    )
    if not claimed:
        return None
    stamp = now_iso(now)
    item = {
        'pk': JOB_PK,
        'sk': job_id,
        'status': STATUS_QUEUED,
        'mode': mode,
        'days': days,
        'include_manual': include_manual,
        **dict.fromkeys(COUNTERS, 0),
        'started_by': started_by,
        'created_at': stamp,
        'updated_at': stamp,
    }
    try:
        table.put_item(Item=item, ConditionExpression='attribute_not_exists(sk)')
    except Exception:
        release_lock(table, job_id)
        raise
    return item


def _transition(
    table: Any, job_id: str, updates: dict, *,
    worker_token: str | None = None, claim_from: str | None = None, claiming: bool = False,
) -> dict | None:
    """SET ``updates`` on an ACTIVE job; None when the condition refused the write.

    ``worker_token`` requires the job to be held by that token; ``claiming``
    requires it to be held by ``claim_from`` (or by nobody when that is None).
    """
    names = {'#status': 'status'}
    values: dict = {}
    sets = []
    for index, (field, value) in enumerate(updates.items()):
        names[f'#f{index}'] = field
        values[f':v{index}'] = value
        sets.append(f'#f{index} = :v{index}')
    condition = 'attribute_exists(sk) AND #status IN (:queued, :running)'
    values[':queued'] = STATUS_QUEUED
    values[':running'] = STATUS_RUNNING
    if worker_token is not None or claiming:
        names['#token'] = 'worker_token'
    if worker_token is not None:
        condition += ' AND #token = :held_by'
        values[':held_by'] = worker_token
    if claiming:
        if claim_from is None:
            condition += ' AND attribute_not_exists(#token)'
        else:
            condition += ' AND #token = :claim_from'
            values[':claim_from'] = claim_from
    try:
        response = table.update_item(
            Key={'pk': JOB_PK, 'sk': job_id},
            UpdateExpression='SET ' + ', '.join(sets),
            ConditionExpression=condition,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ReturnValues='ALL_NEW',
        )
    except Exception as e:
        if is_conditional_check_failure(e):
            return None
        raise
    return response.get('Attributes')


def claim_job(
    table: Any, job_id: str, worker_token: str, *, previous_token: str | None = None,
    now: datetime | None = None,
) -> dict | None:
    """Mark the job running and owned by ``worker_token``.

    Compare-and-set: succeeds only while the job is active and held by
    ``previous_token`` (the handing-over worker's), or by nobody for the first
    delivery. None when refused — another delivery owns the job, or it ended.
    """
    return _transition(
        table, job_id,
        {'status': STATUS_RUNNING, 'worker_token': worker_token, 'updated_at': now_iso(now)},
        claiming=True, claim_from=previous_token,
    )


def checkpoint(
    table: Any, job_id: str, counters: dict, cursor: dict | None, worker_token: str,
    now: datetime | None = None,
) -> dict | None:
    """Persist progress. None when the job is no longer active (cancelled) or
    another delivery has claimed it — the caller must stop either way."""
    updates: dict[str, Any] = {name: int(counters.get(name, 0)) for name in COUNTERS}
    updates['updated_at'] = now_iso(now)
    updates['cursor'] = cursor or {}
    return _transition(table, job_id, updates, worker_token=worker_token)


def finish_job(
    table: Any,
    job_id: str,
    status: str,
    *,
    counters: dict | None = None,
    error: str | None = None,
    worker_token: str | None = None,
    stopped_at_ceiling: bool = False,
    now: datetime | None = None,
) -> dict | None:
    """Move an active job to a terminal status and release the lock.

    With ``worker_token`` (the worker's own finish) the write — and so the lock
    release — happens only while that token still owns the job; without it
    (cancel, stale reclaim) any active job is finished.
    """
    stamp = now_iso(now)
    updates: dict = {'status': status, 'updated_at': stamp, 'finished_at': stamp}
    if counters is not None:
        updates.update({name: int(counters.get(name, 0)) for name in COUNTERS})
    if error:
        updates['error'] = error[:MAX_ERROR_CHARS]
    if stopped_at_ceiling:
        updates['stopped_at_ceiling'] = True
    result = _transition(table, job_id, updates, worker_token=worker_token)
    if result is not None or worker_token is None:
        release_lock(table, job_id)
    return result


def cancel_job(table: Any, job_id: str, now: datetime | None = None) -> dict | None:
    """Cancel an active job; an already-terminal job is returned unchanged.

    None when the job does not exist.
    """
    cancelled = finish_job(table, job_id, STATUS_CANCELLED, now=now)
    return cancelled if cancelled is not None else get_job(table, job_id)
