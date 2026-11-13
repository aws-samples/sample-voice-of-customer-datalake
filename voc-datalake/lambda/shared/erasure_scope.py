"""Which data an erasure job reaches: the deployment's, or ONE workspace's (TENETS.md D5; docs/source-policies.md,
"Workspace items"; docs/multi-workspace.md).

The erasure routes (``POST`` / ``GET /settings/erasure``, lambda/api/settings_handler.py) serve both paths:

* without ``X-Workspace-Id``: the deployment's erasure, for the deployment's ``admins`` (shared/api.py
  ``require_admin``), exactly as before. Its job row (``JOB#erasure``) names no workspace, so an erasure by email
  reaches every workspace's copies too and an erasure by author, source id or CSV row the deployment's items only
  (shared/retention.py ``reaches_workspaces``); its job list is that partition's;
* with it: the workspace's erasure, for the caller's admin role there (shared/workspace.py
  ``require_workspace_admin``: a member admin; the deployment's ``admins`` grants nothing inside a workspace),
  resolved from the table, never the 30 s cache. A platform admin is never elevated here (``no_platform_admin_entry``):
  they act with their own membership's role, or get the one 404, so these routes write no entry audit row and run no
  live check (the settings role reads the membership through the stack's one workspace-resolution policy,
  lib/utils/workspace-resolution-grants.ts, with the resolver's projections, shared/workspace.py). A platform admin who must
  erase in a workspace makes themselves a member admin there first (the platform console, audited). Its job row
  lives in the workspace's own partition (``WS#{ws}#JOB#erasure``, shared/erasure_jobs.py, written through the
  workspace layer) and names the workspace (``scoped_job_row``); one erasure of a workspace runs at a time (its lock,
  409 otherwise); voc-retention erases that workspace's items only (``WS#{ws}#…``, their Silver versions and raw
  objects under ``ws/{ws}/``, each tombstoned first) by author, source id, CSV row or email
  (``WORKSPACE_ERASE_FIELDS``), and never the deployment's nor another workspace's; its job list is its own
  partition's. A whole-source erasure is refused there (``refuse_field_in_workspace``): the sources it may name, its
  lock and its sweep of ``raw/{source}/`` are the deployment's.

The workspace on a job row and on the worker's invoke event comes only from the request's resolved membership,
through shared/workspace_routing.py ``workspace_payload`` (it drops any ``workspace_id`` the row or event carried and
refuses anything but a ``WorkspaceContext``), never from the request body (lambda/shared/test/test_ws_raw_access.py
pins that no request-facing module writes the field itself).
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.api import require_admin
from shared.erasure_jobs import (
    WorkspaceErasureRunning,
    acquire_workspace_lock,
    job_key,
    job_partition,
    release_workspace_lock,
)
from shared.exceptions import AuthorizationError, ConflictError, ValidationError
from shared.ingest_tables import table_view
from shared.logging import logger
from shared.project_gate import caller_from_event
from shared.retention import ERASURE_JOB_PREFIX, SOURCE_FIELD
from shared.workspace import WorkspaceContext, require_workspace_admin
from shared.workspace_request import RequestWorkspace
from shared.workspace_routing import workspace_payload
from shared.ws_repo import WorkspaceScope, scope_of

__all__ = [
    'fail_unstarted_job',
    'job_event',
    'listed_jobs',
    'no_platform_admin_entry',
    'put_job_row',
    'refuse_field_in_workspace',
    'require_erasure_admin',
    'scoped_job_row',
]

#: The 400 of a whole-source erasure asked for in a workspace.
WHOLE_SOURCE_NOT_IN_WORKSPACES: Final = (
    "An erasure in a workspace is by author, source_id, csv_row_id or email: a whole-source erasure is the "
    "deployment's. Send it without X-Workspace-Id as a deployment admin.")
#: The 409 of a second erasure started in a workspace while one is live there.
WORKSPACE_ERASURE_RUNNING: Final = 'An erasure is already running in this workspace; wait for it to finish'


def no_platform_admin_entry(_event: dict) -> bool:
    """The erasure routes' live platform-admin check (``RequestWorkspace``'s ``confirm_platform_admin``): never, so a
    platform admin enters with their own membership's role or gets the one 404, and nothing is written or asked of
    Cognito (see the module docstring)."""
    return False


def require_erasure_admin(workspace: RequestWorkspace, event: dict, *, write: bool = False) -> WorkspaceContext | None:
    """The erasure routes' gate on both paths (403 otherwise); the workspace the request acts in, or None.

    Resolved first, afresh from the table (``fresh``: a member demoted a moment ago cannot erase or read the jobs):
    400 for an empty header, the one 404 for a malformed id, an unknown or ``deleting`` workspace and a non-member.
    Without the header the deployment's ``admins`` (``require_admin``), as before; with it the caller's admin role in
    the workspace (``require_workspace_admin``: a member admin; ``workspace`` is built with
    ``no_platform_admin_entry``). A start (``write``) in a workspace is the member admin's own act: a delegated
    caller (an MCP token, an agent or a plan step acting for the person) gets 403, as for the workspace's admin
    settings (shared/request_workspace.py ``require_settings_admin``); an erasure cannot be undone.
    """
    context = workspace.context(event, fresh=True)
    if context is None:
        require_admin(event)
    else:
        require_workspace_admin(context)
        if write and caller_from_event(event).delegated:
            raise AuthorizationError('An erasure in a workspace cannot be started by a delegated caller')
    return context


def _scope(context: WorkspaceContext | None) -> WorkspaceScope | None:
    return scope_of(context) if context is not None else None


def refuse_field_in_workspace(field: object, context: WorkspaceContext | None) -> None:
    """400 for a whole-source erasure asked for in a workspace, checked before the deployment's source list or lock is
    read. Any other field, an unknown or missing one included, goes on to the deployment path's own checks (the same
    "field must be one of" answer). Deployment-wide nothing is refused here."""
    if context is not None and field == SOURCE_FIELD:
        raise ValidationError(WHOLE_SOURCE_NOT_IN_WORKSPACES)


def scoped_job_row(row: Mapping[str, Any], context: WorkspaceContext | None) -> dict[str, Any]:
    """The erasure job row to store: deployment-wide (``context`` None) in ``JOB#erasure`` without any
    ``workspace_id``; in a workspace in its own partition with the resolved workspace set after every other field
    (``workspace_payload``: never a value the row carried). A whole-source row never names a workspace."""
    if context is not None and row.get('field') == SOURCE_FIELD:
        raise ValidationError(WHOLE_SOURCE_NOT_IN_WORKSPACES)
    return workspace_payload({**row, 'pk': job_partition(_scope(context))}, context)


def put_job_row(table: Any, row: Mapping[str, Any], context: WorkspaceContext | None, now: datetime) -> None:
    """Store a new job row (conditional on its ``sk``). In a workspace, first take its one-live-erasure lock (409
    while another erasure of the workspace is live) and write through the workspace layer; a failed put frees the
    lock again and re-raises."""
    scope = _scope(context)
    job_id = str(row['sk'])
    if scope is not None:
        try:
            acquire_workspace_lock(table, scope, job_id, now)
        except WorkspaceErasureRunning as exc:
            raise ConflictError(WORKSPACE_ERASURE_RUNNING) from exc
    try:
        table_view(scope, table).put_item(row, ConditionExpression='attribute_not_exists(sk)')
    except (ClientError, BotoCoreError):
        if scope is not None:
            _release_on_error(table, scope, job_id, now)
        raise


def job_event(job_id: str, value: str, context: WorkspaceContext | None) -> dict[str, Any]:
    """The worker's invoke event: the value travels here only; in a workspace the resolved workspace too, so the worker
    reads the row in that workspace's partition (``workspace_payload``)."""
    return workspace_payload({'mode': 'erase', 'job_id': job_id, 'value': value}, context)


