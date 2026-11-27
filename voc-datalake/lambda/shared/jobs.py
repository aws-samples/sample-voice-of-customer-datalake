"""
Shared job utilities for VoC Lambda functions.
Provides centralized job creation, status management, and job handler decorator.

A job's row is ``JOB#{job_id}`` in its project's partition of voc-jobs, listed on ``gsi1-by-status`` at its status
(shared/project_keys.py ``project_pk``, ``job_status_pk``). Every store here takes a keyword-only ``workspace``
(since 7.29.00, slice 3c of docs/multi-workspace.md's project plan): in one, the row is ``WS#{ws}#PROJECT#{id}`` /
``JOB#{job_id}`` and its index partition ``WS#{ws}#STATUS#{status}``, each call through shared/ws_repo.py ``ws_table``
(shared/ingest_tables.py ``table_view``, shared/workspace_config.py ``get_scoped_item``), which refuses a key or an
index partition outside it; without one (None, spelled out at every call since 7.102.00, 3h-S1b: no default) every
request is the one sent before. ``job_handler``
reads the workspace from the job's event (shared/ws_repo.py ``event_scope``) and hands it to every job-row call, but
the work itself is not per workspace yet (shared/project_keys.py ``PROJECT_JOB_WORK_STORE``): a job event that names
a workspace marks its own row failed and does nothing else. No route passes a workspace yet. Nothing reads
``gsi1-by-status``, so no sweeper or lister has to fan out over the workspaces' status partitions.
"""

import math
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from functools import wraps
from typing import Any

from botocore.exceptions import ClientError

from shared.aws import invoke_lambda_async, is_conditional_check_failure
from shared.exceptions import ApiError, ServiceError
from shared.ingest_tables import table_view
from shared.job_notices import notify_project_job
from shared.logging import logger
from shared.project_keys import PROJECT_JOB_WORK_STORE, job_status_pk, project_pk, require_deployment
from shared.tables import get_jobs_table
from shared.timestamps import now_iso
from shared.workspace_config import get_scoped_item
from shared.ws_repo import WorkspaceScope, event_scope

EXECUTION_LEASE_SKEW_SECONDS = 5
EXECUTION_REQUEUE_BUDGET_RATIO = 0.9
EXECUTION_REQUEUE_MIN_SECONDS = 30
EXECUTION_LEASE_POLL_SECONDS = 1

# The claim: mark the job running under this delivery's lease, clearing any
# previous outcome; allowed from pending/failed, or from running once the
# holder's lease has lapsed (or was never written).
CLAIM_UPDATE_EXPRESSION = (
    'SET #status = :running, progress = :zero, '
    'current_step = :starting, updated_at = :now, '
    'gsi1pk = :running_gsi, execution_lease_until = :lease, '
    'execution_owner = :owner '
    'REMOVE #error, #result, completed_at, error_code'
)
CLAIM_CONDITION_EXPRESSION = (
    'attribute_exists(pk) AND attribute_exists(sk) AND '
    '(#status = :pending OR #status = :failed OR '
    '(#status = :running AND '
    '(attribute_not_exists(execution_lease_until) OR '
    'execution_lease_until <= :now_epoch)))'
)
CLAIM_ATTRIBUTE_NAMES = {'#status': 'status', '#error': 'error', '#result': 'result'}


def _job_key(project_id: str, job_id: str, *, workspace: WorkspaceScope | None) -> dict[str, str]:
    """The job's row: ``JOB#{job_id}`` in the project's partition of voc-jobs (the workspace's when given)."""
    return {'pk': project_pk(project_id, workspace=workspace), 'sk': f'JOB#{job_id}'}


def error_state_scope(event: dict) -> WorkspaceScope | None:
    """The scope a state machine's error state marks its job failed in: the run's (shared/ws_repo.py ``event_scope``),
    or the deployment's when its ``run_scope`` names none. A workspace's job row is only ever written with a scope the
    layer accepts (``create_job``), so a job whose run carries a malformed scope can only have the deployment's row,
    and ``update_job_status`` changes it only if it exists (its condition): the job never stays ``running``, and no
    workspace's row is written on a guess."""
    try:
        return event_scope(event)
    except ValueError:
        named = False
    logger.error('An error state carried a run scope that names no workspace; failing the deployment\'s job row',
                 extra={'named': named})
    return None


