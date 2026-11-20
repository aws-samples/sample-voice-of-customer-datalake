"""voc-engineering-runtime: a run's start and end, the supervisor's tick, the launcher, the run monitor's signals.

- ``{"action": "start_run", "run_id", "max_tasks", "max_tokens"?, "max_cost_usd"?, "goal"?, "repo"?,
  "default_branch"?, "flow"?,
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
- ``{"action": "end_run", "run_id", "status", "actor"?, "reason"?}``: the run ended (``done``, ``failed`` or
  ``stopped``), every session of it ended (one busy with another move at the next tick, which sees the run ended),
  then settled; a ``stopped`` end also closes the run's tasks that have not ended and runs out its launch holds
  (``stop.close``). A retry of an ended run does the rest again and keeps the first end's status.
- ``{"action": "finish_stop", "run_id", "actor", "reason"}`` (7.50.03): the rest of a person's Stop that
  voc-engineering-start ended the run of (``end_run`` as ``stopped``: its sessions ended, the run settled).
- ``{"action": "stop_run", "run_id", "actor"}`` (7.50.03): a person's Stop whose agents save first, handed on by
  voc-engineering-start (below): each agent asked to checkpoint and stop, the run ended once none has a session left;
  each tick ends a stopping run whose agents have, or whose grace has passed (``_finish_stops``, ``runtime/stop.py``).
- ``{"action": "retrospective", "run_id", "failure"?}``: the learning loop (``learning/loop.py``). Without
  ``failure``: the ended run's scorecards written, and each failure it takes to the coach (at most three) handed on
  as an invocation of its own with its key; with it: that failure to the coach (one Converse call at most, ever)
  and a lesson draft to agent memory. Run apart from the end because a coach's call takes up to minutes: the end
  stays as fast as before, and each failure gets the function's whole time limit. Never raises. Before the
  scorecards, a run with a recorded pull request gets its one reactions schedule (7.10.00, below); nothing of the
  host is read here.
- ``{"action": "reactions", "run_id", "asked_by"?, "actor"?}`` (7.10.00): people's reactions to the ended run's
  recorded pull request, read through the broker's ``reactions`` operation as this function's own role and recorded
  (``learning/reactions_read.py``): the run's one EventBridge Scheduler schedule (``asked_by`` ``schedule``, created at
  its retrospective, deleting itself after it runs) or a person's hand trigger (``actor``, through voc-engineering-
  start). A run with no recorded pull request records nothing and says so. Never raises.
- ``{"action": "learn_cross_run", "flow"?}`` (7.53.00): the scheduled cross-run Learn pass
  (``learning/cross_run.py``). Without ``flow`` (the weekly EventBridge Scheduler schedule, DISABLED unless
  ``-c engineeringCrossRunLearn=weekly``): the transcripts' index's flows listed (at most 100) and each handed on as an
  invocation of its own, as the retrospective hands on its failures; with it: that flow's pass this ISO week (once:
  its week's create-only claim), one model call at most, its proposals only proposals. Never raises.
- ``{"action": "tick"}``: the supervisor's EventBridge rule, every minute while any run is listed
  (``supervisor.Supervisor.tick``), then settled; records the heartbeat metrics.
- Settling: an ended run without a live agent is no longer listed (``RunStore.release``), its retrospective handed
  on first (an asynchronous ``retrospective`` invocation of this function: its record no longer moves; best effort,
  logged, never failing the end or the tick); with no run listed the rule is switched off, and the list re-read
  after that switch (a run that started meanwhile turns it back on).
- ``{"action": "launch", ...}``: the run coordinator starting one agent of an active run on one task: the
  session from the agent's image, with its egress allowlist, and the session row (the first tick hands it its
  role session). Refused (``RuntimeRefused``) while the run's commit has no ``READY`` entry in the checkout cache
  (``checkout_cache.py``); ``launch_coordinator`` fills that entry first, invoking voc-engineering-cache
  (``ENGINEERING_CACHE_FUNCTION``) and waiting for it, then launches in an invocation of its own.
- ``{"action": "signal", "run_id", "agent_id"?, "signal", "attempt"?, "restart_from"?, "actor"?}``: the run monitor's
  Save, Pause, Resume, Shut down, Stop now and (7.51.00) Restart of one agent (since 7.51.02 handed on by
  voc-engineering-start's ``signal_run``, which checked and recorded it), ``restart_from`` ``checkpoint`` (the
  default) or ``fresh`` (``Supervisor.signal_detailed``): each agent's status, and whether the signal took effect
  (``applied``: not when busy, a failed move, or ``stale``, an agent on another attempt than the one given). A
  Resume of the whole run also makes sure the run has a coordinator, as its start does (``_ensure_coordinator``: a
  new one in place of one whose session failed); it is refused while a person's Stop of the run is under way. A
  whole run's Shut down or Stop now is the run's Stop (7.50.03, ``_stop_in_runtime``): it ends the run, a run with no
  session at all included, and answers its outcome in ``run``.

``delivery_handler`` is voc-engineering-delivery's entry point, the same code with a role of its own
(engineering-runtime.ts createDelivery): the router's message for an agent, the conductor or a role of a run,
recorded in the run's inbox and its addressees woken (``delivery.py``).

- ``{"action": "seed_restart", "run_id", "actor"?}`` (7.51.00): a child run's seeds (``runtime/restart.py``): its
  parent ended first when it was not, then a ``voc-resume-seed/1`` record and working tree per task the child takes
  over under the child's ``_seed/``, those tasks posted with their ``seed_key``, and the child's coordinator launched.
  Handed on by voc-engineering-start's ``restart_run``; never raises (a failure sends the child to a person).

``start_handler`` is voc-engineering-start's entry point, the same code with a role of its own that holds only what
a start needs (engineering-start.ts): the Agents API's ``POST /agents/engineering/runs``, whose role may invoke that
function and never this one. It takes ``start_run``, ``restart_run`` (7.51.00: a person's Resume or Restart of an
ended run, as a child run: ``runtime/restart.py``), since 7.10.00 ``ask_reactions`` (an administrator's hand
trigger of an ended run's reactions read, ``POST /agents/engineering/<run_id>/reactions``: once per run and hour, then
handed on to this function's ``reactions``) and since 7.50.03 ``stop_run`` (the run monitor's Stop, ``POST
/agents/engineering/<run_id>/stop``: the run ended at once when nothing is to be saved, its end's rest handed on to
this function's ``finish_stop``; else the request recorded and the agents' save handed on to its ``stop_run``), since
7.51.02 ``signal_run`` (the run workspace's Pause, Resume and Save, and an agent's Save, Pause, Resume, Shut down, Stop
now and Restart, ``POST /agents/engineering/<run_id>/signals``: checked against the run, the agent and the state,
recorded on a ``RUNLOG#`` row, then handed on to this function's ``signal``: ``runtime/run_signals.py``), and nothing
else: an event naming any other action, or none, is refused before anything is read, so the API's grant can start a
run, ask for an ended run's reactions, stop a run and hand a person's checked signal on, and never tick, launch, end a
run or send this function anything else. It writes
the run and answers; the coordinator's launch is handed on to this function's ``launch_coordinator`` (``{"run_id",
"actor"}``, asynchronous, never raising: a failure sends the run to a person).

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
from dataclasses import replace
from decimal import Decimal
from functools import cache
from typing import TYPE_CHECKING, Any, Final, TypeGuard

from aws_lambda_powertools.metrics import MetricUnit
from botocore.exceptions import BotoCoreError, ClientError

from engineering import readiness
from engineering.board.store import COORDINATE_TASK, COORDINATOR, MAX_AGENTS, BoardError, BoardStore
from engineering.connectors.cache_layout import FSCK_REJECTED, NO_COMMIT
from engineering.connectors.identity import AGENT_ROLES, WORKSPACE
from engineering.flow.conductor import FlowError
from engineering.flow.settings import LearnSettings, learn_settings
from engineering.runtime import caps, egress, harness_switch, run_signals
from engineering.runtime import stop as run_stop
from engineering.runtime.checkout import checkout_commands
from engineering.runtime.checkout_cache import (
    DENIED,
    FILL_READ_TIMEOUT_SECONDS,
    FILLING,
    NOT_READY,
    CheckoutCache,
    CheckoutUnavailable,
    Found,
)
from engineering.runtime.checkpoints import CheckpointReader
from engineering.runtime.delivery import deliver
from engineering.runtime.docs_publish import ACTION as DOCS_PUBLISH_ACTION
from engineering.runtime.harness import model_choice
from engineering.runtime.harness.skills import harness_argv
from engineering.runtime.interface import AgentRuntime, AgentSpec, RuntimeRefused, RuntimeSession, check_run_id
from engineering.runtime.launcher import Launcher
from engineering.runtime.runs import (
    ENDED,
    STOP,
    STOP_NOW,
    UNATTRIBUTED,
    Run,
    RunCaps,
    RunExists,
    RunNotActive,
    RunOrigin,
    RunStore,
    StartReadFailed,
    TableRunControl,
    hard_capped,
    meta_key,
    run_pk,
)
from engineering.runtime.sessions import (
    LIVE_STATUSES,
    AgentSession,
    LaunchUnderWay,
    SessionStore,
    StaleSession,
)
from engineering.runtime.supervisor import (
    CHECKOUT_CACHE_POINT,
    SessionBusy,
    Supervisor,
    landed_session,
    stop_or_keep_lost,
)
from engineering.runtime.tenets_end import draft_tenets_at_end
from engineering.runtime.triage_end import copy_triage_at_end
from engineering.settings import read_hard_cap
from engineering.skills.templates import bundled
from shared.invocation_cost import measure_invocation_cost
from shared.logging import logger, metrics

if TYPE_CHECKING:
    from engineering.learning.cross_run import CrossRunLearn
    from engineering.learning.loop import LearningLoop
    from engineering.learning.reactions_read import ReactionsRead
    from engineering.quality_gate.record import GateRecord
    from engineering.runtime.board_bus import SessionState
    from engineering.runtime.sandbox import Walls
    from engineering.skills.resolve import Resolved

MAX_HARNESS_ARGS: Final = 32
#: A failure's key as the retrospective names it (``<task>#<attempt>#<how>``), at most.
MAX_FAILURE_KEY: Final = 300

_supervisor_cache: Supervisor | None = None
_learning_cache: LearningLoop | None = None
#: This invocation's function (its Lambda context's name), where the learning steps are handed on; '' with none.
_function_name = ''
#: This invocation's function's ARN (its Lambda context's), the target of a run's reactions schedule; '' with none.
_function_arn = ''
clock: Callable[[], float] = time.time


@cache
def _sts_client() -> Any:
    import boto3
    return boto3.client('sts')


@cache
def _agentcore_client() -> Any:
    import boto3
    return boto3.client('bedrock-agentcore')


@cache
def _cache_lambda_client() -> Any:
    """The Lambda client for a fill (built once): it waits ``FILL_READ_TIMEOUT_SECONDS`` and never retries itself."""
    import boto3
    from botocore.config import Config
    return boto3.client('lambda', config=Config(read_timeout=FILL_READ_TIMEOUT_SECONDS, connect_timeout=5,
                                                retries={'total_max_attempts': 1}))


def _checkout_cache() -> CheckoutCache:
    """The run's checkout cache: ``READY`` in the raw bucket, its writer (``ENGINEERING_CACHE_FUNCTION``) and its
    fills' claim rows in voc-engineering."""
    from shared.aws import get_dynamodb_client, get_s3_client
    return CheckoutCache(s3=get_s3_client(), bucket=os.environ['RAW_DATA_BUCKET'], lambda_client=_cache_lambda_client(),
                         function_name=os.environ.get('ENGINEERING_CACHE_FUNCTION', ''),
                         dynamodb=get_dynamodb_client(), table=os.environ['ENGINEERING_TABLE'])


def _build_roles() -> frozenset[str]:
    """The roles that build and test the repository (``ENGINEERING_BUILD_ROLES``): the build size's, when the
    deployment gives one."""
    return frozenset(json.loads(os.environ.get('ENGINEERING_BUILD_ROLES', '[]')))


def _runtime() -> AgentRuntime:
    """AgentCore Runtime, always: the local fake (no sandbox) is for tests, which put it in place themselves. Each
    started session's walls are kept as its language's last (``_record_walls``, 7.50.03)."""
    from engineering.runtime.agentcore import AgentCoreRuntime, runtimes_from
    return AgentCoreRuntime(_agentcore_client(), runtimes_from(os.environ.get('ENGINEERING_AGENT_RUNTIMES')),
                            region=os.environ.get('AWS_REGION', 'us-east-1'), build_roles=_build_roles(),
                            on_walls=_record_walls)


