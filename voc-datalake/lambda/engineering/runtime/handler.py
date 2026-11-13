"""voc-engineering-runtime: a run's start and end, the supervisor's tick, the launcher, the run monitor's signals.

- ``{"action": "start_run", "run_id", "max_tasks", "max_tokens"?, "max_cost_usd"?, "goal"?, "repo"?, "flow"?,
  "connection"?, "commit"?, "language"?, "actor"?}``: the run's ``META`` row and its ``coordinate`` task
  (``runs.RunStore.start``), the supervisor's rule switched on, and, for a run with its connection, commit and
  language, its coordinator launched on that task (``coordinator-1``, on the coordinator's skill's harness). A
  retry of a run that is live switches the rule on again, keeps the first start's caps and launches the
  coordinator only if the run is active and no session of it exists yet.
- ``{"action": "end_run", "run_id", "status", "actor"?}``: the run ended (``done``, ``failed`` or ``stopped``), every
  MicroVM of it ended (one busy with another move at the next tick, which sees the run ended), then settled. A
  retry of an ended run does the rest again and keeps the first end's status.
- ``{"action": "tick"}``: the supervisor's EventBridge rule, every minute while any run is listed
  (``supervisor.Supervisor.tick``), then settled; records the heartbeat metrics.
- Settling: an ended run without a live agent is no longer listed (``RunStore.release``); with no run listed the
  rule is switched off, and the list re-read after that switch (a run that started meanwhile turns it back on).
- ``{"action": "launch", ...}``: the run coordinator starting one agent of an active run on one task: the
  MicroVM from the agent's image, with its egress allowlist, and the session row (the first tick hands it its
  role session).
- ``{"action": "signal", "run_id", "agent_id"?, "signal", "attempt"?, "actor"?}``: the run monitor's Save, Pause, Resume,
  Shut down and Stop now (``Supervisor.signal_detailed``): each agent's status, and whether the signal took effect
  (``applied``: not when busy, a failed move, or ``stale``, an agent on another attempt than the one given).

``delivery_handler`` is voc-engineering-delivery's entry point, the same code with a role of its own
(engineering-runtime.ts createDelivery): the router's message for an agent, the conductor or a role of a run,
recorded in the run's inbox and its addressees woken (``delivery.py``).

``actor`` is who asked (a person's id; the run monitor is to send it with its signals, and no caller sends it yet): a
run's start, its end and a person's Resume of the whole run record it with the change (D4: ``runs.py``), as
``unattributed`` when it is missing; the supervisor's decision points record ``supervisor``.

Both functions' supervisor reads the board through its store and speaks on the bus as the supervisor
(``board_bus.py``: ``ENGINEERING_BUS_NAME``); the run's controls are its own rows (``runs.TableRunControl``); a
Resume of the whole run also takes it off its decision point (``RunStore.resume``).
"""
from __future__ import annotations

import contextlib
import json
import os
import time
from collections.abc import Callable, Mapping
from functools import cache
from typing import Any, Final, TypeGuard

from aws_lambda_powertools.metrics import MetricUnit

