"""A workspace's hard delete: its request, its job row, its cancel and resume (docs/multi-workspace.md, "Export and
delete", steps 3 and 4; decision 17).

Shared by the workspaces API (``POST /me/workspaces/current/delete``, ``POST /platform/workspaces/{ws}/delete/resume``
and ``…/delete/cancel``, lambda/api/workspaces_handler.py) and the delete job (``voc-workspace-delete``,
lambda/jobs/workspace_delete/). Its rows, all in voc-workspaces::

    WSDELETE                / {ws}             the job: status, phase, generation, progress_at, checkpoint, counts,
                                               requested_at, deleting_at, fence_at, requested_by_sub, platform_admin,
                                               legal_basis, name, slug, listing_sk, workspace_id, error,
                                               started_at, completed_at, cancelled_at, resumes: kept for good
    AUDIT#workspace-deletes / {iso}#{random}   kind requested, cancelled, resumed or completed: the workspace's id,
                                               name and slug, the actor, the basis, the counts; never a row's content
    AUDIT#WS#{ws}           / {iso}#{random}   kind workspace_delete_requested or workspace_delete_cancelled

* **The request** (a member admin, or an entered platform admin: the route's gate): the slug typed exactly and a
  basis (shared/legal_basis.py ``required_legal_basis``); the workspace's export lock and its erasure lock taken for
  ``delete-{ws}`` (409 while an export or an erasure holds one: ``DeleteBlocked``), then ONE transaction: ``META``
  and the listing row ``active`` → ``deleting`` with ``deleting_at``, the job row (conditional: no row, or a cancelled
  one, so it is also the one-delete-per-workspace lock), and both audit rows. A repeat whose transaction meets this
  job's row answers that job (idempotent); once the workspace reads ``deleting`` every route, this one too, answers
  the workspace's one 404. Then the job's asynchronous invoke with ``{workspace_id}`` only.
* **The fence**: the job deletes nothing before ``fence_at`` (``deleting_at`` + ``FENCE``: the writers' 300 s status
  cache, one 15-minute invocation and a minute, shared/ws_repo.py ``ACTIVE_STATUS_TTL_SECONDS``). The fence ends when
  the job moves its row ``waiting`` → ``running`` (``begin_sweeps``, conditional), the same row a cancel moves: of
  the two, exactly one wins.
* **Cancel** (a platform admin, during the fence only): one transaction: the row ``waiting`` (or ``failed`` while
  still in the fence) → ``cancelled``, ``META`` and the listing row back to ``active``, both audit rows; then both
  locks are freed. The messages the processor dropped meanwhile are lost (docs/multi-workspace.md) and are not counted
  per workspace (``WorkspaceMessagesDropped`` has no workspace dimension): the audit row says so. The counters are
  marked for a rebuild (``counters_rebuild``): the operator runs scripts/retention/rebuild_aggregates.py
  ``--workspace`` once the stream has settled (that script's own rule).
* **Resume** (a platform admin): a ``failed`` job, or one whose ``progress_at`` is older than ``STALE_AFTER`` (an
  invocation the timeout killed, a hand-over dropped), is invoked again from its checkpoint, the next generation.
* **The generation claim**: invocation ``g`` claims the row only at generation ``g - 1`` (none for 0) while it is
  ``waiting`` or ``running`` and moved within ``STALE_AFTER`` (created within it, for 0), so a duplicate, stale or late
  delivery changes nothing.
"""
from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.audit_rows import put_new_audit_row
from shared.aws import consistent_item, is_conditional_check_failure
from shared.dynamo_values import plain
from shared.erasure_jobs import acquire_lock, lock_holder, release_lock, release_quietly
from shared.exceptions import AuthorizationError, ConflictError, NotFoundError, ValidationError
from shared.export_jobs import DELETE_HOLDER_PREFIX, ERASURE_HOLDER_PREFIX, progress_stalled
from shared.legal_basis import required_legal_basis
from shared.logging import logger, metrics
from shared.platform_workspaces import LISTING_PK, listing_sort_key
from shared.request_body import reject_unknown_fields
from shared.source_erasure import STALE_AFTER
from shared.update_expressions import set_clause
from shared.workspace import ACTIVE, WorkspaceContext, audit_key, audit_sort_key, is_workspace_id
from shared.workspace_routing import workspace_payload
from shared.ws_repo import (
    DELETING,
    WORKSPACE_FIELD,
    WorkspaceScope,
    WorkspaceTable,
    erasure_job_pk,
    export_job_pk,
    scope_from_message,
)

