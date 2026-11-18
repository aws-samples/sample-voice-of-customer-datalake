"""A feedback form's AI draft (docs/feedback-forms.md "AI drafts"), included by ``api/settings_handler.py``.

    POST /settings/form-drafts {description, language, channel, base_form?, instruction?}   -> 202 {job_id, status}
    GET  /settings/form-drafts/{job_id}                                                     -> the job's poll answer

Served by the SETTINGS API, not by the forms Lambda (the AI review's round 1 on 7.55.00, TENETS.md tenet 6): the forms
Lambda also serves the four unauthenticated widget routes, so its role holds no worker invoke and no jobs-table
action. The settings role already owns ``shared/assist_jobs.py``'s job rows (``ASSIST#{sub}``, a workspace's
``WS#{ws}#ASSIST#{sub}``), its own assist twin (``ASSIST_WORKER_FUNCTION``, which runs ``shared/forms_v2_draft.py``
``run_job`` with the deployment's Bedrock grant, per workspace: ``Work.per_workspace``) and the job notice the twin
sends when the draft ends (``/jobs/<sub>``, docs/realtime.md). Both routes ride the settings API's own
``/settings/{proxy+}`` (lib/stacks/api-routes.ts), so the move costs no API Gateway resource: the 7.55.00 paths
``/feedback-forms/draft`` and ``/feedback-forms/draft/{job_id}`` are gone (a static ``draft`` resource beside
``{form_id}``, as main has it, would take the API stack's performance-tier synth past its 425-resource gate,
lib/stacks/api-engagement-budget.test.ts).

Workspace-scoped as the form routes are (docs/feedback-forms.md "Workspaces"): a request that sends
``X-Workspace-Id`` is resolved as the settings API resolves every route (shared/request_workspace.py
``request_workspace``, from the table: ``fresh``), and only the workspace's editors and admins may draft or poll
(a viewer 403, as for a form's create); the job is the workspace's, its Bedrock calls counted to it. A request that
sends none drafts deployment-wide, for any signed-in user (the owner's decision, as the form CRUD). Either way at
``MAX_DRAFTS_PER_HOUR`` per person per hour (per workspace), and not gated by the person's way of working (a form is
not a gated document type). Nothing is ever saved: the draft opens unsaved in the builder.
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router
from botocore.exceptions import ClientError

from shared import assist_jobs, forms_v2_draft
from shared.api import get_caller_subject
from shared.aws import is_conditional_check_failure
from shared.exceptions import AuthorizationError, ServiceError, TooManyRequestsError
from shared.ingest_tables import table_view
from shared.logging import logger, tracer
from shared.onboarding import FEEDBACK_FORM_PK
from shared.request_body import json_object_body
from shared.request_workspace import request_workspace
from shared.tables import configured_table
from shared.workspace import EDITING_ROLES
from shared.ws_repo import optional_scope

if TYPE_CHECKING:
    from shared.workspace import WorkspaceContext

__all__ = ['app', 'bind_aggregates_table']

app = Router()
#: The including handler's voc-aggregates getter (``bind_aggregates_table``); empty until it binds one.
_bound: list[Callable[[], Any]] = []

#: Drafts per person per hour (per workspace: the deployment's own outside one).
MAX_DRAFTS_PER_HOUR: Final = 20
#: The hourly counters live in the forms partition (``FORMDRAFT#{sub}#{hour}`` in ``FEEDBACK_FORM``, a workspace's
#: ``WS#{ws}#FEEDBACK_FORM``), gone two days later by TTL: rate plumbing, like an assist job's own row, not a record
#: of anything (the forms list reads ``FORM#`` rows only).
_DRAFT_RATE_PREFIX: Final = 'FORMDRAFT#'
_DRAFT_RATE_TTL_SECONDS: Final = 2 * 24 * 3600
FAILED_DRAFT_START: Final = 'The AI draft could not be started; try again.'
FAILED_DRAFT_READ: Final = 'Failed to read the AI draft'
#: A viewer's answer, as the form routes give it (lambda/api/feedback_form_handler.py ``_request_scope``).
DRAFTS_NEED_AN_EDITOR: Final = 'Managing feedback forms needs the editor or admin role in this workspace'


def bind_aggregates_table(source: Callable[[], Any]) -> None:
    """Read voc-aggregates through the including handler's own table (``source()``, None when it has none), so a
    test that patches the handler's table patches the drafts' too."""
    _bound[:] = [source]


def _table() -> Any:
    return configured_table(_bound[0]() if _bound else None, 'Aggregates')


def _drafting_workspace(public_error: str) -> WorkspaceContext | None:
    """The workspace the request names (None: the deployment's), resolved from the table (a draft is a write: a
    member demoted a moment ago cannot draft), and 403 for anyone there but an editor or an admin."""
    context = request_workspace(app.current_event.raw_event, public_error, fresh=True)
    if context is not None and context.role not in EDITING_ROLES:
        raise AuthorizationError(DRAFTS_NEED_AN_EDITOR)
    return context


def _charge_draft(context: WorkspaceContext | None, subject: str) -> None:
    """Count one draft for ``subject`` this hour in the forms partition of ``context``'s workspace, or 429
    ``rate_limited`` with ``retry_after`` (seconds to the next hour). Charged before the job starts, so a start that
    fails still counts toward the hour; a counter that cannot be written is a clean 500, never the AWS error."""
    now = datetime.now(UTC)
    scope = optional_scope(context)
    partition = scope.key(FEEDBACK_FORM_PK) if scope is not None else FEEDBACK_FORM_PK
    try:
        table_view(scope, _table()).update_item(
            {'pk': partition, 'sk': f"{_DRAFT_RATE_PREFIX}{subject}#{now.strftime('%Y-%m-%dT%H')}"},
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
        raise ServiceError(FAILED_DRAFT_START) from e


@app.post('/settings/form-drafts')
@tracer.capture_method
def start_form_draft():
    """Start an AI draft of a form → 202 ``{success, job_id, status}`` (shared/forms_v2_draft.py ``validate_request``
    checks the body first). The job's result is ``{success: true, form, notes, warnings}`` or ``{success: false, code:
    'invalid_draft' | 'no_model', error, errors?}``. Never saves."""
    context = _drafting_workspace(FAILED_DRAFT_START)
    request = forms_v2_draft.validate_request(json_object_body(app))
    subject = get_caller_subject(app.current_event.raw_event)
    _charge_draft(context, subject)
    return assist_jobs.accepted(assist_jobs.start_owned(subject, forms_v2_draft.DRAFT_JOB, request,
                                                        workspace=context))


@app.get('/settings/form-drafts/<job_id>')
@tracer.capture_method
def get_form_draft(job_id: str):
    """Poll one of the caller's own AI drafts, in the workspace it was started in (404 for anyone else's, or from
    another workspace): ``{status, result, error}`` (shared/assist_jobs.py ``view``). The twin's job notice (its
    ``job_id`` this one) wakes the browser's poll at once (docs/realtime.md)."""
    context = _drafting_workspace(FAILED_DRAFT_READ)
    subject = get_caller_subject(app.current_event.raw_event)
    return assist_jobs.get(assist_jobs.owner_pk(subject, workspace=context), job_id, workspace=context)