def _record_walls(spec: AgentSpec, vm: RuntimeSession, walls: Walls) -> None:
    """A started session's walls, as its language's last (``runtime/sandbox.py``: readiness's ``sandbox`` check reads
    it). Best effort: the runtime logs a failure here and the start still succeeds. A session that started without
    every wall (its runner refuses the work the missing one guards: the dependency step, or any repository code) is
    logged too, so the gap is seen before readiness is read."""
    from engineering.runtime import sandbox
    from shared.aws import get_dynamodb_client
    if not walls.holds:
        logger.warning('engineering runtime: a session started without every wall',
                       extra={'run_id': spec.run_id, 'agent_id': spec.agent_id, 'language': spec.language,
                              'egress': walls.egress, 'code': walls.code, 'guards': list(walls.hardlink_guard)})
    at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(clock()))
    sandbox.record(get_dynamodb_client(), os.environ['ENGINEERING_TABLE'], spec.language, walls, at=at,
                   runtime=vm.endpoint)


def _pricing() -> caps.SessionPricing:
    """Each session's vCPU and memory at the deployment's AgentCore rates (``ENGINEERING_SESSION_RATES``), at its
    role's size (``ENGINEERING_BUILD_ROLES``, ``ENGINEERING_BUILD_MEMORY_MIB``), its model tokens at the
    deployment's price per model (``ENGINEERING_MODEL_PRICES`` over ``caps.DEFAULT_TOKEN_PRICES``, 7.50.00), and a Kiro
    session's credits at its price per credit (``ENGINEERING_KIRO_CREDIT_PRICE``, 7.58.00)."""
    return caps.SessionPricing(rates=caps.session_rates(os.environ.get('ENGINEERING_SESSION_RATES')),
                               build_roles=_build_roles(),
                               build_size=caps.build_size(os.environ.get('ENGINEERING_BUILD_MEMORY_MIB')),
                               tokens=caps.model_prices(os.environ.get('ENGINEERING_MODEL_PRICES')),
                               credit_price=caps.kiro_credit_price(os.environ.get(caps.KIRO_CREDIT_PRICE_ENV)))


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
            continuation_generation=_continuation_generation,
        )
    return _supervisor_cache


def _continuation_generation(session: AgentSession) -> int | None:
    """The cache generation a continuation of ``session`` clones: the one usable now (the cache may have moved on to
    the next generation since the agent's launch), None when none is (the supervisor holds the agent). Served by the
    previous generation only, it hands the current one's fill on in the background, as a board launch does (so a long
    run that launches nothing new never meets the 28-day edge): only where the cache has its writer (the supervisor's
    function, never the delivery's, whose role may neither invoke nor read a claim) and no fill of it holds a live
    claim."""
    run = _runs().get(session.run_id)
    cache = _checkout_cache()
    found = cache.look(session.connection, session.commit, run.repo if run is not None else '')
    if found.state != 'ready':
        return None
    if found.fill_ahead and cache.function_name:
        _fill_unless_under_way(cache, session.run_id, session.connection, session.commit, found)
    return found.generation


def _hard_cap_on() -> bool:
    """The administrators' hard cap (voc-agents' one settings row: ENGINEERING_SETTINGS_TABLE), read at a budgeted
    first start. A read that fails refuses the start, saying so (nothing is written yet: retry), rather than start
    a run the cap may have refused."""

    try:
        return read_hard_cap(_settings_table(os.environ['ENGINEERING_SETTINGS_TABLE'])).on
    except (ClientError, BotoCoreError, KeyError) as error:
        logger.exception('engineering runtime: the hard cap\'s setting could not be read')
        raise StartReadFailed('the hard cap\'s setting could not be read: start the run again') from error


def _settings_table(name: str) -> Any:
    """voc-agents (``ENGINEERING_SETTINGS_TABLE``), for its ``SETTINGS#engineering`` rows only: the hard cap's and,
    since 7.58.00, the roles' models (engineering/settings.py; the runtime's role may GetItem that partition alone)."""
    from shared.aws import get_dynamodb_resource
    return get_dynamodb_resource().Table(name)


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
    _finish_stops(int(now))
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
    after_fill = event.get('after_fill') is True
    if agent_id is None and kind in WHOLE_RUN_STOPS:
        # A whole run's Shut down or Stop now ends the run itself (7.50.03), whatever its agents are doing.
        # (its release and the rule are the next tick's: this path is reached by name from the delivery function too)
        stopped = _stop_in_runtime(run_id, str(event.get('actor') or ''), WHOLE_RUN_STOPS[kind])
        return {'agents': stopped.agents, 'applied': dict.fromkeys(stopped.agents, True),
                'run': stopped.view()}
    if kind in ('resume', 'restart'):
        _refuse_while_stopping(run_id, kind)
    if after_fill:
        # A person's Resume, carried on once the fill it handed on has landed: only while the run still waits at the
        # checkout cache's point, where that Resume left it; at any other (a flow step, the coordinator's) the person
        # has not decided, so nothing passes it.
        try:
            _runs().resume(run_id, now=int(clock()), actor=str(event.get('actor') or ''),
                           only_from=CHECKOUT_CACHE_POINT)
        except RunNotActive:
            logger.info('engineering runtime: the run waits elsewhere now; the Resume is not carried on',
                        extra={'run_id': run_id})
            return {'agents': {}, 'applied': {}}
    answers = _supervisor().signal_detailed(run_id, None if agent_id is None else str(agent_id), kind, int(clock()),
                                            attempt, restart_from=str(event.get('restart_from') or 'checkpoint'))
    if kind == 'resume' and agent_id is None:
        # The supervisor accepted it (the run is not ended, its budget not spent): the run may launch agents again.
        with contextlib.suppress(RunNotActive):  # it was not at a decision point
            _runs().resume(run_id, now=int(clock()), actor=str(event.get('actor') or ''))
        # A run whose coordinator kept crashing waited for this Resume: it gets a new one. One under way is logged
        # (it may still start). A launch refused (its record cleared, as the board's are) or a session that will not
        # start is logged and sends the run back to a person, as a start does: never active with nobody planning it.
        try:
            # (resume_after_fill: agents held for want of a usable checkout are continued once the fill has landed; a
            # Resume that follows a fill, ``after_fill``, never hands another one on: never a loop)
            _ensure_coordinator(run_id, str(event.get('actor') or ''), fill_first=not after_fill,
                                resume_after_fill=True)
        except SessionBusy:
            logger.info('engineering runtime: the run\'s coordinator launch is under way', extra={'run_id': run_id})
        except Exception:
            logger.exception('engineering runtime: the run\'s coordinator was not launched', extra={'run_id': run_id})
            with contextlib.suppress(RunNotActive):   # (ended meanwhile)
                _runs().needs_human(run_id, 'coordinator', now=int(clock()),
                                    actor=str(event.get('actor') or '') or UNATTRIBUTED)
    return {'agents': {agent: status for agent, (status, _) in answers.items()},
            'applied': {agent: applied for agent, (_, applied) in answers.items()}}


#: The whole run's signals that end it (7.50.03): a Shut down saves first (``stop``), a Stop now does not.
WHOLE_RUN_STOPS: Final[dict[str, str]] = {'shutdown': STOP, 'stop_now': STOP_NOW}


def _refuse_while_stopping(run_id: str, kind: str) -> None:
    """A Resume of a run a person is stopping, or (7.51.00) a Restart of one of its agents, is refused: the Stop
    decided (7.50.03)."""
    run = _runs().get(run_id)
    if run is not None and run.stopping:
        raise RuntimeRefused(f'run {run_id} is being stopped: it cannot be '
                             f'{"resumed" if kind == "resume" else "restarted"}')


def _board_store() -> BoardStore:
    """The board's store on this function's client: the runtime's (its supervisor's) or the start function's own."""
    from engineering.bus.publish import new_event_id
    from shared.aws import get_dynamodb_client
    return BoardStore(get_dynamodb_client(), os.environ['ENGINEERING_TABLE'], new_id=new_event_id)


def _session_store() -> SessionStore:
    """The sessions' rows without the supervisor (the start function builds no session client: its role has none), on
    the runs' own table."""
    runs = _runs()
    return SessionStore(runs.table, runs)


def _stopping_run(run_id: str, mode: str) -> tuple[Run | None, str]:
    """The run a Stop is for, read once, and its mode checked: None for one that ended done or failed (nobody's Stop:
    answered as it is, nothing of it closed); ``RuntimeRefused`` for no run or a bad mode."""
    check_run_id(run_id)
    mode = run_stop.check_mode(mode)
    run = _runs().get(run_id)
    if run is None:
        raise RuntimeRefused(f'no run {run_id}')
    return (None if run.status in ENDED and run.status != 'stopped' else run), mode


def _ended_as_it_is(run_id: str, mode: str) -> run_stop.Stopped:
    """A Stop's answer for a run that ended done or failed (``_stopping_run``'s None): its status, nothing closed."""
    ended = _runs().get(run_id)
    return run_stop.Stopped(run_id, ended.status if ended is not None else 'done', mode, already=True)


def _stop_from_start(run_id: str, actor: str, mode: str) -> run_stop.Stopped:
    """voc-engineering-start's part of a person's Stop of the whole run (``runtime/stop.py``), with its role's reads and
    writes of the run's rows alone (no session, no bus). A Stop now, or a Stop with no agent that has a session, ends
    the run here (META, tasks, holds) and hands the rest of its end (its sessions, its release) on to the runtime's
    ``finish_stop``; a Stop with agents to save records the request and hands their save on to the runtime's
    ``stop_run`` (whose tick ends the run once they have, ``_finish_stops``). A hand-on of the save that fails stops the run at
    once instead (``fell_back``), never leaves it running. A run that ended done or failed is answered as it is; one
    already stopped has what its Stop left undone done again."""
    run, mode = _stopping_run(run_id, mode)
    if run is None:
        return _ended_as_it_is(run_id, mode)
    sessions = _session_store()
    saving = run_stop.saving_agents(sessions.of_run(run_id))
    if run.status in ENDED or mode == STOP_NOW or not saving:
        return _close_and_hand_on_end(run_id, actor, mode, sessions)
    _runs().request_stop(run_id, mode=STOP, now=int(clock()), actor=actor)
    try:
        _hand_on_runtime({'action': 'stop_run', 'run_id': run_id, 'actor': actor})
    except Exception:
        logger.exception('engineering stop: the agents could not be asked to save; the run is stopped now',
                         extra={'run_id': run_id})
        return replace(_close_and_hand_on_end(run_id, actor, STOP_NOW, sessions), mode=mode, fell_back=True)
    logger.info('engineering stop: the agents are asked to save, then the run ends',
                extra={'run_id': run_id, 'saving': len(saving)})
    return run_stop.Stopped(run_id, 'stopping', mode, saving=saving)


def _close_and_hand_on_end(run_id: str, actor: str, mode: str, sessions: SessionStore) -> run_stop.Stopped:
    """The start function ends the run as stopped (``stop.close``) and hands the rest of its end on to the runtime's
    ``finish_stop`` (``end_run`` as stopped), best effort (when it cannot, the supervisor's next tick ends the sessions:
    the run has ended)."""
    reason = run_stop.reason_of(mode)
    stopped = run_stop.close(_runs(), _board_store(), sessions, run_id, actor=actor, mode=mode, now=int(clock()),
                             reason=reason)
    try:
        _hand_on_runtime({'action': 'finish_stop', 'run_id': run_id, 'actor': actor, 'reason': reason})
    except Exception:
        logger.exception('engineering stop: the end was not handed on; the next tick ends its sessions',
                         extra={'run_id': run_id})
    return stopped


def _hand_on_runtime(event: dict[str, Any]) -> None:
    """``event`` to voc-engineering-runtime, asynchronously (the start function's hand-on, ENGINEERING_RUNTIME_FUNCTION:
    its role may invoke it, the Agents API's never)."""
    from shared.aws import invoke_lambda_async
    invoke_lambda_async(os.environ['ENGINEERING_RUNTIME_FUNCTION'], event)


