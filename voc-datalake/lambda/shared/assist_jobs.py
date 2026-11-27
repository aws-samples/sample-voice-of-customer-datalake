"""Assist jobs: a model call started by a request and finished in the background.

API Gateway gives a REST request 29 seconds. A model answer can take longer than
that, so no route answers with model output any more. Instead the route:

1. writes a ``pending`` job row in voc-jobs (``start``), and
2. invokes its domain's **assist worker** asynchronously — the same code and IAM
   role as the API Lambda, deployed a second time with a 15-minute timeout
   (``ASSIST_WORKER_FUNCTION``) — then answers **202** ``{success, job_id, status}``;
3. the worker's ``lambda_handler`` sees ``action == 'assist_job'`` and calls ``run``,
   which claims the row (``pending → running``, once), runs the registered work
   function and records ``completed`` + ``result`` or ``failed`` + ``error``;
4. the client polls ``GET …/jobs/{job_id}`` and reads ``result``, which is exactly
   the body the synchronous route used to return;
5. when the job ends, the worker sends the starter a ``{type: 'job', job_id, status}``
   notice on ``/jobs/<starter sub>`` (``shared/realtime.py``, docs/realtime.md), and a
   subscribed browser polls once at once instead of waiting for its next (slower) poll.

Where a row lives (``pk``):

- ``PROJECT#{project_id}`` for a project's assists, so the project's existing
  ``GET /projects/{id}/jobs/{job_id}`` serves them to anyone who may view the
  project. ``GET /projects/{id}/jobs`` (the Background jobs panel) leaves out
  ``assist_*`` rows: they are request plumbing, not work a user started.
- ``ASSIST#{caller_sub}`` for assists outside a project (categories, URL
  analysis), so a caller can only ever read their own (``owner_pk``).

In a workspace (since 7.29.00, slice 3c of docs/multi-workspace.md's project plan; no route passes one yet) the
request side (``start``, ``start_owned``, ``get``, ``owner_pk``) takes the request's resolved membership
(``workspace``, a ``WorkspaceContext``): the row's partitions are that workspace's (``WS#{ws}#PROJECT#{id}``,
``WS#{ws}#ASSIST#{sub}``, its index partition ``WS#{ws}#STATUS#{status}``: shared/project_keys.py ``job_status_pk``),
every call through shared/ws_repo.py ``ws_table``, and the worker's event names it (shared/workspace_routing.py
``workspace_payload``). ``run`` reads it back (shared/ws_repo.py ``event_scope``) and keys every row call by it, but the
work is not per workspace yet (``ASSIST_WORK_STORE``): it records the job failed and runs nothing. Without one
(``workspace=None``, spelled out at every call since 7.102.00, 3h-S1b: no default), every request and event is the one
sent before.

The work function receives the job's ``config`` and returns a JSON-able dict.
Raising an ``ApiError`` with a 4xx status records its message as the job's
``error`` (the same text the synchronous route answered); anything else is
logged and recorded as ``failed`` with the registered generic message, and is
NOT re-raised: async retries are off for assist workers and a retry could not
change the answer.
"""
from __future__ import annotations

import json
import os
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Final

from aws_lambda_powertools.event_handler import Response, content_types
from botocore.exceptions import ClientError

from shared import realtime
from shared.aws import invoke_lambda_async, is_conditional_check_failure
from shared.exceptions import ApiError, NotFoundError, ServiceError
from shared.ingest_tables import table_view
from shared.logging import logger
from shared.model_profile import payload_fields
from shared.project_keys import ASSIST_JOB_PREFIX, job_status_pk, require_deployment
from shared.scoped_keys import scoped_pk
from shared.tables import get_jobs_table
from shared.workspace_config import get_scoped_item
from shared.workspace_routing import workspace_payload
from shared.ws_repo import (
    OutOfScopeError,
    WorkspaceScope,
    event_scope,
    is_workspace_key,
    message_scope,
    optional_scope,
)

if TYPE_CHECKING:
    from shared.workspace import WorkspaceContext

ASSIST_ACTION: Final = 'assist_job'
JOB_ID_PREFIX: Final = 'job_'
# Long enough for a client to read the outcome after a slow answer; the row is
# plumbing, so a day is plenty.
ASSIST_JOB_TTL: Final = timedelta(days=1)
MAX_ERROR_CHARS: Final = 500
#: The registered work functions (the categories, the URL analysis, a project's assists) read the deployment's
#: settings and projects: not per workspace yet, so a worker event that names a workspace runs none (since 7.29.00).
ASSIST_WORK_STORE: Final = 'Assist work'
#: The start of an assist's partition outside any project (``owner_pk``).
_OWNER_PREFIX: Final = 'ASSIST#'