def has_time_left(lambda_context: Any, reserve_ms: int) -> bool:
    """More than ``reserve_ms`` of the invocation remain: room for one more slice before handing over."""
    return lambda_context.get_remaining_time_in_millis() > reserve_ms


def _remaining_seconds(lambda_context: Any) -> int:
    remaining_time = getattr(lambda_context, 'get_remaining_time_in_millis', None)
    if not callable(remaining_time):
        raise TypeError('Lambda context must expose its remaining runtime')
    remaining_ms: Any = remaining_time()
    return math.ceil(max(0, int(remaining_ms)) / 1000)


def claim_job_execution(
    project_id: str,
    job_id: str,
    lambda_context: Any,
    *,
    workspace: WorkspaceScope | None,
) -> bool:
    """Claim one direct async delivery until its Lambda deadline (the workspace's job row when given)."""
    jobs_table = get_jobs_table()
    if not jobs_table:
        raise ValueError('JOBS_TABLE environment variable not configured')

    remaining_seconds = _remaining_seconds(lambda_context)
    now = datetime.now(UTC)
    now_epoch = int(now.timestamp())
    lease_until = now_epoch + remaining_seconds + EXECUTION_LEASE_SKEW_SECONDS
    owner = str(getattr(lambda_context, 'aws_request_id', '') or 'unknown')

    try:
        table_view(workspace, jobs_table).update_item(
            _job_key(project_id, job_id, workspace=workspace),
            UpdateExpression=CLAIM_UPDATE_EXPRESSION,
            ConditionExpression=CLAIM_CONDITION_EXPRESSION,
            ExpressionAttributeNames=CLAIM_ATTRIBUTE_NAMES,
            ExpressionAttributeValues={
                ':pending': 'pending',
                ':running': 'running',
                ':failed': 'failed',
                ':zero': 0,
                ':starting': 'starting',
                ':now': now.isoformat(),
                ':now_epoch': now_epoch,
                ':running_gsi': job_status_pk('running', workspace=workspace),
                ':lease': lease_until,
                ':owner': owner,
            },
        )
    except ClientError as error:
        if is_conditional_check_failure(error):
            return False
        raise
    else:
        return True


def recover_job_execution_claim(
    event: dict,
    lambda_context: Any,
    *,
    workspace: WorkspaceScope | None,
) -> bool:
    """Wait for the owner, or self-redeliver before this waiter loses budget.

    The redelivery is ``event`` itself, so it names the workspace it came with (``job_handler`` reads
    ``workspace`` from it)."""
    project_id = event['project_id']
    job_id = event['job_id']
    jobs_table = get_jobs_table()
    if not jobs_table:
        raise ValueError('JOBS_TABLE environment variable not configured')

    initial_remaining = _remaining_seconds(lambda_context)
    minimum_budget = max(
        EXECUTION_REQUEUE_MIN_SECONDS,
        math.ceil(initial_remaining * EXECUTION_REQUEUE_BUDGET_RATIO),
    )
    while True:
        item = get_scoped_item(jobs_table, _job_key(project_id, job_id, workspace=workspace), workspace,
                               ConsistentRead=True)
        if not item:
            raise ServiceError('Job no longer exists')
        if item.get('status') == 'completed':
            return False

        remaining = _remaining_seconds(lambda_context)
        if remaining <= minimum_budget:
            function_name = getattr(lambda_context, 'invoked_function_arn', None)
            if not isinstance(function_name, str) or not function_name:
                function_name = getattr(lambda_context, 'function_name', None)
            if not isinstance(function_name, str) or not function_name:
                raise TypeError('Lambda context must identify its function')
            invoke_lambda_async(function_name, event)
            logger.info(
                f'[JOB] Requeued lease waiter for project={project_id}, job={job_id}'
            )
            return False

        lease_value = item.get('execution_lease_until')
        lease_until = (
            int(lease_value)
            if isinstance(lease_value, (int, Decimal))
            and not isinstance(lease_value, bool)
            else 0
        )
        status = item.get('status')
        if (
            status in {'pending', 'failed'}
            or lease_until <= int(time.time())
        ) and claim_job_execution(project_id, job_id, lambda_context, workspace=workspace):
            return True

        # `remaining` and `minimum_budget` are whole seconds and this line is
        # only reached when remaining > minimum_budget, so the gap is >= 1 s:
        # the poll interval is the constant, never a fraction of the budget.
        time.sleep(EXECUTION_LEASE_POLL_SECONDS)


