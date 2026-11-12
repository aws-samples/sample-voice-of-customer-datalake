"""The deployment's start theme (included by ``api/settings_handler.py``).

    GET /settings/appearance                      (any signed-in user) -> {default_theme}
    PUT /settings/appearance {default_theme}      (platform admin)     -> {success, settings: {default_theme}}

One colour scheme for the whole deployment (docs/multi-workspace.md, decision 7), so its writer is a platform
admin's, checked live (shared/platform_admin_gate.py), never a workspace admin's or a plain administrator's (403).

An unknown theme id is a 400. The theme only changes how the app is painted, never what a read
returns, so a save does not bump ``config_version`` (docs/caching.md); the GET still gets the
HTTP revalidation every API GET carries (its ETag is the hash of the body).
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared.api import get_caller_subject, require_admin
from shared.appearance import APPEARANCE_PK, APPEARANCE_SK, appearance_view, parse_default_theme
from shared.exceptions import ConfigurationError, ValidationError
from shared.logging import logger, tracer
from shared.platform_admin import require_platform_admin
from shared.platform_admin_gate import require_live_platform_admin
from shared.request_body import json_object_body
from shared.timestamps import now_iso

__all__ = ['app', 'bind_aggregates_table']

#: The fixed answer of a failed platform-admin look-up (#263: never the AWS text).
FAILED_SAVE = 'Failed to save the appearance'

app = Router()
_aggregates_table: dict[str, Callable[[], Any]] = {}


def bind_aggregates_table(source: Callable[[], Any]) -> None:
    """The including handler's voc-aggregates table getter (None when not configured)."""
    _aggregates_table['source'] = source


def _table() -> Any:
    source = _aggregates_table.get('source')
    table = source() if source else None
    if table is None:
        raise ConfigurationError('Aggregates table not configured')
    return table


@app.get('/settings/appearance')
@tracer.capture_method
def get_appearance():
    """The deployment's start theme (no row = the default theme)."""
    item = _table().get_item(Key={'pk': APPEARANCE_PK, 'sk': APPEARANCE_SK}).get('Item')
    return appearance_view(item)


@app.put('/settings/appearance')
@tracer.capture_method
def put_appearance():
    """Platform admin: set the start theme every person of the deployment sees until they pick their own."""
    event = app.current_event.raw_event
    require_admin(event)
    require_platform_admin(event)
    require_live_platform_admin(event, FAILED_SAVE)
    table = _table()
    try:
        theme = parse_default_theme(json_object_body(app))
    except ValueError as exc:
        raise ValidationError(str(exc)) from None
    # `updated_by` = the admin's Cognito sub (stable; never logged, never answered by the GET).
    updated_by = get_caller_subject(app.current_event.raw_event)
    table.put_item(Item={
        'pk': APPEARANCE_PK, 'sk': APPEARANCE_SK, 'default_theme': theme, 'updated_at': now_iso(), 'updated_by': updated_by,
    })
    logger.info('Appearance: default theme saved', extra={'default_theme': theme})
    return {'success': True, 'settings': {'default_theme': theme}}