PENDING: Final = 'pending'
RUNNING: Final = 'running'
COMPLETED: Final = 'completed'
FAILED: Final = 'failed'

# The fields a poll returns (and nothing else: config may hold the caller's input).
VIEW_FIELDS: Final = ('job_id', 'job_type', 'status', 'created_at', 'updated_at', 'completed_at', 'error', 'result')


def _owner_prefix(*, workspace: WorkspaceScope | None) -> str:
    """How a caller's assist partition starts: ``ASSIST#``, ``WS#{ws}#ASSIST#`` in a workspace."""
    return _OWNER_PREFIX if workspace is None else f'{workspace.prefix}{_OWNER_PREFIX}'


def owner_pk(subject: str, *, workspace: WorkspaceContext | None) -> str:
    """The partition of a caller's assists outside any project (``WS#{ws}#ASSIST#{sub}`` in a workspace)."""
    if not subject:
        raise ServiceError('An assist needs a signed-in caller')
    return scoped_pk(optional_scope(workspace), f'{_OWNER_PREFIX}{subject}')


def is_assist_job_type(job_type: object) -> bool:
    return isinstance(job_type, str) and job_type.startswith(ASSIST_JOB_PREFIX)


def is_assist_event(event: object) -> bool:
    """True for the worker's invocation (``lambda_handler`` routes it to ``run``)."""
    return isinstance(event, Mapping) and event.get('action') == ASSIST_ACTION


@dataclass(frozen=True)
class Work:
    """One assist kind: the function that does it and the message shown when it fails unexpectedly.

    ``per_workspace``: the work reads nothing but its job's ``config`` (since 7.55.00: a feedback form's AI draft,
    shared/forms_v2_draft.py), so it also runs for a workspace's job, its Bedrock calls counted to that workspace
    (shared/ws_repo.py ``message_scope``). Every other kind still refuses one (``ASSIST_WORK_STORE``).

    ``in_scope``: the work also writes its outcome in the job's own scope, which it is handed with its config
    (``run(config, scope)``, the scope None for the deployment's job; since 7.63.00: a form report's summary,
    shared/forms_report_routes.py, written to that scope's forms partition only).

    ``forget_config``: the row's ``config`` is removed when the job ends, completed or failed, so what the request
    carried is kept no longer than the work needs it (since 7.63.00: a form report's summary, whose config holds the
    respondents' answers; a job that never ran keeps it until the row's TTL, a day)."""

    run: Callable[..., dict]
    failure_message: str
    per_workspace: bool = False
    in_scope: bool = False
    forget_config: bool = False


def _now() -> datetime:
    return datetime.now(UTC)


def _key(pk: str, job_id: str) -> dict[str, str]:
    return {'pk': pk, 'sk': f'JOB#{job_id}'}


def _table() -> Any:
    table = get_jobs_table()
    if table is None:
        raise ServiceError('Jobs table not configured')
    return table


def view(item: Mapping[str, Any]) -> dict[str, Any]:
    """The public poll answer for one row."""
    return {'success': True, **{field: item.get(field) for field in VIEW_FIELDS}}


def start(pk: str, job_type: str, config: Mapping[str, Any], *, worker_function: str,
          initiated_by: str | None, project_id: str | None = None,
          workspace: WorkspaceContext | None) -> dict[str, Any]:
    """Record a pending assist and hand it to the worker; the route answers this dict with 202.

    The row is written BEFORE the invoke, so the worker always finds it. If the
    invoke itself fails, the row is marked failed and the request answers 500:
    nothing will ever pick it up. ``workspace``: the request's resolved membership, whose partition ``pk`` must be
    (the row is written through its ``ws_table``, and the event names it); None for the deployment.
    """
    if not is_assist_job_type(job_type):
        raise ValueError(f'assist job types start with {ASSIST_JOB_PREFIX!r}: {job_type}')
    if not worker_function:
        raise ServiceError('Assist worker not configured')
    scope = optional_scope(workspace)
    job_id = f'{JOB_ID_PREFIX}{uuid.uuid4().hex[:16]}'
    now = _now()
    item: dict[str, Any] = {
        **_key(pk, job_id), 'gsi1pk': job_status_pk(PENDING, workspace=scope), 'gsi1sk': now.isoformat(),
        'job_id': job_id, 'job_type': job_type, 'status': PENDING, 'progress': 0, 'current_step': 'queued',
        'created_at': now.isoformat(), 'updated_at': now.isoformat(),
        'ttl': int((now + ASSIST_JOB_TTL).timestamp()), 'config': dict(config),
    }
    if project_id is not None:
        item['project_id'] = project_id
    if initiated_by:
        item['initiated_by'] = initiated_by
    table_view(scope, _table()).put_item(item)
    try:
        # The starter's model profile rides the event (the worker's api_handler opens its scope).
        invoke_lambda_async(worker_function, workspace_payload(
            {'action': ASSIST_ACTION, 'pk': pk, 'job_id': job_id, **payload_fields()}, workspace))
    except Exception as exc:
        logger.exception('Assist worker invoke failed', extra={'job_type': job_type})
        _finish(pk, job_id, FAILED, error='The assistant could not be started; try again.', workspace=scope)
        raise ServiceError('The assistant could not be started; try again.') from exc
    return {'success': True, 'job_id': job_id, 'status': PENDING}


