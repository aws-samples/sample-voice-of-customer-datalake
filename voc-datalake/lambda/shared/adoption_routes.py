"""The leadership view's time-saved baselines (7.70.00, docs/leadership-view.md), included by ``api/settings_handler.py``:

    GET /settings/adoption                       (the scope's admins)           -> {baselines, defaults, note, updated_at,
                                                                                    max_hours, max_note_chars}
    PUT /settings/adoption {baselines?, note?}   (the scope's admins, never a delegated caller) -> the same view

With ``X-Workspace-Id`` the workspace's row (``WS#{ws}#SETTINGS#adoption``), for its admins; without it the deployment's
(``SETTINGS#adoption``), for the deployment's ``admins``, as every settings kind that moved into its workspace
(shared/request_workspace.py ``require_settings_admin``). ``baselines`` maps some of the artifact types to the hours a
person takes to make one by hand (0 to 200; null puts one back to its default); ``note`` is the admin's own words on
where the numbers come from. The row records who saved it, when and why (D4). A save does not bump ``config_version``
(it changes no read of the data: the view applies the baselines when it answers).
"""
from __future__ import annotations

from typing import Final

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared import adoption
from shared.adoption import ADOPTION_KIND, DEPLOYMENT_KEY
from shared.delete_audit import actor_from_event
from shared.exceptions import AuthorizationError
from shared.forms_v2_draft_routes import aggregates
from shared.logging import logger, tracer
from shared.project_gate import caller_from_event
from shared.request_body import json_object_body
from shared.request_workspace import request_workspace, require_settings_admin
from shared.timestamps import now_iso
from shared.workspace import WorkspaceContext
from shared.workspace_config import get_config_item, put_config_item
from shared.ws_repo import optional_scope

__all__ = ['app']

app = Router()

FAILED_READ: Final = 'Failed to read the time-saved baselines'
FAILED_SAVE: Final = 'Failed to save the time-saved baselines'


def _require_admin_for_themselves(event: dict, context: WorkspaceContext | None) -> None:
    """403 unless an admin of the scope acts for themselves (a delegated caller reads the baselines in the view's
    answer only, and never changes them)."""
    require_settings_admin(event, context)
    if caller_from_event(event).delegated:
        raise AuthorizationError('The time-saved baselines are not open to a delegated caller')


@app.get('/settings/adoption')
@tracer.capture_method
def get_adoption_settings():
    """The scope's baselines (no row: every default)."""
    event = app.current_event.raw_event
    context = request_workspace(event, FAILED_READ)
    _require_admin_for_themselves(event, context)
    return adoption.config_view(get_config_item(aggregates(), ADOPTION_KIND, DEPLOYMENT_KEY, optional_scope(context)))


@app.put('/settings/adoption')
@tracer.capture_method
def put_adoption_settings():
    """An admin of the scope sets the hours each artifact takes by hand, and their note."""
    event = app.current_event.raw_event
    context = request_workspace(event, FAILED_SAVE, fresh=True)
    _require_admin_for_themselves(event, context)
    scope = optional_scope(context)
    changes = adoption.validate_changes(json_object_body(app))
    merged = adoption.merged_config(get_config_item(aggregates(), ADOPTION_KIND, DEPLOYMENT_KEY, scope), changes)
    stored = put_config_item(aggregates(), ADOPTION_KIND, DEPLOYMENT_KEY, scope, {
        **adoption.stored_fields(merged), 'updated_by': actor_from_event(event), 'updated_at': now_iso(),
        'reason': adoption.REASON,
    })
    logger.info('Time-saved baselines saved', extra={'types_set': len(merged['baselines']),
                                                     'has_note': merged['note'] is not None})
    return adoption.config_view(stored)
