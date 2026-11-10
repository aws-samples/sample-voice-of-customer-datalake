"""`GET /logs/system/environment`: what someone without AWS access needs to know about this deployment.

Region, the last four digits of the account, the deployment prefix, the enabled sources, whether
web search is on, the inference scope, the persona-avatar image model (and whether avatars run
at all), the model in force per AI surface (and which ones an admin overrode), alerting (on or
off, every alarm and its state), the sources whose circuit breaker is open, and which log groups
the System errors search can read. Nothing secret: no full account id, no ARN, no address.

Every section is read on its own: one that cannot be read answers `{"unavailable": true}`
instead of failing the whole answer. The platform version is the SPA's own build constant
(Administration → System → Version), not repeated here: a Lambda environment variable carrying
it would change every template on every release.
"""
from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.avatar import avatars_enabled
from shared.enabled_sources import default_source_ids
from shared.logging import logger
from shared.model_config import (
    ALLOWED_MODEL_IDS,
    MODEL_SETTINGS_PK,
    MODEL_SETTINGS_SK,
    PICKER_SURFACES,
    get_active_model_id,
    inference_scope,
)
from shared.ops_alerts import ALERTS_SETTINGS_KEY, load_targets, owned_alarms
from shared.pii_redaction import redact_text
from shared.plugin_circuit import CircuitReadError, read_circuits
from shared.prompts import get_avatar_prompt_config
from shared.system_log_sources import LogSources

WEB_SEARCH_ENV: Final = 'WEB_SEARCH_ENABLED'
UNAVAILABLE: Final = {'unavailable': True}
_READ_ERRORS: Final = (ClientError, BotoCoreError, CircuitReadError, KeyError, TypeError, ValueError)


def _section(name: str, read: Callable[[], Any]) -> Any:
    try:
        return read()
    except _READ_ERRORS as error:
        logger.warning('System environment section unreadable', extra={'section': name,
                                                                      'error_type': type(error).__name__})
        return UNAVAILABLE


def _account_suffix(function_arn: str) -> str | None:
    parts = function_arn.split(':')
    return parts[4][-4:] if len(parts) > 4 and parts[4].isdigit() else None


def _image_model() -> dict[str, Any]:
    config = get_avatar_prompt_config()['image_model']
    return {'id': str(config['model_id']), 'region': str(config['region']), 'avatars_enabled': avatars_enabled()}


def _models(table: Any) -> dict[str, Any]:
    item = table.get_item(Key={'pk': MODEL_SETTINGS_PK, 'sk': MODEL_SETTINGS_SK}).get('Item') if table else None
    surfaces = item.get('surfaces') if isinstance(item, dict) else None
    overrides = {str(surface): str(model) for surface, model in (surfaces or {}).items()
                 if isinstance(model, str) and model in ALLOWED_MODEL_IDS}
    return {'effective': {surface: get_active_model_id(surface) for surface in PICKER_SURFACES},
            'overrides': overrides}


def _alerting(table: Any, cloudwatch: Any) -> dict[str, Any]:
    targets = load_targets()
    if targets is None:
        return {'configured': False}
    row = table.get_item(Key=ALERTS_SETTINGS_KEY).get('Item') if table else None
    alarms = owned_alarms(cloudwatch, targets)
    stored = row.get('enabled') if isinstance(row, dict) else None
    prefix = f'{targets.alarm_prefix}-'
    return {
        'configured': True,
        'enabled': stored if isinstance(stored, bool) else bool(alarms),
        'alarms': [{'name': alarm['name'].removeprefix(prefix), 'state': alarm['state']} for alarm in alarms],
        'in_alarm': sum(1 for alarm in alarms if alarm['state'] == 'ALARM'),
    }


def _open_circuits() -> list[dict[str, Any]]:
    states = read_circuits(default_source_ids(), include_error=True)
    return [{'source': source, 'tripped_at': state['tripped_at'], 'failure_count': state['failure_count'],
             'last_error': redact_text(state['last_error']).text if state['last_error'] else None}
            for source, state in states.items() if state['tripped']]


def environment(table: Any, cloudwatch: Any, function_arn: str) -> dict[str, Any]:
    """The `GET /logs/system/environment` body."""
    sources = LogSources.from_env()
    return {
        'region': os.environ.get('AWS_REGION') or None,
        'account_suffix': _account_suffix(function_arn),
        'deployment_prefix': sources.deployment_prefix(),
        'enabled_sources': default_source_ids(),
        'web_search': os.environ.get(WEB_SEARCH_ENV, '') == 'true',
        'inference_scope': inference_scope(),
        'image_model': _section('image_model', _image_model),
        'models': _section('models', lambda: _models(table)),
        'alerting': _section('alerting', lambda: _alerting(table, cloudwatch)),
        'open_circuits': _section('open_circuits', _open_circuits),
        'log_coverage': sources.coverage(),
    }