def worker_function() -> str:
    """This Lambda's assist twin (``ASSIST_WORKER_FUNCTION``); '' when unconfigured."""
    return os.environ.get('ASSIST_WORKER_FUNCTION', '')


def start_owned(subject: str, job_type: str, config: Mapping[str, Any], *,
                workspace: WorkspaceContext | None) -> dict[str, Any]:
    """Start a global assist only ``subject`` may poll (pk ``ASSIST#{subject}``, the workspace's when given)."""
    return start(owner_pk(subject, workspace=workspace), job_type, config, worker_function=worker_function(),
                 initiated_by=subject, workspace=workspace)


def accepted(started: Mapping[str, Any]) -> Response:
    """The route's **202** answer for a started assist."""
    return Response(status_code=202, content_type=content_types.APPLICATION_JSON, body=json.dumps(started))


def get(pk: str, job_id: str, *, workspace: WorkspaceContext | None) -> dict[str, Any]:
    """The poll answer for ``job_id`` in ``pk`` (a partition of ``workspace`` when given); 404 when missing or not an
    assist."""
    if not job_id.startswith(JOB_ID_PREFIX):
        raise NotFoundError('Job not found')
    scope = optional_scope(workspace)
    item = get_scoped_item(_table(), _key(pk, job_id), scope, ConsistentRead=True)
    if not item or not is_assist_job_type(item.get('job_type')):
        raise NotFoundError('Job not found')
    return view(item)


def _claim(pk: str, job_id: str, *, workspace: WorkspaceScope | None) -> dict[str, Any] | None:
    """Move the row pending → running once; the row (with its config), or None if another delivery has it."""
    now = _now().isoformat()
    try:
        return table_view(workspace, _table()).update_item(
            _key(pk, job_id),
            UpdateExpression='SET #s = :running, gsi1pk = :gsi, updated_at = :now, current_step = :step',
            ConditionExpression='attribute_exists(pk) AND #s = :pending',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':running': RUNNING, ':pending': PENDING,
                                       ':gsi': job_status_pk(RUNNING, workspace=workspace),
                                       ':now': now, ':step': 'running'},
            ReturnValues='ALL_NEW',
        )['Attributes']
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            return None
        raise


def _finish(pk: str, job_id: str, status: str, *, workspace: WorkspaceScope | None, result: dict | None = None,
            error: str | None = None, forget_config: bool = False) -> None:
    now = _now().isoformat()
    names = {'#s': 'status'}
    values: dict[str, Any] = {':status': status, ':gsi': job_status_pk(status, workspace=workspace), ':now': now,
                              ':step': 'complete' if status == COMPLETED else 'error'}
    sets = ['#s = :status', 'gsi1pk = :gsi', 'updated_at = :now', 'completed_at = :now', 'current_step = :step']
    if result is not None:
        names['#r'] = 'result'
        values[':result'] = result
        sets.append('#r = :result')
    if error is not None:
        names['#e'] = 'error'
        values[':error'] = error[:MAX_ERROR_CHARS]
        sets.append('#e = :error')
    update = 'SET ' + ', '.join(sets)
    if forget_config:
        names['#c'] = 'config'
        update += ' REMOVE #c'
    table_view(workspace, _table()).update_item(_key(pk, job_id), UpdateExpression=update,
                                                ExpressionAttributeNames=names, ExpressionAttributeValues=values)


def _starter(pk: str, row: Mapping[str, Any], *, workspace: WorkspaceScope | None) -> object:
    """Who started the job: the sub in the scope's ``ASSIST#{sub}`` pk, else the row's ``initiated_by``."""
    prefix = _owner_prefix(workspace=workspace)
    return pk.removeprefix(prefix) if pk.startswith(prefix) else row.get('initiated_by')


