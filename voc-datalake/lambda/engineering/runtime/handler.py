"""voc-engineering-runtime: a run's start and end, the supervisor's tick, the launcher, the run monitor's signals.

- ``{"action": "start_run", "run_id", "max_tasks", "max_tokens"?, "max_cost_usd"?, "goal"?, "repo"?, "flow"?,
  "connection"?, "commit"?, "language"?, "actor"?}``: the run's ``META`` row and its ``coordinate`` task
  (``runs.RunStore.start``), the supervisor's rule switched on, and, for a run with its connection, commit and
  language, its coordinator launched on that task (``coordinator-1``, on the coordinator's skill's harness). A run
  started without its connection or commit can launch no agent and read no knowledge (the board answers 409); one
  without its language gets no coordinator. A language this deployment has no MicroVM image for, or a coordinator
  with no skill, is refused before anything is written. A retry of a run that is live switches the rule on again,
  keeps the first start's caps and launches the coordinator only if the run is active and no session of it exists
  yet.
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
  (``applied``: not when busy, a failed move, or ``stale``, an agent on another attempt than the one given). A
  Resume of the whole run also makes sure the run has a coordinator, as its start does (``_ensure_coordinator``: a
  new one in place of one whose session failed).

``delivery_handler`` is voc-engineering-delivery's entry point, the same code with a role of its own
(engineering-runtime.ts createDelivery): the router's message for an agent, the conductor or a role of a run,
recorded in the run's inbox and its addressees woken (``delivery.py``).

``actor`` is who asked (a person's id: the run monitor sends it with its signals; nothing starts or ends a run with
it yet): a
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
from typing import TYPE_CHECKING, Any, Final, TypeGuard

from aws_lambda_powertools.metrics import MetricUnit

from engineering.board.store import COORDINATE_TASK, COORDINATOR, BoardError
from engineering.runtime import caps, egress
from engineering.runtime.checkout import checkout_commands
from engineering.runtime.checkpoints import CheckpointReader
from engineering.runtime.delivery import deliver
from engineering.runtime.harness.skills import harness_argv, skill_for, skill_label
from engineering.runtime.interface import AgentSpec, MicroVmRuntime, RuntimeRefused
from engineering.runtime.launcher import Launcher
from engineering.runtime.runs import (
    ENDED,
    UNATTRIBUTED,
    RunCaps,
    RunExists,
    RunNotActive,
    RunStore,
    TableRunControl,
)
from engineering.runtime.sessions import LIVE_STATUSES, AgentSession, LaunchUnderWay, SessionStore, StaleSession
from engineering.runtime.supervisor import SessionBusy, Supervisor
from shared.invocation_cost import measure_invocation_cost
from shared.logging import logger, metrics

if TYPE_CHECKING:
    from engineering.runtime.board_bus import SessionState

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


def signal_action(event: Mapping[str, Any]) -> dict[str, Any]:
    """The ``signal`` action: ``{"agents": {agent: status}, "applied": {agent: bool}}``, ``applied`` false where
    nothing took effect (busy, a failed move, or ``stale`` when the ``attempt`` given is not the one the agent works
    on). Named apart from every ``.signal`` attribute, which a reachability sweep matches by name (the delivery
    function never runs it)."""
    agent_id, run_id, kind = event.get('agent_id'), str(event.get('run_id', '')), str(event.get('signal', ''))
    attempt = _optional_number(event, 'attempt', int)
    answers = _supervisor().signal_detailed(run_id, None if agent_id is None else str(agent_id), kind, int(clock()),
                                            attempt)
    if kind == 'resume' and agent_id is None:
        # The supervisor accepted it (the run is not ended, its budget not spent): the run may launch agents again.
        with contextlib.suppress(RunNotActive):  # it was not at a decision point
            _runs().resume(run_id, now=int(clock()), actor=str(event.get('actor') or ''))
        # A run whose coordinator kept crashing waited for this Resume: it gets a new one. One under way is logged
        # (it may still start). A launch refused (its record cleared, as the board's are) or a MicroVM that will not
        # start is logged and sends the run back to a person, as a start does: never active with nobody planning it.
        try:
            _ensure_coordinator(run_id, str(event.get('actor') or ''))
        except SessionBusy:
            logger.info('engineering runtime: the run\'s coordinator launch is under way', extra={'run_id': run_id})
        except Exception:
            logger.exception('engineering runtime: the run\'s coordinator was not launched', extra={'run_id': run_id})
            with contextlib.suppress(RunNotActive):   # (ended meanwhile)
                _runs().needs_human(run_id, 'coordinator', now=int(clock()),
                                    actor=str(event.get('actor') or '') or UNATTRIBUTED)
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


def _image_languages() -> frozenset[str]:
    """The languages this deployment has a MicroVM image for (``ENGINEERING_IMAGE_ARNS``, the runtime's own)."""
    return frozenset(json.loads(os.environ.get('ENGINEERING_IMAGE_ARNS', '{}')))


def _coordinator_launchable(language: str) -> None:
    """What the coordinator's launch would refuse, refused before a coordinator is numbered (the board's launch op
    checks the same before it numbers an agent: ``BoardApi._check_launchable``): the coordinator role with no skill,
    a language this deployment has no MicroVM image for."""
    if skill_for(COORDINATOR) is None:
        raise RuntimeRefused('no coordinator can be launched yet: the role has no skill')
    images = _image_languages()
    if language not in images:
        raise RuntimeRefused(f'no {language} image in this deployment: start the run in one of '
                             f'{sorted(images) or "none yet"}')


def _ensure_coordinator(run_id: str, actor: str) -> None:
    """Make sure an active run with its connection, commit and language has a coordinator: the one its coordinate
    task records, started when it has no session yet (the run's start, ``coordinator-1``; a start whose MicroVM
    failed), or a new one in its place when its session failed: it kept crashing, which sent the run to a person
    (``BoardLeases.coordinator_to_start``). Nothing for a run whose coordinator is live or held (a Resume continues
    a held one itself), nor one a person shut down or stopped. A refusal of the board's (the run's agent cap, a
    racing start or Resume that moved the task on) is logged, never raised: the Resume it follows was applied.

    The launch follows the board's launch rules: a coordinator that cannot be launched (no skill, no image) is
    refused before one is numbered; ``launch`` answers a repeat from its session and refuses one while another
    launch of it still starts (``SessionBusy``, raised with the record kept: a start asks again, the run being
    written; a Resume logs it) before any other check; and a refusal that means no session and no launch of it exist
    (the board's ``CLEARS_LAUNCH``) clears its record on the coordinate task, so the next start or Resume numbers a
    new one, and is raised. A Resume logs every failure here (``signal_action``): it was applied."""
    from engineering.board.api import CLEARS_LAUNCH
    from engineering.runtime.board_bus import BoardLeases
    run = _runs().get(run_id)
    if run is None or run.status != 'active' or not (run.connection and run.commit and run.language):
        return
    supervisor = _supervisor()
    if not isinstance(supervisor.board, BoardLeases):
        raise RuntimeRefused('the supervisor has no board to start a coordinator on')
    # (one label for "nobody named", on the board's history rows as on the run's RUNLOG rows)
    board, who = supervisor.board, actor or UNATTRIBUTED

    def state(agent_id: str) -> SessionState:
        session = supervisor.sessions.get(run_id, agent_id)
        if session is None:
            return 'none'
        return 'failed' if session.status == 'failed' else 'kept'

    try:
        found = board.coordinator_to_start(run_id, state, actor=who,
                                           launchable=lambda: _coordinator_launchable(run.language))
    except BoardError as error:
        if error.kind not in ('cap', 'conflict'):
            raise
        logger.warning('engineering runtime: no new coordinator', extra={'run_id': run_id, 'reason': str(error)})
        return
    if found is None:
        return
    agent_id, attempt = found
    try:
        launch({'run_id': run_id, 'agent_id': agent_id, 'role': COORDINATOR, 'task_id': COORDINATE_TASK,
                'attempt': attempt, 'language': run.language, 'paths': [], 'commit': run.commit,
                'connection': run.connection})
    except SessionBusy:
        # Another start's or Resume's launch of it is under way (or one killed while its MicroVM booted, until its
        # hold runs out): it keeps its record, and the caller asks again (the run is written).
        raise
    except (RuntimeRefused, StaleSession) as refused:
        if type(refused).__name__ in CLEARS_LAUNCH:
            board.clear_coordinator(run_id, agent_id, attempt, actor=who, reason=str(refused))
        raise


def start_run(event: Mapping[str, Any]) -> dict[str, Any]:
    """Start a run with its caps, its repository ``connection`` and ``commit`` (the board's ``launch`` and
    ``knowledge`` read them from META) and its ``language``, and launch its coordinator; the supervisor's rule is on
    from then. A first start that names a ``language`` is refused, before anything is written, when the coordinator
    cannot be launched (``_coordinator_launchable``), with or without its connection and commit (a run without them
    never gets a coordinator, but no run records a language this deployment cannot run); a start with all three
    numbers it ``coordinator-1``. A start
    whose coordinator then fails to launch (its MicroVM did not start, or the runtime refused it) sends the run to a
    person (``needs_human`` ``coordinator``), whose Resume launches it, and raises the failure."""
    caps = RunCaps(max_tasks=_optional_number(event, 'max_tasks', int) or 0,
                   max_tokens=_optional_number(event, 'max_tokens', int),
                   max_cost_usd=_optional_number(event, 'max_cost_usd', float))
    run_id, runs, status = str(event.get('run_id', '')), _runs(), 'active'
    language = str(event.get('language', ''))
    if language and runs.get(run_id) is None:   # (any first start naming a language: no run records one it cannot run)
        _coordinator_launchable(language)
    try:
        runs.start(run_id, caps=caps, now=int(clock()), goal=str(event.get('goal', '')),
                   repo=str(event.get('repo', '')), flow=str(event.get('flow', '')),
                   connection=str(event.get('connection', '')), commit=str(event.get('commit', '')),
                   language=language, actor=str(event.get('actor') or ''))
    except RunExists:
        run = runs.get(run_id)
        if run is None or run.status in ENDED:
            raise
        status = run.status  # a retry of a live run: its rule may never have been switched on
    _switch(True)
    try:
        _ensure_coordinator(run_id, str(event.get('actor') or ''))
    except SessionBusy:
        raise   # (another start's launch of it is under way: ask again)
    except Exception:
        # Its MicroVM did not start, or the runtime refused it: the run goes to a person (the coordinator's
        # decision point, the run monitor's Resume prompt), never left active with no coordinator and no session.
        with contextlib.suppress(RunNotActive):   # (ended meanwhile)
            runs.needs_human(run_id, 'coordinator', now=int(clock()),
                             actor=str(event.get('actor') or '') or UNATTRIBUTED)
        raise
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


def _launched(sessions: SessionStore, spec: AgentSpec) -> dict[str, Any] | None:
    """The agent's session when a launch of it already wrote one: for the same task and attempt, what that launch
    answered (a repeat is the same launch); for another, ``StaleSession`` (not this launch's agent); else None."""
    session = sessions.get(spec.run_id, spec.agent_id)
    if session is None:
        return None
    if (session.task_id, session.task_attempt) != (spec.task_id, spec.attempt):
        raise StaleSession(f'session {spec.run_id}/{spec.agent_id} exists for another task or attempt')
    return _answer(session)


def _repeated(supervisor: Supervisor, event: Mapping[str, Any]) -> dict[str, Any] | None:
    """The answer a launch of this agent, task and attempt already got (its session), else None."""
    run_id, task_id = str(event.get('run_id', '')), str(event.get('task_id', ''))
    session = supervisor.sessions.get(run_id, str(event.get('agent_id', '')))
    if session is None or session.task_id != task_id:
        return None
    given = _optional_number(event, 'attempt', int)
    attempt = _attempt(supervisor, run_id, task_id, None) if given is None else given
    return _answer(session) if session.task_attempt == attempt else None


def _answer(session: AgentSession) -> dict[str, Any]:
    return {'run_id': session.run_id, 'agent_id': session.agent_id, 'status': session.status}


def launch(event: Mapping[str, Any]) -> dict[str, Any]:
    """Start one agent of a run on one task, once: a repeat for the same task and attempt answers the session the
    first wrote, and is refused (``SessionBusy``) while the first is still starting its MicroVM; an agent with a
    session for another task or attempt is refused (``StaleSession``). A repeat is answered, and one while the first
    still starts refused as busy, before any other check (the run's state, the skill, the egress): any other
    refusal so means that no session and no launch of the agent exist, which the board relies on to clear its
    record."""
    supervisor = _supervisor()
    repeat = _repeated(supervisor, event)
    if repeat is not None:
        return repeat
    # Busy before any other check too: a retry refused for its skill or image while the first launch still boots
    # would tell the board nothing started, and the board would clear the record and number another agent.
    if supervisor.sessions.launch_under_way(str(event.get('run_id', '')), str(event.get('agent_id', '')),
                                            int(clock())):
        raise SessionBusy(f'a launch of {event.get("agent_id", "")} is under way: ask again in a few minutes')
    harness, labels = _harness(event)
    paths = event.get('paths', [])
    if not _strings(paths):
        raise RuntimeRefused('paths must be a list of repository paths')
    commit = str(event.get('commit', ''))
    checkout_commands(commit, paths)  # refuses a bad commit or path before anything starts
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
    existing = _launched(supervisor.sessions, spec)
    if existing is not None:
        return existing
    try:   # held before the MicroVM starts: a repeated launch of this agent never starts a second one
        supervisor.sessions.hold_launch(spec.run_id, spec.agent_id, int(clock()))
    except LaunchUnderWay:
        existing = _launched(supervisor.sessions, spec)
        if existing is not None:
            return existing
        raise SessionBusy(f'a launch of {spec.agent_id} is under way: ask again in a few minutes') from None
    try:
        vm = supervisor.runtime.run(spec)
    except Exception:
        supervisor.sessions.release_launch(spec.run_id, spec.agent_id)
        raise
    try:
        session = supervisor.sessions.create(AgentSession(
            run_id=spec.run_id, agent_id=spec.agent_id, role=role, task_id=spec.task_id, language=language,
            egress=allowlist, connection=spec.connection, commit=commit, paths=tuple(paths),
            harness=tuple(harness), vm_id=vm.vm_id, endpoint=vm.endpoint, task_attempt=attempt,
            started_at=int(clock()), last_tick_at=int(clock())),
            labels)
    except Exception:
        # No session row, no MicroVM: one that nothing supervises would run until its idle policy.
        try:
            supervisor.runtime.terminate(vm)
        finally:   # (the hold is let go even when ending the MicroVM fails: its idle policy ends it then)
            supervisor.sessions.release_launch(spec.run_id, spec.agent_id)
        raise
    return _answer(session)


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
    'start_run': start_run, 'end_run': end_run, 'tick': tick, 'launch': launch, 'signal': signal_action,
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