def _stop_in_runtime(run_id: str, actor: str, mode: str) -> run_stop.Stopped:
    """voc-engineering-runtime's part of a person's Stop of the whole run: a whole run's Shut down or Stop now
    (``signal_action``) and the start function's handed-on ``stop_run``. A Stop now, or a Stop with no agent that has a
    session, ends the run here, its sessions too (``_stop_here``); a Stop with agents to save records the request, asks
    each to checkpoint and stop (the Shut down signal), and ends the run now if none has a session left (one waiting
    or paused stops at once), else the tick does once they have (``_finish_stops``). Settling the run (its release, the
    rule) is the caller's or the next tick's."""
    run, mode = _stopping_run(run_id, mode)
    if run is None:
        return _ended_as_it_is(run_id, mode)
    supervisor, now = _supervisor(), int(clock())
    if run.status in ENDED or mode == STOP_NOW or not run_stop.saving_agents(supervisor.sessions.of_run(run_id)):
        return _stop_here(run_id, actor, mode, now)
    _runs().request_stop(run_id, mode=STOP, now=now, actor=actor)
    answers = supervisor.signal_detailed(run_id, None, 'shutdown', now)
    agents = {agent: status for agent, (status, _) in answers.items()}
    stopping, left = _runs().get(run_id), supervisor.sessions.of_run(run_id)
    if stopping is not None and run_stop.due(stopping, left, now):
        stopped = _stop_here(run_id, actor or stopping.stop_requested_by, STOP, now)
        return replace(stopped, agents={**agents, **stopped.agents})
    return run_stop.Stopped(run_id, 'stopping', STOP, saving=run_stop.saving_agents(left), agents=agents)


def _stop_here(run_id: str, actor: str, mode: str, now: int) -> run_stop.Stopped:
    """The runtime ends the run as stopped at once (``stop.close``), then every session of it, and says so."""
    supervisor = _supervisor()
    stopped = run_stop.close(_runs(), _board_store(), supervisor.sessions, run_id, actor=actor, mode=mode, now=now,
                             reason=run_stop.reason_of(mode))
    agents = supervisor.signal(run_id, None, 'stop_now', now)
    _say_stopped(run_id, stopped, agents)
    return replace(stopped, agents=agents)


def finish_stop_action(event: Mapping[str, Any]) -> dict[str, Any]:
    """voc-engineering-runtime's ``finish_stop`` (``{"run_id", "actor", "reason"}``), handed on by voc-engineering-start
    once its Stop has ended the run: the rest of the end (``end_run`` as ``stopped``: every session ended, the run
    settled). Its own name, so the start function's hand-on names no function of this module's (a reachability sweep
    matches such a name to its def)."""
    return end_run({'run_id': event.get('run_id', ''), 'status': 'stopped', 'actor': event.get('actor') or '',
                    'reason': event.get('reason') or ''})


def stop_run_action(event: Mapping[str, Any]) -> dict[str, Any]:
    """voc-engineering-runtime's ``stop_run`` (``{"run_id", "actor"}``), handed on by voc-engineering-start for a Stop
    whose agents save first (asynchronously): each agent asked to save and stop, the run ended once none is left
    with a session (``_stop_in_runtime``; the tick finishes it otherwise), then settled. A run that has ended is
    finished as it is."""
    stopped = _stop_in_runtime(str(event.get('run_id', '')), str(event.get('actor') or ''), STOP)
    _settle()
    return stopped.view()


def _finish_stops(now: int) -> None:
    """Each tick: every listed run a person is stopping is ended once none of its agents has a session left, or its
    grace has passed (``stop.due``); best effort per run, logged, never failing the tick."""
    runs, supervisor = _runs(), _supervisor()
    for run_id in runs.listed():
        try:
            run = runs.get(run_id)
            left = supervisor.sessions.of_run(run_id) if run is not None and run.stopping else []
            if run is None or not run_stop.due(run, left, now):
                continue
            grace = bool(run_stop.saving_agents(left))
            stopped = run_stop.close(runs, _board_store(), supervisor.sessions, run_id, actor=run.stop_requested_by,
                                     mode=STOP, now=now, reason=run_stop.reason_of(STOP, saved=not grace, grace=grace))
            _say_stopped(run_id, stopped, supervisor.signal(run_id, None, 'stop_now', now))
        except Exception:
            logger.exception('engineering stop: a stopping run could not be ended this tick', extra={'run_id': run_id})


def _say_stopped(run_id: str, stopped: run_stop.Stopped, agents: Mapping[str, str]) -> None:
    """The run's conversation says it was stopped (``run.health``, as the supervisor's own stop does); best effort."""
    if stopped.already:
        return
    ended = sum(status == 'stopped' for status in agents.values())
    try:
        _supervisor().bus.emit(run_id, 'run', 'run.health',
                               f'Stopped from the run monitor: {ended} session(s) ended, '
                               f'{len(stopped.tasks_closed)} task(s) closed.')
    except Exception:
        logger.exception('engineering stop: the stop was not said on the bus', extra={'run_id': run_id})


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
        if run is not None and run.status == 'needs_human':
            _sweep_at_a_person(runs, run)
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


#: Each listed run's Learn hours at a person, once read (its flow copy never changes), at most this many runs.
_learn_hours: dict[str, int] = {}
MAX_LEARN_HOURS_CACHED: Final = 500


def _sweep_at_a_person(runs: RunStore, run: Run) -> None:
    """Learn's sweep (7.50.00): a run left at a person past its flow's ``learn.after_needs_human_hours`` learns once
    (``RunStore.mark_learn_swept``), its record as it stands; best effort, logged, never failing the tick."""
    if run.learn_swept_at or not run.needs_human_at:
        return
    try:
        hours = _learn_hours.get(run.run_id)
        if hours is None:
            if len(_learn_hours) >= MAX_LEARN_HOURS_CACHED:
                _learn_hours.clear()
            settings = _learn_settings(run.run_id)
            hours = _learn_hours[run.run_id] = settings.after_needs_human_hours if settings.enabled else -1
        now = int(clock())
        if hours < 0 or now - run.needs_human_at < hours * 3600 or not runs.mark_learn_swept(run.run_id, now=now):
            return
        _hand_on({'action': 'retrospective', 'run_id': run.run_id, 'at_a_person': True})
    except Exception:
        logger.exception('engineering learn: the sweep of a run at a person failed', extra={'run_id': run.run_id})


def _attempt(supervisor: Supervisor, run_id: str, task_id: str, given: int | None) -> int:
    """The task's attempt, as the board has it (a launch naming another is refused: the agent's lease epoch is the
    attempt, and the supervisor ends a session at another); 1, or the one given, for a task not on the board yet."""
    lease = supervisor.board.lease(run_id, task_id)
    if lease is None:
        return 1 if given is None else given
    if given is not None and given != lease.attempt:
        raise RuntimeRefused(f'the task is at attempt {lease.attempt}, not {given}')
    return lease.attempt


def _skill_rows() -> Any:
    """The skills store on voc-engineering (the runtime's role reads its rows: ``LearningCoachSkills``)."""
    from engineering.skills.store import SkillStore
    from shared.aws import get_dynamodb_client
    return SkillStore(get_dynamodb_client(), os.environ['ENGINEERING_TABLE'])


def _resolved_skill(event: Mapping[str, Any]) -> tuple[Resolved | None, dict[str, str]]:
    """The skill the launch runs (``skills/resolve.py``): the flow step's pin, the store's current version for the
    run's connection, else the role's bundled template; None for a role with none. A pin or label the store refuses
    is ``RuntimeRefused`` (the board clears its launch record); a store that cannot be read raises as it is (the
    board answers 503 and the coordinator asks again), never falling back to the template. With it, the Registry
    card the step was made from (7.52.00, ``step_card``: ``{card, card_version}``, empty for none)."""
    from engineering.skills.model import SkillError
    from engineering.skills.resolve import resolve_launch, step_card, step_pin
    role, run_id = str(event.get('role', '')), str(event.get('run_id', ''))
    step = str(event.get('step', '') or '')
    try:
        definition = _runs().flow_definition(run_id) if step else None
        return resolve_launch(role, connection=str(event.get('connection', '')),
                              pin=step_pin(definition, step, role), rows=_skill_rows(),
                              templates=bundled()), step_card(definition, step, role)
    except (SkillError, FlowError) as error:
        raise RuntimeRefused(f'the {role} cannot be launched on its skill: {error}') from error


def _harness(event: Mapping[str, Any]) -> tuple[tuple[str, ...], dict[str, str]]:
    """The agent's harness argv and what the reports name it by: its resolved skill's (a request that names another
    argv for it is refused), else the request's (a role with no skill yet). The session row records the skill's
    label, which the session's harness fetches the record by (the board's ``skill``), and the Registry card its step
    was made from (7.52.00: ``card``, ``card_version``)."""
    resolved, card = _resolved_skill(event)
    given = event.get('harness')
    if resolved is not None:
        argv = harness_argv(resolved.skill)
        if given is not None and (not _strings(given) or tuple(given) != argv):
            raise RuntimeRefused(f'a {resolved.skill.name} runs its skill\'s harness ({resolved.label}), not another')
        return argv, {'model': resolved.skill.model, 'skill_version': resolved.label, **card}
    if not _strings(given) or not 0 < len(given) <= MAX_HARNESS_ARGS:
        raise RuntimeRefused(f'harness must be an argv of 1-{MAX_HARNESS_ARGS} strings (the role has no skill yet)')
    return tuple(given), {'model': str(event.get('model', ''))[:200],
                          'skill_version': str(event.get('skill_version', ''))[:200]}


def _launch_model(argv: tuple[str, ...], labels: dict[str, str], role: str,
                  run: Run) -> tuple[tuple[str, ...], dict[str, str]]:
    """The launch's argv on its harness and model (7.58.00, ``harness_switch.with_model``): the run's choice for every
    role, else the role's as the run's start recorded it; none, as before (the skill's model). Its labels say the
    model it asks for (on Kiro without a choice, Kiro's name for its skill's model; its Bedrock id when Kiro has none,
    and that session stops) and the choice applied (``model_choice``, none without one)."""
    choice = model_choice.chosen(run.model_choice, run.role_models.get(role, ''))
    argv, model = harness_switch.with_model(argv, role, os.environ, choice)
    if choice:
        return argv, {**labels, 'model': model, 'model_choice': choice}
    return argv, ({**labels, 'model': model} if harness_switch.is_kiro(argv) else labels)


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
    if bundled().skill(COORDINATOR) is None:
        raise RuntimeRefused('no coordinator can be launched yet: the role has no skill')
    images = _image_languages()
    if language not in images:
        raise RuntimeRefused(f'no {language} image in this deployment: start the run in one of '
                             f'{sorted(images) or "none yet"}')


def _coordinated_run(run_id: str, *, or_waiting_for_cache: bool = False) -> Run | None:
    """The run when it is active with its connection, commit and language (it has, or gets, a coordinator), else
    None. ``or_waiting_for_cache``: a run waiting at the checkout cache's point counts too (its fill is what it
    waits for)."""
    run = _runs().get(run_id)
    if run is None or not (run.connection and run.commit and run.language):
        return None
    waiting = run.status == 'needs_human' and run.waiting_at == CHECKOUT_CACHE_POINT
    return run if run.status == 'active' or (or_waiting_for_cache and waiting) else None


def _fill_handed_on(run: Run, actor: str, *, resume_after_fill: bool) -> bool:
    """When the run's commit has no usable entry, or only the previous generation's, the current one is filled first,
    in an invocation of its own (a fill may take minutes), which then launches as ``_ensure_coordinator`` does
    (``launch_coordinator``): True, the fill handed on. Whatever the coordinator's state: a Resume refills an entry
    gone under a live run. Only a run with nothing usable waits for it (at the checkout cache's point, which the
    Resume carried on after the fill may pass); one served by the previous generation goes on, and its fill ahead
    resumes nothing."""
    found = _checkout_cache().look(run.connection, run.commit, run.repo)
    if found.state == 'ready' and not found.fill_ahead:
        return False
    held = resume_after_fill and found.state != 'ready'
    if held:
        with contextlib.suppress(RunNotActive):
            _runs().needs_human(run.run_id, CHECKOUT_CACHE_POINT, now=int(clock()), actor=actor or UNATTRIBUTED)
    _fill_marked(run.run_id)
    _launch_later(run.run_id, actor, filled=False, resume=held)
    return True


