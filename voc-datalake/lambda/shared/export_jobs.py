"""A workspace's export jobs: their row, their one-at-a-time lock, the generation claim and the status a reader sees
(docs/multi-workspace.md, "Export and delete", step 2).

Shared by the workspaces API (``POST`` / ``GET /me/workspaces/current/export``, ``POST …/export/link``,
lambda/api/workspaces_handler.py), the export job (``voc-workspace-export``, lambda/jobs/workspace_export/handler.py)
and voc-retention (an erasure that reaches the workspace marks its exports ``erased``, lambda/jobs/retention/exports.py).
Every read and write goes through the workspace layer (shared/ws_repo.py ``ws_table``) on the workspace's own
partition of voc-aggregates:

    WS#{ws}#JOB#export / ex_{ulid}   the job: status, started_by_sub, created_at, generation, progress_at, phase,
                                     counts, size_bytes, completed_at, expires_at, error, workspace_id
    WS#{ws}#JOB#export / LOCK        one live export per workspace (shared/erasure_jobs.py's lock helpers, the rule of
                                     a workspace's erasure lock): a second start answers 409. ``LOCK`` sorts before
                                     ``ex_``, and every list reads ``begins_with(sk, 'ex_')`` only.

* Statuses: ``queued`` (written by the route), ``running`` (each invocation claims its generation), then
  ``completed``, ``failed``, ``cancelled`` (the workspace began deleting) or ``erased`` (an erasure reached the
  workspace: its export objects are deleted, D5). A reader also sees ``expired`` once a completed export is past
  ``expires_at`` (completion + ``DOWNLOAD_DAYS``), and ``failed`` for a job that stopped moving (``progress_at``
  older than the lock's ``STALE_AFTER``: its invocation timed out or died before it could write its row, or its
  hand-over was throttled past ``maxEventAge`` and dropped; ``STALLED_ERROR``; no notice
  is sent for it, and its lock is free again); a queued job that never claimed generation 0 in that time reads
  ``failed`` with ``NOT_STARTED_ERROR`` (its start, throttled past ``maxEventAge``, was dropped unrun).
* The lock during an erasure: voc-retention takes it for its sweep (``hold_for_erasure``) before it marks the
  exports ``erased``, and frees it after its last sweep (``release_after_erasure``): a start meanwhile answers 409.
* The generation claim: invocation ``g`` moves the row to ``running`` only from ``queued`` with no generation
  (``g`` 0, created within ``STALE_AFTER``) or from ``running`` at generation ``g - 1`` (which moved within
  ``STALE_AFTER``), so a duplicate, stale or late delivery changes nothing and stops at once: a start held up past the
  hour its lock lives never runs beside the export that took the freed lock.
* The zip: ``ws/{ws}/exports/{export id}/workspace-export.zip``, its work objects beside it under ``work/``
  (shared/ws_repo.py ``ExportObjects``), every one tagged ``voc-export=true`` (the raw bucket expires them).
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from typing import Any, Final, TypeGuard

from botocore.exceptions import BotoCoreError, ClientError

from shared.audit_rows import put_new_audit_row
from shared.aws import is_conditional_check_failure
from shared.dynamo_values import plain
from shared.erasure_jobs import WORKSPACE_LOCK_SK, acquire_lock, lock_holder, release_lock, release_quietly
from shared.logging import logger
from shared.platform_workspaces import new_workspace_id
from shared.source_erasure import STALE_AFTER
from shared.timestamps import parse_iso
from shared.workspace import WorkspaceContext, audit_key, audit_sort_key
from shared.workspace_routing import workspace_payload
from shared.ws_repo import ExportObjects, WorkspaceScope, WorkspaceTable, export_job_pk

__all__ = [
    'DELETE_HOLDER_PREFIX',
    'ERASURE_HOLDER_PREFIX',
    'EXPORT_JOB_TYPE',
    'ErasureHoldsExports',
    'ExportRunning',
    'LinkUnavailable',
    'claim_generation',
    'expires_at',
    'export_lock_key',
    'export_status',
    'finish_job',
    'hold_for_erasure',
    'is_export_id',
    'issue_link',
    'mark_erased',
    'record_progress',
    'release_after_erasure',
    'start_export',
]

EXPORT_ID_PREFIX: Final = 'ex_'
EXPORT_QUEUED: Final = 'queued'
EXPORT_RUNNING: Final = 'running'
EXPORT_COMPLETED: Final = 'completed'
EXPORT_FAILED: Final = 'failed'
EXPORT_CANCELLED: Final = 'cancelled'
#: An erasure reached the workspace: its export objects are gone (voc-retention).
EXPORT_ERASED: Final = 'erased'
#: Only what a reader sees: a completed export past its download window.
EXPORT_EXPIRED: Final = 'expired'
#: The download window of a completed export (the server's: each link request signs a fresh short link inside it).
DOWNLOAD_DAYS: Final = 7
#: How long one presigned download link works.
LINK_TTL_SECONDS: Final = 15 * 60
#: The job notice's ``job_type`` (shared/job_notices.py): the export page listens for it.
EXPORT_JOB_TYPE: Final = 'workspace_export'
#: The zip's file name under the export's folder, and the folder of its work objects.
ZIP_NAME: Final = 'workspace-export.zip'
WORK_FOLDER: Final = 'work'
#: Why a job ended cancelled: the workspace began deleting (or is gone) while it ran.
WORKSPACE_DELETING: Final = 'workspace_deleting'
#: A running export whose ``progress_at`` is past ``STALE_AFTER``: an invocation timed out or ran out of memory, or
#: its hand-over was throttled past ``maxEventAge`` and dropped. Its lock is stale by then, so a new start works.
STALLED_ERROR: Final = 'The export stopped before it finished. Start it again.'
#: A queued export that never claimed generation 0 within ``STALE_AFTER``: its start was throttled past
#: ``maxEventAge`` (the job's reserved concurrency was in use) and dropped unrun.
NOT_STARTED_ERROR: Final = 'The export did not start. Start it again.'
#: A queued or running export an erasure marked ``erased``: what it had written is deleted.
ERASED_DURING_EXPORT: Final = "The workspace's data was erased during the export. Start a new one."
#: ``ex_`` + a ULID (48 bits of milliseconds then 80 random bits, 26 Crockford base32 characters, first 0-7).
_EXPORT_ID: Final = re.compile(r'ex_[0-7][0-9A-HJKMNP-TV-Z]{25}')
_UNFINISHED: Final = (EXPORT_QUEUED, EXPORT_RUNNING)
#: What an erasure marks erased: every export whose objects may still exist.
_ERASABLE: Final = (EXPORT_QUEUED, EXPORT_RUNNING, EXPORT_COMPLETED)


class ExportRunning(Exception):
    """Another export of the workspace holds its lock (the API answers 409)."""


class ErasureHoldsExports(ExportRunning):
    """An erasure holds the workspace's export lock (``hold_for_erasure``): the API answers 409, saying so."""


