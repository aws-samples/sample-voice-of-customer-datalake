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
   the body the synchronous route used to return.

Where a row lives (``pk``):

- ``PROJECT#{project_id}`` for a project's assists, so the project's existing
  ``GET /projects/{id}/jobs/{job_id}`` serves them to anyone who may view the
  project. ``GET /projects/{id}/jobs`` (the Background jobs panel) leaves out
  ``assist_*`` rows: they are request plumbing, not work a user started.
- ``ASSIST#{caller_sub}`` for assists outside a project (categories, URL
  analysis), so a caller can only ever read their own (``owner_pk``).

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
from typing import Any, Final

from aws_lambda_powertools.event_handler import Response, content_types
from botocore.exceptions import ClientError

from shared.aws import invoke_lambda_async, is_conditional_check_failure
from shared.exceptions import ApiError, NotFoundError, ServiceError
from shared.logging import logger
from shared.model_profile import payload_fields
from shared.tables import get_jobs_table

ASSIST_ACTION: Final = 'assist_job'
ASSIST_JOB_PREFIX: Final = 'assist_'
JOB_ID_PREFIX: Final = 'job_'
# Long enough for a client to read the outcome after a slow answer; the row is
# plumbing, so a day is plenty.
ASSIST_JOB_TTL: Final = timedelta(days=1)
MAX_ERROR_CHARS: Final = 500

PENDING: Final = 'pending'
RUNNING: Final = 'running'
COMPLETED: Final = 'completed'
FAILED: Final = 'failed'

# The fields a poll returns (and nothing else: config may hold the caller's input).
VIEW_FIELDS: Final = ('job_id', 'job_type', 'status', 'created_at', 'updated_at', 'completed_at', 'error', 'result')


def project_pk(project_id: str) -> str:
    return f'PROJECT#{project_id}'


def owner_pk(subject: str) -> str:
    """The partition of a caller's assists outside any project."""
    if not subject:
        raise ServiceError('An assist needs a signed-in caller')
    return f'ASSIST#{subject}'


def is_assist_job_type(job_type: object) -> bool:
    return isinstance(job_type, str) and job_type.startswith(ASSIST_JOB_PREFIX)


def is_assist_event(event: object) -> bool:
    """True for the worker's invocation (``lambda_handler`` routes it to ``run``)."""
    return isinstance(event, Mapping) and event.get('action') == ASSIST_ACTION


@dataclass(frozen=True)
class Work:
    """One assist kind: the function that does it and the message shown when it fails unexpectedly."""

    run: Callable[[dict], dict]
    failure_message: str


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
          initiated_by: str | None, project_id: str | None = None) -> dict[str, Any]:
    """Record a pending assist and hand it to the worker; the route answers this dict with 202.

    The row is written BEFORE the invoke, so the worker always finds it. If the
    invoke itself fails, the row is marked failed and the request answers 500:
    nothing will ever pick it up.
    """
    if not is_assist_job_type(job_type):
        raise ValueError(f'assist job types start with {ASSIST_JOB_PREFIX!r}: {job_type}')
    if not worker_function:
        raise ServiceError('Assist worker not configured')
    job_id = f'{JOB_ID_PREFIX}{uuid.uuid4().hex[:16]}'
    now = _now()
    item: dict[str, Any] = {
        **_key(pk, job_id), 'gsi1pk': f'STATUS#{PENDING}', 'gsi1sk': now.isoformat(),
        'job_id': job_id, 'job_type': job_type, 'status': PENDING, 'progress': 0, 'current_step': 'queued',
        'created_at': now.isoformat(), 'updated_at': now.isoformat(),
        'ttl': int((now + ASSIST_JOB_TTL).timestamp()), 'config': dict(config),
    }
    if project_id is not None:
        item['project_id'] = project_id
    if initiated_by:
        item['initiated_by'] = initiated_by
    _table().put_item(Item=item)
    try:
        # The starter's model profile rides the event (the worker's api_handler opens its scope).
        invoke_lambda_async(worker_function, {'action': ASSIST_ACTION, 'pk': pk, 'job_id': job_id, **payload_fields()})
    except Exception as exc:
        logger.exception('Assist worker invoke failed', extra={'job_type': job_type})
        _finish(pk, job_id, FAILED, error='The assistant could not be started; try again.')
        raise ServiceError('The assistant could not be started; try again.') from exc
    return {'success': True, 'job_id': job_id, 'status': PENDING}