def _ensure_coordinator(run_id: str, actor: str, *, fill_first: bool = True, resume_after_fill: bool = False) -> None:
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
    run = _coordinated_run(run_id)
    if run is None:
        return
    if fill_first and _fill_handed_on(run, actor, resume_after_fill=resume_after_fill):
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
    issue, commit, verified = _optional_number(event, 'issue', int) or 0, str(event.get('commit', '')), False
    first = runs.get(run_id) is None
    if first:   # (a run that cannot fit is refused before anything is written)
        _run_fits(caps)
    if language and first:   # (any first start naming a language: no run records one it cannot run)
        _coordinator_launchable(language)
    if first and event.get('resolve_commit') is True:
        # (an engineering agent's run, 7.47.00: the head of the connection's default branch, and its issue confirmed)
        commit, verified = _resolved_head(event, issue)
    # (the administrators' hard cap, or the start's own: what is left of the flow's month, or no start; a retry of a
    # live run is not capped again)
    if first and budget_usd is not None and (event.get('hard_cap') is True or _hard_cap_on()):
        caps = hard_capped(caps, budget_usd=budget_usd, flow=flow, table=runs.table, now=int(clock()))
    definition = event.get('flow_definition', '')
    if not isinstance(definition, str):
        raise RuntimeRefused('flow_definition is the stored flow\'s definition, as its JSON text')
    # (7.58.00: the model chosen for every role, and the roles' own choices as the Registry holds them now)
    model, role_models = _start_models(event, definition) if first else ('', {})
    try:
        runs.start(run_id, caps=caps, now=int(clock()), goal=_goal(event),
                   repo=str(event.get('repo', '')), default_branch=str(event.get('default_branch', '')),
                   flow=flow,
                   connection=str(event.get('connection', '')), commit=commit,
                   language=language, actor=str(event.get('actor') or ''),
                   budget_usd=budget_usd, flow_definition=definition,
                   flow_revision=_optional_number(event, 'flow_revision', int) or 0,
                   issue=issue, host=str(event.get('host', '')), issue_verified=verified,
                   issue_repo=str(event.get('issue_repo', '')),
                   origin=RunOrigin.of(event), model_choice=model, role_models=role_models)
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


def _role_model_choices() -> dict[str, str]:
    """Each role's model choice as the Registry holds it (7.58.00, voc-agents' settings row: the hard cap's partition,
    ENGINEERING_SETTINGS_TABLE), read at a first start; {} for a deployment that names no settings table. A read that
    fails refuses the start, saying so (nothing is written yet: retry)."""
    table = os.environ.get('ENGINEERING_SETTINGS_TABLE')
    if not table:
        return {}
    from engineering.settings import read_role_models
    try:
        found = read_role_models(_settings_table(table))
    except (ClientError, BotoCoreError) as error:
        logger.exception('engineering runtime: the roles\' model choices could not be read')
        raise StartReadFailed('the roles\' models could not be read: start the run again') from error
    return {role: model.choice for role, model in found.items() if role in AGENT_ROLES}


def _start_models(event: Mapping[str, Any], definition: str) -> tuple[str, dict[str, str]]:
    """A first start's models (7.58.00, ``harness/model_choice.py``): the start's ``model_choice`` (one model for every
    role, checked), and the roles' own choices (``_role_model_choices``); refused before anything is written when a
    role of the flow would run on the native harness on a model this deployment does not grant and price
    (``harness_switch.native_models``): never a launch that cannot run, never a wider grant."""
    choice = _checked_choice(event)
    roles = _role_model_choices()
    _refuse_native(choice, roles, definition)
    return choice, roles


def _checked_choice(event: Mapping[str, Any]) -> str:
    """A start's or a restart's ``model_choice`` (one model for every role), checked: '' for none."""
    try:
        return model_choice.checked(event.get('model_choice'))
    except model_choice.ModelChoiceError as error:
        raise RuntimeRefused(str(error)) from error


def _refuse_native(choice: str, roles: Mapping[str, str], definition: str) -> None:
    """Refused (``RuntimeRefused``) when a role of the flow ``definition`` (every role without one it can read) would
    run on the native harness on a model this deployment does not grant and price, with ``choice`` for every role over
    ``roles``' own."""
    try:
        parsed = json.loads(definition) if definition else None
    except ValueError:
        parsed = None   # (the start refuses a definition off its shape, in its own words)
    launched = readiness.flow_roles(parsed) if isinstance(parsed, Mapping) else AGENT_ROLES
    native = (launched & harness_switch.KIRO_ROLES) - harness_switch.kiro_roles(
        os.environ.get(harness_switch.HARNESS_ENV))
    enabled = harness_switch.native_models(os.environ)
    for role in sorted(native):
        chosen = model_choice.chosen(choice, roles.get(role, ''))
        model = model_choice.bedrock_model(chosen, '')
        if model and model not in enabled:
            raise RuntimeRefused(f'the {role} runs on the native harness: {harness_switch.not_native(model)}')


def _goal(event: Mapping[str, Any]) -> str:
    """The run's goal; an engineering agent's (``via``, 7.47.00: its instructions and a sentence of its trigger's) with
    credential-shaped text redacted, as the Agents API redacts a person's."""
    goal = str(event.get('goal', ''))
    if event.get('via') is None:
        return goal
    from engineering.quality_gate.text import redact
    return redact(goal)


def _resolved_head(event: Mapping[str, Any], issue: int) -> tuple[str, bool]:
    """The head commit of the connection's stored default branch, read through the broker's ``head`` as this
    function's own role (``ENGINEERING_BROKER_URL``), and whether the run's ``issue`` is confirmed on the host; before
    anything is written. A start that names a commit too is refused; so is an issue the repository does not have, or
    has closed, and a broker refusal (in its words); a broker that cannot be reached is ``StartReadFailed``."""
    from engineering.learning.reactions_broker import BrokerAnswered, BrokerUnavailable
    from engineering.runtime.broker_head import BrokerHead
    if event.get('commit'):
        raise RuntimeRefused('a start resolves its commit or names one, never both')
    repository, branch = str(event.get('repo', '')), str(event.get('default_branch', ''))
    try:
        head = BrokerHead(url=os.environ['ENGINEERING_BROKER_URL'], region=os.environ.get('AWS_REGION', 'us-east-1'),
                          credentials=_own_credentials())(str(event.get('connection', '')), repository, branch,
                                                          issue or None)
    except BrokerAnswered as refused:
        if 400 <= refused.status < 500:
            raise RuntimeRefused(f'the repository refused the start: {refused.reason or refused}') from refused
        raise StartReadFailed('the repository\'s head could not be read: start the run again') from refused
    except (BrokerUnavailable, KeyError) as error:
        raise StartReadFailed('the repository\'s head could not be read: start the run again') from error
    if issue and head.issue_state == 'closed':
        raise RuntimeRefused(f'issue #{issue} of {repository} is closed')
    if issue and head.issue_state != 'open':
        raise RuntimeRefused(f'issue #{issue} is not an issue of {repository}')
    return head.commit, bool(issue)


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
    flags = {name: event.get(name) is True for name in ('resume', 'background', 'board')}
    asks = event.get('asks')
    asks = asks if isinstance(asks, int) and not isinstance(asks, bool) and 0 <= asks <= MAX_FILL_ASKS else 0
    try:
        check_run_id(run_id)
        if _filled_first(run_id, refilled=event.get('filled') is True, asks=asks):
            # The launch in an invocation of its own: a fill's wait and a session's start never share one limit.
            _cache_failures_cleared(run_id)
            _launch_later(run_id, actor, filled=True, **flags)
            return {'run_id': run_id, 'status': 'filled'}
        if flags['resume']:
            # A person's Resume handed this fill on: its agents held for want of a checkout are continued now, as
            # that Resume asked (the whole-run Resume again, which also makes sure of the coordinator).
            signal_action({'run_id': run_id, 'signal': 'resume', 'actor': actor, 'after_fill': True})
        else:
            _ensure_coordinator(run_id, actor, fill_first=False)
    except FillOutlasted as outlasted:
        # Not a launch under way: another run's fill of the commit held its claim past this one's wait, or ended with
        # no READY. Asked again in a fresh invocation, whose own fill takes a lapsed claim over (bounded: asks).
        logger.warning('engineering runtime: another fill of the commit outlasted the wait; asked again',
                       extra={'run_id': run_id, 'reason': str(outlasted), 'asks': asks + 1})
        _launch_later(run_id, actor, filled=False, asks=asks + 1, **flags)
        return {'run_id': run_id, 'status': 'waiting'}
    except SessionBusy:
        logger.info('engineering runtime: the run\'s coordinator launch is under way', extra={'run_id': run_id})
        return {'run_id': run_id, 'status': 'launching'}
    except Exception as error:
        logger.exception('engineering runtime: the run\'s coordinator, or its checkout, was not made ready',
                         extra={'run_id': run_id, 'background': flags['background']})
        # (background, and a board's transient, only for the cache's own failure: a coordinator's launch that fails
        # after such a fill is a coordinator failure like any other)
        cache_failed = isinstance(error, CheckoutUnavailable)
        return _coordinator_not_launched(run_id, actor, error, background=flags['background'] and cache_failed,
                                         board=flags['board'] and cache_failed)
    return {'run_id': run_id, 'status': 'active'}


def _coordinator_not_launched(run_id: str, actor: str, error: Exception, *, background: bool,
                              board: bool = False) -> dict[str, Any]:
    """What a ``launch_coordinator`` that failed answers and does. The cache's own failure (``CheckoutUnavailable``)
    is said in its words, already redacted, as the run's health, and the run goes to a person at the
    ``checkout_cache`` point; any other, at the coordinator's. A background fill (one handed on while the previous
    generation still serves the run) sends nobody for a failure a later try may not meet (logged and said as the run's
    health only); its refusal (``transient`` False: the writer's ``EntryRefused``, say the App uninstalled) sends the
    run to a person now, in its words, rather than at the previous generation's 28-day edge. A fill a
    board launch handed on (``board``: the coordinator is live and works) sends nobody for a transient failure
    either, until ``MAX_TRANSIENT_FILLS`` of them in a row (counted on the run's META, ``cache_failures``, cleared by
    a fill that lands) or one more after the streak is ``CACHE_FAILING_LIMIT_SECONDS`` old (``cache_failing_since``);
    a refusal sends the run to a person at once. Said as health in the cache's words: a transient failure ends
    ``RETRY_ENDING``, a refusal the ending of its cause (``_refusal_ending``)."""
    said = str(error) if isinstance(error, CheckoutUnavailable) else ''
    refused = isinstance(error, CheckoutUnavailable) and not error.transient
    if background and not refused:   # (a refusal reaches a person now, in its words, not at the 28-day edge)
        _health(run_id, f'The checkout cache\'s next generation was not filled ahead ({said or "it failed"}); the '
                        'current one still serves the run.')
        return {'run_id': run_id, 'status': 'active'}
    if board and isinstance(error, CheckoutUnavailable) and error.transient:
        now = int(clock())
        try:
            # (one spell of failures counts once: a fill's lease is the window racing fills fail within)
            failures, since = _runs().count_cache_failure(run_id, now=now, window=CACHE_FAILURE_WINDOW_SECONDS,
                                                          reset_after=CACHE_FAILURE_RESET_SECONDS)
        except Exception:   # (the count could not be kept: the run keeps working, the next launch tries again)
            logger.exception('engineering runtime: a cache failure was not counted', extra={'run_id': run_id})
            failures, since = 1, now
        # (bounded by time too: a coordinator asking less often than hourly never makes three in a row, and its
        # agents would be told to try again in a few minutes for ever)
        if failures < MAX_TRANSIENT_FILLS and now - since < CACHE_FAILING_LIMIT_SECONDS:
            _health(run_id, f'{said[:1].upper()}{said[1:]}. The run goes on; the next launch tries again '
                            f'({failures} of {MAX_TRANSIENT_FILLS} failures in a row).')
            return {'run_id': run_id, 'status': 'active'}
    try:
        if said:
            _health(run_id, f'{said[:1].upper()}{said[1:]}. {_refusal_ending(said) if refused else RETRY_ENDING}')
            with contextlib.suppress(RunNotActive):
                _runs().needs_human(run_id, CHECKOUT_CACHE_POINT, now=int(clock()), actor=actor or UNATTRIBUTED)
        else:
            _to_person(run_id, actor)
    except Exception:
        logger.exception('engineering runtime: the run could not be sent to a person', extra={'run_id': run_id})
    return {'run_id': run_id, 'status': 'needs_human'}


#: What the run's health says after a failure a later try may pass.
RETRY_ENDING: Final = 'A Resume of the run tries again.'
#: ... after a refusal a person puts right (the repository, the App, a cap): a Resume, the same commit, then fills it.
FIXED_ENDING: Final = 'Once that is put right, a Resume of the run fills the checkout.'
#: ... after a refusal of the commit itself: a Resume keeps the commit, so it helps only once the commit is pushed.
NO_COMMIT_ENDING: Final = ('A Resume of the run keeps this commit: it fills the checkout once the commit is pushed; '
                           'otherwise start a new run on a commit that is there.')
#: ... after an object of the commit failed its check: a Resume, the same commit, meets it again.
FSCK_ENDING: Final = 'A Resume of the run keeps this commit and would meet it again: start a new run on another commit.'


