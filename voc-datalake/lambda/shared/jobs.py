"""
Shared job utilities for VoC Lambda functions.
Provides centralized job creation, status management, and job handler decorator.
"""

import uuid
from functools import wraps
from datetime import datetime, timezone, timedelta
from typing import Callable, Any

from shared.logging import logger
from shared.tables import get_jobs_table
from shared.exceptions import ServiceError


def create_job(
    project_id: str,
    job_type: str,
    config_key: str,
    config: dict,
    ttl_minutes: int = 30,
    status: str = 'running'
) -> tuple[str, str]:
    """Create a job record and return (job_id, now).
    
    Args:
        project_id: Project ID
        job_type: Type of job (e.g., 'generate_personas', 'research')
        config_key: Key name for the config in the item (e.g., 'filters', 'doc_config')
        config: Configuration dict for the job
        ttl_minutes: TTL in minutes (default 30)
        status: Initial status ('running' or 'pending')
        
    Returns:
        Tuple of (job_id, created_at timestamp)
    """
    jobs_table = get_jobs_table()
    if not jobs_table:
        raise ValueError("JOBS_TABLE environment variable not configured")
    
    job_id = f"job_{uuid.uuid4().hex[:16]}"
    now = datetime.now(timezone.utc).isoformat()
    ttl = int((datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes)).timestamp())
    
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
    jobs_table.put_item(Item=item)
    return job_id, now


def update_job_status(
    project_id: str,
    job_id: str,
    status: str,
    progress: int,
    current_step: str = None,
    error: str = None,
    result: dict = None
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
    
    now = datetime.now(timezone.utc).isoformat()
    
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
        expr_values[':ttl'] = int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp())
    
    if result:
        update_expr += ', #result = :result, completed_at = :now, #ttl = :ttl'
        expr_values[':result'] = result
        expr_names['#result'] = 'result'
        expr_names['#ttl'] = 'ttl'
        # Extend TTL to 7 days for completed jobs
        expr_values[':ttl'] = int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp())
    
    try:
        jobs_table.update_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_values,
            ExpressionAttributeNames=expr_names
        )
    except Exception as e:
        logger.error(f"Failed to update job status: {e}")


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
        
    Example:
        @job_handler(error_message='Persona generation failed')
        def handle_generate_personas_job(ctx: JobContext, project_id: str, job_id: str, filters: dict) -> dict:
            ctx.update_progress(10, 'starting')
            result = generate_personas(project_id, filters)
            return {'persona_count': len(result.get('personas', []))}
    """
    def decorator(func: Callable[..., dict]) -> Callable[[dict], dict]:
        @wraps(func)
        def wrapper(event: dict) -> dict:
            project_id = event['project_id']
            job_id = event['job_id']
            
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
                
                return {'success': True, **result}
                
            except Exception as e:
                logger.exception(f"[JOB] {func.__name__} failed for job={job_id}: {e}")
                truncated_error = f'{error_message}: {str(e)[:200]}'
                update_job_status(project_id, job_id, 'failed', 0, 'error', error=truncated_error)
                raise ServiceError(error_message)
        
        return wrapper
    return decorator