#: The holder an erasure takes the export lock under: ``erasure-{run id}`` (jobs/retention/exports.py).
ERASURE_HOLDER_PREFIX: Final = 'erasure-'
#: The holder a workspace delete takes it under: ``delete-{ws}`` (shared/workspace_deletes.py ``holder``).
DELETE_HOLDER_PREFIX: Final = 'delete-'


class LinkUnavailable(Exception):
    """The newest export is not a completed one inside its download window: no link is signed."""


def new_export_id(now_ms: int | None = None) -> str:
    """``ex_`` + a ULID (the one ULID writer, shared/platform_workspaces.py, that makes a workspace's id): ids sort
    by creation time, so the newest export is the last ``ex_`` row of the partition."""
    return EXPORT_ID_PREFIX + new_workspace_id(now_ms).removeprefix('ws_')


def is_export_id(value: object) -> TypeGuard[str]:
    return isinstance(value, str) and _EXPORT_ID.fullmatch(value) is not None


def job_key(scope: WorkspaceScope, export_id: str) -> dict[str, str]:
    """The key of one export job's row. Refuses (ValueError) an id that is not an export id."""
    if not is_export_id(export_id):
        raise ValueError('not an export id')
    return {'pk': export_job_pk(scope), 'sk': export_id}


# ── The row ────────────────────────────────────────────────────────────────────────────────────────────────────

