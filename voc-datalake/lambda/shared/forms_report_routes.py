"""A feedback form's AI report summary (7.63.00, docs/feedback-forms.md "Report"), included by
``api/settings_handler.py``.

    POST /settings/form-reports {form_id, answers: [{response_id, text}], filters?, last_response_at?}
                                                                                    -> 202 {job_id, status}
    GET  /settings/form-reports/{job_id}                                            -> the job's poll answer

Served by the settings API, as the AI drafts are (shared/forms_v2_draft_routes.py, whose workspace resolution, 403
for a viewer and hourly counter it shares) and for the same reason: the forms Lambda also serves the public widget
routes, so its role holds no model, worker or jobs access. Gated as Results: the workspace's editors and admins (a
viewer 403), whoever manages forms deployment-wide; the form must be one the request's scope holds (404 otherwise, so
another workspace's form is never reported on); ``MAX_REPORTS_PER_HOUR`` per person per hour. The browser sends the
answers it already read with the person's own access (``GET /feedback-forms/{id}/responses``), so the settings role
needs no read of the feedback table.

The settings assist twin runs ``run_job`` (settings_handler ``ASSIST_WORK``: per workspace, in the job's own scope):
the one model call (shared/forms_v2_report_ai.py), then, when it found themes, the report row
``FORMREPORT#{form_id}#{report_id}`` in that scope's forms partition: ``{form_id, report_id, created_at, created_by:
{sub, kind}, reason, responses_counted (the answers it read), last_response_at, filters, response_ids, themes: [{label,
count, sentiment, quote_ids}], ai: {model, prompt_version, summary}}``, no ``ttl``. Labels and ids only, never a
respondent's text; the report route (``GET /feedback-forms/{id}/report``, shared/forms_v2_report.py) reads the newest
and joins its quotes. A form deleted while its job ran gets no row.

The job row's ``config`` holds the answers only while the job runs: the worker removes it when the job ends
(``assist_jobs.Work.forget_config``), so no respondent's text stays in voc-jobs after the summary (a job whose worker
never ran keeps it until the row's TTL, a day). The worker reads no answer itself: the settings role holds no read
of the feedback table, and the access the browser read them with (category, source) is the person's own.
"""
from __future__ import annotations

import re
import secrets
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Final

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared import assist_jobs, forms_v2_report_ai
from shared.api import get_caller_subject
from shared.delete_audit import actor_from_event
from shared.dynamo_values import plain
from shared.exceptions import NotFoundError
from shared.forms_v2_draft_routes import aggregates, charge_hourly, forms_partition, own_job, require_editor
from shared.forms_v2_report import report_key
from shared.ingest_tables import table_view
from shared.logging import tracer
from shared.request_body import json_object_body
from shared.request_workspace import request_workspace
from shared.timestamps import now_iso
from shared.ws_repo import optional_scope

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

__all__ = ['app', 'run_job']

app = Router()

#: AI summaries per person per hour (per workspace: the deployment's own outside one).
MAX_REPORTS_PER_HOUR: Final = 20
#: The hourly counters, beside the drafts' in the forms partition, gone two days later by TTL.
_REPORT_RATE_PREFIX: Final = 'FORMREPORTRATE#'
FAILED_REPORT_START: Final = 'The AI summary could not be started; try again.'
FAILED_REPORT_READ: Final = 'Failed to read the AI summary'
#: Why the row was written (TENETS.md D4: every write says who, when and why).
REPORT_REASON: Final = 'ai_summary'
#: ``rpt_`` + the start's UTC time + 8 random hex: report ids sort by when they were asked for.
REPORT_ID: Final = re.compile(r'rpt_\d{14}[0-9a-f]{8}')


def _new_report_id() -> str:
    return f"rpt_{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}{secrets.token_hex(4)}"


def _form_key(partition: str, form_id: str) -> dict[str, str]:
    return {'pk': partition, 'sk': f'FORM#{form_id}'}


@app.post('/settings/form-reports')
@tracer.capture_method
def start_form_report():
    """Start an AI summary of a form's answers → 202 ``{success, job_id, status}``. The job's result is ``{success:
    true, form_id, report_id}`` (the report then carries it) or ``{success: false, code: 'no_summary' | 'no_model' |
    'form_deleted', error}``."""
    context = request_workspace(app.current_event.raw_event, FAILED_REPORT_START, fresh=True)
    require_editor(context)
    request = forms_v2_report_ai.validate_request(json_object_body(app))
    scope = optional_scope(context)
    if not table_view(scope, aggregates()).get_item(_form_key(forms_partition(scope), request['form_id'])).get('Item'):
        raise NotFoundError('Form not found')
    subject = get_caller_subject(app.current_event.raw_event)
    charge_hourly(context, subject, prefix=_REPORT_RATE_PREFIX, cap=MAX_REPORTS_PER_HOUR, noun='AI summaries',
                  failure=FAILED_REPORT_START)
    config = {**request, 'report_id': _new_report_id(), 'created_by': actor_from_event(app.current_event.raw_event)}
    return assist_jobs.accepted(assist_jobs.start_owned(subject, forms_v2_report_ai.REPORT_JOB, config,
                                                        workspace=context))


@app.get('/settings/form-reports/<job_id>')
@tracer.capture_method
def get_form_report(job_id: str):
    """Poll one of the caller's own AI summaries, in the workspace it was started in (404 for anyone else's, or from
    another workspace): ``{status, result, error}`` (shared/assist_jobs.py ``view``)."""
    context = request_workspace(app.current_event.raw_event, FAILED_REPORT_READ, fresh=True)
    require_editor(context)
    return own_job(app.current_event.raw_event, context, job_id)


def run_job(config: dict, scope: WorkspaceScope | None) -> dict:
    """The assist worker's work for ``REPORT_JOB`` in the job's own ``scope``: the request as the route checked it,
    summarized, and the report row written when the model found anything (and the form is still there)."""
    stored = plain(config)  # (as the job row holds it: DynamoDB's numbers are Decimals)
    request = forms_v2_report_ai.validate_request({key: stored[key] for key in ('form_id', 'answers', 'filters',
                                                                                 'last_response_at') if key in stored})
    report_id = str(config.get('report_id') or '')
    if not REPORT_ID.fullmatch(report_id):
        raise ValueError('a report job needs its report_id')
    result = forms_v2_report_ai.summarize(request)
    if not result['success']:
        return result
    partition, view = forms_partition(scope), table_view(scope, aggregates())
    if not view.get_item(_form_key(partition, request['form_id'])).get('Item'):
        return {'success': False, 'code': 'form_deleted', 'error': 'The form was deleted.'}
    created_by = config.get('created_by') if isinstance(config.get('created_by'), dict) else {}
    view.put_item({
        **report_key(partition, request['form_id'], report_id), 'form_id': request['form_id'], 'report_id': report_id,
        'created_at': now_iso(), 'created_by': created_by, 'reason': REPORT_REASON,
        'responses_counted': len(request['answers']), 'last_response_at': request['last_response_at'],
        'filters': request['filters'], 'response_ids': [answer['response_id'] for answer in request['answers']],
        'themes': result['themes'],
        'ai': {'model': result['model'], 'prompt_version': result['prompt_version'], 'summary': result['summary']},
    }, ConditionExpression='attribute_not_exists(sk)')
    return {'success': True, 'form_id': request['form_id'], 'report_id': report_id}