from engineering.board.store import COORDINATE_TASK, COORDINATOR
from engineering.runtime import caps, egress
from engineering.runtime.checkout import checkout_commands
from engineering.runtime.checkpoints import CheckpointReader
from engineering.runtime.delivery import deliver
from engineering.runtime.harness.skills import harness_argv, skill_for, skill_label
from engineering.runtime.interface import AgentSpec, MicroVmRuntime, RuntimeRefused
from engineering.runtime.launcher import Launcher
from engineering.runtime.runs import (
    COORDINATOR_AGENT,
    ENDED,
    RunCaps,
    RunExists,
    RunNotActive,
    RunStore,
    TableRunControl,
)
from engineering.runtime.sessions import LIVE_STATUSES, AgentSession, SessionStore, StaleSession
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
        from engineering.runtime.board_bus import wired
        from shared.aws import get_dynamodb_client, get_dynamodb_resource, get_eventbridge_client, get_s3_client
        bucket, workspace = os.environ['RAW_DATA_BUCKET'], os.environ['ENGINEERING_WORKSPACE_BUCKET']
        table = os.environ['ENGINEERING_TABLE']
        board, bus = wired(get_dynamodb_client(), table, get_eventbridge_client(), os.environ['ENGINEERING_BUS_NAME'])
        runs = _runs()
        _supervisor_cache = Supervisor(
            runtime=_runtime(),
            sessions=SessionStore(get_dynamodb_resource().Table(table), runs,
                                  caps.microvm_price(os.environ.get('ENGINEERING_MICROVM_USD_PER_SECOND'))),
            board=board, bus=bus, control=TableRunControl(runs, clock),
            launcher=Launcher(_sts_client(), json.loads(os.environ['ENGINEERING_AGENT_ROLE_ARNS'])),
            checkpoints=CheckpointReader(get_s3_client(), workspace),
            bucket=bucket, workspace_bucket=workspace,
            timings=caps.timings(json.loads(os.environ.get('ENGINEERING_TIMINGS', '{}'))),
            board_url=os.environ['ENGINEERING_BOARD_URL'],
        )
    return _supervisor_cache


def _runs() -> RunStore:
    from shared.aws import get_dynamodb_resource
    return RunStore(get_dynamodb_resource().Table(os.environ['ENGINEERING_TABLE']))


def tick(_event: Mapping[str, Any]) -> dict[str, Any]:
    now = clock()
    statuses = _supervisor().tick(int(now))
    _settle()
    # Embedded metrics (no API call), only while the rule runs: the heartbeat alarm's and the run monitor's.
    live = sum(count for status, count in statuses.items() if status in LIVE_STATUSES)
    metrics.add_metric(name='EngineeringSupervisorHeartbeat', unit=MetricUnit.Count, value=1)
    metrics.add_metric(name='EngineeringLiveSessions', unit=MetricUnit.Count, value=live)
    return {'sessions': statuses}


def signal(event: Mapping[str, Any]) -> dict[str, Any]:
    """``{"agents": {agent: status}, "applied": {agent: bool}}``: ``applied`` false where nothing took effect (busy,
    a failed move, or ``stale`` when the ``attempt`` given is not the one the agent works on)."""
    agent_id, run_id, kind = event.get('agent_id'), str(event.get('run_id', '')), str(event.get('signal', ''))
    attempt = _optional_number(event, 'attempt', int)
    answers = _supervisor().signal_detailed(run_id, None if agent_id is None else str(agent_id), kind, int(clock()),
                                            attempt)
    if kind == 'resume' and agent_id is None:
        # The supervisor accepted it (the run is not ended, its budget not spent): the run may launch agents again.
        with contextlib.suppress(RunNotActive):  # it was not at a decision point
            _runs().resume(run_id, now=int(clock()), actor=str(event.get('actor') or ''))
    return {'agents': {agent: status for agent, (status, _) in answers.items()},
            'applied': {agent: applied for agent, (_, applied) in answers.items()}}


def _switch(enabled: bool) -> None:
    """Turn the supervisor's rule on or off (idempotent: a rule already in that state stays so)."""
    from shared.aws import get_eventbridge_client
    events, name = get_eventbridge_client(), os.environ['SUPERVISOR_RULE_NAME']
    if enabled:
        events.enable_rule(Name=name)
    else:
        events.disable_rule(Name=name)


def _optional_number(event: Mapping[str, Any], name: str, kind: type) -> Any:
    """``event[name]`` as ``kind`` (an int only from a whole number), None when absent; never a bool."""
    value = event.get(name)
    accepted = (int,) if kind is int else (int, float)
    if value is not None and (isinstance(value, bool) or not isinstance(value, accepted)):
        raise RuntimeRefused(f'{name} must be a number')
    return None if value is None else kind(value)