def create_job(
    project_id: str,
    job_type: str,
    config_key: str,
    config: dict,
    ttl_minutes: int = 30,
    status: str = 'running',
    initiated_by: str | None = None,
    *,
    workspace: WorkspaceScope | None,
) -> tuple[str, str]:
    """Create a job record and return (job_id, now).

    Args:
        project_id: Project ID
        job_type: Type of job (e.g., 'generate_personas', 'research')
        config_key: Key name for the config in the item (e.g., 'filters', 'doc_config')
        config: Configuration dict for the job
        ttl_minutes: TTL in minutes (default 30)
        status: Initial status ('running' or 'pending')
        initiated_by: The Cognito subject of the caller who started the job. An
            async job runs under the Lambda's own role long after the request
            that was gated, so this is the only record of WHO asked for it.
            Omitted (not stored) when the starter is not a signed-in caller.
        workspace: The project's workspace: the row in its partition, listed at its
            ``WS#{ws}#STATUS#…`` (None: the deployment's, as before).

    Returns:
        Tuple of (job_id, created_at timestamp)
    """
    jobs_table = get_jobs_table()
    if not jobs_table:
        raise ValueError("JOBS_TABLE environment variable not configured")

    job_id = f"job_{uuid.uuid4().hex[:16]}"
    now = now_iso()
    ttl = int((datetime.now(UTC) + timedelta(minutes=ttl_minutes)).timestamp())

    item = {
        **_job_key(project_id, job_id, workspace=workspace),
        'gsi1pk': job_status_pk(status, workspace=workspace),
        'gsi1sk': now,
        'job_id': job_id,
        'project_id': project_id,
        'job_type': job_type,
        'status': status,
        'progress': 0,
        'current_step': 'queued' if status == 'pending' else 'starting',
        'created_at': now,
        'updated_at': now,
        'ttl': ttl,
        config_key: config
    }
    if initiated_by:
        item['initiated_by'] = initiated_by
    table_view(workspace, jobs_table).put_item(item)
    return job_id, now


def update_job_status(
    project_id: str,
    job_id: str,
    status: str,
    progress: int,
    current_step: str | None = None,
    error: str | None = None,
    result: dict | None = None,
    *,
    workspace: WorkspaceScope | None,
    error_code: str | None = None,
    unless_finished: bool = False,
):
    """Update job status in DynamoDB.

    Args:
        project_id: Project ID
        job_id: Job ID
        status: New status ('running', 'completed', 'failed')
        progress: Progress percentage (0-100)
        current_step: Current step description (optional)
        error: Error message if failed (optional)
        result: Result dict if completed (optional)
        workspace: The project's workspace (None: the deployment's row, as before)
        error_code: A failed job's reason as a word, with ``error`` (7.104.00: an extract's ``timed_out``, ``refused``,
            ``cut`` or ``unreadable``), so a client offers what fits without reading the English ``error``
        unless_finished: Only while the job is not ``completed`` or ``failed`` (7.104.00: a progress write, which must
            never reopen a job that ended, ``JobContext.update_progress``); refused, it is logged like a job gone
    """
    jobs_table = get_jobs_table()
    if not jobs_table:
        logger.warning("JOBS_TABLE not configured, skipping job status update")
        return

    now = now_iso()

    update_expr = 'SET #status = :status, progress = :progress, updated_at = :now, gsi1pk = :gsi1pk'
    expr_values = {
        ':status': status,
        ':progress': progress,
        ':now': now,
        ':gsi1pk': job_status_pk(status, workspace=workspace)
    }
    expr_names = {'#status': 'status'}

    if current_step:
        update_expr += ', current_step = :step'
        expr_values[':step'] = current_step

    if error:
        update_expr += ', #error = :error, completed_at = :now, #ttl = :ttl'
        expr_values[':error'] = error
        expr_names['#error'] = 'error'
        expr_names['#ttl'] = 'ttl'
        # Extend TTL to 7 days for failed jobs (for debugging)
        expr_values[':ttl'] = int((datetime.now(UTC) + timedelta(days=7)).timestamp())
        if error_code:
            update_expr += ', error_code = :error_code'
            expr_values[':error_code'] = error_code

    if result:
        update_expr += ', #result = :result, completed_at = :now, #ttl = :ttl'
        expr_values[':result'] = result
        expr_names['#result'] = 'result'
        expr_names['#ttl'] = 'ttl'
        # Extend TTL to 7 days for completed jobs
        expr_values[':ttl'] = int((datetime.now(UTC) + timedelta(days=7)).timestamp())

    condition = 'attribute_exists(pk) AND attribute_exists(sk)'
    if unless_finished:
        condition += ' AND NOT #status IN (:completed, :failed)'
        expr_values[':completed'], expr_values[':failed'] = 'completed', 'failed'
    try:
        table_view(workspace, jobs_table).update_item(
            _job_key(project_id, job_id, workspace=workspace),
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_values,
            ExpressionAttributeNames=expr_names,
            ConditionExpression=condition,
        )
    except Exception as e:
        if not is_conditional_check_failure(e):
            logger.error(f"Failed to update job status: {e}", exc_info=True)
            return
        # The row is gone: its project was deleted (the delete removes its jobs)
        # or its TTL passed; or, for a progress write, the job already ended.
        # Nothing to update, and not a fault (5.35.01 e2e: six ERROR lines for
        # one deleted project).
        logger.info(
            f"[JOB] Job {job_id} status not updated to {status}: its row no longer exists "
            f"(project {project_id} deleted, or the job expired)"
            + (", or the job already ended" if unless_finished else "")
        )