def _notify(pk: str, row: Mapping[str, Any], status: str, *, workspace: WorkspaceScope | None) -> None:
    """Tell the starter's browser the job ended (best effort, never raises; polling stays the fallback)."""
    event: dict[str, Any] = {'type': 'job', 'job_id': row.get('job_id'), 'job_type': row.get('job_type'), 'status': status}
    if isinstance(row.get('project_id'), str):
        event['project_id'] = row['project_id']
    realtime.publish('jobs', _starter(pk, row, workspace=workspace), event)


def _storable(result: object) -> dict:
    """The work's answer as DynamoDB can store it (floats → Decimal via a JSON round trip)."""
    return json.loads(json.dumps(result, default=str), parse_float=Decimal)


def _failure_text(exc: Exception, job_type: object, work: Work) -> str:
    """The job's ``error``: a 4xx refusal's own message, else the kind's generic one (and a traceback in the log)."""
    if isinstance(exc, ApiError) and 400 <= exc.status_code < 500:
        logger.info('Assist ended with a user-facing refusal',
                       extra={'job_type': job_type, 'status_code': exc.status_code})
        return str(exc)
    logger.exception('Assist failed', extra={'job_type': job_type})  # noqa: LOG004 — only called from an except handler, which supplies the traceback
    return work.failure_message


def _refusal(event: Mapping[str, Any], pk: str) -> str | None:
    """Why the event may not run, as an error type, or None: a workspace field that names none (``ValueError``), or a
    ``pk`` that is not a partition of the event's own scope (``OutOfScopeError``): the workspace's
    (``WorkspaceScope.owns``), or for the deployment one that is not a workspace's key."""
    try:
        workspace = event_scope(event)
    except ValueError as exc:
        return type(exc).__name__
    own = workspace.owns(pk) if workspace is not None else not is_workspace_key(pk)
    return None if own else OutOfScopeError.__name__


def _run_work(work: Work, row: Mapping[str, Any], event: Mapping[str, Any], *,
              workspace: WorkspaceScope | None) -> dict:
    """The registered work on the row's config; refused (``NotPerWorkspaceError``) in a workspace unless the kind is
    ``per_workspace``, whose model calls are then counted to the event's workspace."""
    if not work.per_workspace:
        require_deployment(workspace, ASSIST_WORK_STORE)
    else:
        message_scope(event)
    config = dict(row.get('config') or {})
    return work.run(config, workspace) if work.in_scope else work.run(config)


def run(event: Mapping[str, Any], registry: Mapping[str, Work]) -> dict[str, Any]:
    """The worker side: claim, run the registered work, record the outcome. Never raises.

    An event whose ``workspace_id`` names no workspace, or whose ``pk`` is not a partition of its own scope (a
    workspace's key for the deployment, or another scope's), is ignored: nothing read or written, an error logged
    with the refusal's type only."""
    pk, job_id = event.get('pk'), event.get('job_id')
    if not isinstance(pk, str) or not isinstance(job_id, str):
        logger.warning('Malformed assist event')
        return {'status': 'ignored'}
    refusal = _refusal(event, pk)
    if refusal is not None:
        # Its type only: the message may quote the event's fields.
        logger.error('Assist event refused', extra={'error': refusal})
        return {'status': 'ignored'}
    workspace = event_scope(event)
    try:
        row = _claim(pk, job_id, workspace=workspace)
        refused = False
    except OutOfScopeError:
        # The layer's own refusal of the key (never expected once the pk is the scope's): run never raises.
        row, refused = None, True
    if refused:
        logger.error('Assist event refused', extra={'error': OutOfScopeError.__name__})
        return {'status': 'ignored'}
    if row is None:
        logger.info('Assist already taken or gone', extra={'job_id': job_id})
        return {'status': 'skipped'}
    job_type = row.get('job_type')
    work = registry.get(job_type) if isinstance(job_type, str) else None
    if work is None:
        _finish(pk, job_id, FAILED, error='This assistant is not available.', workspace=workspace)
        logger.error('No work registered for assist', extra={'job_type': job_type})
        _notify(pk, row, FAILED, workspace=workspace)
        return {'status': FAILED}
    try:
        result = _run_work(work, row, event, workspace=workspace)
    except Exception as exc:  # noqa: BLE001 - the worker never raises; _failure_text logs the traceback
        _finish(pk, job_id, FAILED, error=_failure_text(exc, job_type, work), workspace=workspace,
                forget_config=work.forget_config)
        _notify(pk, row, FAILED, workspace=workspace)
        return {'status': FAILED}
    _finish(pk, job_id, COMPLETED, result=_storable(result), workspace=workspace, forget_config=work.forget_config)
    logger.info('Assist completed', extra={'job_type': job_type})
    _notify(pk, row, COMPLETED, workspace=workspace)
    return {'status': COMPLETED}
