"""Job-end notices for the long jobs the SPA polls (docs/realtime.md → Channels).

When a job ends, the Lambda that wrote its final status tells the person who started it, on
``/jobs/<their sub>``, so the page re-reads the job at once instead of on its next poll:

    {type: 'job', job_id, job_type, status, project_id?}

Like every notice it carries ids and a status only, and it is never the data: the SPA re-reads the
job through the API. Best effort (``shared/realtime.py``): it never raises and never fails the job,
and it is a no-op when the Event API is not configured. ``notify_project_job`` reads the job row's
``initiated_by`` only when a notice can be sent at all.
"""
from __future__ import annotations

from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from shared import realtime
from shared.logging import logger
from shared.project_keys import project_pk
from shared.tables import get_jobs_table


def notify(starter: object, job_id: object, status: object, *, job_type: object = None,
           project_id: object = None) -> bool:
    """Send ``{type: 'job', …}`` to ``starter``'s jobs channel. True when AppSync accepted it; never raises."""
    # Nobody to tell (an older row, a run nobody started) or nothing to name: not even the endpoint is read.
    if not all(isinstance(value, str) and value for value in (starter, job_id, status)):
        return False
    event: dict[str, Any] = {'type': 'job', 'job_id': job_id, 'status': status}
    if isinstance(job_type, str) and job_type:
        event['job_type'] = job_type
    if isinstance(project_id, str) and project_id:
        event['project_id'] = project_id
    return realtime.publish('jobs', starter, event)


def notify_project_job(project_id: str, job_id: str, status: str) -> bool:
    """Tell a project job's starter (the row's ``initiated_by``) that it ended. Never raises.

    No read at all without a configured Event API. A row without ``initiated_by`` (a job an
    agent or an older release started) or a failed read sends nothing: the poll still sees it.
    """
    if not realtime.configured():
        return False
    table = get_jobs_table()
    if table is None:
        return False
    try:
        response = table.get_item(
            Key={'pk': project_pk(project_id), 'sk': f'JOB#{job_id}'},
            ProjectionExpression='initiated_by, job_type',
            ConsistentRead=True,
        )
    except (BotoCoreError, ClientError) as exc:
        logger.info('Job notice skipped: the job row was not readable', extra={'error': type(exc).__name__})
        return False
    row = response.get('Item') if isinstance(response, dict) else None
    if not isinstance(row, dict) or not row.get('initiated_by'):
        return False
    return notify(row.get('initiated_by'), job_id, status, job_type=row.get('job_type'), project_id=project_id)