class JobContext:
    """Context object passed to job handlers for progress updates (``workspace``: the job's, None the deployment;
    ``lambda_context``: the invocation's, for a job that keeps its own deadline, None in a test or a direct call)."""

    def __init__(self, project_id: str, job_id: str, *, workspace: WorkspaceScope | None,
                 lambda_context: Any = None):
        self.project_id = project_id
        self.job_id = job_id
        self.workspace = workspace
        self.lambda_context = lambda_context

    def remaining_ms(self) -> int | None:
        """The invocation's remaining time in milliseconds, None without a Lambda context."""
        remaining = getattr(self.lambda_context, 'get_remaining_time_in_millis', None)
        value = remaining() if callable(remaining) else None
        return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else None

    def update_progress(self, progress: int, step: str):
        """Update job progress, only while the job has not ended: a late progress write (a heartbeat thread's) never
        reopens a job already ``completed`` or ``failed`` (``unless_finished``).

        Args:
            progress: Progress percentage (0-100)
            step: Current step description
        """
        update_job_status(self.project_id, self.job_id, 'running', progress, step, workspace=self.workspace,
                          unless_finished=True)


def job_handler(error_message: str = 'Job execution failed'):
    """Decorator for async job handlers that standardizes error handling and status updates.

    The decorated function receives a JobContext as its first argument, followed by
    project_id, job_id, and the job config. It should return a result dict that will
    be stored in the job record.

    Args:
        error_message: Error message to use when the job fails

    Workspace (since 7.29.00): the event's ``workspace_id`` (shared/ws_repo.py ``event_scope``; a field that names
    no workspace raises ValueError before any row is touched) keys every job-row call: the claim, the redelivery,
    the progress, the outcome and the notice. The work is not per workspace yet: with a workspace the job fails
    (``NotPerWorkspaceError``, the 5xx path below) before the decorated function runs.

    Failure contract:
        - An ApiError with a 4xx status (ValidationError, NotFoundError,
          AuthorizationError, ConflictError) is TERMINAL: the job is marked
          failed with ``'{error_message}: {reason}'``, a WARNING is logged and the
          wrapper RETURNS ``{'success': False, 'error': ...}`` — no Lambda error,
          no async-failure DLQ message, no alarm.
        - Anything else (ServiceError / ConfigurationError / unexpected) marks the
          job failed the same way, logs the traceback, and re-raises as
          ServiceError(error_message) so a genuine fault reaches the DLQ.
    Example:
        @job_handler(error_message='Persona generation failed')
        def handle_generate_personas_job(ctx: JobContext, project_id: str, job_id: str, filters: dict) -> dict:
            ctx.update_progress(10, 'starting')
            result = generate_personas(project_id, filters)
            return {'persona_count': len(result.get('personas', []))}
    """
    def decorator(func: Callable[..., dict]) -> Callable[..., dict]:
        @wraps(func)
        def wrapper(event: dict, lambda_context: Any = None) -> dict:
            project_id = event['project_id']
            job_id = event['job_id']
            workspace = event_scope(event)

            if lambda_context is not None:
                claimed = claim_job_execution(
                    project_id, job_id, lambda_context, workspace=workspace,
                )
                if not claimed:
                    claimed = recover_job_execution_claim(event, lambda_context, workspace=workspace)
                if not claimed:
                    logger.info(
                        f'[JOB] Delivery deferred or already complete for '
                        f'project={project_id}, job={job_id}'
                    )
                    return {'success': True, 'skipped': True}

            # Create context for progress updates
            ctx = JobContext(project_id, job_id, workspace=workspace, lambda_context=lambda_context)

            # Extract config - look for common config key patterns
            config = None
            for key in ['filters', 'doc_config', 'merge_config', 'import_config', 'research_config', 'config']:
                if key in event:
                    config = event[key]
                    break

            try:
                logger.info(f"[JOB] Starting {func.__name__} for project={project_id}, job={job_id}")
                require_deployment(workspace, PROJECT_JOB_WORK_STORE)

                # Call the handler with context, IDs, and config
                if config is not None:
                    result = func(ctx, project_id, job_id, config)
                else:
                    result = func(ctx, project_id, job_id)

                # Mark job as completed
                update_job_status(project_id, job_id, 'completed', 100, 'complete', result=result,
                                  workspace=workspace)
                logger.info(f"[JOB] Completed {func.__name__} for job={job_id}")
                # Its starter's page re-reads the job now (best effort, docs/realtime.md).
                notify_project_job(project_id, job_id, 'completed', workspace=workspace)

                response = {'success': True, **result}

            except Exception as e:
                if _is_terminal_user_outcome(e):
                    return _end_job_without_result(func.__name__, project_id, job_id, error_message, e,
                                                   workspace=workspace)
                logger.exception(f"[JOB] {func.__name__} failed for job={job_id}: {e}")
                update_job_status(
                    project_id, job_id, 'failed', 0, 'error', error=_job_error_text(error_message, e),
                    workspace=workspace,
                )
                notify_project_job(project_id, job_id, 'failed', workspace=workspace)
                raise ServiceError(error_message) from e
            else:
                return response

        return wrapper
    return decorator


