"""The scheduled cross-run Learn pass's weekly record, read (7.53.00; included by ``api/agents_handler.py``).

    GET /agents/engineering/learn?flow=<flow>&week=<yyyy-Www>   -> {flow, week, weeks, key, record, label, model_text}

The pass (``engineering/learning/cross_run.py``: voc-engineering-runtime's ``learn_cross_run``, on its weekly schedule
while ``-c engineeringCrossRunLearn=weekly``) writes one record per flow and ISO week, create-only, at
``ws/default/learn/<flow>/<week>/v1.json``. This lists the flow's weeks (one listing of
``ws/default/learn/<flow>/`` by ``/``: its newest 52 answered as ``weeks``) and reads the one asked for, the newest
when ``week`` is left out: one GetObject, never of a key the listing did not name (so a week with no record is a 404,
never a denied read). The Agents API's grants: its run reads' ``s3:GetObject`` and its listing held to prefixes,
each with ``ws/default/learn/*`` added (lib/stacks/api-engineering-run-reads.ts).

The record's analysis and its proposals' texts are model text: the answer names them (``model_text``, the record's own
list) and says so (``label``); a reader shows them as text, never as HTML. Its proposals already wait where every
proposal waits (a lesson draft for an administrator's approval, a proposed skill version for the benchmark gate and an
administrator's accept): nothing here accepts anything.

Administrators only, acting for themselves (403 for anyone else, a delegated credential included), as every
``/agents/engineering/*`` route; 404 while the engineering agents are off, and for a flow with no record (or none that
week); 400 for a flow or a week off its shape; 503 when the bucket cannot be read.

Kept in ``shared/`` because an API bundle ships ``api/<handler>.py`` and ``shared/`` only; the engineering package
ships beside it only with the module on, so it is imported inside the route.
"""
from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from typing import Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router
from botocore.exceptions import BotoCoreError, ClientError

from shared.engineering_agents import engineering_agents_on
from shared.exceptions import NotFoundError, ServiceUnavailableError, ValidationError
from shared.logging import logger, tracer
from shared.project_gate import caller_from_event, require_admin_caller

__all__ = ['app']

NOT_FOUND: Final = 'No cross-run Learn record for this flow and week'
UNREADABLE: Final = 'the cross-run Learn record could not be read: retry'
#: The weeks a flow's answer lists, newest first, at most.
MAX_WEEKS: Final = 52
MAX_QUERY_TEXT: Final = 200

app = Router()


def _bucket() -> str:
    """The workspace bucket, for an administrator: 404 while the module is off, then 403 for anyone else."""
    bucket = os.environ.get('ENGINEERING_WORKSPACE_BUCKET', '')
    if not (engineering_agents_on() and bucket):
        raise NotFoundError(NOT_FOUND)
    require_admin_caller(caller_from_event(app.current_event.raw_event))
    return bucket


def _query(name: str) -> str:
    value = (app.current_event.query_string_parameters or {}).get(name) or ''
    if len(value) > MAX_QUERY_TEXT:
        raise ValidationError(f'{name} is at most {MAX_QUERY_TEXT} characters')
    return value


def _weeks(s3: Any, bucket: str, prefix: str) -> list[str]:
    """The flow's recorded weeks, newest first (one page of the listing: years of weeks)."""
    from engineering.learning.cross_run import WEEK  # (the package ships only with the module)

    page = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, Delimiter='/', MaxKeys=1000)
    found = (str(item.get('Prefix', ''))[len(prefix):].rstrip('/') for item in page.get('CommonPrefixes', []))
    return sorted((week for week in found if WEEK.fullmatch(week)), reverse=True)


#: The recurring failures a run's retrospective shows of its flow's cross-run record, at most.
MAX_SUMMARY_FAILURES: Final = 20


def latest_summary(s3: Any, bucket: str, flow: str) -> dict[str, Any]:
    """The newest weekly record of ``flow`` as a run's retrospective shows it (7.53.00, ``engineering_run_analysis``):
    its week and key, the model's analysis (labelled as model text), the convergence and the recurring failures (at
    most ``MAX_SUMMARY_FAILURES``); ``{available: false, reason}`` when the flow has none or it cannot be read. The
    caller has checked who asks."""
    from engineering.learning import cross_run

    try:
        prefix = cross_run.flow_prefix(flow)
    except ValueError:
        return {'available': False, 'reason': 'the run follows no flow with a cross-run Learn record'}
    try:
        weeks = _weeks(s3, bucket, prefix)
        if not weeks:
            return {'available': False, 'reason': 'no cross-run Learn record of this flow yet'}
        from engineering.workspace.store import WorkspaceStore
        key = cross_run.record_key(flow, weeks[0])
        text = WorkspaceStore(s3, bucket, denied_is_missing=True).read_text(key)
        record = json.loads(text) if text is not None else None
    except (ClientError, BotoCoreError, ValueError):
        logger.exception('engineering: a cross-run Learn summary could not be read', extra={'flow': flow})
        return {'available': False, 'reason': UNREADABLE}
    if not isinstance(record, dict):
        return {'available': False, 'reason': 'no cross-run Learn record of this flow yet'}
    failures = record.get('failures')
    return {'available': True, 'flow': flow, 'week': weeks[0], 'key': key, 'label': cross_run.MODEL_LABEL,
            'analysis': record.get('analysis'), 'convergence': record.get('convergence'),
            'failures': failures[:MAX_SUMMARY_FAILURES] if isinstance(failures, list) else []}


@app.get('/agents/engineering/learn')
@tracer.capture_method
def get_cross_run_learn() -> dict[str, Any]:
    """A flow's weekly cross-run Learn record (see the module's doc)."""
    bucket = _bucket()
    from engineering.learning import cross_run
    from engineering.workspace.store import WorkspaceStore
    from shared.aws import get_s3_client

    flow, asked = _query('flow'), _query('week')
    try:
        prefix = cross_run.flow_prefix(flow)
        cross_run.check_week(asked or cross_run.week_of(datetime.now(UTC)))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    s3 = get_s3_client()
    try:
        weeks = _weeks(s3, bucket, prefix)
    except (ClientError, BotoCoreError) as exc:
        logger.exception('engineering: a flow\'s cross-run Learn weeks could not be listed', extra={'flow': flow})
        raise ServiceUnavailableError(UNREADABLE) from exc
    week = asked or (weeks[0] if weeks else '')
    if week not in weeks:
        raise NotFoundError(NOT_FOUND)
    key = cross_run.record_key(flow, week)
    try:
        text = WorkspaceStore(s3, bucket, denied_is_missing=True).read_text(key)
        record = json.loads(text) if text is not None else None
    except (ClientError, BotoCoreError, ValueError) as exc:
        logger.exception('engineering: a cross-run Learn record could not be read', extra={'flow': flow})
        raise ServiceUnavailableError(UNREADABLE) from exc
    if not isinstance(record, dict):
        raise NotFoundError(NOT_FOUND)
    return {'flow': flow, 'week': week, 'weeks': weeks[:MAX_WEEKS], 'key': key, 'record': record,
            'label': cross_run.MODEL_LABEL, 'model_text': list(cross_run.MODEL_TEXT)}
