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

Slices and resume (TENETS.md D3, ``shared/reprocess_slices.py``): a job row
carries the slice it replays (``sources``, ``categories``, ``date_from`` /
``date_to``, ``date_basis``), the configuration the worker derived with
(``config``: config_version, categories digest, model id; ``config_changed`` when
a hand-over saw another one) and ``raw_fallback`` (raw-mode reviews replayed from
the stored text, with ``raw_fallback_sources``). A job that reaches the item
ceiling ends ``partial`` with a ``resume_from`` cursor; a resume is a NEW job
(``resumed_from``) that starts at that cursor, and the partial job records
``resumed_by`` so it is resumed once.
"""
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from boto3.dynamodb.conditions import Key

from shared.aws import is_conditional_check_failure
from shared.reprocess_slices import ReprocessSlice
from shared.timestamps import now_iso

JOB_PK = 'JOB#category_reprocess'
LOCK_SK = 'LOCK'
JOB_ID_PREFIX = 'rp_'
JOB_ID_PATTERN = re.compile(r'^rp_[0-9a-f]{12}\Z')

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
# Stopped at the item ceiling with a ``resume_from`` cursor (terminal; resumable once).
STATUS_PARTIAL = 'partial'
ACTIVE_STATUSES = (STATUS_QUEUED, STATUS_RUNNING)

COUNTERS = ('scanned', 'updated', 'unchanged', 'skipped_manual', 'failed')
# Progress counted BESIDE the outcomes (a review lands in exactly one outcome):
# raw-mode reviews whose archived raw item was unreadable or absent, replayed from
# the stored text instead (audit R1).
PROGRESS_COUNTERS = ('raw_fallback',)
ALL_COUNTERS = COUNTERS + PROGRESS_COUNTERS
# The distinct sources a job saw a raw fallback for, kept on the row (bounded).
MAX_FALLBACK_SOURCES = 50

# A job's `days` window is the platform's: 0 (ALL_TIME_DAYS) = all time, up to
# MAX_FEEDBACK_WINDOW_DAYS — both imported from shared/api.py, never restated.

# The worker checkpoints every page and re-invokes itself before ~12 minutes,
# so an active job silent for this long has no live worker.
STALE_AFTER_SECONDS = 20 * 60

MAX_ERROR_CHARS = 500

# Cost ceiling: each examined review can cost one model call, so a job stops
# (as 'partial', with ``stopped_at_ceiling`` and a ``resume_from`` cursor) once it
# has scanned this many.
MAX_REPROCESS_ITEMS = 50000


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


_VIEW_OPTIONAL = (
    'finished_at', 'error', 'sources', 'categories', 'date_from', 'date_to', 'resumed_from', 'resumed_by',
)


def _config_view(config: object) -> dict | None:
    if not isinstance(config, dict):
        return None
    version = config.get('config_version')
    return {
        'config_version': _as_int(version) if version is not None else None,
        'categories_sha16': config.get('categories_sha16'),
        'model_id': config.get('model_id'),
        'prompt_version': config.get('prompt_version'),
    }


def job_view(item: dict) -> dict:
    """The API's ``Job`` shape (internal fields such as the cursor stay private)."""
    view = {
        'job_id': item.get('sk'),
        'status': item.get('status'),
        'mode': item.get('mode'),
        'days': _as_int(item.get('days')),
        'include_manual': item.get('include_manual') is True,
        **{name: _as_int(item.get(name)) for name in ALL_COUNTERS},
        'raw_fallback_sources': [s for s in item.get('raw_fallback_sources') or [] if isinstance(s, str)],
        'date_basis': item.get('date_basis') or 'processed',
        'started_by': item.get('started_by', ''),
        'created_at': item.get('created_at'),
        'updated_at': item.get('updated_at'),
        'stopped_at_ceiling': item.get('stopped_at_ceiling') is True,
        'resumable': item.get('status') == STATUS_PARTIAL and bool(item.get('resume_from'))
        and not item.get('resumed_by'),
        'config': _config_view(item.get('config')),
        'config_changed': item.get('config_changed') is True,
    }
    for optional in _VIEW_OPTIONAL:
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