def worker_function() -> str:
    """This Lambda's assist twin (``ASSIST_WORKER_FUNCTION``); '' when unconfigured."""
    return os.environ.get('ASSIST_WORKER_FUNCTION', '')


def start_owned(subject: str, job_type: str, config: Mapping[str, Any]) -> dict[str, Any]:
    """Start a global assist only ``subject`` may poll (pk ``ASSIST#{subject}``)."""
    return start(owner_pk(subject), job_type, config, worker_function=worker_function(), initiated_by=subject)


def accepted(started: Mapping[str, Any]) -> Response:
    """The route's **202** answer for a started assist."""
    return Response(status_code=202, content_type=content_types.APPLICATION_JSON, body=json.dumps(started))


def get(pk: str, job_id: str) -> dict[str, Any]:
    """The poll answer for ``job_id`` in ``pk``; 404 when missing or not an assist."""
    if not job_id.startswith(JOB_ID_PREFIX):
        raise NotFoundError('Job not found')
    item = _table().get_item(Key=_key(pk, job_id), ConsistentRead=True).get('Item')
    if not item or not is_assist_job_type(item.get('job_type')):
        raise NotFoundError('Job not found')
    return view(item)


def _claim(pk: str, job_id: str) -> dict[str, Any] | None:
    """Move the row pending → running once; the row (with its config), or None if another delivery has it."""
    now = _now().isoformat()
    try:
        return _table().update_item(
            Key=_key(pk, job_id),
            UpdateExpression='SET #s = :running, gsi1pk = :gsi, updated_at = :now, current_step = :step',
            ConditionExpression='attribute_exists(pk) AND #s = :pending',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':running': RUNNING, ':pending': PENDING, ':gsi': f'STATUS#{RUNNING}',
                                       ':now': now, ':step': 'running'},
            ReturnValues='ALL_NEW',
        )['Attributes']
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            return None
        raise


def _finish(pk: str, job_id: str, status: str, *, result: dict | None = None, error: str | None = None) -> None:
    now = _now().isoformat()
    names = {'#s': 'status'}
    values: dict[str, Any] = {':status': status, ':gsi': f'STATUS#{status}', ':now': now,
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
    _table().update_item(Key=_key(pk, job_id), UpdateExpression='SET ' + ', '.join(sets),
                         ExpressionAttributeNames=names, ExpressionAttributeValues=values)


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


def run(event: Mapping[str, Any], registry: Mapping[str, Work]) -> dict[str, Any]:
    """The worker side: claim, run the registered work, record the outcome. Never raises."""
    pk, job_id = event.get('pk'), event.get('job_id')
    if not isinstance(pk, str) or not isinstance(job_id, str):
        logger.warning('Malformed assist event')
        return {'status': 'ignored'}
    row = _claim(pk, job_id)
    if row is None:
        logger.info('Assist already taken or gone', extra={'job_id': job_id})
        return {'status': 'skipped'}
    job_type = row.get('job_type')
    work = registry.get(job_type) if isinstance(job_type, str) else None
    if work is None:
        _finish(pk, job_id, FAILED, error='This assistant is not available.')
        logger.error('No work registered for assist', extra={'job_type': job_type})
        return {'status': FAILED}
    try:
        result = work.run(dict(row.get('config') or {}))
    except Exception as exc:  # noqa: BLE001 - the worker never raises; _failure_text logs the traceback
        _finish(pk, job_id, FAILED, error=_failure_text(exc, job_type, work))
        return {'status': FAILED}
    _finish(pk, job_id, COMPLETED, result=_storable(result))
    logger.info('Assist completed', extra={'job_type': job_type})
    return {'status': COMPLETED}
