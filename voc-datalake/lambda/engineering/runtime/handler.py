"""voc-engineering-runtime: a run's start and end, the supervisor's tick, the launcher, the run monitor's signals.

- ``{"action": "start_run", "run_id", "max_tasks", "max_tokens"?, "max_cost_usd"?, "goal"?, "repo"?, "flow"?,
  "budget_usd"? (the flow's monthly budget, copied onto the run for its alerts and, with the administrators' hard
  cap on, its first start's cost cap: ``runs.hard_capped``, ``engineering/settings.py``), "connection"?,
  "commit"?, "language"?, "actor"?, "flow_definition"?, "flow_revision"?}``: the run's ``META`` row, its
  ``coordinate`` task and, with ``flow_definition`` (the stored flow's JSON text at ``flow_revision``), its own copy
  of the flow, which its coordinator follows (``runs.RunStore.start``, ``engineering/flow/``), the supervisor's
  rule switched on, and, for a run with its connection, commit and
  language, its coordinator launched on that task (``coordinator-1``, on the coordinator's skill's harness). A run
  started without its connection or commit can launch no agent and read no knowledge (the board answers 409); one
  without its language gets no coordinator. A language this deployment has no agent runtime for, or a coordinator
  with no skill, is refused before anything is written. A retry of a run that is live switches the rule on again,
  keeps the first start's caps and launches the coordinator only if the run is active and no session of it exists
  yet.
- ``{"action": "end_run", "run_id", "status", "actor"?}``: the run ended (``done``, ``failed`` or ``stopped``), every
  session of it ended (one busy with another move at the next tick, which sees the run ended), then settled. A
  retry of an ended run does the rest again and keeps the first end's status.
- ``{"action": "retrospective", "run_id", "failure"?}``: the learning loop (``learning/loop.py``). Without
  ``failure``: the ended run's scorecards written, and each failure it takes to the coach (at most three) handed on
  as an invocation of its own with its key; with it: that failure to the coach (one Converse call at most, ever)
  and a lesson draft to agent memory. Run apart from the end because a coach's call takes up to minutes: the end
  stays as fast as before, and each failure gets the function's whole time limit. Never raises.
- ``{"action": "tick"}``: the supervisor's EventBridge rule, every minute while any run is listed
  (``supervisor.Supervisor.tick``), then settled; records the heartbeat metrics.
- Settling: an ended run without a live agent is no longer listed (``RunStore.release``), its retrospective handed
  on first (an asynchronous ``retrospective`` invocation of this function: its record no longer moves; best effort,
  logged, never failing the end or the tick); with no run listed the rule is switched off, and the list re-read
  after that switch (a run that started meanwhile turns it back on).
- ``{"action": "launch", ...}``: the run coordinator starting one agent of an active run on one task: the
  session from the agent's image, with its egress allowlist, and the session row (the first tick hands it its
  role session).
- ``{"action": "signal", "run_id", "agent_id"?, "signal", "attempt"?, "actor"?}``: the run monitor's Save, Pause, Resume,
  Shut down and Stop now (``Supervisor.signal_detailed``): each agent's status, and whether the signal took effect
  (``applied``: not when busy, a failed move, or ``stale``, an agent on another attempt than the one given). A
  Resume of the whole run also makes sure the run has a coordinator, as its start does (``_ensure_coordinator``: a
  new one in place of one whose session failed).

``delivery_handler`` is voc-engineering-delivery's entry point, the same code with a role of its own
(engineering-runtime.ts createDelivery): the router's message for an agent, the conductor or a role of a run,
recorded in the run's inbox and its addressees woken (``delivery.py``).

``start_handler`` is voc-engineering-start's entry point, the same code with a role of its own that holds only what
a start needs (engineering-start.ts): the Agents API's ``POST /agents/engineering/runs``, whose role may invoke that
function and never this one. It takes ``start_run`` and nothing else: an event naming any other action, or none, is
refused before anything is read, so the API's grant can start a run and never tick, launch, signal or end one. It
writes the run and answers; the coordinator's launch is handed on to this function's ``launch_coordinator``
(``{"run_id", "actor"}``, asynchronous, never raising: a failure sends the run to a person).

``actor`` is who asked (a person's id: the run monitor sends it with its signals, the Agents API with a start; nothing
ends a run with it yet): a
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

from engineering.board.store import COORDINATE_TASK, COORDINATOR, MAX_AGENTS, BoardError
from engineering.connectors.identity import WORKSPACE
from engineering.runtime import caps, egress
from engineering.runtime.checkout import checkout_commands
from engineering.runtime.checkpoints import CheckpointReader
from engineering.runtime.delivery import deliver
from engineering.runtime.harness.skills import harness_argv, skill_for, skill_label
from engineering.runtime.interface import AgentRuntime, AgentSpec, RuntimeRefused, check_run_id
from engineering.runtime.launcher import Launcher
from engineering.runtime.runs import (
    ENDED,
    UNATTRIBUTED,
    RunCaps,
    RunExists,
    RunNotActive,
    RunStore,
    StartReadFailed,
    TableRunControl,
    hard_capped,
)
from engineering.runtime.sessions import (
    LIVE_STATUSES,
    AgentSession,
    LaunchUnderWay,
    SessionStore,
    StaleSession,
)
from engineering.runtime.supervisor import SessionBusy, Supervisor, landed_session, stop_or_keep_lost
from engineering.settings import read_hard_cap
from shared.invocation_cost import measure_invocation_cost
from shared.logging import logger, metrics

if TYPE_CHECKING:
    from engineering.learning.loop import LearningLoop
    from engineering.quality_gate.record import GateRecord
    from engineering.runtime.board_bus import SessionState

MAX_HARNESS_ARGS: Final = 32
#: A failure's key as the retrospective names it (``<task>#<attempt>#<how>``), at most.
MAX_FAILURE_KEY: Final = 300

_supervisor_cache: Supervisor | None = None
_learning_cache: LearningLoop | None = None
#: This invocation's function (its Lambda context's name), where the learning steps are handed on; '' with none.
_function_name = ''
clock: Callable[[], float] = time.time


@cache
def _sts_client() -> Any:
    import boto3
    return boto3.client('sts')


@cache
def _agentcore_client() -> Any:
    import boto3
    return boto3.client('bedrock-agentcore')


def _build_roles() -> frozenset[str]:
    """The roles that build and test the repository (``ENGINEERING_BUILD_ROLES``): the build size's, when the
    deployment gives one."""
    return frozenset(json.loads(os.environ.get('ENGINEERING_BUILD_ROLES', '[]')))


def _runtime() -> AgentRuntime:
    """AgentCore Runtime, always: the local fake (no sandbox) is for tests, which put it in place themselves."""
    from engineering.runtime.agentcore import AgentCoreRuntime, runtimes_from
    return AgentCoreRuntime(_agentcore_client(), runtimes_from(os.environ.get('ENGINEERING_AGENT_RUNTIMES')),
                            region=os.environ.get('AWS_REGION', 'us-east-1'), build_roles=_build_roles())


def _pricing() -> caps.SessionPricing:
    """Each session's vCPU and memory at the deployment's AgentCore rates (``ENGINEERING_SESSION_RATES``), at its
    role's size (``ENGINEERING_BUILD_ROLES``, ``ENGINEERING_BUILD_MEMORY_MIB``)."""
    return caps.SessionPricing(rates=caps.session_rates(os.environ.get('ENGINEERING_SESSION_RATES')),
                               build_roles=_build_roles(),
                               build_size=caps.build_size(os.environ.get('ENGINEERING_BUILD_MEMORY_MIB')))


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
            sessions=SessionStore(get_dynamodb_resource().Table(table), runs, _pricing()),
            board=board, bus=bus, control=TableRunControl(runs, clock),
            launcher=Launcher(_sts_client(), json.loads(os.environ['ENGINEERING_AGENT_ROLE_ARNS'])),
            checkpoints=CheckpointReader(get_s3_client(), workspace),
            bucket=bucket, workspace_bucket=workspace,
            timings=caps.timings(json.loads(os.environ.get('ENGINEERING_TIMINGS', '{}'))),
            board_url=os.environ['ENGINEERING_BOARD_URL'], broker_url=os.environ['ENGINEERING_BROKER_URL'],
        )
    return _supervisor_cache