def _is_terminal_user_outcome(error: Exception) -> bool:
    """True for an ApiError answering 4xx (Validation/NotFound/Authorization/Conflict)."""
    return isinstance(error, ApiError) and 400 <= error.status_code < 500


def _job_error_text(error_message: str, error: Exception) -> str:
    """The job record's `error` field, which the Background Jobs panel shows."""
    return f'{error_message}: {str(error)[:200]}'


def _end_job_without_result(
    func_name: str, project_id: str, job_id: str, error_message: str, error: Exception, *,
    workspace: WorkspaceScope | None,
) -> dict:
    """Record a 4xx outcome as the job's failure and return instead of raising.

    A 4xx is the job's correct answer about the caller's input (no feedback for
    these filters, an unreadable file, a document that is gone), not a platform
    fault, and retrying cannot change it. A raise would make Lambda count an
    Errors datapoint and send the event to the async-failure DLQ, whose alarm
    then pages the operator about a user's empty filter (F1, 2026-10). So: a
    WARNING without a traceback, the reason on the job record, a normal return. An ApiError's ``code`` goes on the
    record as ``error_code`` (7.104.00), the reason as a word.
    """
    status = error.status_code if isinstance(error, ApiError) else 0
    code = error.code if isinstance(error, ApiError) else None
    logger.warning(
        f"[JOB] {func_name} ended without a result for job={job_id} "
        f"({type(error).__name__}, {status}): {error}"
    )
    error_text = _job_error_text(error_message, error)
    update_job_status(project_id, job_id, 'failed', 0, 'error', error=error_text, workspace=workspace,
                      error_code=code)
    notify_project_job(project_id, job_id, 'failed', workspace=workspace)
    return {'success': False, 'error': error_text, **({'error_code': code} if code else {})}
