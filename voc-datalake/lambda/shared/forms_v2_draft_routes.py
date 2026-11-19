"""A feedback form's AI draft (docs/feedback-forms.md "AI drafts"), included by ``api/settings_handler.py``.

    POST /feedback-forms/draft {description, language, channel, base_form?, instruction?}   -> 202 {job_id, status}
    GET  /feedback-forms/draft/{job_id}                                                      -> the job's poll answer

Served by the SETTINGS API, not by the forms Lambda (7.04.00, the AI review's round 1, TENETS.md tenet 6): the forms
Lambda also serves the three unauthenticated widget routes, so its role holds no worker invoke and no jobs-table
action. The settings role already owns ``shared/assist_jobs.py``'s job rows (``ASSIST#{sub}``), its own assist twin
(``ASSIST_WORKER_FUNCTION``, which runs ``shared/forms_v2_draft.py`` ``run_job`` with the deployment's Bedrock grant)
and the job notice the twin sends when the draft ends (``/jobs/<sub>``, docs/realtime.md). API Gateway routes the two
paths to this Lambda (lib/stacks/api-routes.ts, a static ``draft`` resource beside ``{form_id}``).

Any signed-in user may draft (the owner's decision, as the form CRUD), at ``MAX_DRAFTS_PER_HOUR`` per person per hour,
and not gated by the person's way of working (a form is not a gated document type). Nothing is ever saved: the draft
opens unsaved in the builder.
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router
from botocore.exceptions import ClientError

from shared import assist_jobs, forms_v2_draft
from shared.api import get_caller_subject
from shared.aws import is_conditional_check_failure
from shared.exceptions import ServiceError, TooManyRequestsError
from shared.logging import logger, tracer
from shared.onboarding import FEEDBACK_FORM_PK
from shared.request_body import json_object_body
from shared.tables import configured_table

__all__ = ['app', 'bind_aggregates_table']

app = Router()
#: The including handler's voc-aggregates getter (``bind_aggregates_table``); empty until it binds one.
_bound: list[Callable[[], Any]] = []

#: Drafts per person per hour.
MAX_DRAFTS_PER_HOUR: Final = 20
#: The hourly counters live in the forms partition (``FORMDRAFT#{sub}#{hour}``), gone two days later by TTL: rate
#: plumbing, like an assist job's own row, not a record of anything (the forms list reads ``FORM#`` rows only).
_DRAFT_RATE_PREFIX: Final = 'FORMDRAFT#'
_DRAFT_RATE_TTL_SECONDS: Final = 2 * 24 * 3600


def bind_aggregates_table(source: Callable[[], Any]) -> None:
    """Read voc-aggregates through the including handler's own table (``source()``, None when it has none), so a
    test that patches the handler's table patches the drafts' too."""
    _bound[:] = [source]


def _table() -> Any:
    return configured_table(_bound[0]() if _bound else None, 'Aggregates')


def _charge_draft(subject: str) -> None:
    """Count one draft for ``subject`` this hour, or 429 ``rate_limited`` with ``retry_after`` (seconds to the next
    hour). Charged before the job starts, so a start that fails still counts toward the hour."""
    now = datetime.now(UTC)
    try:
        _table().update_item(
            Key={'pk': FEEDBACK_FORM_PK, 'sk': f"{_DRAFT_RATE_PREFIX}{subject}#{now.strftime('%Y-%m-%dT%H')}"},
            UpdateExpression='ADD drafts :one SET #ttl = if_not_exists(#ttl, :ttl)',
            ConditionExpression='attribute_not_exists(drafts) OR drafts < :cap',
            ExpressionAttributeNames={'#ttl': 'ttl'},
            ExpressionAttributeValues={':one': 1, ':cap': MAX_DRAFTS_PER_HOUR,
                                       ':ttl': int(now.timestamp()) + _DRAFT_RATE_TTL_SECONDS},
        )
    except ClientError as e:
        if is_conditional_check_failure(e):
            retry_after = 3600 - (now.minute * 60 + now.second)
            raise TooManyRequestsError(f'At most {MAX_DRAFTS_PER_HOUR} AI drafts an hour: try again later',
                                       code='rate_limited', details={'retry_after': retry_after}) from e
        logger.exception(f'Could not count an AI draft: {type(e).__name__}')
        raise ServiceError('The AI draft could not be started; try again.') from e


@app.post('/feedback-forms/draft')
@tracer.capture_method
def start_form_draft():
    """Start an AI draft of a form → 202 ``{success, job_id, status}`` (shared/forms_v2_draft.py ``validate_request``
    checks the body first). The job's result is ``{success: true, form, notes, warnings}`` or ``{success: false, code:
    'invalid_draft' | 'no_model', error, errors?}``. Never saves."""
    request = forms_v2_draft.validate_request(json_object_body(app))
    subject = get_caller_subject(app.current_event.raw_event)
    _charge_draft(subject)
    return assist_jobs.accepted(assist_jobs.start_owned(subject, forms_v2_draft.DRAFT_JOB, request))


@app.get('/feedback-forms/draft/<job_id>')
@tracer.capture_method
def get_form_draft(job_id: str):
    """Poll one of the caller's own AI drafts (404 for anyone else's): ``{status, result, error}``
    (shared/assist_jobs.py ``view``). The twin's job notice wakes the browser's poll at once (docs/realtime.md)."""
    return assist_jobs.get(assist_jobs.owner_pk(get_caller_subject(app.current_event.raw_event)), job_id)
