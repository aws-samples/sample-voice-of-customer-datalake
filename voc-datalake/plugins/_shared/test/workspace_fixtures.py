"""The workspaces a plugin test runs in (docs/multi-workspace.md): two well-formed ids, their scopes, and the event of
a run in one of them."""
from collections.abc import Callable
from unittest.mock import MagicMock, call, patch

from shared.ws_repo import WorkspaceScope

WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
OTHER_WS = 'ws_7ZZZZZZZZZZZZZZZZZZZZZZZZZ'
SCOPE = WorkspaceScope(WS)
OTHER_SCOPE = WorkspaceScope(OTHER_WS)
#: Where each workspace's files sit in the import bucket: a run in it reads no other key (s3_import ``_staged_key``).
WS_PREFIX = f'ws/{WS}/'
OTHER_WS_PREFIX = f'ws/{OTHER_WS}/'
#: The credentials parameter a run of the test plugin in ``WS`` reads (decision 19; plugins/conftest.py
#: WORKSPACE_PARAMETER_PREFIX and SOURCE_PLATFORM): the name its double is asked for.
SECRET_NAME = f'/voc/ws/{WS}/credentials/test_source'
#: An EventBridge scheduled event: the plugin's tick, which names no workspace.
SCHEDULED_TICK = {
    'version': '0', 'id': 'tick-1', 'detail-type': 'Scheduled Event', 'source': 'aws.events',
    'account': '123456789012', 'time': '2026-11-12T08:00:00Z', 'region': 'us-east-1',
    'resources': ['arn:aws:events:us-east-1:123456789012:rule/voc-ingest-test-schedule'], 'detail': {},
}


def ws_event(**fields: object) -> dict:
    """The event of a run in ``WS`` (Run now, a continuation, the fan-out), plus ``fields``."""
    return {'workspace_id': WS, **fields}


#: Events that name no workspace at all: every ingestor runs them deployment-wide (scope None), as before workspaces.
EVENTS_NAMING_NO_WORKSPACE = ({}, {'execution_id': 'exec-7'})
#: Events whose ``workspace_id`` is not a workspace id: every ingestor refuses them, builds nothing, and never runs
#: them deployment-wide instead.
EVENTS_WITH_A_MALFORMED_WORKSPACE = (
    {'workspace_id': 'acme-outfitters'}, {'workspace_id': None}, {'workspace_id': ''}, {'workspace_id': 7},
    {'workspace_id': f'WS#{WS}'}, {'workspace_id': f' {WS}', 'execution_id': 'exec-7'},
)
#: What ``run_in_workspace`` answers for one of those.
REFUSED = {'status': 'refused', 'reason': 'invalid_workspace'}


def deployment_wide_events(run_now_id: str) -> list[tuple[object, str | None]]:
    """``(event, the execution id the deployment-wide ingestor is built with)`` for the events that name no
    workspace: the fixtures', the integrations API's Run now (lambda/api/integrations_handler.py run_source: the
    execution id only), and events that are not objects."""
    return [
        *((event, event.get('execution_id')) for event in EVENTS_NAMING_NO_WORKSPACE),
        ({'execution_id': run_now_id}, run_now_id),
        (None, None), ([], None),
    ]


def fan_out_then_run(run: MagicMock, invoke: Callable[[], object]) -> tuple[object, list]:
    """Call ``invoke`` (a handler given the scheduled tick) and answer its result and the order of the tick's
    ``fan_out_once`` (patched for the call) and ``run``."""
    manager = MagicMock()
    manager.attach_mock(run, 'run')
    with patch('_shared.base_ingestor.fan_out_once') as fan_out:
        manager.attach_mock(fan_out, 'fan_out_once')
        result = invoke()
    return result, manager.mock_calls


#: What ``fan_out_then_run`` answers for the tick of the plugin ``test_source``: the fan-out first, then the run.
TICK_ORDER = (call.fan_out_once('test_source', SCHEDULED_TICK), call.run())
#: ``(event, the execution id the ingestor is built with)``: a Run now's, a scheduled run's, a misspelt key's.
EXECUTION_ID_EVENTS = (
    (ws_event(execution_id='exec-7'), 'exec-7'), (ws_event(), None), (ws_event(executionId='exec-7'), None),
)
