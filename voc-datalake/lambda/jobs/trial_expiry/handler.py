"""voc-trial-expiry: a trial workspace's end (7.71.00; docs/multi-workspace.md "Trial workspaces"; the pause:
shared/trial_pause.py).

One way in: ``{"action": "trial_expiry"}``, the hourly EventBridge rule's input (lib/stacks/trial-expiry.ts). Each tick
reads the platform listing once (``WORKSPACES``, the rows that carry a trial: shared/trial_pause.py ``due_trials``) and
pauses each trial that is due: not converted, its ``expires_at`` passed, not paused yet (or paused within the last day,
so a pause a failed attempt left half done is finished). The pause reads the trial from the workspace's ``META`` again
(the stored ``expires_at`` decides) and sets ``paused_at`` first, then turns the workspace's plugins (the existing
audited disable) and its live forms off, everything recorded on the trial and in a ``trial_paused`` audit row. A trial
whose ``expires_at`` does not parse is never paused (skipped and logged). So a trial pauses within the hour after its
end, and an extension or a conversion needs nothing but its own write.

It never deletes anything but the plugins' own enable rows (``PLUGIN#{plugin}`` / ``WS#{ws}``, which ARE the existing
disable): no workspace, form, response, feedback item, project, file or audit row. A whole-workspace delete stays the
data controller's own request (shared/workspace_deletes.py, only with ``-c workspaceHardDelete=true``).

Env: ``WORKSPACES_TABLE``, ``AGGREGATES_TABLE`` (the workspace's forms), ``ENABLED_SOURCES`` (the deployment's plugins).
"""
from __future__ import annotations

import os
from collections import Counter
from datetime import UTC, datetime
from typing import Any, Final

from shared.aws import get_dynamodb_resource
from shared.enabled_sources import enabled_plugin_ids
from shared.exceptions import ConfigurationError
from shared.ingest_tables import ingest_table
from shared.invocation_cost import instrumented_handler
from shared.logging import logger
from shared.trial_pause import PauseTables, due_trials, pause
from shared.warm_init import warm_at_init

WORKSPACES_TABLE: Final = os.environ.get('WORKSPACES_TABLE', '')
AGGREGATES_TABLE: Final = os.environ.get('AGGREGATES_TABLE', '')
IGNORED: Final = 'ignored'
#: The rule's input (lib/stacks/trial-expiry.ts TRIAL_EXPIRY_INPUT).
EXPIRY_ACTION: Final = 'trial_expiry'
SWEPT: Final = 'swept'
PAUSE_FAILED: Final = 'failed'


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
    """The hourly tick: every due trial paused (shared/trial_pause.py ``pause``); how many trials ended in each
    outcome. One trial that fails, whatever the error, is logged, counted ``PAUSE_FAILED`` and left for the next tick,
    never stopping the others."""
    if not isinstance(event, dict) or event.get('action') != EXPIRY_ACTION:
        # Only its own rule invokes it: anything else is logged and left alone.
        logger.warning('trial_expiry ignored an event it does not take')
        return {'outcome': IGNORED}
    outcomes: Counter[str] = Counter()
    for ws in due_trials(tables.workspaces, now):
        try:
            outcome = pause(tables, ws, now)
        except Exception:
            # Any error of one trial (AWS, a write that lost a race, a stored map the code does not expect): the
            # others are still paused, and the next tick tries this one again.
            logger.exception('trial_expiry could not pause a trial', extra={'workspace_id': ws})
            outcomes[PAUSE_FAILED] += 1
            continue
        logger.info('trial_expiry', extra={'workspace_id': ws, **outcome})
        outcomes[str(outcome['outcome'])] += 1
    return {'outcome': SWEPT, **outcomes}


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource)


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return handle_event(event, _tables(), datetime.now(UTC))