def _hard_cap_on() -> bool:
    """The administrators' hard cap (voc-agents' one settings row: ENGINEERING_SETTINGS_TABLE), read at a budgeted
    first start. A read that fails refuses the start, saying so (nothing is written yet: retry), rather than start
    a run the cap may have refused."""
    from botocore.exceptions import BotoCoreError, ClientError

    from shared.aws import get_dynamodb_resource
    try:
        return read_hard_cap(get_dynamodb_resource().Table(os.environ['ENGINEERING_SETTINGS_TABLE'])).on
    except (ClientError, BotoCoreError, KeyError) as error:
        logger.exception('engineering runtime: the hard cap\'s setting could not be read')
        raise StartReadFailed('the hard cap\'s setting could not be read: start the run again') from error


def _gate_record(key: str) -> GateRecord | None:
    """A gate record from the workspace bucket (the runtime's role reads them: the GO ledger's check of a flow's
    quality gate verdict). Built at the read: the start function, which never plans a flow, names no bucket."""
    from engineering.flow.ledger import read_gate_record
    from engineering.workspace.store import WorkspaceStore
    from shared.aws import get_s3_client
    workspace = WorkspaceStore(get_s3_client(), os.environ['ENGINEERING_WORKSPACE_BUCKET'], denied_is_missing=True)
    return read_gate_record(workspace, key)


