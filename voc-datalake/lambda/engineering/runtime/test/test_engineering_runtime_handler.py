"""voc-engineering-runtime's entry points, wired from the environment on moto and the local fake."""
import json
import sys
from typing import Any

import boto3
import pytest

from engineering.runtime import handler
from engineering.runtime.aws import AwsMicroVmRuntime
from engineering.runtime.interface import AgentSpec, MicroVm, RuntimeRefused
from engineering.runtime.ports import PendingPorts, PortNotWired
from engineering.runtime.sessions import StaleSession
from engineering.runtime.test.conftest import BUCKET, COMMIT, ROLE_ARNS
from engineering.runtime.test.local_runtime import LocalMicroVmRuntime
from shared import aws as shared_aws

SCHEDULE = 'voc-engineering-supervisor'
LAUNCH = {'action': 'launch', 'run_id': 'run-1', 'agent_id': 'fixer-1', 'role': 'fixer', 'task_id': 'task-1',
          'language': 'python', 'connection': 'conn-1', 'commit': COMMIT, 'paths': ['src'],
          'harness': [sys.executable, '-c', 'pass']}


@pytest.fixture
def wired(aws: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch) -> Any:
    assert aws is not None  # moto's S3 and voc-agents are up for the handler's own clients
    monkeypatch.setattr(handler, '_runtime', LocalMicroVmRuntime)
    for name, value in {'RAW_DATA_BUCKET': BUCKET, 'AGENTS_TABLE': 'voc-agents-test',
                        'SUPERVISOR_RULE_NAME': SCHEDULE, 'ENGINEERING_AGENT_ROLE_ARNS': json.dumps(ROLE_ARNS),
                        'AWS_DEFAULT_REGION': 'us-east-1', 'AWS_REGION': 'us-east-1'}.items():
        monkeypatch.setenv(name, value)
    for client in ('_dynamodb_resource', '_s3_client', '_lambda_client', '_eventbridge_client'):
        monkeypatch.setattr(shared_aws, client, None)
    monkeypatch.setattr(handler, '_supervisor_cache', None)
    handler._sts_client.cache_clear()
    events = boto3.client('events', region_name='us-east-1')
    events.put_rule(Name=SCHEDULE, ScheduleExpression='rate(1 minute)', State='DISABLED')
    return events


def _state(events: Any) -> str:
    return events.describe_rule(Name=SCHEDULE)['State']


def test_launch_starts_the_agents_microvm_and_records_its_session(wired: Any):
    answer = handler.lambda_handler(LAUNCH, None)
    session = handler._supervisor().sessions.get('run-1', 'fixer-1')
    assert answer == {'run_id': 'run-1', 'agent_id': 'fixer-1', 'status': 'booting'}
    assert session is not None
    assert ('pypi.org' in session.egress, session.paths, session.connection) == (True, ('src',), 'conn-1')
    assert _state(wired) == 'DISABLED'


def test_a_second_launch_of_the_same_agent_is_refused_and_ends_the_microvm_it_started(
        wired: Any, monkeypatch: pytest.MonkeyPatch):
    assert wired is not None
    handler.lambda_handler(LAUNCH, None)
    runtime = handler._supervisor().runtime
    assert isinstance(runtime, LocalMicroVmRuntime)
    started: list[MicroVm] = []
    original = runtime.run

    def run(spec: AgentSpec) -> MicroVm:
        started.append(original(spec))
        return started[-1]

    monkeypatch.setattr(runtime, 'run', run)
    with pytest.raises(StaleSession):
        handler.lambda_handler(LAUNCH, None)
    with pytest.raises(RuntimeRefused, match='terminated'):
        runtime.mint_token(started[0])


@pytest.mark.parametrize('change', [{'harness': []}, {'harness': 'python3 -c pass'}, {'harness': ['python3', 1]},
                                    {'commit': 'main'}, {'paths': ['../etc']}, {'paths': 'src'}, {'paths': None},
                                    {'role': 'admin'}, {'language': 'cobol'}],
                         ids=['no-harness', 'shell-string', 'not-strings', 'branch', 'path', 'paths-string',
                              'paths-null', 'role', 'language'])
def test_launch_refuses_a_bad_request_before_anything_starts(wired: Any, change: dict[str, Any]):
    assert wired is not None
    with pytest.raises(RuntimeRefused):
        handler.lambda_handler({**LAUNCH, **change}, None)
    assert list(handler._supervisor().sessions.active()) == []


def test_the_runs_transitions_switch_the_schedule_on_and_off(wired: Any):
    assert handler.lambda_handler({'action': 'switch', 'enabled': True}, None) == {'enabled': True}
    assert _state(wired) == 'ENABLED'
    handler.lambda_handler({'action': 'switch', 'enabled': False}, None)
    assert _state(wired) == 'DISABLED'
    with pytest.raises(RuntimeRefused, match='true or false'):
        handler.lambda_handler({'action': 'switch', 'enabled': 'yes'}, None)


def test_a_tick_with_nothing_live_writes_its_heartbeat_and_leaves_the_rule_alone(
        wired: Any, capsys: pytest.CaptureFixture[str]):
    handler.lambda_handler({'action': 'switch', 'enabled': True}, None)
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
    before = handler._supervisor().sessions.get('run-1', 'fixer-1')
    assert handler.lambda_handler({'action': 'tick'}, None) == {'sessions': {'booting': 1}}
    after = handler._supervisor().sessions.get('run-1', 'fixer-1')
    assert before is not None
    assert after == before
    assert _metric(capsys.readouterr().out, 'EngineeringLiveSessions') == 1


@pytest.mark.parametrize(('method', 'args'), [
    ('lease', ('r', 't')), ('repost', ('r', 't', 'x')), ('emit', ('r', 'a', 'k', 's')), ('inbox_depth', ('r', 'a')),
    ('budget', ('r',)), ('started_at', ('r',)), ('stop_requested', ('r',)), ('needs_human', ('r', 'x')),
], ids=lambda value: value if isinstance(value, str) else '')
def test_every_pending_port_refuses_rather_than_guesses(method: str, args: tuple[str, ...]):
    with pytest.raises(PortNotWired, match='not wired yet'):
        getattr(PendingPorts(), method)(*args)


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
        handler.lambda_handler({'action': 'signal', 'run_id': 'run-1', 'signal': 'reboot'}, None)
    answer = handler.lambda_handler({'action': 'signal', 'run_id': 'run-1', 'agent_id': 'fixer-1',
                                     'signal': 'stop_now'}, None)
    assert answer == {'agents': {'fixer-1': 'stopped'}}
