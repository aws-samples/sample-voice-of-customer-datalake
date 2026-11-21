"""voc-trial-expiry: a trial workspace's end (7.71.00; docs/multi-workspace.md "Trial workspaces"; the pause:
shared/trial_pause.py).

One way in: ``{"action": "trial_expiry", "workspace_id", "expires_at"}``, from the trial's one-time EventBridge Scheduler
schedule (shared/trial_schedule.py), which deletes itself once it has run. The job reads the trial from the workspace's
``META`` (the stored ``expires_at`` decides, never the event's) and, when it is due, pauses it: ``paused_at`` first,
then the workspace's plugins (the existing audited disable) and its live forms turned off, everything recorded on the
trial and in a ``trial_paused`` audit row. Nothing else: a trial that is converted, not active (being deleted), not
due yet (an extension moved its end; a newer schedule waits for that) or no trial at all is answered as such. Running
it again finishes a pause a failed attempt left half done and changes nothing once it is done.

It never deletes anything but the plugins' own enable rows (``PLUGIN#{plugin}`` / ``WS#{ws}``, which ARE the existing
disable): no workspace, form, response, feedback item, project, file or audit row. A whole-workspace delete stays the
data controller's own request (shared/workspace_deletes.py, only with ``-c workspaceHardDelete=true``).

Env: ``WORKSPACES_TABLE``, ``AGGREGATES_TABLE`` (the workspace's forms), ``ENABLED_SOURCES`` (the deployment's plugins).
"""
from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Any, Final

from shared.aws import get_dynamodb_resource
from shared.enabled_sources import enabled_plugin_ids
from shared.exceptions import ConfigurationError
from shared.ingest_tables import ingest_table
from shared.invocation_cost import instrumented_handler
from shared.logging import logger
from shared.trial_pause import PauseTables, pause
from shared.trial_schedule import EXPIRY_ACTION
from shared.warm_init import warm_at_init
from shared.workspace_ids import is_workspace_id

WORKSPACES_TABLE: Final = os.environ.get('WORKSPACES_TABLE', '')
AGGREGATES_TABLE: Final = os.environ.get('AGGREGATES_TABLE', '')
IGNORED: Final = 'ignored'


def _tables() -> PauseTables:
    if not (WORKSPACES_TABLE and AGGREGATES_TABLE):
        raise ConfigurationError('WORKSPACES_TABLE and AGGREGATES_TABLE are required')
    resource = get_dynamodb_resource()
    # voc-workspaces is the control plane (the trial, the plugin rows, the audit rows); the forms go through the
    # workspace layer (ws_table), so a key outside the trial's workspace is refused before DynamoDB.
    return PauseTables(workspaces=resource.Table(WORKSPACES_TABLE),
                       forms=lambda scope: ingest_table(scope, resource, AGGREGATES_TABLE),
                       ceiling=enabled_plugin_ids())


def handle_event(event: object, tables: PauseTables, now: datetime) -> dict[str, Any]:
    """The schedule's event: the trial's pause when it is due (shared/trial_pause.py ``pause``), or why not."""
    if not isinstance(event, dict) or event.get('action') != EXPIRY_ACTION or not is_workspace_id(event.get('workspace_id')):
        # Only its own schedules invoke it: anything else is logged and left alone.
        logger.warning('trial_expiry ignored an event it does not take')
        return {'outcome': IGNORED}
    ws = str(event['workspace_id'])
    outcome = pause(tables, ws, now)
    logger.info('trial_expiry', extra={'workspace_id': ws, **outcome})
    return outcome


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource)


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return handle_event(event, _tables(), datetime.now(UTC))