def _runs() -> RunStore:
    from shared.aws import get_dynamodb_resource
    return RunStore(get_dynamodb_resource().Table(os.environ['ENGINEERING_TABLE']), gate_records=_gate_record)


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
        # (it may still start). A launch refused (its record cleared, as the board's are) or a session that will not
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
            if run is not None:
                # Every agent of it has ended, its sessions priced: its record no longer moves, so the run's
                # retrospective starts now (before the release, so a release that fails starts it again on the next
                # tick; the learning loop's writes are create-only, a second start writes nothing new).
                _hand_on({'action': 'retrospective', 'run_id': run_id})
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
    """The languages this deployment has an agent runtime for (``ENGINEERING_AGENT_RUNTIMES``, the runtime's own)."""
    return frozenset(json.loads(os.environ.get('ENGINEERING_AGENT_RUNTIMES', '{}')))


def _max_sessions() -> int:
    return caps.max_sessions(os.environ.get('ENGINEERING_MAX_SESSIONS'))


def _run_fits(run_caps: RunCaps) -> None:
    """Refuse, before anything is written, a run that cannot fit: more agents at once than the deployment's sessions
    (its coordinator and one agent per task, at most the board's ``MAX_AGENTS``), or clocks that would let an agent
    outlive its session's 8 hours without a continuation (``caps.Timings``)."""
    caps.timings(json.loads(os.environ.get('ENGINEERING_TIMINGS', '{}')))
    agents, sessions = min(run_caps.max_tasks + 1, MAX_AGENTS), _max_sessions()
    if agents > sessions:
        raise RuntimeRefused(f'this run may have {agents} agents at once, more than the {sessions} agent sessions '
                             'this deployment runs: lower its task cap')


def _coordinator_launchable(language: str) -> None:
    """What the coordinator's launch would refuse, refused before a coordinator is numbered (the board's launch op
    checks the same before it numbers an agent: ``BoardApi._check_launchable``): the coordinator role with no skill,
    a language this deployment has no agent runtime for."""
    if skill_for(COORDINATOR) is None:
        raise RuntimeRefused('no coordinator can be launched yet: the role has no skill')
    images = _image_languages()
    if language not in images:
        raise RuntimeRefused(f'no {language} image in this deployment: start the run in one of '
                             f'{sorted(images) or "none yet"}')