def _refusal_ending(said: str) -> str:
    """The words after a refusal's own, by its cause: the commit's own refusals (cache_layout ``NO_COMMIT``,
    ``FSCK_REJECTED``) say what a Resume, which keeps the commit, can and cannot do; every other, that a Resume fills
    the checkout once it is put right."""
    if NO_COMMIT in said:
        return NO_COMMIT_ENDING
    if FSCK_REJECTED in said:
        return FSCK_ENDING
    return FIXED_ENDING


#: How many transient checkout-cache failures in a row a working run's board launches meet before a person is asked.
MAX_TRANSIENT_FILLS: Final = 3
#: Transient failures within this long of the last one counted are the same spell, counted once (a writer's lease).
CACHE_FAILURE_WINDOW_SECONDS: Final = 300
#: A failure this long after the last one counted is not "in a row": the count starts again at 1.
CACHE_FAILURE_RESET_SECONDS: Final = 3600
#: A streak this old (its first failure, ``cache_failing_since``, with no fill landing since) goes to a person at its
#: next transient failure, whatever the count.
CACHE_FAILING_LIMIT_SECONDS: Final = 3600


def _fill_marked(run_id: str) -> None:
    """A fill of the run's checkout begins before a coordinator's launch: marked on its META (``cache_fill_at``) so the
    supervisor waits for that chain of invocations (best effort: logged)."""
    try:
        _runs().mark_cache_fill(run_id, now=int(clock()))
    except Exception:
        logger.exception('engineering runtime: the fill was not marked on the run', extra={'run_id': run_id})


def _cache_failures_cleared(run_id: str) -> None:
    """The run's count of transient cache failures cleared, a fill having landed (best effort: logged)."""
    try:
        _runs().clear_cache_failures(run_id)
    except Exception:
        logger.exception('engineering runtime: the cache failures were not cleared', extra={'run_id': run_id})


def _health(run_id: str, text: str) -> None:
    """``text`` as the run's health on the bus, as the supervisor (best effort: logged, never raised)."""
    try:
        _supervisor().bus.emit(run_id, 'run', 'run.health', text)
    except Exception:
        logger.exception('engineering runtime: the run\'s health was not said', extra={'run_id': run_id})


class FillOutlasted(RuntimeError):
    """Another run's fill of the commit held its claim past this one's wait, or ended with no READY
    (``CheckoutCache.wait_for``)."""


#: How many times a launch is asked again after other fills of its commit ended with no READY (each ask takes the
#: lapsed claim over with a fill of its own): bounded, then the run goes to a person.
MAX_FILL_ASKS: Final = 2


def _filled_first(run_id: str, *, refilled: bool, asks: int = 0) -> bool:
    """Fill an active run's commit in the checkout cache when it is not ready (the writer invoked and waited for):
    True when it filled, False when there was nothing to fill. Refused in the cache's words (``CheckoutUnavailable``:
    an entry of another repository, a fill refused or failed, a role that cannot read READY). A fill another fill
    holds is waited for (``CheckoutCache.wait_for``), then ``FillOutlasted``, so the launch is asked again: once for a
    claim still held, up to ``MAX_FILL_ASKS`` times for one that lapsed with no READY (each fresh ask's own fill takes
    it over); past that, ``CheckoutUnavailable``. ``refilled``: this invocation follows a fill, so an entry still not
    ready is refused rather than filled again (never a loop)."""
    run = _coordinated_run(run_id, or_waiting_for_cache=True)
    if run is None:
        return False
    cache = _checkout_cache()
    found = cache.look(run.connection, run.commit, run.repo)
    if found.state == 'ready' and (not found.fill_ahead or refilled):
        return False
    _fill_marked(run_id)   # (a fill begins: the coordinator's launch, if any, waits for its chain)
    if found.state == 'ready':
        # Only the previous generation is usable: the current one is filled ahead, best effort (the previous one
        # serves meanwhile), so the run's later launches and continuations never meet its 28-day edge.
        try:
            cache.fill(run.connection, run.commit, found.current)
        except CheckoutUnavailable as unavailable:
            if not unavailable.transient:
                # (the writer's refusal, the App uninstalled say: no later fill meets anything else, so a person
                # hears it now, in its words, not at the previous generation's 28-day edge)
                raise
            return _not_filled_ahead(run_id, unavailable)
        except (RuntimeRefused, SessionBusy, ClientError, BotoCoreError, ValueError) as error:
            # (a claim held, a throttle or a timeout of the invoke, an answer that does not read)
            return _not_filled_ahead(run_id, error)
        return True
    if found.state == 'refused':
        raise CheckoutUnavailable(found.refusal)
    if refilled:
        raise CheckoutUnavailable(DENIED if found.denied else
                                  'the run\'s checkout was filled, but no usable READY of it reads back')
    try:
        cache.fill(run.connection, run.commit, found.generation)   # (the current generation)
    except SessionBusy:
        # (another run's fill of the same commit holds the claim: its READY serves this run too)
        ended = cache.wait_for(run.connection, run.commit, run.repo, found.generation)
        if ended != 'ready':
            if asks >= (1 if ended == 'held' else MAX_FILL_ASKS):
                # Transient: other fills' contention, which a later try may not meet. A board-handed fill of a working
                # run counts it (a person on the third spell); a coordinator's own launch sends the run to a person
                # now (``_coordinator_not_launched`` reads ``transient`` only for a board's fill).
                raise CheckoutUnavailable('the run\'s checkout could not be cached: another fill of the commit held '
                                          'its claim past two waits' if ended == 'held' else
                                          'the run\'s checkout could not be cached: fills of the commit kept ending '
                                          'with no READY', transient=True) from None
            # (``lapsed``: that fill crashed, and the fresh invocation's own fill takes its claim over)
            raise FillOutlasted('another fill of the commit held its claim past the wait' if ended == 'held' else
                                'another fill of the commit ended with no READY: taken over') from None
    return True


def _not_filled_ahead(run_id: str, error: Exception) -> bool:
    """A fill ahead that failed (``error``) in a way a later try may not meet: logged and said, the previous
    generation serving meanwhile (False: nothing was filled)."""
    logger.error('engineering runtime: the current generation was not filled ahead', extra={'run_id': run_id},
                 exc_info=error)
    _health(run_id, 'The checkout cache\'s next generation was not filled ahead; the current one still serves the run.')
    return False


def _launch_later(run_id: str, actor: str, *, filled: bool, resume: bool = False, background: bool = False,
                  board: bool = False, asks: int = 0) -> None:
    """``launch_coordinator`` of the run in an invocation of its own of this function (asynchronous, by its name: the
    runtime's role may invoke itself); here and now with no function name (a local run, the tests). ``resume``: a
    person's whole-run Resume handed it on, so it resumes the run once filled; ``background``: a fill ahead while the
    previous generation serves, which never sends the run to a person; ``board``: a board launch handed it on while
    the coordinator works, so a transient failure sends nobody until it repeats; ``asks``: how many times it was
    asked again after another fill outlasted the wait."""
    event = {'action': 'launch_coordinator', 'run_id': run_id, 'actor': actor, 'filled': filled, 'resume': resume,
             'background': background, 'board': board, 'asks': asks}
    if not _function_name:
        launch_coordinator(event)
        return
    from shared.aws import invoke_lambda_async
    invoke_lambda_async(_function_name, event)


def _launch_generation(run: Run, connection: str, commit: str, role: str) -> int:
    """The cache generation a launch of ``role`` on ``commit`` clones, or ``RuntimeRefused`` in the cache's words."""
    cache = _checkout_cache()
    found = cache.look(connection, commit, run.repo)
    filling = False
    if (found.state == 'missing' or found.fill_ahead) and role != COORDINATOR:
        # The board's launch of an agent finds nothing usable (the cache moved on under a live run), or only the
        # previous generation: the current one is filled in an invocation of its own, so the coordinator's next ask
        # finds it (best effort; this launch is answered as it is). A coordinator's own launch never does: its
        # caller (``_ensure_coordinator``) has just filled first.
        filling = _fill_unless_under_way(cache, run.run_id, connection, commit, found)
    if found.state != 'ready':
        # (a fill on its way: the refusal says to try again shortly, not that a person's Resume is needed)
        raise RuntimeRefused(FILLING if filling and found.refusal == NOT_READY else found.refusal)
    if found.generation == found.current:
        _cache_failures_cleared(run.run_id)   # (the entry serves: no failure spell is still on)
    return found.generation


def _fill_unless_under_way(cache: CheckoutCache, run_id: str, connection: str, commit: str, found: Found) -> bool:
    """The current generation's fill handed on (``_fill_later``) unless a fill of it holds a live claim (a burst of
    launches or continuations starts one fill); background while the previous generation serves (``found`` ready):
    then only its refusal sends the run to a person. True when a fill is on its way (handed on, or holding a claim)."""
    if cache.fill_under_way(connection, commit, found.current):
        return True
    return _fill_later(run_id, background=found.state == 'ready')


def _fill_later(run_id: str, *, background: bool) -> bool:
    """The run's current generation filled in an invocation of its own (``launch_coordinator``, which then makes sure
    of the coordinator), best effort: logged, never raised over the launch that asked. True when it was handed on."""
    try:
        _launch_later(run_id, '', filled=False, background=background, board=True)
    except Exception:
        logger.exception('engineering runtime: the checkout cache\'s fill was not handed on', extra={'run_id': run_id})
        return False
    return True


def end_run(event: Mapping[str, Any]) -> dict[str, Any]:
    """End a run and every session of it, then settle (which starts its retrospective once none of its agents is
    live: here, or at the tick that ends the last busy one; best effort, never failing the end)."""
    run_id, status, runs = str(event.get('run_id', '')), str(event.get('status', '')), _runs()
    actor, reason = str(event.get('actor') or ''), str(event.get('reason') or '')
    try:
        runs.end(run_id, status, now=int(clock()), actor=actor, reason=reason)
    except RunNotActive:
        run = runs.get(run_id)
        if run is None or run.status not in ENDED:
            raise
        status = run.status  # a retry: the rest of the first end is done again
    if status == 'stopped':
        # (a person's Stop: its tasks closed and its launch holds run out, whether voc-engineering-start's Stop did it
        # first or not; each idempotent)
        run_stop.close(runs, _board_store(), _supervisor().sessions, run_id, actor=actor, mode=STOP_NOW,
                       now=int(clock()), reason=reason or run_stop.reason_of(STOP_NOW))
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
        from engineering.learning.reactions import ReactionsStore, host_reactions
        cases = json.loads(os.environ['ENGINEERING_BENCHMARK_CASES'])
        reactions = ReactionsStore(client, table)
        from engineering.learning.budget import LearnBudget, MeteredCoachModel
        runs = _runs()
        budget = LearnBudget(runs.table, runs, _token_price)

        def coach_for(run_id: str, settings: LearnSettings) -> Coach:
            """The run's coach on Learn's model (its flow's, when allowed), every reply's tokens counted in the run's
            spend (learning/budget.py)."""
            from engineering.coach.model import COACH_MODEL
            from shared.model_config import ALLOWED_MODEL_IDS
            model = settings.model if settings.model in ALLOWED_MODEL_IDS else COACH_MODEL
            return Coach(skills, MeteredCoachModel(BedrockCoachModel(model), lambda reply: budget.record(
                run_id, reply.model_id, reply.tokens_in, reply.tokens_out)))

        _learning_cache = LearningLoop(
            reader=RunRecordReader(client, table, workspace), scorecards=ScorecardStore(client, table),
            # A role's lessons only: no person memory is learned here, so no user is looked up.
            memory=AgentMemoryStore(client, table, is_user=lambda _user: False),
            coach=lambda: Coach(skills, BedrockCoachModel()),
            cases=tuple(str(case) for case in cases) if isinstance(cases, list) else (),
            # (7.10.00: the HostReactions port answers the run's latest recorded read, one Query of one row)
            reactions=lambda run: host_reactions(reactions.latest(run.ws, run.run_id)),
            # (7.50.00: Learn, as the run's flow sets it; the failed attempt's transcript; its share of the budget)
            settings=_learn_settings, transcripts=_transcript_excerpts, budget=budget, coach_for=coach_for)
    return _learning_cache


def _token_price(model: str, tokens_in: int, tokens_out: int) -> Decimal:
    """A model's tokens at this deployment's prices (``ENGINEERING_MODEL_PRICES`` over the defaults: caps.py)."""
    return caps.token_usd(caps.model_prices(os.environ.get('ENGINEERING_MODEL_PRICES')), model, tokens_in,
                          tokens_out)


