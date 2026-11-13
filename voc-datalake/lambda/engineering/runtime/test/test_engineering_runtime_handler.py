"""voc-engineering-runtime's entry points, wired from the environment on moto and the local fake."""
import json
import sys
from dataclasses import replace
from typing import Any

import boto3
import pytest

from engineering.board.store import COORDINATE_TASK, BoardError, BoardStore
from engineering.bus.test.messages import message
from engineering.connectors.identity import WORKSPACE
from engineering.runtime import handler
from engineering.runtime import supervisor as supervisor_module
from engineering.runtime.aws import AwsMicroVmRuntime
from engineering.runtime.board_bus import SupervisorBus
from engineering.runtime.harness.skills import COORDINATOR, harness_argv
from engineering.runtime.interface import AgentSpec, MicroVm, RuntimeRefused
from engineering.runtime.runs import Run, RunCaps, RunNotActive, RunStore, StartReadFailed, meta_key, run_pk
from engineering.runtime.sessions import LAUNCH_HOLD_SECONDS, StaleSession
from engineering.runtime.supervisor import SessionBusy
from engineering.runtime.test.conftest import BUCKET, COMMIT, ROLE_ARNS, RUN, TABLE, WORKSPACE_BUCKET
from engineering.runtime.test.local_runtime import LocalMicroVmRuntime
from shared import aws as shared_aws

SCHEDULE = 'voc-engineering-supervisor'
OTHER_RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0CD'
ENDED_RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0EF'
LAUNCH = {'action': 'launch', 'run_id': '01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'agent_id': 'fixer-1', 'role': 'fixer', 'task_id': 'task-1',
          'language': 'python', 'connection': 'conn-1', 'commit': COMMIT, 'paths': ['src'],
          'harness': [sys.executable, '-c', 'pass']}


#: The engineering bus the supervisor speaks on (moto's).
BUS = 'voc-engineering'
#: The board API's function URL the agents are handed.
BOARD_URL = 'https://abc123def.lambda-url.us-east-1.on.aws/'
#: The deployment's MicroVM images (the local fake runs every language; the handler's checks read these).
IMAGE_ARNS = {'python': 'arn:aws:lambda:us-east-1:123456789012:microvm-image/python',
              'java': 'arn:aws:lambda:us-east-1:123456789012:microvm-image/java'}

@pytest.fixture
def wired(aws: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch) -> Any:
    assert aws is not None  # moto's S3 and voc-engineering are up for the handler's own clients
    monkeypatch.setattr(handler, '_runtime', LocalMicroVmRuntime)
    # (the hard cap's row lives in voc-agents; here the same moto table holds it)
    for name, value in {'RAW_DATA_BUCKET': BUCKET, 'ENGINEERING_WORKSPACE_BUCKET': WORKSPACE_BUCKET, 'ENGINEERING_TABLE': TABLE,
                        'ENGINEERING_SETTINGS_TABLE': TABLE,
                        'SUPERVISOR_RULE_NAME': SCHEDULE, 'ENGINEERING_AGENT_ROLE_ARNS': json.dumps(ROLE_ARNS),
                        'ENGINEERING_BUS_NAME': BUS, 'ENGINEERING_BOARD_URL': BOARD_URL,
                        'ENGINEERING_IMAGE_ARNS': json.dumps(IMAGE_ARNS),
                        'ENGINEERING_BENCHMARK_CASES': json.dumps(['slug-cut-bug']),
                        'AWS_DEFAULT_REGION': 'us-east-1', 'AWS_REGION': 'us-east-1'}.items():
        monkeypatch.setenv(name, value)
    for client in ('_dynamodb_resource', '_dynamodb_client', '_s3_client', '_lambda_client', '_eventbridge_client'):
        monkeypatch.setattr(shared_aws, client, None)
    monkeypatch.setattr(handler, '_supervisor_cache', None)
    monkeypatch.setattr(handler, '_learning_cache', None)
    handler._sts_client.cache_clear()
    events = boto3.client('events', region_name='us-east-1')
    events.put_rule(Name=SCHEDULE, ScheduleExpression='rate(1 minute)', State='DISABLED')
    events.create_event_bus(Name=BUS)
    handler.lambda_handler({'action': 'start_run', 'run_id': RUN, 'max_tasks': 50, 'goal': 'fix the parser',
                            'repo': 'example/app', 'flow': 'bug-hunt'}, None)
    return events


def _state(events: Any) -> str:
    return events.describe_rule(Name=SCHEDULE)['State']


def _recording(monkeypatch: pytest.MonkeyPatch) -> tuple[LocalMicroVmRuntime, list[MicroVm]]:
    """The wired runtime, and every MicroVM it starts from now on."""
    runtime = handler._supervisor().runtime
    assert isinstance(runtime, LocalMicroVmRuntime)
    started: list[MicroVm] = []
    original = runtime.run

    def run(spec: AgentSpec) -> MicroVm:
        started.append(original(spec))
        return started[-1]

    monkeypatch.setattr(runtime, 'run', run)
    return runtime, started


def _runs() -> RunStore:
    return RunStore(boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE))


def test_launch_starts_the_agents_microvm_and_records_its_session(wired: Any):
    answer = handler.lambda_handler(LAUNCH, None)
    session = handler._supervisor().sessions.get('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1')
    assert answer == {'run_id': '01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'agent_id': 'fixer-1', 'status': 'booting'}
    assert session is not None
    # egress is a tuple of host names: counting the exact name, not a substring of a URL.
    assert (session.egress.count('pypi.org'), session.paths, session.connection) == (1, ('src',), 'conn-1')
    assert _state(wired) == 'ENABLED'


def test_the_launchs_attempt_reaches_the_session_and_the_microvms_environment(wired: Any):
    assert wired is not None
    handler.lambda_handler({**LAUNCH, 'attempt': 2}, None)
    supervisor = handler._supervisor()
    session = supervisor.sessions.get(RUN, 'fixer-1')
    assert session is not None
    env = session.spec(None, supervisor.workspace_bucket, supervisor.board_url).environment()
    assert (session.task_attempt, env['VOC_ATTEMPT'], env['VOC_COMMIT'], env['VOC_WORKSPACE_BUCKET']) == (
        2, '2', COMMIT, WORKSPACE_BUCKET)
    # Each bucket for its own: the cache's mount from the raw one, the agents' keys in the workspace one.
    assert (supervisor.bucket, supervisor.workspace_bucket) == (BUCKET, WORKSPACE_BUCKET)
    assert f'{WORKSPACE_BUCKET}.s3.us-east-1.amazonaws.com' in session.egress
    # The board: its URL in the harness's environment, its own host (by name) on the egress the session keeps.
    assert (env['VOC_BOARD_URL'], 'abc123def.lambda-url.us-east-1.on.aws' in session.egress) == (BOARD_URL, True)


def test_no_agent_is_launched_for_a_run_that_was_never_started_or_has_ended(wired: Any):
    assert wired is not None
    with pytest.raises(RunNotActive, match='active run'):
        handler.lambda_handler({**LAUNCH, 'run_id': OTHER_RUN}, None)
    handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'done'}, None)
    with pytest.raises(RunNotActive, match='active run'):
        handler.lambda_handler(LAUNCH, None)


def test_a_launch_racing_the_runs_end_is_refused_by_the_session_write_and_ends_its_microvm(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'stopped'}, None)
    runtime, started = _recording(monkeypatch)
    # The launch read the run while it was still active; it ended before the session's write.
    monkeypatch.setattr(RunStore, 'get', lambda _self, run_id: Run(run_id, 'active', 0, RunCaps(max_tasks=1)))
    with pytest.raises(RunNotActive, match='no agent is launched'):
        handler.lambda_handler(LAUNCH, None)
    with pytest.raises(RuntimeRefused, match='terminated'):
        runtime.mint_token(started[0])
    assert handler._supervisor().sessions.get(RUN, 'fixer-1') is None


def test_a_repeated_launch_answers_the_session_the_first_wrote_and_starts_no_second_microvm(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    """The board's retry of a launch (its answer lost, or timed out) for the same task and attempt."""
    assert wired is not None
    first = handler.lambda_handler(LAUNCH, None)
    _, started = _recording(monkeypatch)
    assert handler.lambda_handler(LAUNCH, None) == first
    assert started == []
    session = handler._supervisor().sessions.get(RUN, 'fixer-1')
    assert session is not None
    assert session.seq == 1   # (the first launch's row, untouched)
    # Answered before any other check: once the run has stopped, a retry of a launch that got through is still told
    # its session, never refused (the board would read a refusal as nothing started).
    handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'stopped'}, None)
    assert handler.lambda_handler(LAUNCH, None)['agent_id'] == 'fixer-1'
    assert started == []