def new_job_row(context: WorkspaceContext, export_id: str, started_by: str, at: str) -> dict[str, Any]:
    """The queued row of a new export: ``workspace_id`` is the request's resolved membership's (``context``, a
    ``WorkspaceContext``), set after every other field by ``workspace_payload``, never a value a body carried."""
    row = {'export_id': export_id, 'status': EXPORT_QUEUED, 'started_by_sub': started_by, 'created_at': at}
    return workspace_payload(row, context)


def put_job_row(view: WorkspaceTable, row: Mapping[str, Any]) -> None:
    """Store a new job row (conditional on a new key)."""
    view.put_item({**job_key(view.scope, str(row['export_id'])), **row},
                  ConditionExpression='attribute_not_exists(sk)')


def _export_rows(view: WorkspaceTable, **kwargs: Any) -> dict[str, Any]:
    return view.query('pk', export_job_pk(view.scope), sort_condition='begins_with(#sk, :ex)',
                      ExpressionAttributeNames={'#sk': 'sk'}, ExpressionAttributeValues={':ex': EXPORT_ID_PREFIX},
                      **kwargs)


def latest_job(view: WorkspaceTable) -> dict[str, Any] | None:
    """The newest export job of the workspace (strongly consistent), or None. One Query of one item."""
    items = _export_rows(view, ScanIndexForward=False, Limit=1, ConsistentRead=True).get('Items') or []
    return dict(items[0]) if items and isinstance(items[0], Mapping) else None


def claim_generation(view: WorkspaceTable, export_id: str, generation: int, now: datetime) -> dict[str, Any] | None:
    """Claim invocation ``generation`` of the job: the row, now ``running`` at that generation, or None when the row
    is missing, finished, at another generation, or stale (generation 0 created, or the previous one moved, more
    than ``STALE_AFTER`` ago): a duplicate, stale or late delivery must do nothing."""
    if generation == 0:
        condition = ('attribute_exists(pk) AND #status = :queued AND attribute_not_exists(#generation) '
                     'AND created_at > :fresh')
        values: dict[str, Any] = {':queued': EXPORT_QUEUED}
    else:
        condition = 'attribute_exists(pk) AND #status = :running AND #generation = :previous AND progress_at > :fresh'
        values = {':previous': generation - 1}
    try:
        response = view.update_item(
            job_key(view.scope, export_id),
            UpdateExpression='SET #status = :running, #generation = :generation, progress_at = :now, '
                             'started_at = if_not_exists(started_at, :now)',
            ConditionExpression=condition,
            ExpressionAttributeNames={'#status': 'status', '#generation': 'generation'},
            ExpressionAttributeValues={**values, ':running': EXPORT_RUNNING, ':generation': generation,
                                       ':now': now.isoformat(), ':fresh': (now - STALE_AFTER).isoformat()},
            ReturnValues='ALL_NEW')
    except ClientError as error:
        if is_conditional_check_failure(error):
            return None
        raise
    attributes = response.get('Attributes')
    return dict(attributes) if isinstance(attributes, Mapping) else None


def _sets(fields: Mapping[str, Any]) -> tuple[str, dict[str, str], dict[str, Any]]:
    """``SET #f0 = :f0, …`` of ``fields`` (every name aliased: ``status`` and ``error`` are reserved words)."""
    names = {f'#f{index}': name for index, name in enumerate(fields)}
    values = {f':f{index}': value for index, value in enumerate(fields.values())}
    return ', '.join(f'#f{index} = :f{index}' for index in range(len(fields))), names, values