def _learn_settings(run_id: str) -> LearnSettings:
    """The run's Learn settings: its flow copy's (flow/settings.py); the defaults for a run without a flow, or a copy
    that cannot be read (Learn never stops for a setting it cannot read)."""
    try:
        return learn_settings(_runs().flow_definition(run_id))
    except FlowError:
        logger.warning('engineering learn: the run\'s flow copy cannot be read; the defaults apply',
                       extra={'run_id': run_id})
        return LearnSettings()


def _transcript_excerpts(run: Any, failure: Any) -> tuple[str, ...]:
    """The failed attempt's transcript, as excerpts (learning/transcripts.py), through this function's grant on the
    agents' ``_transcripts/`` keys alone; none when it cannot be read (logged)."""
    from engineering.learning.transcripts import excerpts
    from engineering.workspace.store import WorkspaceStore
    from shared.aws import get_s3_client
    s3, bucket = get_s3_client(), os.environ['ENGINEERING_WORKSPACE_BUCKET']
    store = WorkspaceStore(s3, bucket, denied_is_missing=True)

    def listed(prefix: str) -> list[str]:
        answer = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=1000)
        return [key for item in answer.get('Contents', []) if (key := item.get('Key'))]

    try:
        return excerpts(listed, store.read_bytes, run.run_id, failure.attempt.agent, run.commit,
                        failure.attempt.attempt)
    except Exception:
        logger.exception('engineering learn: the transcript was not read', extra={'run_id': run.run_id})
        return ()


def retrospective(event: Mapping[str, Any]) -> dict[str, Any]:
    """The ``retrospective`` action, Learn (7.50.00): ``{"run_id", "at_a_person"?}`` (the run's end hands it on, or
    the sweep of a run left at a person past its flow's hours) writes the run's manifest and index entry, the ended
    run's scorecards, and hands each failure it takes to the coach on as ``{"run_id", "failure": <key>}``, which takes
    that one to the coach and to memory (``learning/loop.py``). Best effort: whatever fails is logged and answered,
    never raised (an asynchronous invocation that raised would be retried, and a retry would spend nothing new but
    time)."""
    run_id, failure = str(event.get('run_id', '')), event.get('failure')
    at_a_person = event.get('at_a_person') is True
    try:
        check_run_id(run_id)
        return (_retrospect(run_id, at_a_person=at_a_person) if failure is None
                else _learn_from(run_id, str(failure)[:MAX_FAILURE_KEY], at_a_person=at_a_person))
    except Exception:
        logger.exception('engineering retrospective failed', extra={'run_id': run_id, 'failure': failure})
        return {'run_id': run_id, 'status': 'failed'}


@cache
def _scheduler_client() -> Any:
    import boto3
    return boto3.client('scheduler')


@cache
def _own_credentials() -> Any:
    """This function's own role's credentials (Lambda's environment), which sign its call of the broker."""
    import boto3
    return boto3.Session().get_credentials()


def _broker_reactions(run_id: str) -> object:
    """The broker's ``reactions`` answer for ``run_id`` (its ``reactions``: a ``voc-reactions/1``, or None for no
    recorded pull request): one call of its function URL, SigV4-signed as this function's role, the one caller besides
    the agents the broker admits, and for this operation alone."""
    from engineering.learning.reactions_broker import BrokerReactions
    return BrokerReactions(url=os.environ['ENGINEERING_BROKER_URL'], region=os.environ.get('AWS_REGION', 'us-east-1'),
                           credentials=_own_credentials())(run_id)


def _reactions_read() -> ReactionsRead:
    from engineering.learning.reactions import ReactionsStore
    from engineering.learning.reactions_read import ReactionsRead
    from engineering.learning.scorecard import ScorecardStore
    from shared.aws import get_dynamodb_client
    client, table = get_dynamodb_client(), os.environ['ENGINEERING_TABLE']
    return ReactionsRead(client=client, table=table, broker=_broker_reactions, store=ReactionsStore(client, table),
                         scorecards=ScorecardStore(client, table))


def _asked_by(event: Mapping[str, Any]) -> str:
    """Who asked for a read: a person (``actor``, the hand trigger), else the schedule (the only other caller)."""
    from engineering.board.model import PERSON_PREFIX
    from engineering.learning.reactions import SCHEDULE
    actor = event.get('actor')
    return f'{PERSON_PREFIX}{actor[:200]}' if isinstance(actor, str) and actor else SCHEDULE


def reactions_action(event: Mapping[str, Any]) -> dict[str, Any]:
    """The ``reactions`` action: ``{"run_id", "asked_by"?: "schedule", "actor"?}`` (the run's schedule, or a person's
    hand trigger handed on by voc-engineering-start): one read of the ended run's reactions through the broker,
    recorded (``learning/reactions_read.py``); a run with no recorded pull request records nothing and says so. Never
    raises (an asynchronous invocation: nothing retries it)."""
    run_id = str(event.get('run_id', ''))
    asked_by = _asked_by(event)
    try:
        check_run_id(run_id)
        answer = _reactions_read().read(WORKSPACE, run_id, asked_by)
    except Exception:
        logger.exception('engineering reactions: the read failed', extra={'run_id': run_id, 'asked_by': asked_by})
        return {'run_id': run_id, 'status': 'failed'}
    logger.info('engineering reactions', extra={**answer, 'asked_by': asked_by})
    return answer


def _reactions_at_end(run_id: str) -> None:
    """At an ended run's retrospective: its one reactions schedule, ``ENGINEERING_REACTIONS_DELAY_DAYS`` on, only when
    its record keeps a pull request (``has_pull_request``: two reads of its own rows, never the host). Nothing is read
    of the host here: the schedule and a person's hand trigger are the reads, so the retrospective keeps its time. Best
    effort: logged, never raised."""
    from engineering.learning.reactions_read import has_pull_request
    from shared.aws import get_dynamodb_client
    try:
        if not has_pull_request(get_dynamodb_client(), os.environ['ENGINEERING_TABLE'], WORKSPACE, run_id):
            logger.info('engineering reactions: no recorded pull request, no schedule', extra={'run_id': run_id})
            return
        _schedule_reactions(run_id)
    except Exception:
        logger.exception('engineering reactions: the schedule was not created', extra={'run_id': run_id})


def _schedule_reactions(run_id: str) -> None:
    """The run's one schedule (``ReactionsSchedule``), invoking this function (its own ARN) later; none where the
    deployment names no group or role (a local run, the tests)."""
    from datetime import UTC, datetime

    from engineering.learning.reactions_read import ReactionsSchedule, delay_days
    group, role = os.environ.get('ENGINEERING_REACTIONS_GROUP', ''), os.environ.get('ENGINEERING_REACTIONS_ROLE_ARN', '')
    if not (group and role and _function_arn):
        logger.info('engineering reactions: no schedule in this deployment', extra={'run_id': run_id})
        return
    schedule = ReactionsSchedule(_scheduler_client(), group, role,
                                 delay_days(os.environ.get('ENGINEERING_REACTIONS_DELAY_DAYS')))
    created = schedule.create(run_id, _function_arn, datetime.fromtimestamp(clock(), UTC))
    logger.info('engineering reactions scheduled', extra={'run_id': run_id, 'created': created, 'days': schedule.days})


def _manifest_at_end(run_id: str) -> None:
    """The run's manifest and its index entry (runtime/manifest.py), create-only; best effort: logged, never raised
    (Learn goes on without it)."""
    from engineering.board.store import BoardStore
    from engineering.runtime import manifest
    from engineering.workspace.store import WorkspaceStore
    from shared.aws import get_dynamodb_client, get_s3_client
    try:
        runs = _runs()
        run = runs.get(run_id)
        if run is None:
            return
        query = {'KeyConditionExpression': 'pk = :run AND begins_with(sk, :agent)', 'ConsistentRead': True,
                 'ExpressionAttributeValues': {':run': run_pk(run_id), ':agent': 'AGENT#'}}
        from shared.dynamo_paging import iter_query
        agents = list(iter_query(runs.table, query))
        learn = runs.table.get_item(Key={'pk': run_pk(run_id), 'sk': 'LEARN#spend'}, ConsistentRead=True).get('Item')
        tasks = BoardStore(get_dynamodb_client(), os.environ['ENGINEERING_TABLE'], new_id=lambda: '').tasks(
            WORKSPACE, run_id)
        built = manifest.build(run, agents, tasks, revision=runs.flow_revision(run_id),
                               learn_spend={name: str(value) for name, value in (learn or {}).items()
                                            if name in ('tokens_in', 'tokens_out', 'cost_usd')})
        store = WorkspaceStore(get_s3_client(), os.environ['ENGINEERING_WORKSPACE_BUCKET'])
        key, indexed = manifest.write(store, built)
        logger.info('engineering run manifest written', extra={'run_id': run_id, 'key': key, 'indexed': indexed})
    except Exception:
        logger.exception('engineering run manifest not written', extra={'run_id': run_id})


def _retrospect(run_id: str, *, at_a_person: bool = False) -> dict[str, Any]:
    copy_triage_at_end(run_id)   # (7.50.00: a triage run's issue gets its trusted triage row; never raises)
    draft_tenets_at_end(run_id)   # (7.52.00: a Tenets run's record drafted as the next tenets version; never raises)
    _manifest_at_end(run_id)
    _reactions_at_end(run_id)   # (the schedule only: no host read here)
    summary = _learning().retrospective(WORKSPACE, run_id, at_a_person=at_a_person)
    for key in summary.to_coach:
        _hand_on({'action': 'retrospective', 'run_id': run_id, 'failure': key,
                  **({'at_a_person': True} if at_a_person else {})})
    logger.info('engineering retrospective', extra={
        'run_id': run_id, 'scorecards': summary.scorecards_written, 'kept': summary.scorecards_kept,
        'failures': summary.failure_count, 'coached': len(summary.to_coach), 'skipped': summary.skipped})
    return {'run_id': run_id, 'scorecards': summary.scorecards_written, 'failures': summary.failure_count,
            'to_coach': list(summary.to_coach), 'skipped': summary.skipped}


def _learn_from(run_id: str, failure: str, *, at_a_person: bool = False) -> dict[str, Any]:
    learned = _learning().learn_from(WORKSPACE, run_id, failure, at_a_person=at_a_person)
    # The coach's skill.proposed message is the coach's to publish, and this role speaks only as the supervisor: it
    # is logged (its id), and the proposal is in the skills store's history.
    logger.info('engineering retrospective: a failure learned from', extra={
        'run_id': run_id, 'failure': learned.key, 'coach': learned.coach, 'version': learned.proposed_version,
        'lesson': learned.lesson, 'skipped': learned.skipped,
        'announcement': (learned.announcement or {}).get('message', {}).get('event_id', '')})
    return {'run_id': run_id, 'failure': learned.key, 'proposed_version': learned.proposed_version,
            'coach': learned.coach, 'memory_id': learned.memory_id, 'lesson': learned.lesson,
            'skipped': learned.skipped}


def _cross_run() -> CrossRunLearn:
    """The cross-run Learn pass on this function's clients (7.53.00): the index listed and the manifests read through
    its grants on them alone (``CrossRunListsIndex``, ``CrossRunReadsManifests``), its model the coach's bounded
    client on Learn's model, every reply's tokens booked first (learning/cross_run.py ``CrossRunBudget``)."""
    from engineering.agent_memory.store import AgentMemoryStore
    from engineering.coach.model import BedrockCoachModel
    from engineering.learning.budget import MeteredCoachModel
    from engineering.learning.cross_run import CrossRunBudget, CrossRunLearn
    from engineering.learning.cross_run_input import RunInputReader, s3_lister
    from engineering.skills.store import SkillStore
    from engineering.workspace.store import WorkspaceStore
    from shared.aws import get_dynamodb_client, get_s3_client
    client, table = get_dynamodb_client(), os.environ['ENGINEERING_TABLE']
    s3, bucket = get_s3_client(), os.environ['ENGINEERING_WORKSPACE_BUCKET']
    # (a manifest never written answers 403 without ListBucket on its prefix: read as missing, and counted)
    workspace, runs = WorkspaceStore(s3, bucket, denied_is_missing=True), _runs()
    cases = json.loads(os.environ['ENGINEERING_BENCHMARK_CASES'])
    return CrossRunLearn(
        lister=s3_lister(s3, bucket), reader=RunInputReader(runs.table, workspace.read_text), runs=runs,
        skills=SkillStore(client, table), memory=AgentMemoryStore(client, table, is_user=lambda _user: False),
        budget=CrossRunBudget(runs.table, _token_price),
        model_for=lambda model, on_reply: MeteredCoachModel(BedrockCoachModel(model), on_reply),
        put_once=workspace.put_once, cases=tuple(str(case) for case in cases) if isinstance(cases, list) else ())


