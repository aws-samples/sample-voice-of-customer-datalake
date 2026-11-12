"""voc-engineering-runtime: the supervisor's tick, the launcher, the run monitor's signals, the rule's switch.

- ``{"action": "tick"}``: the supervisor's EventBridge rule, every minute while any run is active
  (``supervisor.Supervisor.tick``); records the heartbeat metrics.
- ``{"action": "launch", ...}``: the run coordinator starting one agent on one task: the MicroVM from the
  agent's image, with its egress allowlist, and the session row (the first tick hands it its role session).
- ``{"action": "signal", "run_id", "agent_id"?, "signal"}``: the run monitor's Save, Pause, Resume, Shut down
  and Stop now (``Supervisor.signal``).
- ``{"action": "switch", "enabled": true|false}``: the runs' own transitions turn the rule on (a run
  starts) and off (the last active run ends), after the transaction that changed their active-run count,
  and re-read that count afterwards; the supervisor never switches it itself.

The board, the bus and the run's controls are not this track's: until they land they are
``ports.PendingPorts``, which refuse, and the runtime stays behind ``-c engineeringAgents=true``.
"""
from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Mapping
from functools import cache
from typing import Any, Final, TypeGuard

from aws_lambda_powertools.metrics import MetricUnit

from engineering.runtime import caps, egress
from engineering.runtime.checkout import checkout_commands
from engineering.runtime.checkpoints import CheckpointReader
from engineering.runtime.interface import AgentSpec, MicroVmRuntime, RuntimeRefused
from engineering.runtime.launcher import Launcher
from engineering.runtime.ports import PendingPorts
from engineering.runtime.sessions import LIVE_STATUSES, AgentSession, SessionStore
from engineering.runtime.supervisor import Supervisor
from shared.invocation_cost import measure_invocation_cost
from shared.logging import logger, metrics

MAX_HARNESS_ARGS: Final = 32

_supervisor_cache: Supervisor | None = None
clock: Callable[[], float] = time.time


@cache
def _sts_client() -> Any:
    import boto3
    return boto3.client('sts')


def _runtime() -> MicroVmRuntime:
    """Lambda MicroVMs, always: the local fake (no sandbox) is for tests, which put it in place themselves."""
    from engineering.runtime.aws import AwsMicroVmRuntime
    from shared.aws import get_lambda_client
    return AwsMicroVmRuntime(get_lambda_client(), json.loads(os.environ.get('ENGINEERING_IMAGE_ARNS', '{}')))


def _supervisor() -> Supervisor:
    global _supervisor_cache
    if _supervisor_cache is None:
        from shared.aws import get_dynamodb_resource, get_s3_client
        bucket = os.environ['RAW_DATA_BUCKET']
        pending = PendingPorts()
        _supervisor_cache = Supervisor(
            runtime=_runtime(),
            sessions=SessionStore(get_dynamodb_resource().Table(os.environ['AGENTS_TABLE'])),
            board=pending, bus=pending, control=pending,
            launcher=Launcher(_sts_client(), json.loads(os.environ['ENGINEERING_AGENT_ROLE_ARNS'])),
            checkpoints=CheckpointReader(get_s3_client(), bucket),
            bucket=bucket,
            timings=caps.timings(json.loads(os.environ.get('ENGINEERING_TIMINGS', '{}'))),
        )
    return _supervisor_cache


def tick(_event: Mapping[str, Any]) -> dict[str, Any]:
    now = clock()
    statuses = _supervisor().tick(int(now))
    # Embedded metrics (no API call), only while the rule runs: the heartbeat alarm's and the run monitor's.
    live = sum(count for status, count in statuses.items() if status in LIVE_STATUSES)
    metrics.add_metric(name='EngineeringSupervisorHeartbeat', unit=MetricUnit.Count, value=1)
    metrics.add_metric(name='EngineeringLiveSessions', unit=MetricUnit.Count, value=live)
    return {'sessions': statuses}


def signal(event: Mapping[str, Any]) -> dict[str, Any]:
    agent_id = event.get('agent_id')
    statuses = _supervisor().signal(str(event.get('run_id', '')), None if agent_id is None else str(agent_id),
                                    str(event.get('signal', '')), int(clock()))
    return {'agents': statuses}


def switch(event: Mapping[str, Any]) -> dict[str, Any]:
    enabled = event.get('enabled')
    if not isinstance(enabled, bool):
        raise RuntimeRefused('enabled must be true or false')
    from shared.aws import get_eventbridge_client
    events, name = get_eventbridge_client(), os.environ['SUPERVISOR_RULE_NAME']
    if enabled:
        events.enable_rule(Name=name)
    else:
        events.disable_rule(Name=name)
    return {'enabled': enabled}


def _strings(value: object) -> TypeGuard[list[str]]:
    """``value`` is a JSON list of strings (never one string, which would be read character by character)."""
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def launch(event: Mapping[str, Any]) -> dict[str, Any]:
    """Start one agent of a run on one task (refused when that agent already has a session in the run)."""
    harness = event.get('harness')
    if not _strings(harness) or not 0 < len(harness) <= MAX_HARNESS_ARGS:
        raise RuntimeRefused(f'harness must be an argv of 1-{MAX_HARNESS_ARGS} strings')
    paths = event.get('paths', [])
    if not _strings(paths):
        raise RuntimeRefused('paths must be a list of repository paths')
    commit = str(event.get('commit', ''))
    checkout_commands(commit, paths)  # refuses a bad commit or path before anything starts
    supervisor = _supervisor()
    role, language = str(event.get('role', '')), str(event.get('language', ''))
    allowlist = egress.egress_allowlist(
        role=role, language=language, region=os.environ.get('AWS_REGION', 'us-east-1'), bucket=supervisor.bucket,
        extra_hosts=json.loads(os.environ.get('ENGINEERING_EXTRA_EGRESS', '[]')))
    spec = AgentSpec(run_id=str(event.get('run_id', '')), agent_id=str(event.get('agent_id', '')), role=role,
                     task_id=str(event.get('task_id', '')), language=language, egress=allowlist,
                     connection=str(event.get('connection', '')))
    vm = supervisor.runtime.run(spec)
    try:
        session = supervisor.sessions.create(AgentSession(
            run_id=spec.run_id, agent_id=spec.agent_id, role=role, task_id=spec.task_id, language=language,
            egress=allowlist, connection=spec.connection, commit=commit, paths=tuple(paths),
            harness=tuple(harness), vm_id=vm.vm_id, endpoint=vm.endpoint,
            started_at=int(clock()), last_tick_at=int(clock())))
    except Exception:
        # No session row, no MicroVM: one that nothing supervises would run until its idle policy.
        supervisor.runtime.terminate(vm)
        raise
    return {'run_id': session.run_id, 'agent_id': session.agent_id, 'status': session.status}


ACTIONS: Final[dict[str, Callable[[Mapping[str, Any]], dict[str, Any]]]] = {
    'tick': tick, 'launch': launch, 'signal': signal, 'switch': switch,
}


@metrics.log_metrics
@measure_invocation_cost
def lambda_handler(event: Mapping[str, Any], context: object) -> dict[str, Any]:
    action = ACTIONS.get(str(event.get('action')))
    if action is None:
        raise RuntimeRefused(f'unknown action {event.get("action")!r}')
    answer = action(event)
    logger.info('engineering runtime', extra={'action': event.get('action')})
    return answer
