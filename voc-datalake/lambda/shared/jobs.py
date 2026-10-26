"""
Shared job utilities for VoC Lambda functions.
Provides centralized job creation, status management, and job handler decorator.
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
from shared.logging import logger
from shared.tables import get_jobs_table

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
    'REMOVE #error, #result, completed_at'
)
CLAIM_CONDITION_EXPRESSION = (
    'attribute_exists(pk) AND attribute_exists(sk) AND '
    '(#status = :pending OR #status = :failed OR '
    '(#status = :running AND '
    '(attribute_not_exists(execution_lease_until) OR '
    'execution_lease_until <= :now_epoch)))'
)
CLAIM_ATTRIBUTE_NAMES = {'#status': 'status', '#error': 'error', '#result': 'result'}


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
) -> bool:
    """Claim one direct async delivery until its Lambda deadline."""
    jobs_table = get_jobs_table()
    if not jobs_table:
        raise ValueError('JOBS_TABLE environment variable not configured')

    remaining_seconds = _remaining_seconds(lambda_context)
    now = datetime.now(UTC)
    now_epoch = int(now.timestamp())
    lease_until = now_epoch + remaining_seconds + EXECUTION_LEASE_SKEW_SECONDS
    owner = str(getattr(lambda_context, 'aws_request_id', '') or 'unknown')

    try:
        jobs_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'},
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
                ':running_gsi': 'STATUS#running',
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
) -> bool:
    """Wait for the owner, or self-redeliver before this waiter loses budget."""
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
        response = jobs_table.get_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'},
            ConsistentRead=True,
        )
        item = response.get('Item') if isinstance(response, dict) else None
        if not isinstance(item, dict):
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
        ) and claim_job_execution(project_id, job_id, lambda_context):
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

    Returns:
        Tuple of (job_id, created_at timestamp)
    """
    jobs_table = get_jobs_table()
    if not jobs_table:
        raise ValueError("JOBS_TABLE environment variable not configured")

    job_id = f"job_{uuid.uuid4().hex[:16]}"
    now = datetime.now(UTC).isoformat()
    ttl = int((datetime.now(UTC) + timedelta(minutes=ttl_minutes)).timestamp())

    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': f'JOB#{job_id}',
        'gsi1pk': f'STATUS#{status}',
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
    jobs_table.put_item(Item=item)
    return job_id, now
def update_job_status(
    project_id: str,
    job_id: str,
    status: str,
    progress: int,
    current_step: str | None = None,
    error: str | None = None,
    result: dict | None = None
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
    """
    jobs_table = get_jobs_table()
    if not jobs_table:
        logger.warning("JOBS_TABLE not configured, skipping job status update")
        return

    now = datetime.now(UTC).isoformat()

    update_expr = 'SET #status = :status, progress = :progress, updated_at = :now, gsi1pk = :gsi1pk'
    expr_values = {
        ':status': status,
        ':progress': progress,
        ':now': now,
        ':gsi1pk': f'STATUS#{status}'
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

    if result:
        update_expr += ', #result = :result, completed_at = :now, #ttl = :ttl'
        expr_values[':result'] = result
        expr_names['#result'] = 'result'
        expr_names['#ttl'] = 'ttl'
        # Extend TTL to 7 days for completed jobs
        expr_values[':ttl'] = int((datetime.now(UTC) + timedelta(days=7)).timestamp())

    try:
        jobs_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_values,
            ExpressionAttributeNames=expr_names,
            ConditionExpression='attribute_exists(pk) AND attribute_exists(sk)',
        )
    except Exception as e:
        logger.error(f"Failed to update job status: {e}", exc_info=True)
class JobContext:
    """Context object passed to job handlers for progress updates."""

    def __init__(self, project_id: str, job_id: str):
        self.project_id = project_id
        self.job_id = job_id

    def update_progress(self, progress: int, step: str):
        """Update job progress.

        Args:
            progress: Progress percentage (0-100)
            step: Current step description
        """
        update_job_status(self.project_id, self.job_id, 'running', progress, step)
def job_handler(error_message: str = 'Job execution failed'):
    """Decorator for async job handlers that standardizes error handling and status updates.

    The decorated function receives a JobContext as its first argument, followed by
    project_id, job_id, and the job config. It should return a result dict that will
    be stored in the job record.

    Args:
        error_message: Error message to use when the job fails

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

            if lambda_context is not None:
                claimed = claim_job_execution(
                    project_id, job_id, lambda_context,
                )
                if not claimed:
                    claimed = recover_job_execution_claim(event, lambda_context)
                if not claimed:
                    logger.info(
                        f'[JOB] Delivery deferred or already complete for '
                        f'project={project_id}, job={job_id}'
                    )
                    return {'success': True, 'skipped': True}

            # Create context for progress updates
            ctx = JobContext(project_id, job_id)

            # Extract config - look for common config key patterns
            config = None
            for key in ['filters', 'doc_config', 'merge_config', 'import_config', 'research_config', 'config']:
                if key in event:
                    config = event[key]
                    break

            try:
                logger.info(f"[JOB] Starting {func.__name__} for project={project_id}, job={job_id}")

                # Call the handler with context, IDs, and config
                if config is not None:
                    result = func(ctx, project_id, job_id, config)
                else:
                    result = func(ctx, project_id, job_id)

                # Mark job as completed
                update_job_status(project_id, job_id, 'completed', 100, 'complete', result=result)
                logger.info(f"[JOB] Completed {func.__name__} for job={job_id}")

                response = {'success': True, **result}

            except Exception as e:
                if _is_terminal_user_outcome(e):
                    return _end_job_without_result(func.__name__, project_id, job_id, error_message, e)
                logger.exception(f"[JOB] {func.__name__} failed for job={job_id}: {e}")
                update_job_status(
                    project_id, job_id, 'failed', 0, 'error', error=_job_error_text(error_message, e),
                )
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
    func_name: str, project_id: str, job_id: str, error_message: str, error: Exception,
) -> dict:
    """Record a 4xx outcome as the job's failure and return instead of raising.

    A 4xx is the job's correct answer about the caller's input (no feedback for
    these filters, an unreadable file, a document that is gone), not a platform
    fault, and retrying cannot change it. A raise would make Lambda count an
    Errors datapoint and send the event to the async-failure DLQ, whose alarm
    then pages the operator about a user's empty filter (F1, 2026-10). So: a
    WARNING without a traceback, the reason on the job record, a normal return.
    """
    status = error.status_code if isinstance(error, ApiError) else 0
    logger.warning(
        f"[JOB] {func_name} ended without a result for job={job_id} "
        f"({type(error).__name__}, {status}): {error}"
    )
    error_text = _job_error_text(error_message, error)
    update_job_status(project_id, job_id, 'failed', 0, 'error', error=error_text)
    return {'success': False, 'error': error_text}