def _hand_on_cross_run(event: dict[str, Any]) -> None:
    """One flow's pass to this function again, asynchronously, so each flow's model call gets the whole time limit;
    run here and now with no function name (a local run, the tests). Best effort: logged, never raised."""
    try:
        if not _function_name:
            learn_cross_run(event)
            return
        from shared.aws import invoke_lambda_async
        invoke_lambda_async(_function_name, event)
    except Exception:
        logger.exception('engineering cross-run learn: a flow\'s pass was not started', extra={'flow': event.get('flow')})


def learn_cross_run(event: Mapping[str, Any]) -> dict[str, Any]:
    """The ``learn_cross_run`` action (7.53.00): ``{}`` (the weekly schedule) hands each of the index's flows on;
    ``{"flow"}`` runs that flow's pass this week (learning/cross_run.py). Never raises: an asynchronous invocation
    that raised would be retried, and a retry finds the week's claim and does nothing new."""
    flow = event.get('flow')
    named = str(flow)[:200] if flow is not None else ''
    try:
        if flow is None:
            from engineering.learning.cross_run_input import flows
            names, more = flows(_cross_run().lister)
            for name in names:
                _hand_on_cross_run({'action': 'learn_cross_run', 'flow': name})
            logger.info('engineering cross-run learn: flows handed on', extra={'flows': len(names), 'more': more})
            return {'status': 'handed_on', 'flows': list(names), 'more': more}
        answer = _cross_run().run(named).view()
    except Exception:
        logger.exception('engineering cross-run learn failed', extra={'flow': named})
        return {'flow': named, 'status': 'failed'}
    logger.info('engineering cross-run learn', extra=answer)
    return answer


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
    checkout_commands(commit, paths, 0)  # refuses a bad commit or path before anything starts (any generation)
    run = _runs().get(str(event.get('run_id', '')))
    if run is None or run.status != 'active':
        raise RunNotActive('agents are launched only for an active run')
    # (7.53.00: the deployment's switch, -c engineeringHarness: the role on Kiro over ACP, or its skill's own adapter;
    # 7.58.00: on the model the run or the role chose)
    harness, labels = _launch_model(harness, labels, str(event.get('role', '')), run)
    # The agent clones its commit from the cache: none is launched before the commit has a usable entry, and the
    # generation found is the one its checkout clones (its session row keeps it).
    generation = _launch_generation(run, str(event.get('connection', '')), commit, str(event.get('role', '')))
    role, language = str(event.get('role', '')), str(event.get('language', ''))
    allowlist = egress.egress_allowlist(
        role=role, language=language, region=os.environ.get('AWS_REGION', 'us-east-1'), bucket=supervisor.bucket,
        workspace_bucket=supervisor.workspace_bucket,
        extra_hosts=json.loads(os.environ.get('ENGINEERING_EXTRA_EGRESS', '[]')),
        service_urls=[supervisor.board_url, supervisor.broker_url], kiro=harness_switch.is_kiro(harness))
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
            egress=allowlist, connection=spec.connection, commit=commit, cache_generation=generation,
            paths=tuple(paths), harness=tuple(harness), vm_id=vm.vm_id, endpoint=vm.endpoint, task_attempt=attempt,
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
#: ... its Resume or Restart of an ended run, as a child run (7.51.00).
RESTART_ACTION: Final = 'restart_run'


def _head_commit(connection: str, repository: str, branch: str) -> str:
    """The connection's default branch's head, through the broker's ``head`` as this function's own role."""
    from engineering.learning.reactions_broker import BrokerAnswered, BrokerUnavailable
    from engineering.runtime.broker_head import BrokerHead
    try:
        return BrokerHead(url=os.environ['ENGINEERING_BROKER_URL'], region=os.environ.get('AWS_REGION', 'us-east-1'),
                          credentials=_own_credentials())(connection, repository, branch, None).commit
    except BrokerAnswered as refused:
        if 400 <= refused.status < 500:
            raise RuntimeRefused(f'the repository refused the restart: {refused.reason or refused}') from refused
        raise StartReadFailed('the repository\'s head could not be read: restart the run again') from refused
    except (BrokerUnavailable, KeyError) as error:
        raise StartReadFailed('the repository\'s head could not be read: restart the run again') from error


def restart_run(event: Mapping[str, Any]) -> dict[str, Any]:
    """voc-engineering-start's ``restart_run`` (7.51.00, ``{"run_id": <parent>, "child_run_id"?, "mode": resume |
    restart, "base": same | head, "agents"?: [<agent>], "model_choice"?, "actor"}``): the child run written
    (``restart.py`` 1), its rule switched on and ``seed_restart`` handed on to voc-engineering-runtime. A retry with
    the same child id answers the child already there. The child runs on the parent's models, or (7.58.00)
    ``model_choice`` for every role, checked as a start's (``_refuse_native``). Refused, before anything is written,
    for a parent that is live (its signals resume and restart its agents), unknown, one this deployment cannot launch a
    coordinator for, or a model it cannot run. Answers ``{run_id: <child>, parent_run_id, status}``."""
    from engineering.bus.publish import new_event_id
    from engineering.runtime import restart
    parent_id, actor = check_run_id(str(event.get('run_id', ''))), str(event.get('actor') or '')[:200]
    child_id = check_run_id(str(event.get('child_run_id') or new_event_id()))
    mode, base = str(event.get('mode', 'resume')), str(event.get('base', 'same'))
    agents = event.get('agents') or []
    if mode not in restart.MODES or base not in seed_bases() or not actor or not _strings(agents) or len(agents) > 50:
        raise RuntimeRefused('a restart is {run_id, mode: resume | restart, base: same | head, agents?, actor}')
    runs = _runs()
    existing = runs.get(child_id)
    if existing is not None:
        meta = runs.table.get_item(Key=meta_key(child_id), ConsistentRead=True).get('Item') or {}
        if (meta.get('parent') or {}).get('run_id') != parent_id:
            raise RunExists(f'run {child_id} exists and is not a child of {parent_id}')
        return {'run_id': child_id, 'parent_run_id': parent_id, 'status': existing.status}
    parent = runs.get(parent_id)
    if parent is None:
        raise RuntimeRefused('no such run')
    now = int(clock())
    restart.may_restart(parent.status, parent.waiting_at, parent.started_at, now)
    if parent.language:
        _coordinator_launchable(parent.language)
    meta = runs.table.get_item(Key=meta_key(parent_id), ConsistentRead=True).get('Item') or {}
    copy = runs.table.get_item(Key={'pk': run_pk(parent_id), 'sk': 'FLOW'}, ConsistentRead=True).get('Item') or {}
    model = _checked_choice(event)
    if model:
        _refuse_native(model, parent.role_models, str(copy.get('definition', '')))
    commit = parent.commit
    if base == 'head' and parent.connection:
        commit = _head_commit(parent.connection, parent.repo, str(meta.get('default_branch', '')))
    plan = runs.flow_plan(parent_id) if copy and mode == 'resume' else None
    inherited = restart.inherited_steps(plan)
    fanned = {step: shards for step, shards in _fanned(runs, parent_id).items() if step in inherited} if inherited \
        else {}
    at = _iso_now(now)
    recorded_issue = meta.get('issue')
    issue: Mapping[str, Any] = recorded_issue if isinstance(recorded_issue, Mapping) else {}
    origin = {'run_id': parent_id, 'mode': mode, 'by': actor, 'at': at, 'base': base, **({'agents': list(agents)}
                                                                                       if agents else {})}
    runs.start(child_id, caps=parent.caps, now=now, goal=str(meta.get('goal', '')), repo=parent.repo, flow=parent.flow,
               connection=parent.connection, commit=commit, language=parent.language, actor=actor,
               budget_usd=parent.budget_usd, flow_definition=str(copy.get('definition', '')),
               flow_revision=int(copy.get('revision', 0)) if copy else 0,
               default_branch=str(meta.get('default_branch', '')), issue=int(issue.get('number', 0) or 0),
               host=str(issue.get('host', '')), issue_verified=bool(issue.get('verified')), parent=origin,
               extra=restart.child_rows(parent_id, child_id, mode=mode, actor=actor, at=at, inherited=inherited,
                                        fanned=fanned),
               coordinator_seed=seed_key_of(child_id),
               # (7.58.00: the parent's models, as its start chose them, unless the restart names one for every role)
               model_choice=model or parent.model_choice, role_models=parent.role_models)
    try:
        _switch(True)
        from shared.aws import invoke_lambda_async
        invoke_lambda_async(os.environ['ENGINEERING_RUNTIME_FUNCTION'],
                            {'action': 'seed_restart', 'run_id': child_id, 'actor': actor})
    except Exception as error:
        _to_person(child_id, actor)
        raise StartFailed(f'run {child_id} was started, but its seeds were not handed on: open it and resume it') \
            from error
    logger.info('engineering run restarted', extra={'run_id': child_id, 'parent_run_id': parent_id, 'mode': mode})
    return {'run_id': child_id, 'parent_run_id': parent_id, 'status': 'active'}


def seed_bases() -> frozenset[str]:
    from engineering.runtime.harness.seed import BASES
    return BASES


def seed_key_of(child_id: str) -> str:
    """The seed the child's coordinator starts from (its coordinate task names it)."""
    from engineering.runtime.harness.seed import seed_key
    return seed_key(child_id, COORDINATE_TASK)


def _iso_now(now: int) -> str:
    from engineering.runtime.runs import utc
    return utc(now).strftime('%Y-%m-%dT%H:%M:%SZ')


def _fanned(runs: RunStore, run_id: str) -> dict[str, tuple[str, ...]]:
    """A run's maps' shards, as its coordinator listed them."""
    from engineering.flow.record import FAN_OUT, STEP_PREFIX
    return {str(row['step']['S']): tuple(item.get('S', '') for item in row.get('shards', {}).get('L', ()))
            for row in runs.typed_rows(run_id, STEP_PREFIX)
            if row.get('record', {}).get('S') == FAN_OUT}


def seed_restart_action(event: Mapping[str, Any]) -> dict[str, Any]:
    """voc-engineering-runtime's ``seed_restart`` (7.51.00, ``restart.py`` 2; named apart from the action, whose name
    the start function hands on as a string, which a reachability sweep matches by name): the child's parent ended first when it
    was not, its seeds written and its tasks posted, then its coordinator launched. Never raises: a failure sends the
    child to a person (whose Resume launches its coordinator, which then plans from the flow)."""
    from engineering.runtime import restart
    child_id, actor = str(event.get('run_id', '')), str(event.get('actor') or '')
    try:
        runs = _runs()
        origin, parent = _child_and_parent(runs, child_id)
        parent_id = parent.run_id
        if parent.status not in ENDED:
            end_run({'run_id': parent_id, 'status': 'stopped', 'actor': actor or RESTARTED_BY})
        outcome = _seeder(child_id).seed(
            child_id, parent_id, mode=str(origin.get('mode', 'resume')), base=str(origin.get('base', 'same')),
            parent_commit=parent.commit, agents=[str(agent) for agent in origin.get('agents', [])],
            inherited=_inherited(runs, child_id), steering=restart.steering_history(_conversation(parent_id)),
            flows=_flow_guard())
        logger.info('engineering restart seeded', extra={'run_id': child_id, 'seeded': len(outcome['seeded']),
                                                         'posted': len(outcome['posted'])})
    except Exception:
        logger.exception('engineering restart: the child run was not seeded', extra={'run_id': child_id})
        _to_person(child_id, actor)
        return {'run_id': child_id, 'status': 'needs_human'}
    launched = launch_coordinator({'run_id': child_id, 'actor': actor})
    return {'run_id': child_id, 'status': launched.get('status', ''), **outcome}


#: Who ends a parent when nobody is named (D4).
RESTARTED_BY: Final = 'restart'


def _child_and_parent(runs: RunStore, child_id: str) -> tuple[Mapping[str, Any], Run]:
    """A child run's ``parent`` record (its META's) and its parent; ``RuntimeRefused`` for a run that is not a
    child, or whose parent is gone."""
    meta = runs.table.get_item(Key=meta_key(check_run_id(child_id)), ConsistentRead=True).get('Item') or {}
    origin = meta.get('parent') if isinstance(meta.get('parent'), Mapping) else None
    parent = runs.get(str(origin.get('run_id', ''))) if origin is not None else None
    if origin is None or parent is None:
        raise RuntimeRefused(f'run {child_id} is not a child run of a run that is there')
    return origin, parent