def _settle() -> None:
    """Stop listing every ended run without a live agent; with none listed, switch the rule off and re-read."""
    runs, sessions = _runs(), _supervisor().sessions
    for run_id in runs.listed():
        run = runs.get(run_id)
        if run is None:
            logger.error('engineering runtime: a listed run has no META row', extra={'run_id': run_id})
        if (run is None or run.status in ENDED) and not sessions.any_live_or_moving(run_id, int(clock())):
            runs.release(run_id)
    if not runs.listed():
        _switch(False)
        if runs.listed():
            _switch(True)


def _attempt(supervisor: Supervisor, run_id: str, task_id: str, given: int | None) -> int:
    """The task's attempt, as the board has it (a launch naming another is refused: the agent's lease epoch is the
    attempt, and the supervisor ends a session at another); 1, or the one given, for a task not on the board yet."""
    lease = supervisor.board.lease(run_id, task_id)
    if lease is None:
        return 1 if given is None else given
    if given is not None and given != lease.attempt:
        raise RuntimeRefused(f'the task is at attempt {lease.attempt}, not {given}')
    return lease.attempt


def _harness(event: Mapping[str, Any]) -> tuple[tuple[str, ...], dict[str, str]]:
    """The agent's harness argv and what the reports name it by: its role's skill's (a request that names another
    argv for it is refused), else the request's (a role with no skill yet)."""
    skill = skill_for(str(event.get('role', '')))
    given = event.get('harness')
    if skill is not None:
        argv = harness_argv(skill)
        if given is not None and (not _strings(given) or tuple(given) != argv):
            raise RuntimeRefused(f'a {skill.name} runs its skill\'s harness '
                                 f'({skill_label(skill.name, skill.version)}), not another')
        return argv, {'model': skill.model, 'skill_version': skill_label(skill.name, skill.version)}
    if not _strings(given) or not 0 < len(given) <= MAX_HARNESS_ARGS:
        raise RuntimeRefused(f'harness must be an argv of 1-{MAX_HARNESS_ARGS} strings (the role has no skill yet)')
    return tuple(given), {'model': str(event.get('model', ''))[:200],
                          'skill_version': str(event.get('skill_version', ''))[:200]}


def _launch_coordinator(run_id: str) -> None:
    """Launch the run's coordinator on its ``coordinate`` task, at the task's attempt, once: never for a run
    without its connection, commit and language, nor when a session of it exists (a retried start's)."""
    run = _runs().get(run_id)
    if run is None or run.status != 'active' or not (run.connection and run.commit and run.language):
        return
    if _supervisor().sessions.get(run_id, COORDINATOR_AGENT) is None:
        with contextlib.suppress(StaleSession):   # a retried start racing this one: its launch is the run's
            launch({'run_id': run_id, 'agent_id': COORDINATOR_AGENT, 'role': COORDINATOR,
                    'task_id': COORDINATE_TASK, 'language': run.language, 'paths': [], 'commit': run.commit,
                    'connection': run.connection})


def start_run(event: Mapping[str, Any]) -> dict[str, Any]:
    """Start a run with its caps and launch its coordinator; the supervisor's rule is on from then."""
    caps = RunCaps(max_tasks=_optional_number(event, 'max_tasks', int) or 0,
                   max_tokens=_optional_number(event, 'max_tokens', int),
                   max_cost_usd=_optional_number(event, 'max_cost_usd', float))
    run_id, runs, status = str(event.get('run_id', '')), _runs(), 'active'
    try:
        runs.start(run_id, caps=caps, now=int(clock()), goal=str(event.get('goal', '')),
                   repo=str(event.get('repo', '')), flow=str(event.get('flow', '')),
                   connection=str(event.get('connection', '')), commit=str(event.get('commit', '')),
                   language=str(event.get('language', '')), actor=str(event.get('actor') or ''))
    except RunExists:
        run = runs.get(run_id)
        if run is None or run.status in ENDED:
            raise
        status = run.status  # a retry of a live run: its rule may never have been switched on
    _switch(True)
    _launch_coordinator(run_id)
    return {'run_id': run_id, 'status': status}


