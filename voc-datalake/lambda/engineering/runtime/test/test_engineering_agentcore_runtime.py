"""The AgentCore runtime against a fake bedrock-agentcore client (never against AWS): one session per agent, the
runner's ops as invocations, commands through the command API, the stop."""
import base64
import io
import json
import re
import shlex
from typing import Any

import pytest
from botocore.exceptions import ClientError

from engineering.runtime.agentcore import (
    BUILD,
    COMMAND_SECONDS,
    QUALIFIER,
    RUNNER_CLIENT,
    STANDARD,
    AgentCoreRuntime,
    runtimes_from,
)
from engineering.runtime.interface import AgentSpec, CacheMount, Command, RuntimeRefused, RuntimeSession, SessionsFull
from engineering.runtime.launcher import RoleSession
from engineering.runtime.unit_runner import MASK

RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0AB'
SPEC = AgentSpec(run_id=RUN, agent_id='fixer-1', role='fixer', task_id='task-1', language='rust',
                 egress=('bedrock-runtime.eu-west-1.amazonaws.com', 'crates.io', 'index.crates.io'), connection='repo-1')
RUNTIMES = {'rust': {STANDARD: 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/voc_eng_rust-a1b2c3d4e5',
                     BUILD: 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/voc_eng_rust_build-f6g7h8'}}


def _error(code: str) -> ClientError:
    return ClientError({'Error': {'Code': code, 'Message': 'fake'}}, 'StopRuntimeSession')


class FakeAgentCore:
    """The bedrock-agentcore data plane, as botocore models it: each call recorded; invocations answered in turn."""

    def __init__(self, answers: list[dict[str, Any]] | None = None,
                 commands: list[tuple[str, str, int]] | None = None, stop_error: str = '') -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.answers = answers if answers is not None else [{'started': True}]
        self.commands = commands or []
        self.stop_error = stop_error

    def invoke_agent_runtime(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(('invoke', kwargs))
        answer = self.answers.pop(0)
        return {'statusCode': answer.pop('_status', 200), 'runtimeSessionId': kwargs['runtimeSessionId'],
                'response': io.BytesIO(json.dumps(answer).encode())}

    def invoke_agent_runtime_command(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(('command', kwargs))
        stdout, stderr, code = self.commands.pop(0)
        return {'statusCode': 200, 'stream': [
            {'chunk': {'contentStart': {}}},
            {'chunk': {'contentDelta': {'stdout': stdout[:5]}}},
            {'chunk': {'contentDelta': {'stdout': stdout[5:], 'stderr': stderr}}},
            {'chunk': {'contentStop': {'exitCode': code, 'status': 'COMPLETED'}}},
        ]}

    def stop_runtime_session(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(('stop', kwargs))
        if self.stop_error:
            raise _error(self.stop_error)
        return {'statusCode': 200}


def _runtime(client: FakeAgentCore, build_roles: tuple[str, ...] = ('gate-runner',)) -> AgentCoreRuntime:
    return AgentCoreRuntime(client, RUNTIMES, region='eu-west-1', build_roles=build_roles, nonce=lambda: 'a1b2c3d4')


def _payload(call: tuple[str, dict[str, Any]]) -> dict[str, Any]:
    return json.loads(call[1]['payload'])


def test_run_starts_one_session_on_its_languages_runtime_with_the_agents_ids_and_egress_and_no_role():
    client = FakeAgentCore()
    vm = _runtime(client).run(SPEC)
    ((kind, args),) = client.calls
    assert kind == 'invoke'
    assert vm == RuntimeSession(vm_id=f'voc-{RUN}-fixer-1-a1b2c3d4', agent_id='fixer-1', endpoint=RUNTIMES['rust'][STANDARD])
    assert (args['agentRuntimeArn'], args['runtimeSessionId'], args['qualifier']) == (
        RUNTIMES['rust'][STANDARD], vm.vm_id, QUALIFIER)
    # The service's own rule: a session id is 33 to 256 characters.
    assert 33 <= len(vm.vm_id) <= 256
    start = _payload(client.calls[0])
    # The agent's own hosts and the dependency step's, apart (each held by a proxy of its own).
    assert (start['op'], start['egress'], start['code_egress']) == (
        'start', ['bedrock-runtime.eu-west-1.amazonaws.com'], ['crates.io', 'index.crates.io'])
    assert start['environment'] == {**SPEC.environment(), 'AWS_REGION': 'eu-west-1'}
    assert not [name for name in args if 'Role' in name or 'Credential' in name]


def test_each_continuation_gets_a_session_of_its_own():
    nonces = iter(['n1', 'n2'])
    client = FakeAgentCore(answers=[{'started': True}, {'started': True}])
    runtime = AgentCoreRuntime(client, RUNTIMES, region='eu-west-1', nonce=lambda: next(nonces).ljust(8, '0'))
    assert runtime.run(SPEC).vm_id != runtime.run(SPEC).vm_id


def test_the_roles_that_build_and_test_run_on_the_build_runtime_and_the_others_on_the_standard_one():
    runtime = _runtime(FakeAgentCore())
    gate = AgentSpec(run_id=RUN, agent_id='gate-runner-2', role='gate-runner', task_id='task-1', language='rust',
                     egress=(), connection='repo-1')
    assert (runtime.runtime_arn(gate), runtime.runtime_arn(SPEC)) == (RUNTIMES['rust'][BUILD],
                                                                      RUNTIMES['rust'][STANDARD])
    # Without a build runtime (no resource configuration in this deployment), the standard one.
    plain = AgentCoreRuntime(FakeAgentCore(), {'rust': {STANDARD: RUNTIMES['rust'][STANDARD]}}, region='eu-west-1',
                             build_roles=('gate-runner',))
    assert plain.runtime_arn(gate) == RUNTIMES['rust'][STANDARD]


def test_a_language_without_a_runtime_is_refused_before_any_call():
    client = FakeAgentCore()
    java = AgentSpec(run_id=RUN, agent_id='fixer-1', role='fixer', task_id='task-1', language='java', egress=(),
                     connection='repo-1')
    with pytest.raises(RuntimeRefused, match='no agent runtime'):
        _runtime(client).run(java)
    assert client.calls == []


@pytest.mark.parametrize(('answer', 'said'), [
    ({'started': False}, 'did not start'), ({'error': 'no egress firewall'}, 'did not start'),
    ({'_status': 500, 'started': True}, 'answered 500'),
    # The runner's own refusal: without its egress firewall and both proxies, no agent starts.
    ({'_status': 400, 'error': 'this session could not keep its agent to its egress allowlist'}, 'answered 400'),
], ids=['refused', 'error', 'status', 'firewall-refused'])
def test_a_session_that_does_not_start_is_stopped_and_refused(answer, said):
    client = FakeAgentCore(answers=[answer])
    with pytest.raises(RuntimeRefused, match=said):
        _runtime(client).run(SPEC)
    assert [kind for kind, _ in client.calls] == ['invoke', 'stop']


class FullAgentCore(FakeAgentCore):
    def __init__(self, code: str) -> None:
        super().__init__()
        self.code = code

    def invoke_agent_runtime(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(('invoke', kwargs))
        raise ClientError({'Error': {'Code': self.code, 'Message': 'fake'}}, 'InvokeAgentRuntime')


@pytest.mark.parametrize('code', ['ServiceQuotaExceededException', 'ThrottlingException'])
def test_no_room_for_a_new_session_is_a_clear_refusal_and_nothing_to_stop(code: str):
    client = FullAgentCore(code)
    with pytest.raises(SessionsFull, match='no room for a new session'):
        _runtime(client).run(SPEC)
    assert [kind for kind, _ in client.calls] == ['invoke']


def test_another_service_error_on_a_start_is_raised_as_it_is_and_the_session_stopped():
    client = FullAgentCore('AccessDeniedException')
    with pytest.raises(ClientError):
        _runtime(client).run(SPEC)
    assert [kind for kind, _ in client.calls] == ['invoke', 'stop']


def test_a_stop_that_fails_after_a_start_that_did_not_still_raises_the_refusal():
    client = FakeAgentCore(answers=[{'started': False}], stop_error='InternalServerException')
    with pytest.raises(RuntimeRefused, match='did not start'):
        _runtime(client).run(SPEC)


def test_hold_wake_status_and_the_role_session_are_invocations_of_the_same_session():
    client = FakeAgentCore(answers=[{'held': True}, {'held': False}, {'kept': True},
                                    {'step': 'token=' + 'x' * 30, 'recent_tools': ['read'] * 30, 'tokens': {}}])
    runtime = _runtime(client)
    vm = RuntimeSession(f'voc-{RUN}-fixer-1-a1b2c3d4', 'fixer-1', RUNTIMES['rust'][STANDARD])
    runtime.suspend(vm)
    runtime.resume(vm)
    session = RoleSession(access_key_id='ASIAFAKE', secret_access_key='fake', session_token='fake', expires_at=0.0)
    runtime.hand_session(vm, session, CacheMount(bucket='voc-raw-test', connection='repo-1'))
    status = runtime.status(vm)
    ops = [_payload(call)['op'] for call in client.calls]
    assert ops == ['hold', 'wake', 'session', 'status']
    assert {call[1]['runtimeSessionId'] for call in client.calls} == {vm.vm_id}
    handed = _payload(client.calls[2])['session']
    assert (handed['AccessKeyId'], handed['mount']) == ('ASIAFAKE', {'bucket': 'voc-raw-test',
                                                                     'prefix': 'engineering/cache/repo-1/'})
    assert (status.step, len(status.recent_tools)) == (f'token={MASK}', 10)


def test_a_role_session_the_runner_did_not_keep_is_refused():
    client = FakeAgentCore(answers=[{'error': 'a session needs ...'}])
    session = RoleSession(access_key_id='ASIAFAKE', secret_access_key='fake', session_token='fake', expires_at=0.0)
    with pytest.raises(RuntimeRefused, match='did not keep'):
        _runtime(client).hand_session(RuntimeSession('s' * 40, 'fixer-1', RUNTIMES['rust'][STANDARD]), session, None)


def _sent(call: tuple[str, dict[str, Any]]) -> tuple[list[str], dict[str, Any], int]:
    """A command call's shell words, the JSON it hands the runner's client, and its timeout."""
    body = call[1]['body']
    words = shlex.split(body['command'])
    return words, json.loads(base64.urlsafe_b64decode(words[-1])), body['timeout']


def test_commands_go_through_the_command_api_as_the_runners_client_in_short_calls():
    client = FakeAgentCore(commands=[
        (json.dumps({'exec_id': 'abc123'}), '', 0),
        (json.dumps({'state': 'running'}), '', 0),
        (json.dumps({'state': 'done', 'exit_code': 0, 'stdout_tail': 'AKIA' + 'Z' * 16,
                     'stderr_tail': '', 'duration_seconds': 4000.5}), '', 0),
    ])
    runtime = _runtime(client)
    vm = RuntimeSession(f'voc-{RUN}-fixer-1-a1b2c3d4', 'fixer-1', RUNTIMES['rust'][STANDARD])
    # A test run of more than the API's hour: one call starts it, later calls read it.
    command = Command(argv=('cargo', 'test', "'; rm -rf / #"), timeout_seconds=2 * 3600)
    exec_id = runtime.start_exec(vm, command)
    assert (exec_id, runtime.poll_exec(vm, exec_id)) == ('abc123', None)
    result = runtime.poll_exec(vm, exec_id)
    assert result is not None
    assert (result.exit_code, result.stdout_tail, result.duration_seconds) == (0, MASK, 4000.5)
    words, body, timeout = _sent(client.calls[0])
    # The one shell string: the runner's fixed client and one base64 word (nothing anyone wrote is read by a shell).
    assert (words[:-2], words[-2]) == (RUNNER_CLIENT.split(), 'start')
    assert (body, timeout) == (command.to_body(), COMMAND_SECONDS)
    # (the command API's bound on one call: 3,600 seconds)
    assert COMMAND_SECONDS <= 3600
    assert all(call[1]['runtimeSessionId'] == vm.vm_id for call in client.calls)
    assert _sent(client.calls[1])[1] == {'exec_id': 'abc123'}


def test_a_command_the_runner_refused_is_refused_with_its_scrubbed_reason():
    client = FakeAgentCore(commands=[('', 'repository code needs the hard-link guard token=' + 'x' * 30, 1),
                                     ('{"exec_id": "../x"}', '', 0), ('not json', '', 0)])
    runtime = _runtime(client)
    vm = RuntimeSession('s' * 40, 'fixer-1', RUNTIMES['rust'][STANDARD])
    with pytest.raises(RuntimeRefused, match=re.escape(f'hard-link guard token={MASK}')):
        runtime.start_exec(vm, Command(argv=('make',), timeout_seconds=60))
    with pytest.raises(RuntimeRefused, match='no exec id'):
        runtime.start_exec(vm, Command(argv=('make',), timeout_seconds=60))
    with pytest.raises(RuntimeRefused, match='JSON'):
        runtime.poll_exec(vm, 'abc')
    with pytest.raises(RuntimeRefused, match='letters and digits'):
        runtime.poll_exec(vm, '../status')


def test_terminate_stops_the_session_and_one_already_gone_is_not_an_error():
    vm = RuntimeSession('s' * 40, 'fixer-1', RUNTIMES['rust'][STANDARD])
    client = FakeAgentCore()
    _runtime(client).terminate(vm)
    assert client.calls == [('stop', {'agentRuntimeArn': vm.endpoint, 'runtimeSessionId': vm.vm_id,
                                      'qualifier': QUALIFIER})]
    _runtime(FakeAgentCore(stop_error='ResourceNotFoundException')).terminate(vm)
    with pytest.raises(ClientError):
        _runtime(FakeAgentCore(stop_error='AccessDeniedException')).terminate(vm)


def test_the_runtimes_come_from_the_stacks_environment():
    assert runtimes_from(None) == {}
    assert runtimes_from(json.dumps(RUNTIMES)) == RUNTIMES
    for bad in ['[]', json.dumps({'rust': {BUILD: 'arn'}}), json.dumps({'rust': {STANDARD: ''}}),
                json.dumps({'rust': {STANDARD: 'arn', 'huge': 'arn'}})]:
        with pytest.raises(RuntimeRefused, match='ENGINEERING_AGENT_RUNTIMES'):
            runtimes_from(bad)


def test_the_operations_and_fields_are_botocores_model_of_bedrock_agentcore():
    """What botocore knows of the service (its model ships with it): the operations and the request fields this
    runtime sends. The answers' shapes are not in it as data, and no real call has checked them yet."""
    import botocore.session
    model = botocore.session.get_session().get_service_model('bedrock-agentcore')
    sent = {'InvokeAgentRuntime': {'agentRuntimeArn', 'runtimeSessionId', 'qualifier', 'contentType', 'accept',
                                   'payload'},
            'InvokeAgentRuntimeCommand': {'agentRuntimeArn', 'runtimeSessionId', 'qualifier', 'contentType', 'accept',
                                          'body'},
            'StopRuntimeSession': {'agentRuntimeArn', 'runtimeSessionId', 'qualifier'}}
    for operation, fields in sent.items():
        assert fields <= set(_members(model.operation_model(operation).input_shape)), operation
    command = model.operation_model('InvokeAgentRuntimeCommand')
    assert set(_members(_members(command.input_shape)['body'])) == {'command', 'timeout'}
    chunk = _members(_members(command.output_shape)['stream'])['chunk']
    assert {'contentDelta', 'contentStop'} <= set(_members(chunk))


def _members(shape: object) -> dict[str, Any]:
    """A botocore structure shape's members (``{}`` for any other shape)."""
    members = getattr(shape, 'members', None)
    return dict(members) if isinstance(members, dict) else {}
