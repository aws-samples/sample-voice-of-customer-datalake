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
from engineering.runtime.interface import AgentSpec, MicroVm, RuntimeRefused
from engineering.runtime.ports import PendingPorts, PortNotWired
from engineering.runtime.runs import Run, RunCaps, RunNotActive, RunStore
from engineering.runtime.sessions import StaleSession
from engineering.runtime.test.conftest import BUCKET, COMMIT, ROLE_ARNS, RUN, TABLE, WORKSPACE_BUCKET
from engineering.runtime.test.local_runtime import LocalMicroVmRuntime
from shared import aws as shared_aws

SCHEDULE = 'voc-engineering-supervisor'
OTHER_RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0CD'
ENDED_RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0EF'
LAUNCH = {'action': 'launch', 'run_id': '01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'agent_id': 'fixer-1', 'role': 'fixer', 'task_id': 'task-1',
          'language': 'python', 'connection': 'conn-1', 'commit': COMMIT, 'paths': ['src'],
          'harness': [sys.executable, '-c', 'pass']}


@pytest.fixture
def wired(aws: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch) -> Any:
    assert aws is not None  # moto's S3 and voc-engineering are up for the handler's own clients
    monkeypatch.setattr(handler, '_runtime', LocalMicroVmRuntime)
    for name, value in {'RAW_DATA_BUCKET': BUCKET, 'ENGINEERING_WORKSPACE_BUCKET': WORKSPACE_BUCKET, 'ENGINEERING_TABLE': TABLE,
                        'SUPERVISOR_RULE_NAME': SCHEDULE, 'ENGINEERING_AGENT_ROLE_ARNS': json.dumps(ROLE_ARNS),
                        'AWS_DEFAULT_REGION': 'us-east-1', 'AWS_REGION': 'us-east-1'}.items():
        monkeypatch.setenv(name, value)
    for client in ('_dynamodb_resource', '_s3_client', '_lambda_client', '_eventbridge_client'):
        monkeypatch.setattr(shared_aws, client, None)
    monkeypatch.setattr(handler, '_supervisor_cache', None)
    handler._sts_client.cache_clear()
    events = boto3.client('events', region_name='us-east-1')
    events.put_rule(Name=SCHEDULE, ScheduleExpression='rate(1 minute)', State='DISABLED')
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
    env = session.spec(None, supervisor.workspace_bucket).environment()
    assert (session.task_attempt, env['VOC_ATTEMPT'], env['VOC_COMMIT'], env['VOC_WORKSPACE_BUCKET']) == (
        2, '2', COMMIT, WORKSPACE_BUCKET)
    # Each bucket for its own: the cache's mount from the raw one, the agents' keys in the workspace one.
    assert (supervisor.bucket, supervisor.workspace_bucket) == (BUCKET, WORKSPACE_BUCKET)
    assert f'{WORKSPACE_BUCKET}.s3.us-east-1.amazonaws.com' in session.egress


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


def test_a_second_launch_of_the_same_agent_is_refused_and_ends_the_microvm_it_started(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    handler.lambda_handler(LAUNCH, None)
    runtime, started = _recording(monkeypatch)
    with pytest.raises(StaleSession):
        handler.lambda_handler(LAUNCH, None)
    with pytest.raises(RuntimeRefused, match='terminated'):
        runtime.mint_token(started[0])


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


def test_until_the_board_and_bus_land_a_tick_with_live_sessions_moves_nothing_rather_than_guesses(
        wired: Any, capsys: pytest.CaptureFixture[str]):
    assert wired is not None
    handler.lambda_handler(LAUNCH, None)
    before = handler._supervisor().sessions.get('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1')
    assert handler.lambda_handler({'action': 'tick'}, None) == {'sessions': {'booting': 1}}
    after = handler._supervisor().sessions.get('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1')
    assert before is not None
    assert after is not None
    # The tick claimed the row and let it go again when the board refused: nothing else about the session moved.
    assert (replace(after, seq=before.seq), after.claimed_until) == (before, None)
    assert _metric(capsys.readouterr().out, 'EngineeringLiveSessions') == 1


@pytest.mark.parametrize(('method', 'args'), [
    ('lease', ('r', 't')), ('repost', ('r', 't', 'x')), ('emit', ('r', 'a', 'k', 's')), ('inbox_depth', ('r', 'a')),
    ('budget', ('r',)), ('started_at', ('r',)), ('stop_requested', ('r',)), ('needs_human', ('r', 'x')),
], ids=lambda value: value if isinstance(value, str) else '')
def test_every_pending_port_refuses_rather_than_guesses(method: str, args: tuple[str, ...]):
    with pytest.raises(PortNotWired, match='not wired yet'):
        getattr(PendingPorts(), method)(*args)


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