def test_an_agent_with_a_session_for_another_task_or_attempt_is_refused_before_any_microvm(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    handler.lambda_handler(LAUNCH, None)
    _, started = _recording(monkeypatch)
    for change in ({'task_id': 'task-2'}, {'attempt': 2}):
        with pytest.raises(StaleSession, match='another task or attempt'):
            handler.lambda_handler({**LAUNCH, **change}, None)
    assert started == []


def test_a_launch_while_another_still_starts_the_agents_microvm_is_busy_and_starts_none(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    """The first launch holds the agent's row before its MicroVM starts (and writes the session after): a second
    one meanwhile (a retry after the board's call timed out) is refused, never a second MicroVM."""
    assert wired is not None
    sessions = handler._supervisor().sessions
    sessions.hold_launch(RUN, 'fixer-1', int(handler.clock()))   # (the first launch, still booting)
    _, started = _recording(monkeypatch)
    with pytest.raises(SessionBusy, match='under way'):
        handler.lambda_handler(LAUNCH, None)
    # Busy before any other check: a retry the skill or egress would refuse is busy too (never "nothing started").
    with pytest.raises(SessionBusy, match='under way'):
        handler.lambda_handler({**LAUNCH, 'harness': None, 'language': 'cobol'}, None)
    assert (started, sessions.get(RUN, 'fixer-1')) == ([], None)
    # A hold past its time (a launch killed at the function's limit) lets the next launch through.
    now = handler.clock()
    monkeypatch.setattr(handler, 'clock', lambda: now + LAUNCH_HOLD_SECONDS + 1)
    assert handler.lambda_handler(LAUNCH, None)['status'] == 'booting'
    assert len(started) == 1
    session = sessions.get(RUN, 'fixer-1')
    assert session is not None
    item = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE).get_item(
        Key={'pk': run_pk(RUN), 'sk': 'AGENT#fixer-1'}).get('Item', {})
    assert item.get('seq') == 1
    assert 'launching_until' not in item   # (the session's write removed the hold)


def test_a_microvm_that_fails_to_start_lets_go_of_the_launch_so_a_retry_starts_at_once(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    runtime = handler._supervisor().runtime
    original, tries = runtime.run, []

    def fails_once(spec: AgentSpec) -> MicroVm:
        tries.append(spec)
        if len(tries) == 1:
            raise RuntimeRefused('no capacity')
        return original(spec)

    monkeypatch.setattr(runtime, 'run', fails_once)
    with pytest.raises(RuntimeRefused, match='no capacity'):
        handler.lambda_handler(LAUNCH, None)
    assert handler.lambda_handler(LAUNCH, None)['status'] == 'booting'   # (no hold left behind: not busy)
    assert len(tries) == 2


@pytest.mark.parametrize('change', [{'harness': []}, {'harness': 'python3 -c pass'}, {'harness': ['python3', 1]},
                                    {'commit': 'main'}, {'paths': ['../etc']}, {'paths': 'src'}, {'paths': None},
                                    {'role': 'admin'}, {'language': 'cobol'}, {'attempt': 0}, {'attempt': 10_000},
                                    {'attempt': True}],
                         ids=['no-harness', 'shell-string', 'not-strings', 'branch', 'path', 'paths-string',
                              'paths-null', 'role', 'language', 'attempt-0', 'attempt-over', 'attempt-bool'])
def test_launch_refuses_a_bad_request_before_anything_starts(wired: Any, change: dict[str, Any]):
    assert wired is not None
    with pytest.raises(RuntimeRefused):
        handler.lambda_handler({**LAUNCH, **change}, None)
    assert list(handler._supervisor().sessions.active()) == []


def test_a_start_copies_the_flows_monthly_budget_onto_the_run(wired: Any):
    assert _state(wired) == 'ENABLED'
    handler.lambda_handler({'action': 'start_run', 'run_id': OTHER_RUN, 'max_tasks': 5, 'flow': 'bug-hunt',
                            'budget_usd': 25.5}, None)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert run.budget_usd == 25.5


def _flow_spent(usd: str) -> None:
    """wf_cap's runs spent ``usd`` this month (a priced write, as the session store makes it)."""
    from datetime import UTC, datetime
    from decimal import Decimal

    from engineering.spend import MICROVM, Usage, Where, ledger_updates
    table = _runs().table
    table.meta.client.transact_write_items(TransactItems=ledger_updates(
        table.name, datetime.fromtimestamp(handler.clock(), UTC), Where(RUN, 'fixer-1', 'wf_cap'),
        {MICROVM: Usage(usd=Decimal(usd))}))


def _hard_cap(on: bool) -> None:
    """An administrator's change (the Agents API's PUT writes it so)."""
    from datetime import UTC, datetime

    from engineering.settings import save_hard_cap
    save_hard_cap(_runs().table, on=on, by='admin-1', at=datetime.now(UTC))


def _start_budgeted() -> None:
    """A first start of OTHER_RUN, a run of wf_cap with its $10 monthly budget."""
    handler.lambda_handler({'action': 'start_run', 'run_id': OTHER_RUN, 'max_tasks': 5, 'flow': 'wf_cap',
                            'budget_usd': 10.0}, None)


@pytest.mark.usefixtures('wired')
def test_with_the_hard_cap_on_a_start_is_capped_at_what_is_left_of_its_flows_month() -> None:
    _flow_spent('7')
    _hard_cap(True)
    _start_budgeted()
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert run.caps.max_cost_usd == 3.0


@pytest.mark.usefixtures('wired')
@pytest.mark.parametrize(('given', 'kept'), [(50.0, 3.0), (2.0, 2.0)])
def test_the_start_routes_default_cap_is_the_smaller_of_it_and_what_is_left(given: float, kept: float) -> None:
    """The Agents API sends the deployment's run cap (50 USD by default) with every start: the hard cap keeps the
    smaller of it and what is left of the flow's month."""
    _flow_spent('7')
    _hard_cap(True)
    handler.lambda_handler({'action': 'start_run', 'run_id': OTHER_RUN, 'max_tasks': 5, 'flow': 'wf_cap',
                            'budget_usd': 10.0, 'max_cost_usd': given, 'max_tokens': 10_000_000}, None)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert (run.caps.max_cost_usd, run.caps.max_tokens) == (kept, 10_000_000)


@pytest.mark.usefixtures('wired')
def test_with_the_hard_cap_on_a_start_with_nothing_left_is_refused_before_anything_is_written() -> None:
    _flow_spent('10')
    _hard_cap(True)
    with pytest.raises(RuntimeRefused, match='turn the hard cap off'):
        _start_budgeted()
    assert _runs().get(OTHER_RUN) is None


@pytest.mark.usefixtures('wired')
def test_with_the_hard_cap_off_a_start_is_as_it_was() -> None:
    _flow_spent('10')
    _hard_cap(False)
    _start_budgeted()
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert run.caps.max_cost_usd is None


@pytest.mark.usefixtures('wired')
def test_a_retry_of_a_live_run_is_not_capped_again() -> None:
    _flow_spent('7')
    _hard_cap(True)
    _start_budgeted()
    _flow_spent('5')   # (the flow's month is past its budget now)
    _start_budgeted()   # (the same start again: answered, never refused)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert (run.status, run.caps.max_cost_usd) == ('active', 3.0)


@pytest.mark.usefixtures('wired')
def test_a_start_with_no_budget_reads_no_hard_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    def unread(_table: Any) -> None:
        raise AssertionError('the hard cap was read')

    monkeypatch.setattr(handler, 'read_hard_cap', unread)
    handler.lambda_handler({'action': 'start_run', 'run_id': OTHER_RUN, 'max_tasks': 5, 'flow': 'wf_cap'}, None)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert run.caps.max_cost_usd is None


@pytest.mark.usefixtures('wired')
def test_a_hard_cap_that_cannot_be_read_refuses_the_start_saying_so(monkeypatch: pytest.MonkeyPatch) -> None:
    from botocore.exceptions import ClientError

    def throttled(_table: Any) -> None:
        raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'GetItem')

    monkeypatch.setattr(handler, 'read_hard_cap', throttled)
    # (its own type, a passing fault the Agents API answers 503, never a refusal's 409)
    with pytest.raises(StartReadFailed, match='could not be read: start the run again'):
        _start_budgeted()
    assert _runs().get(OTHER_RUN) is None


def test_a_runs_start_and_end_switch_the_supervisor_on_and_off_with_the_last_active_run(wired: Any):
    assert _state(wired) == 'ENABLED'
    handler.lambda_handler({'action': 'start_run', 'run_id': OTHER_RUN, 'max_tasks': 5}, None)
    assert handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'done'}, None) == {
        'run_id': RUN, 'status': 'done', 'agents': {}}
    assert _state(wired) == 'ENABLED'
    handler.lambda_handler({'action': 'end_run', 'run_id': OTHER_RUN, 'status': 'stopped'}, None)
    assert _state(wired) == 'DISABLED'
    runs = _runs()
    ended = runs.get(RUN)
    assert ended is not None
    assert (ended.status, ended.caps.max_tasks) == ('done', 50)
    assert runs.listed() == []


