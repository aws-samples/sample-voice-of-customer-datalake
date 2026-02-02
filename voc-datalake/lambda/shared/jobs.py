"""
Shared job utilities for VoC Lambda functions.
Provides centralized job creation and status management.
"""

import uuid
from datetime import datetime, timezone, timedelta

from shared.logging import logger
from shared.tables import get_jobs_table


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


def get_job(project_id: str, job_id: str) -> dict | None:
    """Get a job record by ID.
    
    Args:
        project_id: Project ID
        job_id: Job ID
        
    Returns:
        Job item dict or None if not found
    """
    jobs_table = get_jobs_table()
    if not jobs_table:
        return None
    
    try:
        response = jobs_table.get_item(
            Key={'pk': f'PROJECT#{project_id}', 'sk': f'JOB#{job_id}'}
        )
        return response.get('Item')
    except Exception as e:
        logger.error(f"Failed to get job: {e}")
        return None