def end_run(event: Mapping[str, Any]) -> dict[str, Any]:
    """End a run and every MicroVM of it, then settle."""
    run_id, status, runs = str(event.get('run_id', '')), str(event.get('status', '')), _runs()
    try:
        runs.end(run_id, status, now=int(clock()), actor=str(event.get('actor') or ''))
    except RunNotActive:
        run = runs.get(run_id)
        if run is None or run.status not in ENDED:
            raise
        status = run.status  # a retry: the rest of the first end is done again
    agents = _supervisor().signal(run_id, None, 'stop_now', int(clock()))
    _settle()
    return {'run_id': run_id, 'status': status, 'agents': agents}


def _strings(value: object) -> TypeGuard[list[str]]:
    """``value`` is a JSON list of strings (never one string, which would be read character by character)."""
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def launch(event: Mapping[str, Any]) -> dict[str, Any]:
    """Start one agent of a run on one task (refused when that agent already has a session in the run)."""
    harness, labels = _harness(event)
    paths = event.get('paths', [])
    if not _strings(paths):
        raise RuntimeRefused('paths must be a list of repository paths')
    commit = str(event.get('commit', ''))
    checkout_commands(commit, paths)  # refuses a bad commit or path before anything starts
    supervisor = _supervisor()
    run = _runs().get(str(event.get('run_id', '')))
    if run is None or run.status != 'active':
        raise RunNotActive('agents are launched only for an active run')
    role, language = str(event.get('role', '')), str(event.get('language', ''))
    allowlist = egress.egress_allowlist(
        role=role, language=language, region=os.environ.get('AWS_REGION', 'us-east-1'), bucket=supervisor.bucket,
        workspace_bucket=supervisor.workspace_bucket,
        extra_hosts=json.loads(os.environ.get('ENGINEERING_EXTRA_EGRESS', '[]')), service_urls=[supervisor.board_url])
    attempt = _attempt(supervisor, str(event.get('run_id', '')), str(event.get('task_id', '')),
                       _optional_number(event, 'attempt', int))
    spec = AgentSpec(run_id=str(event.get('run_id', '')), agent_id=str(event.get('agent_id', '')), role=role,
                     task_id=str(event.get('task_id', '')), language=language, egress=allowlist,
                     connection=str(event.get('connection', '')), commit=commit, attempt=attempt,
                     workspace_bucket=supervisor.workspace_bucket, board_url=supervisor.board_url)
    vm = supervisor.runtime.run(spec)
    try:
        session = supervisor.sessions.create(AgentSession(
            run_id=spec.run_id, agent_id=spec.agent_id, role=role, task_id=spec.task_id, language=language,
            egress=allowlist, connection=spec.connection, commit=commit, paths=tuple(paths),
            harness=tuple(harness), vm_id=vm.vm_id, endpoint=vm.endpoint, task_attempt=attempt,
            started_at=int(clock()), last_tick_at=int(clock())),
            labels)
    except Exception:
        # No session row, no MicroVM: one that nothing supervises would run until its idle policy.
        supervisor.runtime.terminate(vm)
        raise
    return {'run_id': session.run_id, 'agent_id': session.agent_id, 'status': session.status}


@metrics.log_metrics
@measure_invocation_cost
def delivery_handler(event: Mapping[str, Any], context: object) -> dict[str, Any]:
    """voc-engineering-delivery: the router's asynchronous ``{"message", "seq"}`` (``delivery.deliver``)."""
    from shared.aws import get_dynamodb_resource
    table = get_dynamodb_resource().Table(os.environ['ENGINEERING_TABLE'])
    answer = deliver(event, table=table, supervisor=_supervisor(), now=int(clock()))
    logger.info('engineering delivery', extra={'event_id': answer['event_id'], 'recorded': answer['recorded']})
    return answer


ACTIONS: Final[dict[str, Callable[[Mapping[str, Any]], dict[str, Any]]]] = {
    'start_run': start_run, 'end_run': end_run, 'tick': tick, 'launch': launch, 'signal': signal,
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