__all__ = [
    'begin_sweeps',
    'cancel_delete',
    'claim_generation',
    'finish_job',
    'hard_delete_enabled',
    'parse_delete_request',
    'record_progress',
    'request_delete',
    'require_hard_delete',
    'resume_delete',
]

#: The job rows' partition and the platform audit partition (voc-workspaces).
JOB_PARTITION: Final = 'WSDELETE'
AUDIT_PARTITION: Final = 'AUDIT#workspace-deletes'
#: How long after ``deleting_at`` the job waits before it deletes anything (the module docstring).
FENCE: Final = timedelta(minutes=21)
WAITING: Final = 'waiting'
RUNNING: Final = 'running'
COMPLETED: Final = 'completed'
FAILED: Final = 'failed'
CANCELLED: Final = 'cancelled'
#: The phase of a job that has deleted nothing yet (the job's first phase).
PHASE_FENCE: Final = 'fence'
#: The kinds of the audit rows (``AUDIT#WS#{ws}`` and ``AUDIT_PARTITION``).
WORKSPACE_DELETE_REQUESTED: Final = 'workspace_delete_requested'
WORKSPACE_DELETE_CANCELLED: Final = 'workspace_delete_cancelled'
REQUESTED: Final = 'requested'
CANCELLED_KIND: Final = 'cancelled'
RESUMED: Final = 'resumed'
#: The 400s and 409s of the routes.
SLUG_MISMATCH: Final = "Type the workspace's slug exactly to confirm the delete"
CHANGED_MEANWHILE: Final = 'The workspace changed while the delete was being requested. Reload and try again'
TOO_LATE_TO_CANCEL: Final = 'The delete has begun (its 21-minute wait is over): it can no longer be cancelled'
NOT_RESUMABLE: Final = 'The delete is not stopped: only a failed delete, or one that has not moved for an hour, resumes'
NO_DELETE: Final = 'No delete of this workspace'
#: How many times a platform admin may resume one delete; each resume grants the job a fresh budget of hand-overs
#: (lambda/jobs/workspace_delete/handler.py ``MAX_GENERATIONS``).
MAX_RESUMES: Final = 10
TOO_MANY_RESUMES: Final = (f'The delete was resumed {MAX_RESUMES} times and did not finish: it needs an operator. '
                           'Read its job row and the job\'s logs to see what stops it, fix that, then resume it')
START_FAILED: Final = 'The delete could not start. A platform admin can resume it.'
#: What the cancel's audit row says about the messages dropped while the workspace was deleting.
DROPPED_NOT_COUNTED: Final = ('not counted per workspace: the processor counts WorkspaceMessagesDropped without a '
                              'workspace dimension; its log lines name the workspace id between deleting_at and '
                              'cancelled_at')
#: The command the cancel's counters rebuild is (scripts/retention/rebuild_aggregates.py, the operator's).
COUNTERS_REBUILD: Final = 'required: scripts/retention/rebuild_aggregates.py --workspace {ws} --apply'
_UNFINISHED: Final = (WAITING, RUNNING)


#: The deployment flag (``-c workspaceHardDelete=true``, lib/utils/workspace-hard-delete.ts): off by default, and
#: off until the per-person export ships (a delete destroys members' conversations and personal memories, of which
#: they have no copy yet).
HARD_DELETE_ENV: Final = 'WORKSPACE_HARD_DELETE'
HARD_DELETE_DISABLED: Final = 'Deleting a workspace is not available in this deployment'


def hard_delete_enabled() -> bool:
    """Whether this deployment allows the hard delete (``WORKSPACE_HARD_DELETE`` is ``true``; anything else: no)."""
    return os.environ.get(HARD_DELETE_ENV) == 'true'


def require_hard_delete() -> None:
    """The request's and the resume's first step: 403 "not available in this deployment" with the flag off, before
    anything is read or written (a platform admin's entry row included). Never the cancel's: it only restores a
    workspace."""
    if not hard_delete_enabled():
        raise AuthorizationError(HARD_DELETE_DISABLED)


class DeleteBlocked(ConflictError):
    """An export or an erasure of the workspace holds its lock: the route answers 409 with what to wait for."""


@dataclass(frozen=True)
class DeleteRequest:
    """A validated ``POST /me/workspaces/current/delete`` body."""

    confirm_slug: str
    legal_basis: str