def _ensure_coordinator(run_id: str, actor: str) -> None:
    """Make sure an active run with its connection, commit and language has a coordinator: the one its coordinate
    task records, started when it has no session yet (the run's start, ``coordinator-1``; a start whose session
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
        # Another start's or Resume's launch of it is under way (or one killed while its session booted, until its
        # hold runs out): it keeps its record, and the caller asks again (the run is written).
        raise
    except (RuntimeRefused, StaleSession) as refused:
        if type(refused).__name__ in CLEARS_LAUNCH:
            board.clear_coordinator(run_id, agent_id, attempt, actor=who, reason=str(refused))
        raise


def start_run(event: Mapping[str, Any], *, launch: bool = True) -> dict[str, Any]:
    """Start a run with its caps, its repository ``connection`` and ``commit`` (the board's ``launch`` and
    ``knowledge`` read them from META) and its ``language``, and launch its coordinator; the supervisor's rule is on
    from then. A first start that names a ``language`` is refused, before anything is written, when the coordinator
    cannot be launched (``_coordinator_launchable``), with or without its connection and commit (a run without them
    never gets a coordinator, but no run records a language this deployment cannot run); a start with all three
    numbers it ``coordinator-1``. A start
    whose coordinator then fails to launch (its session did not start, or the runtime refused it) sends the run to a
    person (``needs_human`` ``coordinator``), whose Resume launches it, and raises the failure; so does a rule that
    could not be switched on. ``launch=False`` (voc-engineering-start) writes the run and switches the rule only: its
    coordinator is launched by the ``launch_coordinator`` action that start hands on."""
    caps = RunCaps(max_tasks=_optional_number(event, 'max_tasks', int) or 0,
                   max_tokens=_optional_number(event, 'max_tokens', int),
                   max_cost_usd=_optional_number(event, 'max_cost_usd', float))
    run_id, runs, status = str(event.get('run_id', '')), _runs(), 'active'
    language = str(event.get('language', ''))
    budget_usd, flow = _optional_number(event, 'budget_usd', float), str(event.get('flow', ''))
    first = runs.get(run_id) is None
    if first:   # (a run that cannot fit is refused before anything is written)
        _run_fits(caps)
    if language and first:   # (any first start naming a language: no run records one it cannot run)
        _coordinator_launchable(language)
    if first and budget_usd is not None and _hard_cap_on():
        # (the administrators' hard cap: what is left of the flow's month, or no start; a retry of a live run is not
        # capped again)
        caps = hard_capped(caps, budget_usd=budget_usd, flow=flow, table=runs.table, now=int(clock()))
    definition = event.get('flow_definition', '')
    if not isinstance(definition, str):
        raise RuntimeRefused('flow_definition is the stored flow\'s definition, as its JSON text')
    try:
        runs.start(run_id, caps=caps, now=int(clock()), goal=str(event.get('goal', '')),
                   repo=str(event.get('repo', '')), flow=flow,
                   connection=str(event.get('connection', '')), commit=str(event.get('commit', '')),
                   language=language, actor=str(event.get('actor') or ''),
                   budget_usd=budget_usd, flow_definition=definition,
                   flow_revision=_optional_number(event, 'flow_revision', int) or 0)
    except RunExists:
        run = runs.get(run_id)
        if run is None or run.status in ENDED:
            raise
        status = run.status  # a retry of a live run: its rule may never have been switched on
    try:
        _switch(True)
        if launch:
            _ensure_coordinator(run_id, str(event.get('actor') or ''))
    except SessionBusy:
        raise   # (another start's launch of it is under way: ask again)
    except Exception:
        # The rule could not be switched on, its session did not start, or the runtime refused it: the run goes to a
        # person (the coordinator's decision point, the run monitor's Resume prompt), never left active with no
        # coordinator and no session.
        _to_person(run_id, str(event.get('actor') or ''))
        raise
    return {'run_id': run_id, 'status': status}


def _to_person(run_id: str, actor: str) -> None:
    """The run at the coordinator's decision point (a person's Resume launches it); one that ended meanwhile stays."""
    with contextlib.suppress(RunNotActive):
        _runs().needs_human(run_id, 'coordinator', now=int(clock()), actor=actor or UNATTRIBUTED)


def launch_coordinator(event: Mapping[str, Any]) -> dict[str, Any]:
    """The ``launch_coordinator`` action: the second half of a start from voc-engineering-start (``{"run_id",
    "actor"}``, invoked asynchronously once the run is written), the run's coordinator launched as ``start_run``
    launches it. Never raises (nothing retries it): a launch under way elsewhere is left to it; any other failure
    sends the run to a person, whose Resume launches it, so a run is never left active with no coordinator."""
    run_id, actor = str(event.get('run_id', '')), str(event.get('actor') or '')
    try:
        check_run_id(run_id)
        _ensure_coordinator(run_id, actor)
    except SessionBusy:
        logger.info('engineering runtime: the run\'s coordinator launch is under way', extra={'run_id': run_id})
        return {'run_id': run_id, 'status': 'launching'}
    except Exception:
        logger.exception('engineering runtime: a started run\'s coordinator was not launched', extra={'run_id': run_id})
        try:
            _to_person(run_id, actor)
        except Exception:
            logger.exception('engineering runtime: the run could not be sent to a person', extra={'run_id': run_id})
        return {'run_id': run_id, 'status': 'needs_human'}
    return {'run_id': run_id, 'status': 'active'}


def end_run(event: Mapping[str, Any]) -> dict[str, Any]:
    """End a run and every session of it, then settle (which starts its retrospective once none of its agents is
    live: here, or at the tick that ends the last busy one; best effort, never failing the end)."""
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


def _hand_on(event: dict[str, Any]) -> None:
    """``event`` to this function again, asynchronously (``_function_name``: the invocation's own): the
    retrospective and each failure it takes to the coach run in invocations of their own, so a model call never
    holds up a run's end or another failure. Best effort: logged, never raised. With no function name (a local
    run, the tests) it runs here and now."""
    try:
        if not _function_name:
            retrospective(event)
            return
        from shared.aws import invoke_lambda_async
        invoke_lambda_async(_function_name, event)
    except Exception:
        logger.exception('engineering runtime: the learning step was not started',
                         extra={'run_id': event.get('run_id'), 'failure': event.get('failure')})


def _learning() -> LearningLoop:
    """The learning loop on this function's clients (built once per container)."""
    global _learning_cache
    if _learning_cache is None:
        from engineering.agent_memory.store import AgentMemoryStore
        from engineering.coach.model import BedrockCoachModel
        from engineering.coach.proposer import Coach
        from engineering.learning.loop import LearningLoop
        from engineering.learning.records import RunRecordReader
        from engineering.learning.scorecard import ScorecardStore
        from engineering.skills.store import SkillStore
        from engineering.workspace.store import WorkspaceStore
        from shared.aws import get_dynamodb_client, get_s3_client
        client, table = get_dynamodb_client(), os.environ['ENGINEERING_TABLE']
        skills = SkillStore(client, table)
        # No ListBucket: a gate record never written answers 403, read as missing (and counted).
        workspace = WorkspaceStore(get_s3_client(), os.environ['ENGINEERING_WORKSPACE_BUCKET'], denied_is_missing=True)
        cases = json.loads(os.environ['ENGINEERING_BENCHMARK_CASES'])
        _learning_cache = LearningLoop(
            reader=RunRecordReader(client, table, workspace), scorecards=ScorecardStore(client, table),
            # A role's lessons only: no person memory is learned here, so no user is looked up.
            memory=AgentMemoryStore(client, table, is_user=lambda _user: False),
            coach=lambda: Coach(skills, BedrockCoachModel()),
            cases=tuple(str(case) for case in cases) if isinstance(cases, list) else ())
    return _learning_cache