def test_a_runs_end_ends_every_microvm_of_it_before_it_stops_being_watched(wired: Any):
    handler.lambda_handler(LAUNCH, None)
    vm = handler._supervisor().sessions.get(RUN, 'fixer-1')
    assert vm is not None
    answer = handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'stopped'}, None)
    assert answer['agents'] == {'fixer-1': 'stopped'}
    runtime = handler._supervisor().runtime
    assert isinstance(runtime, LocalMicroVmRuntime)
    with pytest.raises(RuntimeRefused, match='terminated'):
        runtime.mint_token(vm.vm)
    assert (_runs().listed(), _state(wired)) == ([], 'DISABLED')


def _busy_agent() -> int:
    """The run's launched fixer-1, held by another move for 10 minutes from now (returned)."""
    handler.lambda_handler(LAUNCH, None)
    sessions = handler._supervisor().sessions
    session = sessions.get(RUN, 'fixer-1')
    assert session is not None
    now = int(handler.clock())
    sessions.claim(session, now, 600)
    return now


def test_an_agent_busy_at_the_runs_end_is_ended_by_the_next_tick_then_the_run_is_released(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    now = _busy_agent()
    sessions = handler._supervisor().sessions
    answer = handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'done'}, None)
    # Another move holds it: the run stays watched, and the rule on.
    assert (answer['agents'], _runs().listed(), _state(wired)) == ({'fixer-1': 'busy'}, [RUN], 'ENABLED')
    monkeypatch.setattr(handler, 'clock', lambda: now + 1200)
    handler.lambda_handler({'action': 'tick'}, None)
    # (The tick's run.health report is the bus's, still a pending port: the agent is ended before it.)
    ended = sessions.get(RUN, 'fixer-1')
    assert ended is not None
    assert (ended.status, _runs().listed(), _state(wired)) == ('stopped', [], 'DISABLED')


def test_a_run_started_while_the_last_one_settles_turns_the_rule_back_on(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    switch = handler._switch

    def racing(enabled: bool) -> None:
        switch(enabled)
        if not enabled:
            # Another invocation's start_run lands right after the switch off.
            _runs().start(OTHER_RUN, caps=RunCaps(max_tasks=1), now=0)

    monkeypatch.setattr(handler, '_switch', racing)
    handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'done'}, None)
    assert (_runs().listed(), _state(wired)) == ([OTHER_RUN], 'ENABLED')


def test_an_ended_run_whose_paused_agent_is_being_resumed_stays_watched(wired: Any):
    handler.lambda_handler(LAUNCH, None)
    sessions = handler._supervisor().sessions
    session = sessions.get(RUN, 'fixer-1')
    assert session is not None
    paused = sessions.save(replace(session, status='paused'))
    # A Resume holds the row while it starts the agent's new MicroVM.
    sessions.claim(paused, int(handler.clock()), 600)
    handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'stopped'}, None)
    assert (_runs().listed(), _state(wired)) == ([RUN], 'ENABLED')


def test_a_retried_start_or_end_finishes_what_the_first_one_left(wired: Any):
    wired.disable_rule(Name=SCHEDULE)
    # The first start wrote the run but died before switching the rule on.
    assert handler.lambda_handler({'action': 'start_run', 'run_id': RUN, 'max_tasks': 5}, None) == {
        'run_id': RUN, 'status': 'active'}
    assert _state(wired) == 'ENABLED'
    _runs().end(RUN, 'failed', now=1)
    # The first end ended the run but died before its agents and the rule.
    assert handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'done'}, None) == {
        'run_id': RUN, 'status': 'failed', 'agents': {}}
    assert (_runs().listed(), _state(wired)) == ([], 'DISABLED')


#: The run's first agent, the coordinator its coordinate task records.
COORDINATOR_AGENT = 'coordinator-1'
COORDINATED = {'action': 'start_run', 'run_id': OTHER_RUN, 'max_tasks': 5, 'goal': 'fix the parser',
               'connection': 'conn-1', 'commit': COMMIT, 'language': 'python'}


def test_a_runs_start_launches_its_coordinator_on_its_coordinate_task(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _runtime, started = _recording(monkeypatch)
    assert handler.lambda_handler(COORDINATED, None) == {'run_id': OTHER_RUN, 'status': 'active'}
    session = handler._supervisor().sessions.get(OTHER_RUN, COORDINATOR_AGENT)
    assert session is not None
    assert (session.role, session.task_id, session.task_attempt, session.paths, session.connection, session.commit,
            session.language, session.harness) == ('coordinator', COORDINATE_TASK, 1, (), 'conn-1', COMMIT, 'python',
                                                    harness_argv(COORDINATOR))
    assert [vm.agent_id for vm in started] == [COORDINATOR_AGENT]
    # The coordinator is the run's first agent: the board numbers the agents it launches from 2.
    table = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)
    meta = table.get_item(Key=meta_key(OTHER_RUN)).get('Item')
    assert meta is not None
    assert (meta['agent_count'], meta['language']) == (1, 'python')


