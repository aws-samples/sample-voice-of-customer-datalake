"""voc-retention's bookkeeping: the run state, the erasure job row and the audit row.

A run's state travels across hand-overs in the event (``run``). Every finished
(or failed) run writes ONE audit row (``pk AUDIT#retention``, no ``ttl``: an
audit trail never expires, TENETS.md D4) with its counts and legal basis, never
the erased value. An erasure job's row (``pk JOB#erasure``) is claimed, kept
moving while the job runs, and closed with the outcome; closing it tells the admin who started it
(``/jobs/<sub>``, best effort, docs/realtime.md).
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Mapping
from typing import Any, Final

from botocore.exceptions import ClientError

from shared import job_notices
from shared.aws import is_conditional_check_failure
from shared.retention import ERASURE_JOB_COUNTERS, ERASURE_JOB_PK
from shared.timestamps import now_iso

MODE_RETENTION: Final = 'retention'
MODE_ERASE: Final = 'erase'
AUDIT_PK: Final = 'AUDIT#retention'
STATUS_QUEUED: Final = 'queued'
STATUS_RUNNING: Final = 'running'
#: The notice's ``job_type`` (shared/job_notices.py): the SPA's erasure panels listen for it.
ERASURE_JOB_TYPE: Final = 'erasure'
# A running job's row is refreshed when its counts move, and at least this often.
PROGRESS_EVERY_SECONDS: Final = 60
# Whole-file uploads a run lists for review (keys only); a run that meets more says so (``more``).
MAX_REVIEW_FILES: Final = 200

# The counters a run keeps and carries across hand-overs (audit row, result).
COUNTERS: Final = ('scanned', *ERASURE_JOB_COUNTERS)
# Board rows (requests, +1s) an erasure by email de-identified (boards.py): carried like the others, and
# written on the job and audit rows only once it is above 0 (a run without boards reads as before).
BOARD_COUNTER: Final = 'board_items_deidentified'
_CARRIED_LISTS: Final = ('erased_sources', 'review_files')
_AUDIT_OPTIONAL: Final = ('job_id', 'field', 'source', 'value_hash', 'cutoffs', 'legal_basis', 'legal_bases',
                          'erased_sources')


def new_run(event: Mapping[str, Any], mode: str) -> dict[str, Any]:
    """The run's running state: carried across hand-overs in the event."""
    raw = event.get('run')
    carried: Mapping[str, Any] = raw if isinstance(raw, dict) else {}
    run: dict[str, Any] = {
        'mode': mode,
        'run_id': carried.get('run_id') or uuid.uuid4().hex[:12],
        'started_at': carried.get('started_at') or now_iso(),
        'generation': int(carried.get('generation', 0)),
        **{counter: int(carried.get(counter, 0)) for counter in COUNTERS}, **board_count(carried),
    }
    for name in _CARRIED_LISTS:
        values = carried.get(name)
        run[name] = [str(value) for value in values] if isinstance(values, list) else []
    run['review_files_more'] = carried.get('review_files_more') is True
    return run


def carried_state(run: Mapping[str, Any]) -> dict[str, Any]:
    """What a hand-over passes on (the next generation re-reads its job row and profiles)."""
    return {
        'run_id': run['run_id'], 'started_at': run['started_at'], 'generation': run['generation'] + 1,
        **{counter: run[counter] for counter in COUNTERS}, **board_count(run),
        **{name: list(run[name]) for name in _CARRIED_LISTS},
        'review_files_more': run['review_files_more'],
    }


def board_count(run: Mapping[str, Any]) -> dict[str, int]:
    """``{BOARD_COUNTER: n}`` when the run de-identified board rows, else {}."""
    count = int(run.get(BOARD_COUNTER) or 0)
    return {BOARD_COUNTER: count} if count else {}


def note_erased_source(run: dict[str, Any], source: str) -> None:
    """Remember a source this run deleted from (the lineage pass looks up its tombstones)."""
    if source not in run['erased_sources']:
        run['erased_sources'].append(source)


