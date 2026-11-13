"""voc-engineering-runtime's entry points, wired from the environment on moto and the local fake."""
import json
import sys
from dataclasses import replace
from typing import Any

import boto3
import pytest

from engineering.bus.test.messages import message
from engineering.runtime import handler
from engineering.runtime.aws import AwsMicroVmRuntime
from engineering.runtime.board_bus import SupervisorBus
from engineering.runtime.interface import AgentSpec, MicroVm, RuntimeRefused
from engineering.runtime.runs import Run, RunCaps, RunNotActive, RunStore, run_pk
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

@pytest.fixture
def wired(aws: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch) -> Any:
    assert aws is not None  # moto's S3 and voc-engineering are up for the handler's own clients
    monkeypatch.setattr(handler, '_runtime', LocalMicroVmRuntime)
    for name, value in {'RAW_DATA_BUCKET': BUCKET, 'ENGINEERING_WORKSPACE_BUCKET': WORKSPACE_BUCKET, 'ENGINEERING_TABLE': TABLE,
                        'SUPERVISOR_RULE_NAME': SCHEDULE, 'ENGINEERING_AGENT_ROLE_ARNS': json.dumps(ROLE_ARNS),
                        'ENGINEERING_BUS_NAME': BUS, 'ENGINEERING_BOARD_URL': BOARD_URL,
                        'AWS_DEFAULT_REGION': 'us-east-1', 'AWS_REGION': 'us-east-1'}.items():
        monkeypatch.setenv(name, value)
    for client in ('_dynamodb_resource', '_s3_client', '_lambda_client', '_eventbridge_client'):
        monkeypatch.setattr(shared_aws, client, None)
    monkeypatch.setattr(handler, '_supervisor_cache', None)
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


def test_an_agent_busy_at_the_runs_end_is_ended_by_the_next_tick_then_the_run_is_released(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    handler.lambda_handler(LAUNCH, None)
    sessions = handler._supervisor().sessions
    session = sessions.get(RUN, 'fixer-1')
    assert session is not None
    now = int(handler.clock())
    sessions.claim(session, now, 600)
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


def test_resuming_a_run_at_its_decision_point_lets_it_launch_again(wired: Any):
    assert wired is not None
    _runs().needs_human(RUN, 'budget')
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