def _conditional_update(view: WorkspaceTable, export_id: str, fields: Mapping[str, Any], condition: str,
                        names: Mapping[str, str], values: Mapping[str, Any]) -> bool:
    """SET ``fields`` on the job when ``condition`` holds; whether it was written."""
    clauses, field_names, field_values = _sets(fields)
    try:
        view.update_item(job_key(view.scope, export_id), UpdateExpression=f'SET {clauses}',
                         ConditionExpression=condition, ExpressionAttributeNames={**field_names, **names},
                         ExpressionAttributeValues={**field_values, **values})
    except ClientError as error:
        if is_conditional_check_failure(error):
            return False
        raise
    return True


def record_progress(view: WorkspaceTable, export_id: str, generation: int, fields: Mapping[str, Any]) -> bool:
    """Write ``fields`` on the job while it is running at ``generation``; whether it was written."""
    return _conditional_update(view, export_id, fields, '#status = :running AND #generation = :generation',
                               {'#status': 'status', '#generation': 'generation'},
                               {':running': EXPORT_RUNNING, ':generation': generation})


def finish_job(view: WorkspaceTable, export_id: str, status: str, fields: Mapping[str, Any]) -> bool:
    """Record the job's outcome (``status`` and ``fields``) while it is unfinished (queued or running); whether it
    was written. A row that already reads finished (``erased`` included), or is gone, is left as it is."""
    return _conditional_update(view, export_id, {'status': status, **fields},
                               'attribute_exists(pk) AND #status IN (:queued, :running)', {'#status': 'status'},
                               {':queued': EXPORT_QUEUED, ':running': EXPORT_RUNNING})


def hold_for_erasure(view: WorkspaceTable, holder: str, now: datetime, *, workspace_active: bool) -> None:
    """Take the workspace's export lock for an erasure's sweep (``holder``: the erasure run's id), whoever holds it
    but a workspace delete: every export that holds it is marked ``erased`` right after (``mark_erased``), and while
    the erasure holds it a start answers 409, so no export begins under the sweep. Taken again at each pass (it
    renews ``locked_at``); ``release_after_erasure`` frees it after the last sweep, or it goes stale after
    ``STALE_AFTER``. Nothing is written while a delete holds it (``DELETE_HOLDER_PREFIX``: the delete keeps it to its
    last step, and deletes every export of the workspace itself), nor, for a workspace that is not ``active``
    (``workspace_active`` False: deleting, or deleted), when there is no lock row: no export can start there, and a
    lock created after the delete removed it would outlive the workspace."""
    condition = 'attribute_not_exists(job_id) OR NOT begins_with(job_id, :delete)'
    try:
        view.update_item(export_lock_key(view.scope),
                         UpdateExpression='SET job_id = :holder, locked_at = :now REMOVE released_at',
                         ConditionExpression=condition if workspace_active else f'attribute_exists(pk) AND ({condition})',
                         ExpressionAttributeValues={':holder': holder, ':now': now.isoformat(),
                                                    ':delete': DELETE_HOLDER_PREFIX})
    except ClientError as error:
        if not is_conditional_check_failure(error):
            raise


def release_after_erasure(view: WorkspaceTable, holder: str, now: datetime) -> None:
    """Free the export lock an erasure took (only while ``holder`` still holds it)."""
    release_lock(view, export_job_pk(view.scope), holder, now)


def export_lock_key(scope: WorkspaceScope) -> dict[str, str]:
    """The workspace's export LOCK row (the hard delete holds it to its last step, then deletes it)."""
    return {'pk': export_job_pk(scope), 'sk': WORKSPACE_LOCK_SK}