def fail_unstarted_job(table: Any, job: Mapping[str, Any], context: WorkspaceContext | None, now: datetime) -> None:
    """Mark a job the worker never received failed, and free its workspace's lock. Best effort on an error path: an
    update that fails is logged (its type only), the lock is freed either way, and the caller still raises its own
    invoke error, which is the one to report."""
    scope = _scope(context)
    job_id = str(job['job_id'])
    try:
        table_view(scope, table).update_item(
            job_key(job_id, scope),
            UpdateExpression='SET #s = :failed, finished_at = :now, #e = :error',
            ExpressionAttributeNames={'#s': 'status', '#e': 'error'},
            ExpressionAttributeValues={':failed': 'failed', ':now': now.isoformat(),
                                       ':error': 'Could not start the erasure worker'},
        )
    except (ClientError, BotoCoreError) as exc:
        logger.warning('Could not mark the unstarted erasure job failed', extra={'error_type': type(exc).__name__})
    finally:
        if scope is not None:
            _release_on_error(table, scope, job_id, now)


def _release_on_error(table: Any, scope: WorkspaceScope, job_id: str, now: datetime) -> None:
    """Free the workspace's lock on an error path, best effort: a failed release is logged (its type only) so the
    caller's own error is the one reported; an unreleased lock goes stale after an hour anyway."""
    try:
        release_workspace_lock(table, scope, job_id, now)
    except (ClientError, BotoCoreError) as exc:
        logger.warning('Could not release the workspace erasure lock', extra={'error_type': type(exc).__name__})


def listed_jobs(table: Any, context: WorkspaceContext | None, limit: int) -> list[dict[str, Any]]:
    """The newest ``limit`` erasure jobs of the request's scope, newest first: ONE Query of its own partition with
    ``Limit`` (the deployment's ``JOB#erasure``, or the workspace's through the workspace layer), so no scope's volume
    reaches another's list. The lock rows' ``sk`` does not start ``er_``."""
    scope = _scope(context)
    response = table_view(scope, table).query(
        'pk', job_partition(scope), sort_condition='begins_with(sk, :job)',
        ExpressionAttributeValues={':job': ERASURE_JOB_PREFIX}, ScanIndexForward=False, Limit=limit)
    return list(response.get('Items', []))