def retrospective(event: Mapping[str, Any]) -> dict[str, Any]:
    """The ``retrospective`` action: ``{"run_id"}`` (the run's end hands it on) writes the ended run's scorecards and
    hands each failure it takes to the coach on as ``{"run_id", "failure": <key>}``, which takes that one to the
    coach and to memory (``learning/loop.py``). Best effort: whatever fails is logged and answered, never raised (an
    asynchronous invocation that raised would be retried, and a retry would spend nothing new but time)."""
    run_id, failure = str(event.get('run_id', '')), event.get('failure')
    try:
        check_run_id(run_id)
        return _retrospect(run_id) if failure is None else _learn_from(run_id, str(failure)[:MAX_FAILURE_KEY])
    except Exception:
        logger.exception('engineering retrospective failed', extra={'run_id': run_id, 'failure': failure})
        return {'run_id': run_id, 'status': 'failed'}


def _retrospect(run_id: str) -> dict[str, Any]:
    summary = _learning().retrospective(WORKSPACE, run_id)
    for key in summary.to_coach:
        _hand_on({'action': 'retrospective', 'run_id': run_id, 'failure': key})
    logger.info('engineering retrospective', extra={
        'run_id': run_id, 'scorecards': summary.scorecards_written, 'kept': summary.scorecards_kept,
        'failures': summary.failure_count, 'coached': len(summary.to_coach), 'skipped': summary.skipped})
    return {'run_id': run_id, 'scorecards': summary.scorecards_written, 'failures': summary.failure_count,
            'to_coach': list(summary.to_coach), 'skipped': summary.skipped}