def mark_erased(view: WorkspaceTable, now: datetime) -> None:
    """Mark every export of the workspace whose objects may exist (queued, running or completed) ``erased``: an
    erasure reached the workspace, and its export objects are deleted (voc-retention, D5). The condition names every
    erasable status, not the one read, so an export that moved on between the read and the write (completed) is
    still marked. The lock stays with the erasure (``hold_for_erasure``) until its last sweep."""
    for row in view.iter_query('pk', export_job_pk(view.scope), sort_condition='begins_with(#sk, :ex)',
                               ExpressionAttributeNames={'#sk': 'sk'},
                               ExpressionAttributeValues={':ex': EXPORT_ID_PREFIX}):
        status, export_id = row.get('status'), row.get('export_id')
        if status not in _ERASABLE or not is_export_id(export_id):
            continue
        # An export still under way when its workspace's data was erased says so (its job stops at its next check).
        fields = {'status': EXPORT_ERASED, 'erased_at': now.isoformat(),
                  **({'error': ERASED_DURING_EXPORT} if status in _UNFINISHED else {})}
        _conditional_update(view, export_id, fields, '#status IN (:queued, :running, :completed)',
                            {'#status': 'status'},
                            {':queued': EXPORT_QUEUED, ':running': EXPORT_RUNNING, ':completed': EXPORT_COMPLETED})


# ── What a reader sees ─────────────────────────────────────────────────────────────────────────────────────────

_VIEW_FIELDS: Final = ('created_at', 'started_at', 'completed_at', 'expires_at', 'erased_at', 'phase', 'counts',
                       'size_bytes', 'error')


def progress_stalled(row: Mapping[str, Any], now: datetime, unfinished: tuple[str, ...], created: str) -> bool:
    """A job row in one of the ``unfinished`` statuses that has not moved (``progress_at``, else its ``created``
    time) for ``STALE_AFTER``: its invocation died, or its hand-over was dropped. The export's rule, and the
    workspace delete's (shared/workspace_deletes.py)."""
    moved = parse_iso(row.get('progress_at')) or parse_iso(row.get(created))
    return row.get('status') in unfinished and (moved is None or now - moved > STALE_AFTER)


def _stalled(row: Mapping[str, Any], now: datetime) -> bool:
    """An unfinished export that has not moved for ``STALE_AFTER`` (its lock is free again)."""
    return progress_stalled(row, now, _UNFINISHED, 'created_at')


