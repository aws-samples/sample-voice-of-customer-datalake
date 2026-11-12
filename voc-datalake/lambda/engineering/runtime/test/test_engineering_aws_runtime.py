"""The AWS runtime against a fake MicroVM client and a fake transport (never against AWS)."""
import json
import time
import urllib.request
from types import SimpleNamespace
from typing import Any

import pytest

from engineering.runtime.aws import IDLE_SUSPEND_SECONDS, IDLE_TERMINATE_SECONDS, AwsMicroVmRuntime
from engineering.runtime.interface import AgentSpec, CacheMount, Command, MicroVm, RuntimeRefused
from engineering.runtime.launcher import RoleSession
from engineering.runtime.tokens import MAX_TOKEN_SECONDS
from engineering.runtime.unit_runner import MASK

SPEC = AgentSpec(run_id='run-1', agent_id='fixer-1', role='fixer', task_id='task-1', language='rust',
                 egress=('crates.io',), connection='repo-1')
IMAGES = {'rust': 'arn:aws:lambda:us-east-1:111111111111:microvm-image/voc-engineering-rust:1'}
VM = MicroVm('mvm-1', 'fixer-1', 'https://x.example.org')


class FakeClient:
    meta = SimpleNamespace(region_name='eu-west-1')

    def __init__(self, run_answer: dict[str, Any] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.run_answer = run_answer or {'MicrovmId': 'mvm-1', 'Endpoint': 'https://mvm-1.example.org'}
        self.tokens = 0
        self.issued = int(time.time())

    def run_microvm(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(('run', kwargs))
        return self.run_answer

    def suspend_microvm(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(('suspend', kwargs))
        return {}

    def resume_microvm(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(('resume', kwargs))
        return {}

    def terminate_microvm(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(('terminate', kwargs))
        return {}

    def create_microvm_auth_token(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(('token', kwargs))
        self.tokens += 1
        return {'Token': f'fake-token-{self.tokens}', 'IssuedAt': self.issued,
                'ExpiresAt': self.issued + 5 * MAX_TOKEN_SECONDS}


class TokenlessClient(FakeClient):
    def create_microvm_auth_token(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(('token', kwargs))
        return {'Token': 'fake'}


class FakeTransport:
    def __init__(self, answers: list[dict[str, Any]]) -> None:
        self.answers = answers
        self.requests: list[urllib.request.Request] = []

    def __call__(self, request: urllib.request.Request) -> dict[str, Any]:
        self.requests.append(request)
        return self.answers.pop(0)


def _runtime(client: FakeClient | None = None, answers: list[dict[str, Any]] | None = None) -> AwsMicroVmRuntime:
    return AwsMicroVmRuntime(client or FakeClient(), IMAGES, transport=FakeTransport(answers or []))


def test_run_starts_the_language_image_with_its_egress_and_no_role_of_its_own():
    client = FakeClient()
    vm = _runtime(client).run(SPEC)
    args = client.calls[0][1]
    assert vm == MicroVm(vm_id='mvm-1', agent_id='fixer-1', endpoint='https://mvm-1.example.org')
    assert (args['ImageArn'], args['EgressAllowlist']) == (IMAGES['rust'], ['crates.io'])
    assert 'ExecutionRoleArn' not in args
    assert (args['IdlePolicy'], args['Environment']['VOC_AGENT_ID'], args['Environment']['AWS_REGION']) == (
        {'SuspendAfterSeconds': IDLE_SUSPEND_SECONDS, 'TerminateAfterSeconds': IDLE_TERMINATE_SECONDS}, 'fixer-1',
        'eu-west-1')


def test_a_session_is_handed_to_the_runner_with_the_cache_mount_and_the_status_is_bounded():
    session = RoleSession(access_key_id='ASIAFAKE', secret_access_key='fake', session_token='fake', expires_at=0.0)
    runtime = _runtime(answers=[{'kept': True}, {'step': 'x' * 500, 'recent_tools': ['t'] * 20,
                                                 'tokens': {'m': {'in': 3, 'out': 4}}}])
    runtime.hand_session(VM, session, CacheMount(bucket='voc-raw-test', connection='conn-1'))
    status = runtime.status(VM)
    transport = runtime._transport
    assert isinstance(transport, FakeTransport)
    assert isinstance(transport.requests[0].data, bytes)
    body = json.loads(transport.requests[0].data)
    assert (body['AccessKeyId'], body['mount']) == ('ASIAFAKE', {'bucket': 'voc-raw-test',
                                                                'prefix': 'engineering/cache/conn-1/'})
    assert (len(status.step), len(status.recent_tools), status.tokens) == (200, 10, {'m': {'in': 3, 'out': 4}})


@pytest.mark.parametrize('answer', [{'Endpoint': 'https://x.example.org'}, {'MicrovmId': 'm', 'Endpoint': 'http://x'},
                                    {'MicrovmId': 'm', 'Endpoint': 'https://x.example.org/?a=1'}, {'MicrovmId': 'm'}],
                         ids=['no-id', 'plain-http', 'query', 'no-endpoint'])
def test_run_refuses_an_answer_without_an_id_or_an_https_endpoint(answer):
    with pytest.raises(RuntimeRefused):
        _runtime(FakeClient(answer)).run(SPEC)


def test_run_refuses_a_language_without_an_image():
    with pytest.raises(RuntimeRefused, match='no MicroVM image'):
        AwsMicroVmRuntime(FakeClient(), {}).run(SPEC)


def test_suspend_resume_terminate_name_the_microvm():
    client = FakeClient()
    runtime = _runtime(client)
    vm = runtime.run(SPEC)
    runtime.suspend(vm)
    runtime.resume(vm)
    runtime.terminate(vm)
    assert client.calls[1:] == [('suspend', {'MicrovmId': 'mvm-1'}), ('resume', {'MicrovmId': 'mvm-1'}),
                                ('terminate', {'MicrovmId': 'mvm-1'})]


def test_a_minted_token_is_cut_to_sixty_minutes():
    client = FakeClient()
    assert _runtime(client).mint_token(VM).expires_at == client.issued + MAX_TOKEN_SECONDS


def test_a_token_answer_without_its_fields_is_refused():
    with pytest.raises(RuntimeRefused):
        _runtime(TokenlessClient()).mint_token(VM)


def test_exec_sends_the_command_with_a_bearer_token_minted_once_and_scrubs_the_answer():
    client = FakeClient()
    leaked = 'AKIA' + 'ABCDEFGHIJKLMNOP'
    runtime = _runtime(client, [{'exec_id': 'abc123'}, {'state': 'running'},
                                {'state': 'done', 'exit_code': 0, 'stdout_tail': f'ok {leaked}', 'duration_seconds': 2.5}])
    vm = runtime.run(SPEC)
    exec_id = runtime.start_exec(vm, Command(argv=('cargo', 'test'), timeout_seconds=600))
    assert runtime.poll_exec(vm, exec_id) is None
    result = runtime.poll_exec(vm, exec_id)
    assert result is not None
    assert (result.ok, result.stdout_tail, result.duration_seconds) == (True, f'ok {MASK}', 2.5)
    transport = runtime._transport
    assert isinstance(transport, FakeTransport)
    first = transport.requests[0]
    assert (first.get_method(), first.full_url) == ('POST', 'https://mvm-1.example.org/exec')
    assert isinstance(first.data, bytes)
    assert json.loads(first.data) == {'argv': ['cargo', 'test'], 'timeout_seconds': 600,
                                      'repository_code': True, 'network': False}
    assert {request.get_header('Authorization') for request in transport.requests} == {'Bearer fake-token-1'}
    assert client.tokens == 1


@pytest.mark.parametrize('answer', [{}, {'exec_id': '../x'}], ids=['missing', 'not-alnum'])
def test_start_exec_refuses_a_runner_answer_without_a_clean_exec_id(answer):
    runtime = _runtime(answers=[answer])
    with pytest.raises(RuntimeRefused):
        runtime.start_exec(runtime.run(SPEC), Command(argv=('true',), timeout_seconds=5))


def test_poll_exec_refuses_an_exec_id_that_could_change_the_path():
    runtime = _runtime()
    with pytest.raises(RuntimeRefused):
        runtime.poll_exec(runtime.run(SPEC), '../../admin')