def _learn_from(run_id: str, failure: str) -> dict[str, Any]:
    learned = _learning().learn_from(WORKSPACE, run_id, failure)
    # The coach's skill.proposed message is the coach's to publish, and this role speaks only as the supervisor: it
    # is logged (its id), and the proposal is in the skills store's history.
    logger.info('engineering retrospective: a failure learned from', extra={
        'run_id': run_id, 'failure': learned.key, 'coach': learned.coach, 'version': learned.proposed_version,
        'lesson': learned.lesson, 'skipped': learned.skipped,
        'announcement': (learned.announcement or {}).get('message', {}).get('event_id', '')})
    return {'run_id': run_id, 'failure': learned.key, 'proposed_version': learned.proposed_version,
            'coach': learned.coach, 'memory_id': learned.memory_id, 'lesson': learned.lesson,
            'skipped': learned.skipped}


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
    first wrote, and is refused (``SessionBusy``) while the first is still starting its session; an agent with a
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
        extra_hosts=json.loads(os.environ.get('ENGINEERING_EXTRA_EGRESS', '[]')),
        service_urls=[supervisor.board_url, supervisor.broker_url])
    attempt = _attempt(supervisor, str(event.get('run_id', '')), str(event.get('task_id', '')),
                       _optional_number(event, 'attempt', int))
    spec = AgentSpec(run_id=str(event.get('run_id', '')), agent_id=str(event.get('agent_id', '')), role=role,
                     task_id=str(event.get('task_id', '')), language=language, egress=allowlist,
                     connection=str(event.get('connection', '')), commit=commit, attempt=attempt,
                     workspace_bucket=supervisor.workspace_bucket, board_url=supervisor.board_url,
                     broker_url=supervisor.broker_url)
    existing = _launched(supervisor.sessions, spec)
    if existing is not None:
        return existing
    # (no room for a new session is the service's own answer, at the start itself, atomic: ``SessionsFull``, a
    # refusal in its words; no count of this deployment's sessions is read here)
    try:   # held before the session starts: a repeated launch of this agent never starts a second one
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
        # The write landed after all (its answer lost): the row names the session, which is not lost.
        landed = landed_session(supervisor.sessions, spec.run_id, spec.agent_id, vm)
        if landed is not None:
            return _answer(landed)
        # No session row: one that nothing supervises would run until its idle timeout. Stopped now, or, when that
        # fails too, kept on a row of its own that every tick stops again and counts (``stop_or_keep_lost``).
        # (never raises: it logs what it could not do)
        stop_or_keep_lost(supervisor.runtime, supervisor.sessions, spec.run_id, spec.agent_id, role, vm, int(clock()))
        # The hold is let go whatever happened to the stop; a release that fails is logged, never raised in place of
        # the write's own failure, which is what the caller needs (its hold runs out on its own).
        try:
            supervisor.sessions.release_launch(spec.run_id, spec.agent_id)
        except Exception:
            logger.exception('engineering runtime: a launch hold could not be let go',
                             extra={'run_id': spec.run_id, 'agent_id': spec.agent_id})
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


#: The one action voc-engineering-start takes (``start_handler``).
START_ACTION: Final = 'start_run'


class StartFailed(RuntimeError):
    """The run was written, but the start failed after that (the rule, the launch's hand-on, a launch under way): the
    run is there, at a person's decision point (whose Resume launches its coordinator) unless another launch of it is
    under way. Never a refusal: the start must not be asked again under a new id, which would be a second run; the
    run is opened instead."""