def parse_delete_request(body: Mapping[str, Any]) -> DeleteRequest:
    """``{confirm_slug, legal_basis}`` validated (400 otherwise, checked before the workspace is resolved)."""
    reject_unknown_fields(body, ('confirm_slug', 'legal_basis'))
    slug = body.get('confirm_slug')
    if not isinstance(slug, str) or not slug:
        raise ValidationError("confirm_slug is required: type the workspace's slug")
    try:
        basis = required_legal_basis(body.get('legal_basis'))
    except ValueError as error:
        raise ValidationError(str(error)) from error
    return DeleteRequest(confirm_slug=slug, legal_basis=basis)


def holder(ws: str) -> str:
    """The id the delete holds the workspace's export and erasure locks under."""
    return f'{DELETE_HOLDER_PREFIX}{ws}'


def job_key(ws: str) -> dict[str, str]:
    """The key of a workspace's delete job row; ValueError for an id that is not a workspace id."""
    if not is_workspace_id(ws):
        raise ValueError('not a workspace id')
    return {'pk': JOB_PARTITION, 'sk': ws}


def stored_scope(row: Mapping[str, Any]) -> WorkspaceScope:
    """The workspace a stored job row names (its ``workspace_id``, which the route wrote from a resolved membership),
    checked against the row's key: ValueError for a row that names another workspace than its key."""
    scope = scope_from_message(row)
    if row.get('sk') != scope.ws:
        raise ValueError('a delete job row names another workspace than its key')
    return scope


def _read_job(workspaces: Any, ws: str) -> dict[str, Any] | None:
    return consistent_item(workspaces, job_key(ws))


# ── What a reader sees ─────────────────────────────────────────────────────────────────────────────────────────

_VIEW_FIELDS: Final = ('phase', 'requested_at', 'deleting_at', 'fence_at', 'started_at', 'progress_at',
                       'completed_at', 'cancelled_at', 'counts', 'error', 'counters_rebuild')
#: The metric a cancel adds: the workspace's counters wait for the operator's rebuild (``COUNTERS_REBUILD``).
COUNTERS_REBUILD_METRIC: Final = 'WorkspaceCountersRebuildRequired'
#: A job that has not moved for this long is stalled (its invocation died, or its hand-over was dropped).
STALLED: Final = 'The delete stopped before it finished. A platform admin can resume it.'