def _inherited(runs: RunStore, run_id: str) -> list[str]:
    from engineering.flow.record import INHERITED, STEP_PREFIX
    return [str(row['step']['S']) for row in runs.typed_rows(run_id, STEP_PREFIX)
            if row.get('record', {}).get('S') == INHERITED]


def _conversation(run_id: str) -> list[dict[str, Any]]:
    """The run's conversation, its first pages (the steering people gave it is in it)."""
    from engineering.conversation.store import ConversationStore
    from shared.aws import get_dynamodb_client
    store, found, after = ConversationStore(get_dynamodb_client(), os.environ['ENGINEERING_TABLE']), [], 0
    for _ in range(20):
        page = store.page(WORKSPACE, run_id, after=after, limit=200)
        found += page
        if len(page) < 200:
            break
        after = page[-1]['seq']
    return found


def _flow_guard() -> Any:
    from engineering.board.flow_guard import FlowGuard
    from engineering.board.store import BoardStore
    from engineering.bus.publish import new_event_id
    from shared.aws import get_dynamodb_client
    return FlowGuard(BoardStore(get_dynamodb_client(), os.environ['ENGINEERING_TABLE'], new_id=new_event_id),
                     _gate_record)


def _seeder(child_id: str) -> Any:
    """The runtime's seeder: the workspace bucket, the board's store, the checkpoints, Learn's model and its budget
    (the summary is charged to the child)."""
    from engineering.board.store import BoardStore
    from engineering.bus.publish import new_event_id
    from engineering.coach.model import COACH_MODEL, BedrockCoachModel
    from engineering.learning.budget import LearnBudget
    from engineering.runtime.restart import Seeder
    from shared.aws import get_dynamodb_client, get_dynamodb_resource, get_s3_client
    from shared.model_config import ALLOWED_MODEL_IDS
    settings = _learn_settings(child_id)
    model = settings.model if settings.model in ALLOWED_MODEL_IDS else COACH_MODEL
    table = os.environ['ENGINEERING_TABLE']
    budget = LearnBudget(get_dynamodb_resource().Table(table), _runs(), _token_price)
    return Seeder(s3=get_s3_client(), bucket=os.environ['ENGINEERING_WORKSPACE_BUCKET'],
                  board=BoardStore(get_dynamodb_client(), table, new_id=new_event_id),
                  checkpoints=CheckpointReader(get_s3_client(), os.environ['ENGINEERING_WORKSPACE_BUCKET']),
                  summarize=BedrockCoachModel(model), charge=budget.record)
#: ... and its other one (7.10.00): an administrator's hand trigger of an ended run's reactions read.
ASK_REACTIONS_ACTION: Final = 'ask_reactions'
#: ... and (7.50.03) the run monitor's Stop of a whole run: an administrator's, through the Agents API.
STOP_ACTION: Final = 'stop_run'


def stop_from_api(event: Mapping[str, Any]) -> dict[str, Any]:
    """voc-engineering-start's ``stop_run`` (``{"run_id", "actor", "mode": "stop" | "stop_now"}``, the Agents API's
    ``POST /agents/engineering/<run_id>/stop``, an administrator acting for themselves, 7.50.03): the run ended at once
    when nothing is to be saved (``stop_now``, or no agent with a session), its tasks closed and its launch holds run
    out, the rest of its end (its sessions, its release) handed on to voc-engineering-runtime's ``finish_stop``; else
    the request recorded and the agents' save handed on to its ``stop_run`` (``_stop_from_start``). Answers
    ``stop.Stopped.view()``; a run that is unknown is refused, one that has ended is answered as it is."""
    actor = str(event.get('actor') or '')[:200]
    if not actor:
        raise RuntimeRefused('a Stop names the person who asked')
    return _stop_from_start(str(event.get('run_id', '')), actor, run_stop.check_mode(event.get('mode'))).view()


def signal_from_api(event: Mapping[str, Any]) -> dict[str, Any]:
    """voc-engineering-start's ``signal_run`` (``{"run_id", "signal", "actor", "note"?, "agent_id"?, "task_id"?,
    "attempt"?, "restart_from"?}``, the Agents API's ``POST /agents/engineering/<run_id>/signals``, an administrator acting for
    themselves, 7.51.02): the run workspace's Pause, Resume and Save of the whole run and an agent's Save, Pause,
    Resume, Shut down, Stop now and Restart, checked before anything is read, then against the run, the agent and the
    state (no Stop under way), recorded on the run's ``RUNLOG#`` rows (D4) and handed on to voc-engineering-runtime's
    ``signal`` (``runtime/run_signals.py``). Answers what was sent (``status: sent``); a hand-on that fails is raised
    (its record stays: the person sends it again)."""
    request = run_signals.parse(event)
    runs = _runs()
    run_signals.check(request, runs, _board_store(), _session_store())
    now = int(clock())
    runs.record_signal(request.run_id, request.signal, actor=request.actor, now=now, agent_id=request.agent_id,
                       task_id=request.task_id, attempt=request.attempt, restart_from=request.restart_from,
                       note=request.note)
    try:
        _hand_on_runtime(request.handed_on())
    except Exception:
        logger.exception('engineering signal: recorded but not handed on; the person sends it again',
                         extra={'run_id': request.run_id, 'signal': request.signal})
        raise
    logger.info('engineering signal handed on', extra={'run_id': request.run_id, 'signal': request.signal,
                                                        'agent_id': request.agent_id or None})
    return request.view(_iso_now(now))


#: ... and (7.52.00) an administrator's request for the pull request of the docs they approved.
PUBLISH_DOCS_ACTION: Final = DOCS_PUBLISH_ACTION


def publish_docs(event: Mapping[str, Any]) -> dict[str, Any]:
    """voc-engineering-start's ``publish_docs`` (7.52.00, ``runtime/docs_publish.py``): the broker's
    ``push_approved_docs`` asked as this function's own role, its answer (opened, repeated or refused) answered. An
    event off its shape is ``RuntimeRefused`` before anything is asked; a broker out of reach ``DocsUnavailable``."""
    from engineering.runtime.docs_publish import BrokerDocs, DocsRefused, publish
    try:
        broker = BrokerDocs(url=os.environ['ENGINEERING_BROKER_URL'], region=os.environ.get('AWS_REGION', 'us-east-1'),
                            credentials=_own_credentials())
        answer = publish(event, broker)
    except DocsRefused as refused:
        raise RuntimeRefused(str(refused)) from refused
    logger.info('engineering docs publish', extra={'status': answer['status'], 'kind': str(event.get('kind'))[:20],
                                                   'connection_id': str(event.get('connection'))[:128]})
    return answer


def ask_reactions(event: Mapping[str, Any]) -> dict[str, Any]:
    """voc-engineering-start's ``ask_reactions`` (``{"run_id", "actor"}``, the Agents API's ``POST
    /agents/engineering/<run_id>/reactions``, an administrator acting for themselves): for an ended run, at most once
    per run in a rolling hour (the run's ``REACTIONS_ASK`` row: ``ReactionsStore.claim_ask``), the read handed on to
    voc-engineering-runtime's ``reactions`` (asynchronously: the broker's read does not fit behind API Gateway's 29 s),
    answered ``{"status": "asked"}``; ``{"status": "too_soon", "retry_after": <seconds>}`` while the hour's ask holds.
    A hand-on that fails releases the claim (``release_ask``) before it is raised, so asking again works. A run that is
    unknown or has not ended is refused (``RuntimeRefused``), nothing written."""
    from engineering.learning.reactions import ReactionsStore
    from shared.aws import get_dynamodb_client, invoke_lambda_async
    run_id, actor = str(event.get('run_id', '')), str(event.get('actor') or '')[:200]
    check_run_id(run_id)
    if not actor:
        raise RuntimeRefused('a hand trigger names the person who asked')
    run = _runs().get(run_id)
    if run is None:
        raise RuntimeRefused('no such run')
    if run.status not in ENDED:
        raise RuntimeRefused("the run has not ended: its pull request's reactions are read once it has")
    store = ReactionsStore(get_dynamodb_client(), os.environ['ENGINEERING_TABLE'])
    asked = store.claim_ask(WORKSPACE, run_id, actor)
    if asked.retry_after:
        return {'run_id': run_id, 'status': 'too_soon', 'retry_after': asked.retry_after}
    try:
        invoke_lambda_async(os.environ['ENGINEERING_RUNTIME_FUNCTION'], {'action': 'reactions', 'run_id': run_id,
                                                                         'actor': actor})
    except Exception:
        with contextlib.suppress(Exception):   # (the claim stays until its hour ends when even this fails: logged)
            store.release_ask(WORKSPACE, run_id, asked.claim)
        logger.exception('engineering reactions: the read was not handed on; the ask is released',
                         extra={'run_id': run_id})
        raise
    logger.info('engineering reactions asked for', extra={'run_id': run_id})
    return {'run_id': run_id, 'status': 'asked'}


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


def _beside_a_start(event: Mapping[str, Any]) -> dict[str, Any] | None:
    """voc-engineering-start's actions other than a run's start, each answered by its own handler (looked up when
    called); None for ``start_run`` and for an action it does not take (start_handler refuses that one)."""
    action = event.get('action')
    if action == ASK_REACTIONS_ACTION:
        return ask_reactions(event)
    if action == STOP_ACTION:
        return stop_from_api(event)
    if action == run_signals.SIGNAL_ACTION:
        return signal_from_api(event)
    if action == RESTART_ACTION:
        return restart_run(event)
    if action == PUBLISH_DOCS_ACTION:
        return publish_docs(event)
    return None


@metrics.log_metrics
@measure_invocation_cost
def start_handler(event: Mapping[str, Any], context: object) -> dict[str, Any]:
    """voc-engineering-start: the Agents API's start of a run (``{"action": "start_run", ...}``), since 7.10.00 its
    hand trigger of an ended run's reactions read (``ask_reactions``), since 7.50.03 a person's Stop of a whole run
    (``stop_run``: ``stop_from_api``), since 7.51.00 a person's Resume or Restart of an ended run as a child run
    (``restart_run``), since 7.51.02 a person's signal to a live run or one of its agents (``signal_run``:
    ``signal_from_api``, checked here, then handed on) and since 7.52.00 an administrator's request for the approved
    docs' pull request (``publish_docs``). Every other action, and an event naming none, is refused before anything is
    read: the API's role may invoke this function only (engineering-start.ts, pinned by its test), so it can start a
    run, restart an ended one, ask for an ended run's reactions, stop a run, hand a person's checked signal on and
    publish approved docs, and never tick, launch, end a run or send the runtime anything else.

    It answers as soon as the run is written (its refusals, all before the write, are raised as they are): it writes
    the run and switches the rule on (``start_run`` with ``launch=False``), then hands the coordinator's launch on to
    voc-engineering-runtime (``launch_coordinator``, asynchronously: a session's start does not fit behind API
    Gateway's 29 s). Any failure once the run exists is ``StartFailed``, naming it; the run is sent to a person first
    (the hand-on failed: still active), so it is never left active with nobody to launch its coordinator."""
    beside = _beside_a_start(event)
    if beside is not None:
        return beside
    if event.get('action') != START_ACTION:
        logger.warning('engineering start: an action other than start_run refused',
                       extra={'action': str(event.get('action'))[:40]})
        raise RuntimeRefused(f'this function only starts a run (action {START_ACTION!r}), restarts an ended one as a '
                             f"child run ({RESTART_ACTION!r}), asks for an ended run's reactions "
                             f'({ASK_REACTIONS_ACTION!r}), stops a run ({STOP_ACTION!r}), hands a person\'s signal on '
                             f'({run_signals.SIGNAL_ACTION!r}) or publishes approved docs ({PUBLISH_DOCS_ACTION!r})')
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
    'retrospective': retrospective, 'launch_coordinator': launch_coordinator, 'reactions': reactions_action,
    'stop_run': stop_run_action, 'finish_stop': finish_stop_action, 'seed_restart': seed_restart_action,
    'learn_cross_run': learn_cross_run,
}


@metrics.log_metrics
@measure_invocation_cost
def lambda_handler(event: Mapping[str, Any], context: Any) -> dict[str, Any]:
    """``context``: Lambda's (None in the tests): its function name is where the learning steps are handed on."""
    global _function_name, _function_arn
    _function_name = str(context.function_name) if context is not None else ''
    _function_arn = str(getattr(context, 'invoked_function_arn', '') or '') if context is not None else ''
    action = ACTIONS.get(str(event.get('action')))
    if action is None:
        raise RuntimeRefused(f'unknown action {event.get("action")!r}')
    answer = action(event)
    logger.info('engineering runtime', extra={'action': event.get('action')})
    return answer