class StartNotWritten(RuntimeError):
    """The start failed and its run is known not to exist (read back after the failure): it can be asked again."""


class StartUncertain(RuntimeError):
    """The start failed and whether its run was written could not be read: it may exist, so it is opened (its run
    monitor), never started again under a new id."""


def _written(run_id: str) -> bool | None:
    """Whether the run exists, read back after a failed start; None when that read fails too (nobody can tell)."""
    try:
        return _runs().get(run_id) is not None
    except Exception:
        logger.exception('engineering start: the run could not be read after a failed start', extra={'run_id': run_id})
        return None


def _hand_on_launch(run_id: str, actor: str) -> None:
    """The run's coordinator launched by voc-engineering-runtime's ``launch_coordinator``, invoked asynchronously
    (ENGINEERING_RUNTIME_FUNCTION; the supervisor's role may invoke it, the Agents API's never)."""
    from shared.aws import invoke_lambda_async
    invoke_lambda_async(os.environ['ENGINEERING_RUNTIME_FUNCTION'],
                        {'action': 'launch_coordinator', 'run_id': run_id, 'actor': actor})


@metrics.log_metrics
@measure_invocation_cost
def start_handler(event: Mapping[str, Any], context: object) -> dict[str, Any]:
    """voc-engineering-start: the Agents API's start of a run (``{"action": "start_run", ...}``). Every other action,
    and an event naming none, is refused before anything is read: the API's role may invoke this function only
    (engineering-start.ts, pinned by its test), so it can start a run and nothing more.

    It answers as soon as the run is written (its refusals, all before the write, are raised as they are): it writes
    the run and switches the rule on (``start_run`` with ``launch=False``), then hands the coordinator's launch on to
    voc-engineering-runtime (``launch_coordinator``, asynchronously: a session's start does not fit behind API
    Gateway's 29 s). Any failure once the run exists is ``StartFailed``, naming it; the run is sent to a person first
    (the hand-on failed: still active), so it is never left active with nobody to launch its coordinator."""
    if event.get('action') != START_ACTION:
        logger.warning('engineering start: an action other than start_run refused',
                       extra={'action': str(event.get('action'))[:40]})
        raise RuntimeRefused(f'this function only starts a run (action {START_ACTION!r})')
    run_id, actor = str(event.get('run_id', '')), str(event.get('actor') or '')
    try:
        answer = start_run(event, launch=False)
        _hand_on_launch(run_id, actor)
    except Exception as error:
        written = _written(run_id)
        if written is None:
            raise StartUncertain(f'run {run_id} may have been started: open the run monitor before you start '
                                 'another') from error
        if not written:
            if isinstance(error, RuntimeRefused):
                raise   # (a refusal, all before the write: said as it is)
            raise StartNotWritten('the run could not be started: start it again') from error
        if not isinstance(error, SessionBusy):   # (a launch under way keeps the run: it is the run's coordinator)
            try:
                _to_person(run_id, actor)   # (already there when start_run sent it: no change, no row)
            except Exception:
                logger.exception('engineering start: the run could not be sent to a person', extra={'run_id': run_id})
        raise StartFailed(f'run {run_id} was started, but its coordinator could not be launched: open its run '
                          'monitor and resume it') from error
    logger.info('engineering run started', extra={'run_id': answer.get('run_id'), 'status': answer.get('status')})
    return answer


ACTIONS: Final[dict[str, Callable[[Mapping[str, Any]], dict[str, Any]]]] = {
    'start_run': start_run, 'end_run': end_run, 'tick': tick, 'launch': launch, 'signal': signal_action,
    'retrospective': retrospective, 'launch_coordinator': launch_coordinator,
}


@metrics.log_metrics
@measure_invocation_cost
def lambda_handler(event: Mapping[str, Any], context: Any) -> dict[str, Any]:
    """``context``: Lambda's (None in the tests): its function name is where the learning steps are handed on."""
    global _function_name
    _function_name = str(context.function_name) if context is not None else ''
    action = ACTIONS.get(str(event.get('action')))
    if action is None:
        raise RuntimeRefused(f'unknown action {event.get("action")!r}')
    answer = action(event)
    logger.info('engineering runtime', extra={'action': event.get('action')})
    return answer