@dataclass(frozen=True)
class Resume:
    """Where a resumed job starts: the partial job's id and its ``resume_from`` cursor."""
    job_id: str
    cursor: dict


def start_job(
    table: Any, *, mode: str, days: int, include_manual: bool, started_by: str, now: datetime,
    job_slice: ReprocessSlice | None = None, started_by_sub: str = '', resume: Resume | None = None,
) -> dict | None:
    """Create a queued job holding the lock. None when another job is active.

    With ``resume`` the new job starts at the partial job's cursor, and the partial
    job is marked ``resumed_by`` (``ResumeRefused`` when it was already resumed).
    """
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
        **(job_slice.fields() if job_slice else {}),
    }
    if started_by_sub:
        item['started_by_sub'] = started_by_sub
    if resume is not None:
        item['resumed_from'] = resume.job_id
        item['cursor'] = resume.cursor
    try:
        if resume is not None:
            _mark_resumed(table, resume.job_id, job_id)
        table.put_item(Item=item, ConditionExpression='attribute_not_exists(sk)')
    except Exception:
        release_lock(table, job_id)
        raise
    return item


class ResumeRefused(Exception):
    """The partial job is not resumable any more (resumed already, or not partial)."""


def _mark_resumed(table: Any, partial_job_id: str, new_job_id_: str) -> None:
    """Record ``resumed_by`` on the partial job, once; ``ResumeRefused`` otherwise."""
    try:
        table.update_item(
            Key={'pk': JOB_PK, 'sk': partial_job_id},
            UpdateExpression='SET resumed_by = :new',
            ConditionExpression='attribute_exists(sk) AND #status = :partial AND attribute_not_exists(resumed_by)',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':new': new_job_id_, ':partial': STATUS_PARTIAL},
        )
    except Exception as e:
        if is_conditional_check_failure(e):
            raise ResumeRefused from e
        raise


def resume_point(job: dict | None) -> Resume | None:
    """The resume a partial, not-yet-resumed job offers; None for any other job."""
    if not job or job.get('status') != STATUS_PARTIAL or job.get('resumed_by'):
        return None
    cursor = job.get('resume_from')
    if not isinstance(cursor, dict) or not cursor:
        return None
    return Resume(job_id=str(job.get('sk')), cursor=dict(cursor))


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
    updates: dict[str, Any] = progress_updates(counters)
    updates['updated_at'] = now_iso(now)
    updates['cursor'] = cursor or {}
    return _transition(table, job_id, updates, worker_token=worker_token)


def progress_updates(counters: dict) -> dict[str, Any]:
    """The counters (and the raw-fallback sources, when any) a checkpoint or finish writes."""
    updates: dict[str, Any] = {name: int(counters.get(name, 0)) for name in ALL_COUNTERS}
    sources = counters.get('raw_fallback_sources')
    if isinstance(sources, (list, set, tuple)) and sources:
        updates['raw_fallback_sources'] = sorted(str(s) for s in sources)[:MAX_FALLBACK_SOURCES]
    return updates


def record_config(table: Any, job: dict, config: dict, worker_token: str) -> dict | None:
    """Record the configuration this invocation derives with (R4).

    The first invocation stores ``config``; a later one (a hand-over) that derives
    with another configuration keeps the first and sets ``config_changed`` with
    ``last_config``. None when the job is no longer this worker's.
    """
    stored = job.get('config')
    if not isinstance(stored, dict):
        updates: dict[str, Any] = {'config': config}
    elif stored == config:
        return job
    else:
        updates = {'config_changed': True, 'last_config': config}
    return _transition(table, str(job.get('sk')), updates, worker_token=worker_token)


def finish_job(
    table: Any,
    job_id: str,
    status: str,
    *,
    counters: dict | None = None,
    error: str | None = None,
    worker_token: str | None = None,
    stopped_at_ceiling: bool = False,
    resume_from: dict | None = None,
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
        updates.update(progress_updates(counters))
    if error:
        updates['error'] = error[:MAX_ERROR_CHARS]
    if stopped_at_ceiling:
        updates['stopped_at_ceiling'] = True
    if resume_from:
        updates['resume_from'] = resume_from
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