def note_review_file(run: dict[str, Any], key: str) -> None:
    """List a whole-file upload that holds a deleted row but was kept (see shared/retention.py)."""
    if key in run['review_files']:
        return
    if len(run['review_files']) >= MAX_REVIEW_FILES:
        run['review_files_more'] = True
        return
    run['review_files'].append(key)


def files_needing_review(run: Mapping[str, Any]) -> dict[str, Any] | None:
    """``{count, keys, more}`` of the kept whole-file uploads, or None when there are none."""
    keys = list(run['review_files'])
    if not keys:
        return None
    return {'count': len(keys), 'keys': keys, 'more': bool(run['review_files_more'])}


def write_audit(aggregates_table: Any, run: Mapping[str, Any], status: str, error: str | None = None) -> None:
    """One audit row for a finished (or failed) run: mode, counts, legal basis, never the erased value."""
    now = now_iso()
    review = files_needing_review(run)
    item = {
        'pk': AUDIT_PK, 'sk': f"{now}#{run['run_id']}", 'run_id': run['run_id'], 'mode': run['mode'],
        'status': status, **{counter: run[counter] for counter in COUNTERS}, **board_count(run),
        'started_at': run['started_at'], 'finished_at': now,
        **{key: run[key] for key in _AUDIT_OPTIONAL if run.get(key)},
        **({'files_needing_review': review} if review else {}),
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


def _counter_sets(run: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    """``SET`` clauses and values for the job's moving counters."""
    counts = {**{counter: run[counter] for counter in ERASURE_JOB_COUNTERS}, **board_count(run)}
    clauses = ', '.join(f'{counter} = :{counter}' for counter in counts)
    return clauses, {f':{counter}': value for counter, value in counts.items()}


def finish_erasure_job(aggregates_table: Any, run: Mapping[str, Any], status: str, error: str | None = None) -> None:
    """Record the job's outcome and counts (the row keeps its value_hash, never the value)."""
    clauses, values = _counter_sets(run)
    names = {'#status': 'status'}
    values.update({':status': status, ':now': now_iso()})
    expression = f'SET #status = :status, {clauses}, finished_at = :now'
    review = files_needing_review(run)
    if review:
        expression += ', files_needing_review = :review'
        values[':review'] = review
    if error:
        expression += ', #error = :error'
        names['#error'] = 'error'
        values[':error'] = error
    aggregates_table.update_item(
        Key=_job_key(run['job_id']), UpdateExpression=expression,
        ExpressionAttributeNames=names, ExpressionAttributeValues=values,
    )
    job_notices.notify(run.get('started_by_sub'), run['job_id'], status, job_type=ERASURE_JOB_TYPE)


def record_progress(aggregates_table: Any, run: dict[str, Any], phase: str) -> None:
    """Write a running erasure job's counts and phase (no-op for retention runs).

    Throttled: only when the counts moved since the last write or
    ``PROGRESS_EVERY_SECONDS`` passed, so a long scan with few matches still
    shows it is alive without one write per page.
    """
    if not run.get('job_id'):
        return
    counts = (*(run[counter] for counter in ERASURE_JOB_COUNTERS), run.get(BOARD_COUNTER), phase)
    last = run.get('_progress')
    if isinstance(last, tuple) and last[0] == counts \
            and time.monotonic() - last[1] < PROGRESS_EVERY_SECONDS:
        return
    clauses, values = _counter_sets(run)
    try:
        aggregates_table.update_item(
            Key=_job_key(run['job_id']),
            UpdateExpression=f'SET {clauses}, phase = :phase, progress_at = :now',
            ConditionExpression='#status = :running',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={**values, ':phase': phase, ':now': now_iso(), ':running': STATUS_RUNNING},
        )
    except ClientError as e:
        # A row that is gone or no longer running is never recreated; the outcome write still runs.
        if not is_conditional_check_failure(e):
            raise
    run['_progress'] = (counts, time.monotonic())