def job_view(row: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    """The delete as the API shows it: ``{job_id, workspace_id, status, phase, requested_at, …}`` (the job's id is its
    workspace's: one delete per workspace), ``failed`` for one that stopped moving; never the requester's sub or the
    checkpoint."""
    view: dict[str, Any] = {'job_id': row.get('sk'), 'workspace_id': row.get('sk'), 'status': row.get('status')}
    view.update({field: row[field] for field in _VIEW_FIELDS if row.get(field) is not None})
    if progress_stalled(row, now, _UNFINISHED, 'requested_at'):
        view.update(status=FAILED, error=STALLED)
    return plain(view)


# ── The request ────────────────────────────────────────────────────────────────────────────────────────────────

#: The 409s of a held lock, by its partition's kind.
_HELD: Final = {
    'export': 'An export of this workspace is running: wait for it to finish, then delete the workspace',
    'erasure': 'An erasure is running in this workspace: delete the workspace when it ends',
}


def _take(view: WorkspaceTable, partition: str, kind: str, ws: str, now: datetime) -> bool:
    """Take the lock of ``partition`` for the delete: True when this call took it, False when the delete already
    held it (a repeat); ``DeleteBlocked`` when an export or an erasure does."""
    try:
        acquire_lock(view, partition, holder(ws), now, DeleteBlocked(_HELD[kind]))
    except DeleteBlocked:
        current = lock_holder(view, partition)
        if current == holder(ws):
            return False
        # An erasure that reached the workspace holds its export lock too (shared/export_jobs.py hold_for_erasure).
        if current is not None and current.startswith(ERASURE_HOLDER_PREFIX):
            raise DeleteBlocked(_HELD['erasure']) from None
        raise
    return True


def _release(view: WorkspaceTable, partition: str, ws: str, now: datetime) -> None:
    release_quietly(lambda: release_lock(view, partition, holder(ws), now), 'workspace delete')


def _put(table: Any, item: Mapping[str, Any], condition: str = 'attribute_not_exists(pk)',
         values: Mapping[str, Any] | None = None) -> dict[str, Any]:
    put: dict[str, Any] = {'TableName': table.name, 'Item': dict(item), 'ConditionExpression': condition}
    if values:
        put['ExpressionAttributeValues'] = dict(values)
    return {'Put': put}


def _status_update(table: Any, key: Mapping[str, str], to: str, condition: str, values: Mapping[str, Any],
                   deleting_at: str | None) -> dict[str, Any]:
    """An Update entry moving a control row's status (``META``, the listing row), ``deleting_at`` set or removed."""
    expression = 'SET #status = :to, deleting_at = :at' if deleting_at else 'SET #status = :to REMOVE deleting_at'
    return {'Update': {'TableName': table.name, 'Key': dict(key), 'UpdateExpression': expression,
                       'ConditionExpression': condition, 'ExpressionAttributeNames': {'#status': 'status'},
                       'ExpressionAttributeValues': {':to': to, **({':at': deleting_at} if deleting_at else {}),
                                                     **values}}}


def _audit_rows(table: Any, ws: str, workspace_kind: str, platform_kind: str, fields: Mapping[str, Any],
                at: str) -> list[dict[str, Any]]:
    """The two audit puts of a request or a cancel: the workspace's own trail and the platform's."""
    return [_put(table, {'pk': audit_key(ws), 'sk': audit_sort_key(at), 'kind': workspace_kind, 'at': at, **fields}),
            _put(table, {'pk': AUDIT_PARTITION, 'sk': audit_sort_key(at), 'kind': platform_kind, 'at': at,
                         'workspace_id': ws, **fields})]


def request_delete(workspaces: Any, jobs: WorkspaceTable, context: WorkspaceContext, actor: str,
                   request: DeleteRequest, invoke: Callable[[dict[str, Any]], Any], now: datetime) -> dict[str, Any]:
    """Begin the hard delete of the resolved workspace (the module docstring); the job as ``job_view`` shows it.

    ``jobs`` is the workspace's view of voc-aggregates (its export and erasure locks). 400 for a slug that is not
    the workspace's, ``DeleteBlocked`` while an export or an erasure runs, a ``ConflictError`` when the workspace
    changed meanwhile."""
    if request.confirm_slug != context.slug or not context.slug:
        raise ValidationError(SLUG_MISMATCH)
    ws = context.ws
    taken: list[str] = []
    for partition, kind in ((export_job_pk(jobs.scope), 'export'), (erasure_job_pk(jobs.scope), 'erasure')):
        try:
            if _take(jobs, partition, kind, ws, now):
                taken.append(partition)
        except DeleteBlocked:
            for held in taken:
                _release(jobs, held, ws, now)
            raise
    at = now.isoformat()
    # A cancelled delete's row is replaced: its counters' rebuild marker carries over until the operator clears it.
    previous = _read_job(workspaces, ws) or {}
    carried = ({'counters_rebuild': previous['counters_rebuild']}
               if previous.get('status') == CANCELLED and previous.get('counters_rebuild') else {})
    row = workspace_payload({
        # progress_at from the start: a start never claimed (throttled past the event age) reads stalled an hour
        # later, so a platform admin can resume it.
        **job_key(ws), 'status': WAITING, 'phase': PHASE_FENCE, 'requested_at': at, 'deleting_at': at,
        'progress_at': at,
        'fence_at': (now + FENCE).isoformat(), 'requested_by_sub': actor, 'platform_admin': context.platform_admin,
        'legal_basis': request.legal_basis, 'name': context.name, 'slug': context.slug,
        'listing_sk': listing_sort_key(context.name, ws), 'counts': {}, 'resumes': 0, **carried}, context)
    fields = {'actor': actor, 'platform_admin': context.platform_admin, 'legal_basis': request.legal_basis,
              'slug': context.slug, 'name': context.name}
    items = [
        _status_update(workspaces, {'pk': f'WS#{ws}', 'sk': 'META'}, DELETING, '#status = :active',
                       {':active': ACTIVE}, at),
        _status_update(workspaces, {'pk': LISTING_PK, 'sk': row['listing_sk']}, DELETING, 'workspace_id = :ws',
                       {':ws': ws}, at),
        _put(workspaces, row, 'attribute_not_exists(pk) OR #status = :cancelled', {':cancelled': CANCELLED}),
        *_audit_rows(workspaces, ws, WORKSPACE_DELETE_REQUESTED, REQUESTED, fields, at),
    ]
    items[2]['Put']['ExpressionAttributeNames'] = {'#status': 'status'}
    try:
        workspaces.meta.client.transact_write_items(TransactItems=items)
    except ClientError as error:
        existing = _read_job(workspaces, ws)
        if existing is not None and existing.get('status') != CANCELLED:
            # A repeat of a request that already began this delete: the same job, nothing new written.
            return job_view(existing, now)
        for held in taken:
            _release(jobs, held, ws, now)
        if error.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
            raise ConflictError(CHANGED_MEANWHILE) from error
        raise
    logger.info('Workspace delete requested', extra={'workspace_id': ws})
    try:
        invoke(workspace_payload({}, context))
    except (ClientError, BotoCoreError):
        _fail_unstarted(workspaces, ws)
        raise
    return job_view(row, now)


def _fail_unstarted(workspaces: Any, ws: str) -> None:
    """A job the worker never received: its row ends ``failed`` (still in the fence, so a platform admin may cancel or
    resume it), best effort, so the invoke's error is the one reported."""
    try:
        finish_job(workspaces, ws, None, FAILED, {'error': START_FAILED})
    except (ClientError, BotoCoreError) as exc:
        logger.warning('Could not mark the unstarted delete failed', extra={'error_type': type(exc).__name__})


# ── The job's row (lambda/jobs/workspace_delete/handler.py) ────────────────────────────────────────────────────

def _update(workspaces: Any, ws: str, fields: Mapping[str, Any], condition: str, names: Mapping[str, str],
            values: Mapping[str, Any], *, returning: bool = False) -> dict[str, Any] | None:
    """SET ``fields`` on the job row when ``condition`` holds (every name aliased: ``status`` and ``error`` are
    reserved words): the row as it is now (``returning``) or ``{}``, or None when the condition failed."""
    clauses, field_names, field_values = set_clause(fields)
    try:
        response = workspaces.update_item(
            Key=job_key(ws), UpdateExpression=f'SET {clauses}', ConditionExpression=condition,
            ExpressionAttributeNames={**field_names, **names}, ExpressionAttributeValues={**field_values, **values},
            **({'ReturnValues': 'ALL_NEW'} if returning else {}))
    except ClientError as error:
        if is_conditional_check_failure(error):
            return None
        raise
    attributes = response.get('Attributes') if returning else {}
    return dict(attributes) if isinstance(attributes, Mapping) else {}


def claim_generation(workspaces: Any, ws: str, generation: int, now: datetime) -> dict[str, Any] | None:
    """Claim invocation ``generation``: the row (``waiting`` or ``running`` at that generation now), or None when it
    is missing, finished, at another generation, or stale (the module docstring)."""
    if generation == 0:
        # Fresh since the request, or since a resume of a job whose start was never received.
        condition = ('attribute_exists(pk) AND #status = :waiting AND attribute_not_exists(#generation) '
                     'AND (requested_at > :fresh OR progress_at > :fresh)')
        values: dict[str, Any] = {':waiting': WAITING}
    else:
        condition = ('attribute_exists(pk) AND #status IN (:waiting, :running) AND #generation = :previous '
                     'AND progress_at > :fresh')
        values = {':waiting': WAITING, ':running': RUNNING, ':previous': generation - 1}
    return _update(workspaces, ws, {'generation': generation, 'progress_at': now.isoformat()}, condition,
                   {'#status': 'status', '#generation': 'generation'},
                   {**values, ':fresh': (now - STALE_AFTER).isoformat()}, returning=True)


def begin_sweeps(workspaces: Any, ws: str, generation: int, first_phase: str, now: datetime) -> bool:
    """End the fence: the row ``waiting`` → ``running`` in ``first_phase``, only while it is waiting at this
    generation in the fence (a cancel moves the same row, so of the two one wins); whether it moved."""
    return _update(workspaces, ws, {'status': RUNNING, 'phase': first_phase, 'started_at': now.isoformat(),
                                    'progress_at': now.isoformat()},
                   '#status = :waiting AND #generation = :generation AND #phase = :fence',
                   {'#status': 'status', '#generation': 'generation', '#phase': 'phase'},
                   {':waiting': WAITING, ':generation': generation, ':fence': PHASE_FENCE}) is not None


def record_progress(workspaces: Any, ws: str, generation: int, fields: Mapping[str, Any]) -> bool:
    """Write ``fields`` on the job while it is unfinished at ``generation``; whether it was written. A checkpoint in
    the fence needs the row ``waiting`` in the fence; any other needs it ``running`` (past the fence, which only
    ``begin_sweeps`` ends), so no run records a sweep's progress on a row a cancel can still take."""
    names = {'#status': 'status', '#generation': 'generation'}
    if fields.get('phase') == PHASE_FENCE:
        condition, values = '#status = :waiting AND #phase = :fence', {':waiting': WAITING, ':fence': PHASE_FENCE}
        names['#phase'] = 'phase'
    else:
        condition, values = '#status = :running', {':running': RUNNING}
    return _update(workspaces, ws, fields, f'{condition} AND #generation = :generation', names,
                   {**values, ':generation': generation}) is not None


def finish_job(workspaces: Any, ws: str, generation: int | None, status: str, fields: Mapping[str, Any]) -> bool:
    """Record the job's outcome while it is unfinished (at ``generation``, when one is given); whether it was
    written."""
    condition = 'attribute_exists(pk) AND #status IN (:waiting, :running)'
    names = {'#status': 'status'}
    values: dict[str, Any] = {':waiting': WAITING, ':running': RUNNING}
    if generation is not None:
        condition += ' AND #generation = :generation'
        names['#generation'] = 'generation'
        values[':generation'] = generation
    return _update(workspaces, ws, {'status': status, **fields}, condition, names, values) is not None


def audit_completed(workspaces: Any, row: Mapping[str, Any], counts: Mapping[str, Any], kept: Mapping[str, str],
                    at: str) -> None:
    """The platform's ``completed`` row: the workspace's id, name and slug, who asked, the basis, the counts and
    what is kept or left to expire; never a row's content. Put once (a retried put of the same row passes)."""
    put_new_audit_row(workspaces, {
        'pk': AUDIT_PARTITION, 'sk': f'{row.get("requested_at")}#completed#{row.get("sk")}', 'kind': COMPLETED,
        'at': at, 'workspace_id': row.get('sk'), 'name': row.get('name'), 'slug': row.get('slug'),
        'actor': row.get('requested_by_sub'), 'platform_admin': row.get('platform_admin'),
        'legal_basis': row.get('legal_basis'), 'requested_at': row.get('requested_at'),
        'counts': dict(counts), 'kept': dict(kept)})


# ── The platform routes ────────────────────────────────────────────────────────────────────────────────────────

def _platform_job(workspaces: Any, ws: object) -> dict[str, Any]:
    """The stored job row of the workspace a platform route names, or the one 404 (also for an id that is not one)."""
    if not is_workspace_id(ws):
        raise NotFoundError(NO_DELETE)
    row = _read_job(workspaces, str(ws))
    if row is None:
        raise NotFoundError(NO_DELETE)
    return row


def cancel_delete(workspaces: Any, aggregates: Callable[[WorkspaceScope], WorkspaceTable], ws: object, actor: str,
                  now: datetime) -> dict[str, Any]:
    """Cancel a delete still in its fence (the module docstring): the row ``cancelled``, ``META`` and the listing row
    ``active`` again, both audit rows, in one transaction; then both locks freed. ``aggregates`` makes the workspace's
    view of voc-aggregates (its locks). 409 once the fence is over or the delete has begun; a repeat answers the
    cancelled job."""
    row = _platform_job(workspaces, ws)
    scope = stored_scope(row)
    if row.get('status') == CANCELLED:
        return job_view(row, now)
    at = now.isoformat()
    fields = {'actor': actor, 'platform_admin': True, 'slug': row.get('slug'), 'name': row.get('name'),
              'dropped_messages': DROPPED_NOT_COUNTED, 'counters_rebuild': COUNTERS_REBUILD.format(ws=scope.ws),
              'deleting_at': row.get('deleting_at')}
    job = {'Update': {
        'TableName': workspaces.name, 'Key': job_key(scope.ws),
        # Who cancelled is the audit rows' (below); the row says when, and what the counters need.
        'UpdateExpression': 'SET #status = :cancelled, cancelled_at = :at, counters_rebuild = :rebuild',
        'ConditionExpression': '#status IN (:waiting, :failed) AND #phase = :fence AND fence_at > :at',
        'ExpressionAttributeNames': {'#status': 'status', '#phase': 'phase'},
        'ExpressionAttributeValues': {':cancelled': CANCELLED, ':at': at, ':rebuild': fields['counters_rebuild'],
                                      ':waiting': WAITING, ':failed': FAILED, ':fence': PHASE_FENCE}}}
    items = [
        job,
        _status_update(workspaces, {'pk': f'WS#{scope.ws}', 'sk': 'META'}, ACTIVE, '#status = :deleting',
                       {':deleting': DELETING}, None),
        _status_update(workspaces, {'pk': LISTING_PK, 'sk': str(row.get('listing_sk'))}, ACTIVE,
                       'workspace_id = :ws', {':ws': scope.ws}, None),
        *_audit_rows(workspaces, scope.ws, WORKSPACE_DELETE_CANCELLED, CANCELLED_KIND, fields, at),
    ]
    try:
        workspaces.meta.client.transact_write_items(TransactItems=items)
    except ClientError as error:
        if error.response.get('Error', {}).get('Code') != 'TransactionCanceledException':
            raise
        now_row = _read_job(workspaces, scope.ws) or {}
        if now_row.get('status') == CANCELLED:
            return job_view(now_row, now)
        raise ConflictError(TOO_LATE_TO_CANCEL) from error
    view = aggregates(scope)
    for partition in (export_job_pk(scope), erasure_job_pk(scope)):
        _release(view, partition, scope.ws, now)
    metrics.add_metric(name=COUNTERS_REBUILD_METRIC, unit='Count', value=1)
    logger.info('Workspace delete cancelled; its counters need a rebuild',
                extra={'workspace_id': scope.ws, 'counters_rebuild': fields['counters_rebuild']})
    return job_view(_read_job(workspaces, scope.ws) or row, now)


def resume_delete(workspaces: Any, ws: object, actor: str, invoke: Callable[[dict[str, Any]], Any],
                  now: datetime) -> dict[str, Any]:
    """Invoke a stopped delete again from its checkpoint (the module docstring): 409 for one that is still moving or
    finished. The resume is recorded on the row (``resumes``) and in a ``resumed`` platform audit row first."""
    row = _platform_job(workspaces, ws)
    scope = stored_scope(row)
    # A finished job, or one still moving, first: its answer is NOT_RESUMABLE whatever its resume count.
    stopped = row.get('status') == FAILED or progress_stalled(row, now, _UNFINISHED, 'requested_at')
    if not stopped:
        raise ConflictError(NOT_RESUMABLE)
    if int(row.get('resumes') or 0) >= MAX_RESUMES:
        raise ConflictError(TOO_MANY_RESUMES)
    status = WAITING if row.get('phase') == PHASE_FENCE else RUNNING
    resumed = _update(
        workspaces, scope.ws, {'status': status, 'progress_at': now.isoformat(),
                               'resumes': int(row.get('resumes') or 0) + 1},
        # Stopped: failed, or unfinished and unmoved for STALE_AFTER (a row whose start was never claimed has no
        # progress_at if it was written before the request wrote one: its requested_at says how old it is).
        '(#status = :failed OR (#status IN (:waiting, :running) AND (progress_at < :stale OR '
        '(attribute_not_exists(progress_at) AND requested_at < :stale)))) '
        'AND (attribute_not_exists(resumes) OR resumes < :max)', {'#status': 'status'},
        {':failed': FAILED, ':waiting': WAITING, ':running': RUNNING, ':stale': (now - STALE_AFTER).isoformat(),
         ':max': MAX_RESUMES},
        returning=True)
    if resumed is None:
        raise ConflictError(NOT_RESUMABLE)
    at = now.isoformat()
    put_new_audit_row(workspaces, {'pk': AUDIT_PARTITION, 'sk': audit_sort_key(at), 'kind': RESUMED, 'at': at,
                                   'workspace_id': scope.ws, 'actor': actor, 'platform_admin': True,
                                   'phase': resumed.get('phase')})
    generation = resumed.get('generation')
    event: dict[str, Any] = {WORKSPACE_FIELD: scope.ws}
    if generation is not None:
        # The next generation from the last one claimed (a job that never claimed one starts at 0 again). The
        # generation only: the job reads where it is from the row's checkpoint, never from its event.
        event['run'] = {'generation': int(generation) + 1}
    invoke(event)
    logger.info('Workspace delete resumed', extra={'workspace_id': scope.ws})
    return job_view(resumed, now)
