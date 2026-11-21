"""In-app micro-feedback's settings (7.66.00, docs/micro-feedback.md), included by ``api/settings_handler.py``.

    GET /settings/app-feedback                               (any member; any signed-in user without a workspace)
        -> {enabled, form_id, actions, updated_at, tag, form, active}
    PUT /settings/app-feedback {enabled?, form_id?, actions?}  (the workspace's admins; the deployment's ``admins``
        without a workspace; never a delegated caller)      -> the same view

With ``X-Workspace-Id`` the workspace's row (``WS#{ws}#SETTINGS#app_feedback``) and a form of that workspace; without
it the deployment's row and a deployment form, as every settings kind that moved into its workspace
(shared/request_workspace.py). The chosen form must be one the request's scope holds (404 otherwise, the answer for a
form that exists nowhere, so another workspace's form is never named or read) and fit to receive the control's
responses (400 ``app_feedback_form_unfit`` with its ``problems``: shared/app_feedback.py ``form_problems``); a form
that is Off may be chosen (the view says so and the control stays hidden until it is on). Turning it on needs a form
(400 ``app_feedback_form_required``). Off by default: no row reads ``enabled: false``.

Nothing here is on the public path: the SPA posts each response to the form's own public submit route, which applies
the forms' validation, throttles and access rules (lambda/api/feedback_form_handler.py). A save does not bump
``config_version`` (it changes no read of the data).
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Final

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared import app_feedback
from shared.app_feedback import APP_FEEDBACK_KIND, DEPLOYMENT_KEY
from shared.delete_audit import actor_from_event
from shared.exceptions import AuthorizationError, NotFoundError, ValidationError
from shared.forms_v2_draft_routes import aggregates
from shared.ingest_tables import table_view
from shared.logging import logger, tracer
from shared.onboarding import forms_partition
from shared.project_gate import caller_from_event
from shared.request_body import json_object_body
from shared.request_workspace import request_workspace, require_settings_admin
from shared.timestamps import now_iso
from shared.workspace_config import get_config_item, put_config_item
from shared.ws_repo import optional_scope

if TYPE_CHECKING:
    from shared.ws_repo import WorkspaceScope

__all__ = ['app']

app = Router()

FAILED_READ: Final = 'Failed to read the in-app feedback settings'
FAILED_SAVE: Final = 'Failed to save the in-app feedback settings'
FORM_NOT_FOUND: Final = 'Feedback form not found'


def _form(scope: WorkspaceScope | None, form_id: str | None) -> dict[str, Any] | None:
    """The stored form ``form_id`` of ``scope``'s forms partition, or None (no id, or no such form there)."""
    if form_id is None:
        return None
    item = table_view(scope, aggregates()).get_item({'pk': forms_partition(scope), 'sk': f'FORM#{form_id}'}).get('Item')
    return item if isinstance(item, dict) else None


def _row(scope: WorkspaceScope | None) -> dict[str, Any]:
    return get_config_item(aggregates(), APP_FEEDBACK_KIND, DEPLOYMENT_KEY, scope)


@app.get('/settings/app-feedback')
@tracer.capture_method
def get_app_feedback():
    """The scope's micro-feedback settings and its form's state (no row: off)."""
    context = request_workspace(app.current_event.raw_event, FAILED_READ)
    scope = optional_scope(context)
    row = _row(scope)
    stored_form = row.get('form_id')
    return app_feedback.config_view(row, _form(scope, stored_form if isinstance(stored_form, str) else None))


@app.put('/settings/app-feedback')
@tracer.capture_method
def put_app_feedback():
    """An admin of the scope chooses the form, the actions and whether the control shows."""
    event = app.current_event.raw_event
    context = request_workspace(event, FAILED_SAVE, fresh=True)
    require_settings_admin(event, context)
    if caller_from_event(event).delegated:
        raise AuthorizationError('In-app feedback settings cannot be changed by a delegated caller')
    scope = optional_scope(context)
    changes = app_feedback.validate_changes(json_object_body(app))
    row = _row(scope)
    merged = app_feedback.merged_config(row, changes)
    form = _form(scope, merged['form_id'])
    if merged['form_id'] is not None and ('form_id' in changes or merged['enabled']):
        if form is None:
            raise NotFoundError(FORM_NOT_FOUND)
        blocking = [problem for problem in app_feedback.form_problems(form) if problem in app_feedback.BLOCKING]
        if blocking:
            raise ValidationError("This form can't receive the in-app feedback: make it from the In-app "
                                  'micro-feedback template', code='app_feedback_form_unfit',
                                  details={'problems': blocking})
    stored = put_config_item(aggregates(), APP_FEEDBACK_KIND, DEPLOYMENT_KEY, scope, {
        **merged, 'updated_by': actor_from_event(event), 'updated_at': now_iso(), 'reason': app_feedback.REASON,
    })
    logger.info('In-app feedback settings saved',
                extra={'enabled': merged['enabled'], 'actions': len(merged['actions'])})
    return app_feedback.config_view(stored, form)