def test_a_retried_start_keeps_the_coordinator_it_launched(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    handler.lambda_handler(COORDINATED, None)
    _runtime, started = _recording(monkeypatch)
    handler.lambda_handler(COORDINATED, None)
    assert started == []   # no second MicroVM, not even one ended again


def test_two_starts_racing_launch_one_coordinator(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    handler.lambda_handler(COORDINATED, None)
    first = handler._supervisor().sessions.get(OTHER_RUN, COORDINATOR_AGENT)
    runtime, started = _recording(monkeypatch)
    assert runtime is not None
    with monkeypatch.context() as patch:
        # The second start read no session before the first one's write: the launch's hold refuses it as busy
        # before any MicroVM starts (ask again; a retry then finds the first one's session).
        patch.setattr(handler._supervisor().sessions, 'get', lambda *_args: None)
        with pytest.raises(SessionBusy):
            handler.lambda_handler(COORDINATED, None)
    assert started == []
    assert handler._supervisor().sessions.get(OTHER_RUN, COORDINATOR_AGENT) == first
    assert handler.lambda_handler(COORDINATED, None) == {'run_id': OTHER_RUN, 'status': 'active'}
    assert started == []


def test_a_start_racing_a_coordinator_launch_still_under_way_is_busy_and_keeps_the_record(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _runs().start(OTHER_RUN, caps=RunCaps(max_tasks=5), now=int(handler.clock()), connection='conn-1', commit=COMMIT,
                  language='python')
    # Another start's launch holds the coordinator's row while its MicroVM boots.
    handler._supervisor().sessions.hold_launch(OTHER_RUN, COORDINATOR_AGENT, int(handler.clock()))
    _runtime, started = _recording(monkeypatch)
    with pytest.raises(SessionBusy, match='under way'):
        handler.lambda_handler(COORDINATED, None)
    assert (started, _coordinate_task().launched_agent) == ([], COORDINATOR_AGENT)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert run.status == 'active'   # (never sent to a person: that launch under way is the run's coordinator)


def test_a_resume_that_finds_the_new_coordinators_launch_under_way_still_answers(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _coordinator_gone()
    # Another Resume's launch of the new coordinator holds it (its MicroVM still starting, or killed meanwhile).
    handler._supervisor().sessions.hold_launch(OTHER_RUN, 'coordinator-2', int(handler.clock()))
    _runtime, started = _recording(monkeypatch)
    assert set(handler.lambda_handler(RESUME, None)) == {'agents', 'applied'}
    assert (started, handler._supervisor().sessions.get(OTHER_RUN, 'coordinator-2')) == ([], None)


def test_a_resume_whose_new_coordinator_fails_to_start_still_answers_and_a_resume_again_starts_it(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _coordinator_gone()
    with monkeypatch.context() as patch:
        patch.setattr(handler._supervisor().runtime, 'run', _service_down)
        assert set(handler.lambda_handler(RESUME, None)) == {'agents', 'applied'}   # the Resume was applied
    run = _runs().get(OTHER_RUN)
    assert run is not None
    # Back at a person's decision point, as a start whose coordinator fails: never active with nobody planning it.
    assert (run.status, handler._supervisor().sessions.get(OTHER_RUN, 'coordinator-2')) == ('needs_human', None)
    rows = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE).query(
        KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
        ExpressionAttributeValues={':pk': meta_key(OTHER_RUN)['pk'], ':log': 'RUNLOG#'})['Items']
    latest = max(rows, key=lambda row: str(row['sk']))
    assert (latest['status'], latest['actor']) == ('needs_human', RESUME['actor'])   # (the person's, D4)
    handler.lambda_handler(RESUME, None)
    assert handler._supervisor().sessions.get(OTHER_RUN, 'coordinator-2') is not None


def test_a_launch_whose_microvm_failed_leaves_a_run_out_hold_no_agent_in_the_facts_and_may_launch_again(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    from engineering.reports.facts import FactsReader
    from engineering.rows import LAUNCH_HOLD
    assert wired is not None
    _start_whose_launch_fails(monkeypatch)
    item = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE).get_item(
        Key={'pk': run_pk(OTHER_RUN), 'sk': f'AGENT#{COORDINATOR_AGENT}'}).get('Item')
    assert item is not None
    assert (item[LAUNCH_HOLD], 'seq' in item) == (0, False)   # (a run-out hold, never a key-only row)
    sessions = handler._supervisor().sessions
    assert not sessions.launch_under_way(OTHER_RUN, COORDINATOR_AGENT, int(handler.clock()))
    facts = FactsReader(boto3.client('dynamodb', region_name='us-east-1'), TABLE).read(WORKSPACE, OTHER_RUN)
    assert facts is not None
    assert facts.agents == ()
    handler.lambda_handler(RESUME, None)   # the person's Resume takes the run-out hold and launches at once
    assert sessions.get(OTHER_RUN, COORDINATOR_AGENT) is not None


def test_a_launch_whose_session_write_and_terminate_both_fail_still_lets_go_of_its_hold(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    supervisor = handler._supervisor()

    def no_session(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError('the session write failed')

    def no_terminate(_vm: MicroVm) -> None:
        raise RuntimeError('the terminate failed')

    with monkeypatch.context() as patch:
        patch.setattr(supervisor.sessions, 'create', no_session)
        patch.setattr(supervisor.runtime, 'terminate', no_terminate)
        with pytest.raises(RuntimeError, match='terminate failed'):
            handler.lambda_handler(LAUNCH, None)
    assert not supervisor.sessions.launch_under_way(RUN, 'fixer-1', int(handler.clock()))
    assert handler.lambda_handler(LAUNCH, None)['status'] == 'booting'


def _service_down(_spec: AgentSpec) -> MicroVm:
    """The MicroVM service failing a start: a failure, not a refusal, so a launch keeps its recorded agent."""
    raise RuntimeError('the MicroVM service is unavailable')


def _start_whose_launch_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """A start that wrote the run, then failed to launch its coordinator (the MicroVM service was down)."""
    with monkeypatch.context() as patch:
        patch.setattr(handler._supervisor().runtime, 'run', _service_down)
        with pytest.raises(RuntimeError, match='unavailable'):
            handler.lambda_handler(COORDINATED, None)


def _coordinate_task() -> Any:
    return BoardStore(boto3.client('dynamodb', region_name='us-east-1'), TABLE, new_id=lambda: '').task(
        WORKSPACE, OTHER_RUN, COORDINATE_TASK)


def test_a_coordinator_launch_the_runtime_refuses_clears_its_record_so_a_retry_numbers_a_new_one(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    runtime = handler._supervisor().runtime

    def refused(_spec: AgentSpec) -> MicroVm:
        raise RuntimeRefused('no MicroVM image is configured for this language')

    with monkeypatch.context() as patch:
        patch.setattr(runtime, 'run', refused)
        with pytest.raises(RuntimeRefused, match='no MicroVM image'):
            handler.lambda_handler(COORDINATED, None)
    task = _coordinate_task()
    assert (task.state, task.attempt, task.launched_agent) == ('open', 1, '')
    moves = BoardStore(boto3.client('dynamodb', region_name='us-east-1'), TABLE, new_id=lambda: '').history(
        WORKSPACE, OTHER_RUN)[COORDINATE_TASK]
    refusals = [(move.actor, move.reason) for move in moves if move.op == 'launch_refused']
    # Nobody named: the run's history label (runs.UNATTRIBUTED), the same as its RUNLOG rows'.
    assert refusals == [('unattributed', 'coordinator-1: no MicroVM image is configured for this language')]
    # The run went to a person; their Resume numbers a new coordinator, as the board's launch does after a
    # refusal it cleared.
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert run.status == 'needs_human'
    handler.lambda_handler(RESUME, None)
    assert (_coordinate_task().launched_agent, handler._supervisor().sessions.get(OTHER_RUN, 'coordinator-2')
            is not None) == ('coordinator-2', True)


def test_a_refused_coordinator_launch_whose_record_cannot_be_cleared_still_raises_the_refusal(
        wired: Any, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture):
    assert wired is not None
    runtime = handler._supervisor().runtime

    def refused(_spec: AgentSpec) -> MicroVm:
        raise RuntimeRefused('no MicroVM image is configured for this language')

    def moved(*_args: Any, **_kwargs: Any) -> None:
        raise BoardError('conflict', 'the task is no longer open at this attempt')

    monkeypatch.setattr(runtime, 'run', refused)
    monkeypatch.setattr(BoardStore, 'clear_launch', moved)
    with pytest.raises(RuntimeRefused, match='no MicroVM image'):
        handler.lambda_handler(COORDINATED, None)
    assert 'could not be cleared' in caplog.text
    assert _coordinate_task().launched_agent == COORDINATOR_AGENT


def _unlaunchable(monkeypatch: pytest.MonkeyPatch, missing: str) -> str:
    """The coordinator made unlaunchable (its role with no skill, or no image for the run's language); the refusal."""
    if missing == 'skill':
        monkeypatch.setattr(handler, 'skill_for', lambda _role: None)
        return 'no coordinator can be launched'
    monkeypatch.setenv('ENGINEERING_IMAGE_ARNS', json.dumps({'java': IMAGE_ARNS['java']}))
    return 'no python image'


@pytest.mark.parametrize('missing', ['skill', 'image'])
def test_a_first_start_whose_coordinator_cannot_be_launched_is_refused_before_anything_is_written(
        wired: Any, monkeypatch: pytest.MonkeyPatch, missing: str):
    assert wired is not None
    with pytest.raises(RuntimeRefused, match=_unlaunchable(monkeypatch, missing)):
        handler.lambda_handler(COORDINATED, None)
    assert _runs().get(OTHER_RUN) is None


@pytest.mark.parametrize('missing', ['skill', 'image'])
def test_a_resume_whose_new_coordinator_cannot_be_launched_numbers_none_and_still_answers(
        wired: Any, monkeypatch: pytest.MonkeyPatch, missing: str):
    assert wired is not None
    board = _coordinator_gone()
    _unlaunchable(monkeypatch, missing)
    _runtime, started = _recording(monkeypatch)
    assert set(handler.lambda_handler(RESUME, None)) == {'agents', 'applied'}
    task = board.task(WORKSPACE, OTHER_RUN, COORDINATE_TASK)
    # Neither re-posted nor numbered: the failed coordinator's task is as it was, the run's agent count too.
    assert (task.attempt, task.launched_agent, started) == (1, COORDINATOR_AGENT, [])
    meta = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE).get_item(Key=meta_key(OTHER_RUN)).get('Item')
    assert meta is not None
    assert meta['agent_count'] == 1


def test_a_start_whose_coordinator_failed_to_launch_sends_the_run_to_a_person_whose_resume_launches_it(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _start_whose_launch_fails(monkeypatch)
    # Never left active with no coordinator and no session: the run waits at the coordinator's decision point.
    table = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)
    meta = table.get_item(Key=meta_key(OTHER_RUN)).get('Item')
    assert meta is not None
    assert (meta['status'], meta['needs_human']) == ('needs_human', 'coordinator')
    assert handler._supervisor().sessions.get(OTHER_RUN, COORDINATOR_AGENT) is None
    _runtime, started = _recording(monkeypatch)
    assert handler.lambda_handler(COORDINATED, None)['status'] == 'needs_human'   # (a retried start launches nothing)
    assert started == []
    handler.lambda_handler(RESUME, None)
    assert handler._supervisor().sessions.get(OTHER_RUN, COORDINATOR_AGENT) is not None
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert run.status == 'active'

def test_a_retried_start_of_a_run_at_its_decision_point_launches_nothing(wired: Any, monkeypatch: pytest.MonkeyPatch):
    _start_whose_launch_fails(monkeypatch)
    _runs().needs_human(OTHER_RUN, 'budget', now=1)
    _runtime, started = _recording(monkeypatch)
    assert handler.lambda_handler(COORDINATED, None) == {'run_id': OTHER_RUN, 'status': 'needs_human'}
    assert (started, _state(wired)) == ([], 'ENABLED')


@pytest.mark.parametrize('missing', ['connection', 'commit', 'language'])
def test_a_run_without_its_connection_commit_or_language_starts_without_a_coordinator(wired: Any, missing: str):
    assert wired is not None
    handler.lambda_handler({**COORDINATED, missing: ''}, None)
    assert handler._supervisor().sessions.get(OTHER_RUN, COORDINATOR_AGENT) is None


@pytest.mark.parametrize('without', [None, 'connection'], ids=['coordinated', 'no-connection'])
def test_a_start_with_a_language_that_has_no_image_is_refused_before_anything_is_written(
        wired: Any, without: str | None):
    assert wired is not None
    event = {**COORDINATED, 'language': 'cobol', **({without: ''} if without else {})}
    with pytest.raises(RuntimeRefused, match='cobol'):
        handler.lambda_handler(event, None)
    assert _runs().get(OTHER_RUN) is None


RESUME = {'action': 'signal', 'run_id': OTHER_RUN, 'signal': 'resume', 'actor': 'admin-1'}


def _coordinator_gone(*, claimed: bool = True) -> BoardStore:
    """A run whose coordinator kept crashing (after its claim, or before it): its session ended, the run at a
    person."""
    handler.lambda_handler(COORDINATED, None)
    board = BoardStore(boto3.client('dynamodb', region_name='us-east-1'), TABLE, new_id=lambda: 'unused')
    if claimed:
        board.claim(WORKSPACE, OTHER_RUN, COORDINATE_TASK, role='coordinator', agent=COORDINATOR_AGENT)
    sessions = handler._supervisor().sessions
    session = sessions.get(OTHER_RUN, COORDINATOR_AGENT)
    assert session is not None
    sessions.save(replace(session, status='failed'))
    _runs().needs_human(OTHER_RUN, 'coordinator', now=1)
    return board


@pytest.mark.parametrize('claimed', [True, False], ids=['after-its-claim', 'before-its-claim'])
def test_a_resume_of_a_run_whose_coordinator_is_gone_starts_a_new_one_on_a_new_attempt(
        wired: Any, monkeypatch: pytest.MonkeyPatch, claimed: bool):
    assert wired is not None
    board = _coordinator_gone(claimed=claimed)
    _runtime, started = _recording(monkeypatch)
    handler.lambda_handler(RESUME, None)
    task = board.task(WORKSPACE, OTHER_RUN, COORDINATE_TASK)
    assert (task.state, task.attempt, task.launched_agent, task.launched_attempt) == ('open', 2, 'coordinator-2', 2)
    session = handler._supervisor().sessions.get(OTHER_RUN, 'coordinator-2')
    assert session is not None
    assert (session.task_attempt, session.harness, [vm.agent_id for vm in started]) == (
        2, harness_argv(COORDINATOR), ['coordinator-2'])
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert run.status == 'active'
    # Who asked is on the launch's history row.
    moves = board.history(WORKSPACE, OTHER_RUN)[COORDINATE_TASK]
    assert [(move.op, move.actor) for move in moves if move.op in ('repost', 'launch')] == [
        ('repost', 'admin-1'), ('launch', 'admin-1')]   # (D4: the re-post is the person's Resume too)


def test_a_resume_after_a_re_post_that_landed_without_its_new_coordinator_records_one_once(wired: Any):
    assert wired is not None
    board = _coordinator_gone()
    # An earlier Resume re-posted the task and died before it recorded the new coordinator.
    board.repost(WORKSPACE, OTHER_RUN, COORDINATE_TASK, reason='gone', attempt=1)
    handler.lambda_handler(RESUME, None)
    handler.lambda_handler(RESUME, None)
    task = board.task(WORKSPACE, OTHER_RUN, COORDINATE_TASK)
    assert (task.attempt, task.launched_agent, task.launched_attempt) == (2, 'coordinator-2', 2)
    assert handler._supervisor().sessions.get(OTHER_RUN, 'coordinator-3') is None


# A Resume leaves a waiting session as it is (it waits for its wait), and a stopped one is final.
@pytest.mark.parametrize('status', ['waiting', 'stopped'], ids=['held-for-its-wait', 'shut-down-by-a-person'])
def test_a_resume_never_replaces_a_coordinator_held_or_ended_by_a_person(wired: Any, status: str):
    assert wired is not None
    handler.lambda_handler(COORDINATED, None)
    sessions = handler._supervisor().sessions
    session = sessions.get(OTHER_RUN, COORDINATOR_AGENT)
    assert session is not None
    sessions.save(replace(session, status=status))   # held for its wait, or a person's Shut down / Stop now
    handler.lambda_handler(RESUME, None)
    task = BoardStore(boto3.client('dynamodb', region_name='us-east-1'), TABLE, new_id=lambda: '').task(
        WORKSPACE, OTHER_RUN, COORDINATE_TASK)
    assert (task.attempt, task.launched_agent) == (1, COORDINATOR_AGENT)
    assert sessions.get(OTHER_RUN, 'coordinator-2') is None


def test_a_resume_the_board_refuses_a_new_coordinator_still_answers_and_starts_none(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _coordinator_gone()
    # The run launched as many agents as it may (the board's cap on agent_count).
    boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE).update_item(
        Key=meta_key(OTHER_RUN), UpdateExpression='SET agent_count = :all', ExpressionAttributeValues={':all': 999})
    _runtime, started = _recording(monkeypatch)
    answer = handler.lambda_handler(RESUME, None)
    assert set(answer) == {'agents', 'applied'}
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert (run.status, started, handler._supervisor().sessions.get(OTHER_RUN, 'coordinator-2')) == (
        'active', [], None)


def test_a_retried_resume_keeps_the_new_coordinator_and_a_live_one_is_left_alone(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _coordinator_gone()
    handler.lambda_handler(RESUME, None)
    _runtime, started = _recording(monkeypatch)
    handler.lambda_handler(RESUME, None)   # a retry, and any later Resume of the run while it has its coordinator
    assert started == []
    task = BoardStore(boto3.client('dynamodb', region_name='us-east-1'), TABLE, new_id=lambda: '').task(
        WORKSPACE, OTHER_RUN, COORDINATE_TASK)
    assert (task.attempt, task.launched_agent) == (2, 'coordinator-2')


def test_who_resumed_or_ended_a_run_is_recorded_with_the_change(wired: Any):
    assert wired is not None
    _runs().needs_human(RUN, 'budget', now=1)
    handler.lambda_handler({'action': 'signal', 'run_id': RUN, 'signal': 'resume', 'actor': 'admin-2'}, None)
    handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'stopped', 'actor': 'admin-1'}, None)
    table = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)
    rows = table.query(KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
                       ExpressionAttributeValues={':pk': meta_key(RUN)['pk'], ':log': 'RUNLOG#'})['Items']
    assert sorted((str(row['status']), str(row['actor'])) for row in rows) == [
        ('active', 'admin-2'), ('active', 'unattributed'), ('needs_human', 'supervisor'), ('stopped', 'admin-1')]


def test_resuming_a_run_at_its_decision_point_lets_it_launch_again(wired: Any):
    assert wired is not None
    _runs().needs_human(RUN, 'budget', now=1)
    with pytest.raises(RunNotActive, match='active run'):
        handler.lambda_handler(LAUNCH, None)
    handler.lambda_handler({'action': 'signal', 'run_id': RUN, 'signal': 'resume'}, None)
    assert handler.lambda_handler(LAUNCH, None)['status'] == 'booting'


@pytest.mark.parametrize(('event', 'refused'), [
    ({'action': 'start_run', 'run_id': ENDED_RUN, 'max_tasks': 5}, 'started already'),
    ({'action': 'start_run', 'run_id': OTHER_RUN, 'max_tasks': 5, 'max_cost_usd': float('nan')}, 'max_cost_usd'),
    ({'action': 'start_run', 'run_id': OTHER_RUN, 'max_tasks': 0}, 'max_tasks'),
    ({'action': 'start_run', 'run_id': OTHER_RUN, 'max_tasks': 5, 'max_tokens': 'many'}, 'max_tokens'),
    ({'action': 'start_run', 'run_id': 'run-1', 'max_tasks': 5}, 'ULID'),
    ({'action': 'end_run', 'run_id': RUN, 'status': 'active'}, 'ends as one of'),
    ({'action': 'end_run', 'run_id': OTHER_RUN, 'status': 'done'}, 'not active'),
], ids=['ended-run-again', 'nan-cost', 'no-tasks', 'tokens-not-a-number', 'not-a-ulid', 'not-an-end',
        'never-started'])
def test_a_bad_start_or_end_is_refused(wired: Any, event: dict[str, Any], refused: str):
    assert wired is not None
    _runs().start(ENDED_RUN, caps=RunCaps(max_tasks=1), now=0)
    _runs().end(ENDED_RUN, 'done', now=1)
    with pytest.raises(RuntimeRefused, match=refused):
        handler.lambda_handler(event, None)


def test_a_tick_with_nothing_live_writes_its_heartbeat_and_leaves_the_rule_alone(
        wired: Any, capsys: pytest.CaptureFixture[str]):
    assert handler.lambda_handler({'action': 'tick'}, None) == {'sessions': {}}
    assert _state(wired) == 'ENABLED'
    out = capsys.readouterr().out
    assert '"EngineeringSupervisorHeartbeat"' in out
    assert '"EngineeringLiveSessions"' in out


def _metric(out: str, name: str) -> float:
    for line in out.splitlines():
        if line.startswith('{') and name in line:
            value = json.loads(line)[name]
            return value[0] if isinstance(value, list) else value
    raise AssertionError(f'{name} was not recorded')


def test_a_tick_reads_the_board_and_reports_the_runs_health_on_the_bus_as_the_supervisor(
        wired: Any, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    assert wired is not None
    handler.lambda_handler(LAUNCH, None)
    bus = handler._supervisor().bus
    assert isinstance(bus, SupervisorBus)  # wired: the bus itself, not a port that refuses
    publisher = bus.publisher
    put: list[dict[str, Any]] = []
    original = publisher.client.put_events

    def recording(**kwargs: Any) -> Any:
        put.extend(kwargs['Entries'])
        return original(**kwargs)

    monkeypatch.setattr(publisher.client, 'put_events', recording)
    before = handler._supervisor().sessions.get('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1')
    handler.lambda_handler({'action': 'tick'}, None)
    after = handler._supervisor().sessions.get('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1')
    assert before is not None
    assert after is not None
    # The board was read (the task is not on it: no lease) and the session moved on from booting.
    assert (after.seq > before.seq, after.claimed_until) == (True, None)
    [health] = [entry for entry in put if entry['DetailType'] == 'run.health']
    detail = json.loads(health['Detail'])
    assert (health['EventBusName'], health['Source'], detail['from'], detail['to']['kind']) == (
        BUS, 'voc.engineering/supervisor', {'kind': 'supervisor', 'id': 'supervisor'}, 'run')
    assert _metric(capsys.readouterr().out, 'EngineeringLiveSessions') == 1



def test_the_delivery_entry_point_records_the_message_in_its_runs_inbox(wired: Any):
    assert wired is not None
    handler.lambda_handler(LAUNCH, None)
    raw = message(run_id=RUN, to={'kind': 'agent', 'id': 'fixer-1'}, refs={'s3': []})
    answer = handler.delivery_handler({'message': raw, 'seq': 3}, None)
    # A booting agent reads its inbox once it runs: recorded, and left alone.
    assert answer == {'event_id': raw['event_id'], 'recorded': True, 'woken': {}}
    rows = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE).query(
        KeyConditionExpression='pk = :run AND begins_with(sk, :inbox)',
        ExpressionAttributeValues={':run': f'WS#default#RUN#{RUN}', ':inbox': 'INBOX#agent:fixer-1#'})['Items']
    assert [row['event_id'] for row in rows] == [raw['event_id']]


@pytest.mark.parametrize(('attempt', 'answer'), [(2, ('stale', False)), (1, ('paused', True))])
def test_a_signal_with_the_attempt_the_person_saw(wired: Any, attempt: int, answer: tuple[str, bool]):
    assert wired is not None
    handler.lambda_handler(LAUNCH, None)
    # Still booting: a Pause holds it at once (no message to send, so the bus, not wired yet, is not needed).
    got = handler.lambda_handler({'action': 'signal', 'run_id': RUN, 'agent_id': 'fixer-1', 'signal': 'pause',
                                  'attempt': attempt}, None)
    assert (got['agents']['fixer-1'], got['applied']['fixer-1']) == answer


@pytest.mark.parametrize('attempt', [True, '1', 1.5])
def test_an_attempt_that_is_not_a_whole_number_is_refused(wired: Any, attempt: object):
    assert wired is not None
    handler.lambda_handler(LAUNCH, None)
    with pytest.raises(RuntimeRefused, match='attempt'):
        handler.lambda_handler({'action': 'signal', 'run_id': RUN, 'agent_id': 'fixer-1', 'signal': 'save',
                                'attempt': attempt}, None)


def test_an_unknown_action_is_refused():
    with pytest.raises(RuntimeRefused, match='unknown action'):
        handler.lambda_handler({'action': 'merge'}, None)


def test_the_deployed_handler_always_uses_lambda_microvms(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    assert isinstance(handler._runtime(), AwsMicroVmRuntime)


def test_a_signal_reaches_the_supervisor_and_an_unknown_one_is_refused(wired: Any):
    assert wired is not None
    handler.lambda_handler(LAUNCH, None)
    with pytest.raises(RuntimeRefused, match='unknown signal'):
        handler.lambda_handler({'action': 'signal', 'run_id': '01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'signal': 'reboot'}, None)
    answer = handler.lambda_handler({'action': 'signal', 'run_id': '01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'agent_id': 'fixer-1',
                                     'signal': 'stop_now'}, None)
    assert answer == {'agents': {'fixer-1': 'stopped'}, 'applied': {'fixer-1': True}}


def _coordinator_launch(**extra: Any) -> dict[str, Any]:
    launch = {key: value for key, value in LAUNCH.items() if key != 'harness'}
    return {**launch, 'agent_id': 'coordinator-0', 'role': 'coordinator', 'task_id': 'coordinate', **extra}


def test_a_role_with_a_skill_runs_its_skills_harness_and_is_labelled_by_it(wired: Any):
    assert wired is not None
    handler.lambda_handler(_coordinator_launch(), None)
    session = handler._supervisor().sessions.get(RUN, 'coordinator-0')
    assert session is not None
    assert session.harness == ('/usr/bin/python3', '-I', '/opt/voc/harness.py', 'run', '--adapter', 'converse',
                               '--model', 'global.anthropic.claude-sonnet-5-5')
    row = handler._supervisor().sessions._table.get_item(Key={'pk': f'WS#default#RUN#{RUN}',
                                                                'sk': 'AGENT#coordinator-0'})['Item']
    assert (row['model'], row['skill_version']) == ('global.anthropic.claude-sonnet-5-5', 'coordinator@1')


def test_a_launch_naming_another_harness_for_a_role_with_a_skill_is_refused(wired: Any):
    assert wired is not None
    with pytest.raises(RuntimeRefused, match='its skill'):
        handler.lambda_handler(_coordinator_launch(harness=['python3', '-c', 'print(1)']), None)
    assert handler._supervisor().sessions.get(RUN, 'coordinator-0') is None


def test_a_role_with_no_skill_yet_needs_the_requests_harness(wired: Any):
    assert wired is not None
    launch = {key: value for key, value in LAUNCH.items() if key != 'harness'}
    with pytest.raises(RuntimeRefused, match='no skill yet'):
        handler.lambda_handler(launch, None)


def _on_the_board(attempt: int) -> None:
    """task-1 on the board at ``attempt`` (posted, then re-posted to reach it)."""
    from engineering.board.store import BoardStore
    from engineering.connectors.identity import WORKSPACE
    from shared.aws import get_dynamodb_client
    store = BoardStore(get_dynamodb_client(), TABLE, new_id=lambda: 'task-1')
    store.post(WORKSPACE, RUN, role='fixer', title='Fix the parser', spec={'issue': 7}, parent_task='', priority=1,
               actor='coordinator-0')
    for at in range(1, attempt):
        store.claim(WORKSPACE, RUN, 'task-1', role='fixer', agent='fixer-9')
        store.repost(WORKSPACE, RUN, 'task-1', reason='stalled', attempt=at)


def test_a_launch_takes_its_tasks_attempt_from_the_board(wired: Any):
    assert wired is not None
    _on_the_board(2)
    handler.lambda_handler(LAUNCH, None)
    session = handler._supervisor().sessions.get(RUN, 'fixer-1')
    assert session is not None
    assert session.task_attempt == 2


def test_a_launch_naming_another_attempt_than_the_boards_is_refused(wired: Any):
    assert wired is not None
    _on_the_board(2)
    with pytest.raises(RuntimeRefused, match='at attempt 2, not 1'):
        handler.lambda_handler({**LAUNCH, 'attempt': 1}, None)
    assert handler._supervisor().sessions.get(RUN, 'fixer-1') is None


# ── the learning loop's hand-on (learning/loop.py) ──────────────────────────────────────────────────────────────────
class _Context:
    """Lambda's context, as far as the handler reads it."""

    function_name = 'voc-engineering-runtime'


def _handing_on(monkeypatch: pytest.MonkeyPatch, fails: bool = False) -> list[tuple[str, dict[str, Any]]]:
    """Every asynchronous invocation the handler makes from now on (raising when ``fails``)."""
    calls: list[tuple[str, dict[str, Any]]] = []

    def invoke(name: str, payload: dict[str, Any]) -> dict[str, Any]:
        calls.append((name, payload))
        if fails:
            raise RuntimeError('Lambda could not be reached')
        return {'StatusCode': 202}

    monkeypatch.setattr(shared_aws, 'invoke_lambda_async', invoke)
    return calls


def test_a_runs_end_hands_its_retrospective_on_to_an_invocation_of_its_own(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    calls = _handing_on(monkeypatch)
    answer = handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'done'}, _Context())
    assert answer == {'run_id': RUN, 'status': 'done', 'agents': {}}
    assert calls == [('voc-engineering-runtime', {'action': 'retrospective', 'run_id': RUN})]


def test_a_runs_retrospective_waits_for_its_last_busy_agent_to_end(wired: Any, monkeypatch: pytest.MonkeyPatch):
    """Its record moves until then (the agent's session is priced as it ends), so it starts at the tick that ends it."""
    assert wired is not None
    now = _busy_agent()
    calls = _handing_on(monkeypatch)
    handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'done'}, _Context())
    assert calls == []
    monkeypatch.setattr(handler, 'clock', lambda: now + 1200)
    handler.lambda_handler({'action': 'tick'}, _Context())
    assert calls == [('voc-engineering-runtime', {'action': 'retrospective', 'run_id': RUN})]
    handler.lambda_handler({'action': 'tick'}, _Context())   # (released: never started twice by the ticks)
    assert len(calls) == 1


def test_a_retrospective_that_cannot_be_started_never_fails_the_end(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    calls = _handing_on(monkeypatch, fails=True)
    answer = handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'stopped'}, _Context())
    assert (answer['status'], len(calls), _runs().listed()) == ('stopped', 1, [])


def test_with_no_function_to_hand_on_to_the_retrospective_runs_in_place(wired: Any):
    """A local run: the end's own invocation reads the ended run (here one with no connection: left alone)."""
    assert wired is not None
    handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'done'}, None)
    assert handler.lambda_handler({'action': 'retrospective', 'run_id': RUN}, None) == {
        'run_id': RUN, 'scorecards': 0, 'failures': 0, 'to_coach': [],
        'skipped': 'the run has no connection (it launched no agent)'}


class _Loop:
    """The learning loop's two steps, answered as a run with two failures to coach would."""

    @staticmethod
    def retrospective(_ws: str, run_id: str) -> Any:
        from engineering.learning.loop import Summary
        return Summary(run_id, 2, 0, 3, ('t-1#1#failed', 't-2#1#no_go'))

    @staticmethod
    def learn_from(_ws: str, _run_id: str, key: str) -> Any:
        from engineering.learning.loop import Learned
        return Learned(key, proposed_version=4, coach='proposed', memory_id='amem_1', lesson='drafted')


def test_the_retrospective_hands_each_failure_it_takes_to_the_coach_on(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    monkeypatch.setattr(handler, '_learning', _Loop)
    calls = _handing_on(monkeypatch)
    answer = handler.lambda_handler({'action': 'retrospective', 'run_id': RUN}, _Context())
    assert (answer['scorecards'], answer['to_coach']) == (2, ['t-1#1#failed', 't-2#1#no_go'])
    assert [payload for _, payload in calls] == [
        {'action': 'retrospective', 'run_id': RUN, 'failure': 't-1#1#failed'},
        {'action': 'retrospective', 'run_id': RUN, 'failure': 't-2#1#no_go'}]
    one = handler.lambda_handler({'action': 'retrospective', 'run_id': RUN, 'failure': 't-1#1#failed'}, _Context())
    assert (one['proposed_version'], one['memory_id'], one['lesson']) == (4, 'amem_1', 'drafted')


@pytest.mark.parametrize('event', [
    {'action': 'retrospective', 'run_id': 'not-a-run'},
    {'action': 'retrospective', 'run_id': RUN, 'failure': 'x'},
])
def test_a_retrospective_that_fails_is_logged_and_answered_never_raised(
        wired: Any, monkeypatch: pytest.MonkeyPatch, event: dict[str, Any]):
    assert wired is not None
    monkeypatch.delenv('ENGINEERING_BENCHMARK_CASES')   # (the loop cannot be built)
    assert handler.lambda_handler(event, None) == {'run_id': event['run_id'], 'status': 'failed'}


def test_the_loop_is_built_once_from_the_environment(wired: Any):
    assert wired is not None
    loop = handler._learning()
    assert (loop.cases, handler._learning()) == (('slug-cut-bug',), loop)
    assert loop.coach().store is not None


# --- voc-engineering-start: the Agents API's start of a run, and nothing else ----------------------------------------

def _handing_on_launches(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Each launch the start function hands on (to voc-engineering-runtime's launch_coordinator), kept, not run."""
    handed: list[tuple[str, str]] = []
    monkeypatch.setattr(handler, '_hand_on_launch', lambda run_id, actor: handed.append((run_id, actor)))
    return handed


def test_the_start_function_writes_the_run_as_the_person_who_asked_and_hands_its_launch_on(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _runtime, started = _recording(monkeypatch)
    handed = _handing_on_launches(monkeypatch)
    started_by = {**COORDINATED, 'actor': 'admin-sub', 'flow': 'wf_0123456789ab', 'budget_usd': 50.0}
    assert handler.start_handler(started_by, None) == {'run_id': OTHER_RUN, 'status': 'active'}
    run = _runs().get(OTHER_RUN)
    assert run is not None
    # Answered once the run is written: no MicroVM started here, the launch handed on.
    assert (run.status, run.flow, run.budget_usd, started, handed) == (
        'active', 'wf_0123456789ab', 50.0, [], [(OTHER_RUN, 'admin-sub')])
    assert handler.lambda_handler({'action': 'launch_coordinator', 'run_id': OTHER_RUN, 'actor': 'admin-sub'}, None) \
        == {'run_id': OTHER_RUN, 'status': 'active'}
    assert [vm.agent_id for vm in started] == [COORDINATOR_AGENT]
    table = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)
    meta = table.get_item(Key=meta_key(OTHER_RUN)).get('Item')
    assert meta is not None
    (log,) = table.query(KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
                         ExpressionAttributeValues={':pk': run_pk(OTHER_RUN), ':log': 'RUNLOG#'})['Items']
    # Who started it and when (D4): on META for the broker's dial, and in the run's history row.
    assert (meta['started_by'], log['actor'], log['status'], log['at'] == meta['started_at']) == (
        'admin-sub', 'admin-sub', 'active', True)


@pytest.mark.parametrize('action', ['tick', 'launch', 'signal', 'end_run', 'retrospective', 'START_RUN', None])
def test_the_start_function_refuses_every_other_action_before_anything_is_read(
        wired: Any, monkeypatch: pytest.MonkeyPatch, action: str | None):
    assert wired is not None
    reached: list[str] = []

    def nothing_may_be_read(*_args: Any, **_kwargs: Any) -> Any:
        reached.append('read')
        raise AssertionError('the start function read something for another action')

    monkeypatch.setattr(handler, '_runs', nothing_may_be_read)
    monkeypatch.setattr(handler, '_supervisor', nothing_may_be_read)
    event = {**LAUNCH, 'status': 'stopped', 'signal': 'stop_now'}
    if action is None:
        event.pop('action')
    else:
        event['action'] = action
    with pytest.raises(RuntimeRefused, match='only starts a run'):
        handler.start_handler(event, None)
    assert reached == []


@pytest.mark.parametrize('failure', [_service_down, 'refused'])
def test_a_handed_on_launch_that_fails_sends_the_run_to_a_person_and_never_raises(
        wired: Any, monkeypatch: pytest.MonkeyPatch, failure: Any):
    assert wired is not None
    _handing_on_launches(monkeypatch)
    handler.start_handler(COORDINATED, None)

    def refused(_spec: AgentSpec) -> MicroVm:
        raise RuntimeRefused('the MicroVM service answered no MicrovmId')

    monkeypatch.setattr(handler._supervisor().runtime, 'run', refused if failure == 'refused' else failure)
    answer = handler.lambda_handler({'action': 'launch_coordinator', 'run_id': OTHER_RUN, 'actor': 'admin-sub'}, None)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    # Never active with no coordinator: at a person's decision point, whose Resume launches it.
    assert (answer['status'], run.status) == ('needs_human', 'needs_human')


def _switch_fails(_enabled: bool) -> None:
    raise RuntimeError('EventBridge is unavailable')


def test_a_start_whose_rule_cannot_be_switched_on_sends_the_written_run_to_a_person(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    monkeypatch.setattr(handler, '_switch', _switch_fails)
    with pytest.raises(RuntimeError, match='EventBridge'):
        handler.lambda_handler(COORDINATED, None)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert run.status == 'needs_human'


def _busy_after_the_write(original: Any) -> Any:
    def start(event: Any, **kwargs: Any) -> Any:
        original(event, **kwargs)
        raise SessionBusy('a launch of coordinator-1 is under way: ask again in a few minutes')
    return start


@pytest.mark.parametrize('failure', ['switch', 'hand_on', 'busy'])
def test_any_failure_once_the_run_is_written_is_start_failed_naming_it_never_a_refusal(
        wired: Any, monkeypatch: pytest.MonkeyPatch, failure: str):
    assert wired is not None
    _handing_on_launches(monkeypatch)
    if failure == 'switch':
        monkeypatch.setattr(handler, '_switch', _switch_fails)
    elif failure == 'hand_on':
        monkeypatch.setattr(handler, '_hand_on_launch', lambda *_: _switch_fails(True))
    else:
        monkeypatch.setattr(handler, 'start_run', _busy_after_the_write(handler.start_run))
    with pytest.raises(handler.StartFailed, match=f'run {OTHER_RUN} was started') as raised:
        handler.start_handler(COORDINATED, None)
    # (not a RuntimeRefused: the Agents API answers a refusal 409 and the person would start a second run)
    assert not isinstance(raised.value, RuntimeRefused)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    # A launch under way keeps the run (it is the run's coordinator); anything else sends it to a person.
    assert run.status == ('active' if failure == 'busy' else 'needs_human')


def test_a_start_refused_before_anything_is_written_stays_a_refusal(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    handed = _handing_on_launches(monkeypatch)
    with pytest.raises(RuntimeRefused, match='no rust image in this deployment') as raised:
        handler.start_handler({**COORDINATED, 'language': 'rust'}, None)
    assert (type(raised.value), _runs().get(OTHER_RUN), handed) == (RuntimeRefused, None, [])


def test_the_hand_on_invokes_the_runtimes_launch_asynchronously(monkeypatch: pytest.MonkeyPatch):
    calls: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setenv('ENGINEERING_RUNTIME_FUNCTION', 'voc-engineering-runtime')
    monkeypatch.setattr(shared_aws, 'invoke_lambda_async', lambda name, payload: calls.append((name, payload)))
    handler._hand_on_launch(OTHER_RUN, 'admin-sub')
    assert calls == [('voc-engineering-runtime', {'action': 'launch_coordinator', 'run_id': OTHER_RUN,
                                                  'actor': 'admin-sub'})]


# --- the tick catches a start whose handed-on launch never came (it crashed or timed out) ----------------------------

def _started_whose_launch_never_ran(monkeypatch: pytest.MonkeyPatch) -> int:
    """A start that wrote the run and handed its launch on, the launch never run (as if its invocation crashed): when
    the run started."""
    _handing_on_launches(monkeypatch)
    handler.start_handler(COORDINATED, None)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    return run.started_at


def _tick_at(monkeypatch: pytest.MonkeyPatch, at: int) -> str:
    """One tick at ``at``: the run's status after it."""
    monkeypatch.setattr(handler, 'clock', lambda: float(at))
    handler.lambda_handler({'action': 'tick'}, None)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    return run.status


def _runlog() -> list[dict[str, Any]]:
    return boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE).query(
        KeyConditionExpression='pk = :pk AND begins_with(sk, :log)',
        ExpressionAttributeValues={':pk': run_pk(OTHER_RUN), ':log': 'RUNLOG#'})['Items']


def test_a_crashed_launch_is_caught_by_a_later_tick_and_the_run_sent_to_a_person_once(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    started = _started_whose_launch_never_ran(monkeypatch)
    # Within the runtime's limit and its margin the launch may still come: nothing is asked.
    assert _tick_at(monkeypatch, started + supervisor_module.COORDINATOR_LAUNCH_SECONDS) == 'active'
    assert _tick_at(monkeypatch, started + supervisor_module.COORDINATOR_LAUNCH_SECONDS + 60) == 'needs_human'
    assert _tick_at(monkeypatch, started + supervisor_module.COORDINATOR_LAUNCH_SECONDS + 120) == 'needs_human'
    asked = [(row['status'], row['actor'], row.get('reason')) for row in _runlog() if row['status'] == 'needs_human']
    assert asked == [('needs_human', 'supervisor', 'coordinator')]   # (once: the decision point's own rule)


def test_a_coordinator_launch_still_under_way_is_left_alone(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    started = _started_whose_launch_never_ran(monkeypatch)
    late = started + supervisor_module.COORDINATOR_LAUNCH_SECONDS + 60
    # (a late launch holds the coordinator's row while its MicroVM starts)
    handler._supervisor().sessions.hold_launch(OTHER_RUN, COORDINATOR_AGENT, late - 30)
    assert _tick_at(monkeypatch, late) == 'active'


def test_a_launched_coordinator_is_left_alone(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    started = _started_whose_launch_never_ran(monkeypatch)
    handler.lambda_handler({'action': 'launch_coordinator', 'run_id': OTHER_RUN, 'actor': 'admin-sub'}, None)
    supervisor = handler._supervisor()
    sessions, holds = supervisor.sessions._agents_of(OTHER_RUN)
    assert [session.agent_id for session in sessions] == [COORDINATOR_AGENT]
    supervisor._coordinator_never_launched(OTHER_RUN, sessions, holds,
                                           started + supervisor_module.COORDINATOR_LAUNCH_SECONDS + 60)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert run.status == 'active'


def test_a_resume_gets_its_own_launch_window_and_no_tick_undoes_it(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    started = _started_whose_launch_never_ran(monkeypatch)
    window = supervisor_module.COORDINATOR_LAUNCH_SECONDS
    assert _tick_at(monkeypatch, started + window + 60) == 'needs_human'
    # A person resumes it long after its start (its new coordinator's launch still on its way: no session yet).
    resumed = started + 3600
    _runs().resume(OTHER_RUN, now=resumed, actor='admin-sub')
    assert _tick_at(monkeypatch, resumed + 60) == 'active'   # (measured from the Resume, not the start)
    assert _tick_at(monkeypatch, resumed + window) == 'active'
    assert _tick_at(monkeypatch, resumed + window + 60) == 'needs_human'   # (and that launch never came either)


def _reads_fail_after(monkeypatch: pytest.MonkeyPatch, reads: int) -> None:
    """The run's row reads fail from the ``reads``-th on (a throttled or unreachable table)."""
    from botocore.exceptions import ClientError
    original, seen = RunStore.get, [0]

    def get(store: RunStore, run_id: str) -> Run | None:
        seen[0] += 1
        if seen[0] >= reads:
            raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'GetItem')
        return original(store, run_id)

    monkeypatch.setattr(RunStore, 'get', get)


def test_a_start_that_failed_and_cannot_read_its_run_back_may_have_started_it(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _handing_on_launches(monkeypatch)
    monkeypatch.setattr(handler, '_switch', _switch_fails)
    _reads_fail_after(monkeypatch, 2)   # (the start's own first read passes; the read back after the failure fails)
    with pytest.raises(handler.StartUncertain, match=f'run {OTHER_RUN} may have been started: open the run monitor'):
        handler.start_handler(COORDINATED, None)


def test_a_start_whose_write_failed_says_start_it_again(wired: Any, monkeypatch: pytest.MonkeyPatch):
    from botocore.exceptions import ClientError
    assert wired is not None
    _handing_on_launches(monkeypatch)

    def write_fails(*_args: Any, **_kwargs: Any) -> None:
        raise ClientError({'Error': {'Code': 'InternalServerError'}}, 'TransactWriteItems')

    monkeypatch.setattr(RunStore, 'start', write_fails)
    with pytest.raises(handler.StartNotWritten, match='start it again'):
        handler.start_handler(COORDINATED, None)
    assert _runs().get(OTHER_RUN) is None


def test_a_run_started_without_a_coordinator_to_launch_is_never_asked_about(wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    _handing_on_launches(monkeypatch)
    handler.start_handler({key: value for key, value in COORDINATED.items() if key != 'language'}, None)
    run = _runs().get(OTHER_RUN)
    assert run is not None
    assert _tick_at(monkeypatch, run.started_at + 3600) == 'active'