def job_view(row: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    """The export as the API shows it: ``{id, status, created_at, …}``, ``expired`` past ``expires_at``, ``failed``
    for a job that stopped moving. Never the row's keys, its upload id or its starter's sub."""
    view: dict[str, Any] = {'id': row.get('export_id'), 'status': row.get('status')}
    view.update({field: row[field] for field in _VIEW_FIELDS if row.get(field) is not None})
    expires = parse_iso(row.get('expires_at'))
    if view['status'] == EXPORT_COMPLETED and (expires is None or now >= expires):
        view['status'] = EXPORT_EXPIRED
    elif _stalled(row, now):
        never_started = row.get('status') == EXPORT_QUEUED and row.get('generation') is None
        view.update(status=EXPORT_FAILED, error=NOT_STARTED_ERROR if never_started else STALLED_ERROR)
    return plain(view)


def expires_at(completed: datetime) -> str:
    """The end of a completed export's download window."""
    return (completed + timedelta(days=DOWNLOAD_DAYS)).isoformat()


# ── The routes' steps (lambda/api/workspaces_handler.py) ───────────────────────────────────────────────────────

#: The audit rows of an export (``AUDIT#WS#{ws}``, under the audit-row guard): its start and each link issued.
EXPORT_REQUESTED: Final = 'export_requested'
EXPORT_LINK_ISSUED: Final = 'export_link_issued'
START_FAILED: Final = 'The export could not start. Try again.'


def _audit(workspaces: Any, context: WorkspaceContext, actor: str, kind: str, export_id: str, at: datetime,
           **fields: Any) -> None:
    moment = at.isoformat()
    put_new_audit_row(workspaces, {'pk': audit_key(context.ws), 'sk': audit_sort_key(moment), 'kind': kind,
                                   'actor': actor, 'export_id': export_id, 'platform_admin': context.platform_admin,
                                   'at': moment, **fields})


def _release(view: WorkspaceTable, export_id: str, now: datetime) -> None:
    release_quietly(lambda: release_lock(view, export_job_pk(view.scope), export_id, now), 'workspace export')


def start_export(view: WorkspaceTable, workspaces: Any, context: WorkspaceContext, actor: str,
                 invoke: Callable[[dict[str, Any]], Any], now: datetime) -> dict[str, Any]:
    """Start an export of the resolved workspace: its lock (``ExportRunning`` while one is live), an
    ``export_requested`` audit row, the queued job row, then the job's async invoke with ``{export_id,
    workspace_id}`` (``workspace_payload``: the workspace from ``context`` only). Every failure after the lock frees
    it; a failed invoke also ends the row ``failed`` (best effort: a fault there is logged) and is the error raised.
    The new export as ``job_view`` shows it."""
    export_id = new_export_id()
    try:
        acquire_lock(view, export_job_pk(view.scope), export_id, now, ExportRunning(view.scope.ws))
    except ExportRunning:
        if _held_by_erasure(view):
            raise ErasureHoldsExports(view.scope.ws) from None
        raise
    try:
        _audit(workspaces, context, actor, EXPORT_REQUESTED, export_id, now)
        row = new_job_row(context, export_id, actor, now.isoformat())
        put_job_row(view, row)
    except (ClientError, BotoCoreError):
        _release(view, export_id, now)
        raise
    try:
        invoke(workspace_payload({'export_id': export_id}, context))
    except (ClientError, BotoCoreError):
        _fail_unstarted(view, export_id, now)
        raise
    return job_view(row, now)


def _held_by_erasure(view: WorkspaceTable) -> bool:
    """Whether the export lock that refused a start is an erasure's (one Query of the lock row: the API may Query
    the export partition, not GetItem it)."""
    holder = lock_holder(view, export_job_pk(view.scope))
    return holder is not None and holder.startswith(ERASURE_HOLDER_PREFIX)


def _fail_unstarted(view: WorkspaceTable, export_id: str, now: datetime) -> None:
    """A job the worker never received: its row ended ``failed`` and its lock freed, best effort, so the caller's
    invoke error is the one reported."""
    try:
        finish_job(view, export_id, EXPORT_FAILED, {'error': START_FAILED})
    except (ClientError, BotoCoreError) as exc:
        logger.warning('Could not mark the unstarted export failed', extra={'error_type': type(exc).__name__})
    finally:
        _release(view, export_id, now)


def download_name(context: WorkspaceContext, row: Mapping[str, Any]) -> str:
    """``{slug}-export-{yyyy-mm-dd}.zip``: the slug is ``a-z``, ``0-9`` and ``-`` (the workspace id without one)."""
    created = parse_iso(row.get('created_at'))
    day = created.date().isoformat() if created else 'latest'
    return f'{context.slug or context.ws}-export-{day}.zip'


def export_status(view: WorkspaceTable, now: datetime) -> dict[str, Any] | None:
    """The workspace's newest export as ``job_view`` shows it, or None when it never exported. No link, no write."""
    row = latest_job(view)
    return None if row is None else job_view(row, now)


def issue_link(view: WorkspaceTable, workspaces: Any, objects: ExportObjects, context: WorkspaceContext, actor: str,
               now: datetime) -> dict[str, Any]:
    """A fresh download link of ``LINK_TTL_SECONDS`` for the newest export, only while it is completed and inside its
    window (``LinkUnavailable`` otherwise), issued only once its ``export_link_issued`` audit row is written."""
    row = latest_job(view)
    if row is None or job_view(row, now)['status'] != EXPORT_COMPLETED:
        raise LinkUnavailable
    export_id = str(row['export_id'])
    _audit(workspaces, context, actor, EXPORT_LINK_ISSUED, export_id, now, expires_in=LINK_TTL_SECONDS)
    url = objects.presigned_download(objects.key(export_id, ZIP_NAME), download_name(context, row),
                                     LINK_TTL_SECONDS)
    return {'id': export_id, 'url': url, 'expires_in': LINK_TTL_SECONDS,
            'expires_at': (now + timedelta(seconds=LINK_TTL_SECONDS)).isoformat()}
