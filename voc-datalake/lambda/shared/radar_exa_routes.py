"""Radar's Exa key routes (included by ``radar_handler``, docs/radar.md → "Exa").

    PUT    /radar/settings/exa-key   {api_key}  (admin) -> {success: true, exa_configured: true}
    DELETE /radar/settings/exa-key              (admin) -> {success: true, exa_configured: false}

The key goes to SSM Parameter Store (``shared.radar_exa_key``) and is never returned, logged or
echoed in an error. A change bumps the Radar version, so the cached ``GET /radar`` shows the new
``settings.exa_configured`` (docs/caching.md).

``settings_view`` is the ``settings`` object ``GET /radar`` and ``GET /radar/settings`` answer: the
scan settings plus ``exa_configured``.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from aws_lambda_powertools.event_handler.api_gateway import Router

from shared.api import require_admin
from shared.data_version import bump_radar_version
from shared.exceptions import ValidationError
from shared.logging import logger, tracer
from shared.radar_exa_key import delete_exa_key, exa_key_configured, put_exa_key, validate_exa_key
from shared.radar_settings import load_settings
from shared.request_body import json_body_value

__all__ = ['app', 'bind_radar_table', 'settings_view']

app = Router()
_radar_table: dict[str, Callable[[], Any]] = {}


def bind_radar_table(source: Callable[[], Any]) -> None:
    """The including handler's voc-radar table getter (the version bump writes there)."""
    _radar_table['source'] = source


def _table() -> Any:
    return _radar_table['source']()


def settings_view(table: Any) -> dict[str, Any]:
    """The scan settings and whether an Exa key is stored."""
    return {**load_settings(table), 'exa_configured': exa_key_configured()}


@app.put('/radar/settings/exa-key')
@tracer.capture_method
def put_key():
    """Admin: store (or replace) the Exa API key."""
    require_admin(app.current_event.raw_event)
    try:
        key = validate_exa_key(json_body_value(app))
    except ValueError as exc:
        raise ValidationError(str(exc)) from None
    put_exa_key(key)
    bump_radar_version(_table())
    logger.info('Radar: Exa key stored')
    return {'success': True, 'exa_configured': True}


@app.delete('/radar/settings/exa-key')
@tracer.capture_method
def delete_key():
    """Admin: remove the Exa API key (the scan stops using Exa)."""
    require_admin(app.current_event.raw_event)
    delete_exa_key()
    bump_radar_version(_table())
    logger.info('Radar: Exa key removed')
    return {'success': True, 'exa_configured': False}
