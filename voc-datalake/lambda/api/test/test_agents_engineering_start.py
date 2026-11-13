"""The Agents API's start of an engineering run (``POST /agents/engineering/runs``).

An administrator acting for themselves starts a saved engineering flow: the API checks every field, reads the flow's
budget from the stored workflow (never from the request), mints the run's id and invokes the start function
(voc-engineering-start, which runs ``start_run`` and nothing else) with the person as the actor. The runtime's
refusals are 409 with their words; a start function that fails or cannot be reached is 503.
"""
from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

import pytest
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from botocore.exceptions import (
    ClientError,
    ConnectionClosedError,
    ConnectTimeoutError,
    EndpointConnectionError,
    ReadTimeoutError,
)

import agents_handler
from engineering.test.run_fixture import LambdaClient
from shared.test.test_workflow_engineering import bug_fix

PATH = '/agents/engineering/runs'
START_FUNCTION = 'voc-engineering-start'
COMMIT = '0123456789abcdef0123456789abcdef01234567'
ULID = re.compile(r'[0-9A-HJKMNP-TV-Z]{26}\Z')
#: An MCP credential an administrator minted: delegated, so never an administrator here.
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}


class Start(LambdaClient):
    """The start function as the API's client sees it: it answers each request for the run it names."""

    def invoke(self, **request: Any) -> dict[str, Any]:
        if not self.function_error:
            self.payload = {'run_id': json.loads(request['Payload'])['run_id'], 'status': 'active'}
        return super().invoke(**request)


@pytest.fixture
def start(monkeypatch: pytest.MonkeyPatch, lambda_context: Any) -> Iterator[tuple[Start, str]]:
    """The module on, the start function named, and a saved engineering flow with a $49.99 monthly budget."""
    monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
    monkeypatch.setenv('ENGINEERING_TABLE', 'voc-engineering')
    monkeypatch.setenv('ENGINEERING_START_FUNCTION', START_FUNCTION)
    client = Start({})
    monkeypatch.setattr(agents_handler, '_start_client', lambda: client)
    with _api():
        definition = {**bug_fix(), 'budget': {'monthly_usd': 49.99}}
        status, body = _call(lambda_context, 'POST', '/workflows', body={'definition': definition})
        assert status == 201, body
        yield client, body['workflow']['workflow_id']


def _body(workflow_id: str, **change: Any) -> dict[str, Any]:
    return {'workflow_id': workflow_id, 'connection': 'conn-1', 'commit': COMMIT, 'language': 'python',
            'goal': 'Fix the paging bugs', **change}


def _sent(client: LambdaClient) -> dict[str, Any]:
    (request,) = client.requests
    assert (request['FunctionName'], request['InvocationType']) == (START_FUNCTION, 'RequestResponse')
    return json.loads(request['Payload'])


def test_an_admin_starts_a_saved_flow_with_its_stored_budget_as_themselves(lambda_context: Any,
                                                                            start: tuple[Start, str]) -> None:
    client, workflow_id = start
    status, body = _call(lambda_context, 'POST', PATH, body=_body(workflow_id, commit=COMMIT.upper(),
                                                                  goal='  Fix the\n paging   bugs '))
    # 202: the run is written; its coordinator's launch is under way (the start function hands it on).
    assert status == 202, body
    sent = _sent(client)
    assert ULID.fullmatch(sent['run_id'])
    # The deployment's caps when it sets none (50 USD, 10 million tokens); the repo is the connection's id until a
    # connection's record can be read.
    assert sent == {'action': 'start_run', 'run_id': sent['run_id'], 'max_tasks': agents_handler.RUN_TASK_CAP,
                    'flow': workflow_id, 'budget_usd': 49.99, 'connection': 'conn-1', 'commit': COMMIT,
                    'language': 'python', 'goal': 'Fix the paging bugs', 'actor': 'admin-sub', 'repo': 'conn-1',
                    'max_cost_usd': 50.0, 'max_tokens': 10_000_000}
    assert body == {'run': {'run_id': sent['run_id'], 'status': 'active', 'workflow_id': workflow_id,
                            'started_by': 'admin-sub'}}


@pytest.mark.parametrize(('env', 'caps'), [
    ({'ENGINEERING_RUN_CAP_USD': '12.5', 'ENGINEERING_RUN_TOKEN_CAP': '2000000'}, (12.5, 2_000_000)),
    # A cap that is not a positive number is the deployment's fault: the default holds, never no cap.
    ({'ENGINEERING_RUN_CAP_USD': '-1', 'ENGINEERING_RUN_TOKEN_CAP': '1.5'}, (50.0, 10_000_000)),
    ({'ENGINEERING_RUN_CAP_USD': 'nan', 'ENGINEERING_RUN_TOKEN_CAP': '0'}, (50.0, 10_000_000)),
    ({'ENGINEERING_RUN_CAP_USD': 'inf', 'ENGINEERING_RUN_TOKEN_CAP': 'lots'}, (50.0, 10_000_000)),
])
def test_every_run_gets_the_deployments_caps(lambda_context: Any, start: tuple[Start, str],
                                             monkeypatch: pytest.MonkeyPatch, env: dict[str, str],
                                             caps: tuple[float, int]) -> None:
    client, workflow_id = start
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert _call(lambda_context, 'POST', PATH, body=_body(workflow_id))[0] == 202
    sent = _sent(client)
    assert (sent['max_cost_usd'], sent['max_tokens']) == caps


def test_each_start_mints_its_own_run_and_a_flow_without_a_budget_sends_none(lambda_context: Any,
                                                                              start: tuple[Start, str]) -> None:
    client, _ = start
    status, body = _call(lambda_context, 'POST', '/workflows', body={'definition': bug_fix()})
    assert status == 201
    unbudgeted = body['workflow']['workflow_id']
    for _ in range(2):
        assert _call(lambda_context, 'POST', PATH, body=_body(unbudgeted))[0] == 202
    first, second = (json.loads(request['Payload']) for request in client.requests)
    assert (first['run_id'] != second['run_id'], 'budget_usd' in first) == (True, False)


def test_a_goal_shaped_like_a_credential_is_redacted_before_it_is_sent(lambda_context: Any,
                                                                       start: tuple[Start, str]) -> None:
    client, workflow_id = start
    token = 'ghp_' + 'x' * 36
    assert _call(lambda_context, 'POST', PATH, body=_body(workflow_id, goal=f'Use {token} to fix it'))[0] == 202
    assert _sent(client)['goal'] == 'Use <redacted> to fix it'


@pytest.mark.parametrize('change', [
    {'budget_usd': 1_000_000},             # the budget is the stored flow's, never the request's
    {'max_tasks': 10_000},
    {'actor': 'someone-else'},
    {'commit': COMMIT[:39]},
    {'commit': COMMIT + 'a' * 24},         # a 64-character object id: not a 40-character commit
    {'commit': 'g' * 40},
    {'language': 'cobol'},
    {'connection': 'conn/1'},
    {'connection': 'c' * 64},
    {'connection': ''},
    {'goal': '   '},
    {'goal': 'x' * 501},
    {'goal': 7},
    {'language': None},
], ids=lambda change: next(iter(change)))
def test_a_field_off_its_rule_is_400_and_nothing_is_started(lambda_context: Any, start: tuple[Start, str],
                                                            change: dict[str, Any]) -> None:
    client, workflow_id = start
    status, _ = _call(lambda_context, 'POST', PATH, body=_body(workflow_id, **change))
    assert (status, client.requests) == (400, [])


def test_a_missing_field_is_400(lambda_context: Any, start: tuple[Start, str]) -> None:
    client, workflow_id = start
    body = _body(workflow_id)
    del body['goal']
    assert (_call(lambda_context, 'POST', PATH, body=body)[0], client.requests) == (400, [])


@pytest.mark.parametrize('workflow_id', ['wf_default', 'wf_000000000000', 'not an id'])
def test_only_a_saved_engineering_flow_starts(lambda_context: Any, start: tuple[Start, str], workflow_id: str) -> None:
    client, _ = start
    status, body = _call(lambda_context, 'POST', PATH, body=_body(workflow_id))
    assert (status, client.requests) == (400, [])
    if workflow_id == 'wf_default':   # (an agents workflow, which agents run)
        assert 'engineering flow' in body['error']


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_only_an_admin_acting_for_themselves_starts_a_run(lambda_context: Any, start: tuple[Start, str],
                                                          claims: dict[str, str]) -> None:
    client, workflow_id = start
    assert _call(lambda_context, 'POST', PATH, body=_body(workflow_id), claims=claims)[0] == 403
    assert client.requests == []


@pytest.mark.parametrize('missing', ['ENGINEERING_AGENTS', 'ENGINEERING_TABLE'])
def test_the_start_is_404_while_the_module_is_off(lambda_context: Any, start: tuple[Start, str],
                                                  monkeypatch: pytest.MonkeyPatch, missing: str) -> None:
    client, workflow_id = start
    monkeypatch.delenv(missing)
    for claims in (ADMIN, USER):   # (the 404 comes first: a non-admin learns nothing either)
        assert _call(lambda_context, 'POST', PATH, body=_body(workflow_id), claims=claims)[0] == 404
    assert client.requests == []


def test_a_deployment_that_names_no_start_function_is_503(lambda_context: Any, start: tuple[Start, str],
                                                          monkeypatch: pytest.MonkeyPatch) -> None:
    _, workflow_id = start
    monkeypatch.delenv('ENGINEERING_START_FUNCTION')
    assert _call(lambda_context, 'POST', PATH, body=_body(workflow_id))[0] == 503


@pytest.mark.parametrize(('error_type', 'message', 'answered'), [
    # Refusals a person acts on: 409.
    ('RuntimeRefused', "no rust image in this deployment: start the run in one of ['python']", 409),
    ('RuntimeRefused', ('the flow wf_1 has spent its monthly budget for 2026-11 ($50.00 of $49.99): raise its budget, '
                        'or turn the hard cap off, to start a run of it'), 409),
    # Known to have written nothing: 503, start it again.
    ('StartReadFailed', "the hard cap's setting could not be read: start the run again", 503),
    ('StartNotWritten', 'the run could not be started: start it again', 503),
])
def test_the_runtimes_refusals_are_409_and_faults_that_wrote_nothing_503_in_its_own_words(
        lambda_context: Any, start: tuple[Start, str], error_type: str, message: str, answered: int) -> None:
    client, workflow_id = start
    client.payload, client.function_error = {'errorType': error_type, 'errorMessage': message}, 'Unhandled'
    status, body = _call(lambda_context, 'POST', PATH, body=_body(workflow_id))
    assert (status, body['error'], 'run_id' in body) == (answered, message, False)


class _FailsNamingTheRun(LambdaClient):
    """The start function failing with ``error_type``, its message naming the run it was asked for (``{run}``)."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__({}, 'Unhandled')
        self.error_type, self.message = error_type, message

    def invoke(self, **request: Any) -> dict[str, Any]:
        run_id = json.loads(request['Payload'])['run_id']
        self.payload = {'errorType': self.error_type, 'errorMessage': self.message.format(run=run_id)}
        return super().invoke(**request)


def _may_have_started(body: dict[str, Any], run_id: str) -> bool:
    """A 503 that names the run, beside its message and in it, and never says to start it again."""
    return body.get('run_id') == run_id and run_id in body['error'] and 'start it again' not in body['error'] \
        and 'start the run again' not in body['error']


@pytest.mark.parametrize(('error_type', 'message'), [
    # Written, then failed (a failure after the write, a launch under way included): its words, naming the run.
    ('StartFailed', ('run {run} was started, but its coordinator could not be launched: open its run monitor and '
                     'resume it')),
    # Failed, and whether it was written could not be read back.
    ('StartUncertain', 'run {run} may have been started: open the run monitor before you start another'),
    # A failure of the function's own kind (a timeout, a crash) says nothing of the write.
    ('Sandbox.Timedout', ''),
    ('ClientError', 'table down'),
])
def test_a_start_that_wrote_or_may_have_written_its_run_is_503_naming_it(
        lambda_context: Any, start: tuple[Start, str], monkeypatch: pytest.MonkeyPatch, error_type: str,
        message: str) -> None:
    _, workflow_id = start
    failing = _FailsNamingTheRun(error_type, message)
    monkeypatch.setattr(agents_handler, '_start_client', lambda: failing)
    status, body = _call(lambda_context, 'POST', PATH, body=_body(workflow_id))
    assert (status, _may_have_started(body, _sent(failing)['run_id'])) == (503, True)


class _Unreachable:
    def __init__(self, error: Exception) -> None:
        self.error = error

    def invoke(self, **_request: Any) -> dict[str, Any]:
        raise self.error


@pytest.mark.parametrize('error', [
    ClientError({'Error': {'Code': 'TooManyRequestsException', 'Message': 'slow down'}}, 'Invoke'),
    EndpointConnectionError(endpoint_url='https://lambda.example'),
    ConnectTimeoutError(endpoint_url='https://lambda.example'),
], ids=['refused by the service', 'never connected', 'connect timeout'])
def test_a_start_function_never_reached_is_503_start_it_again(lambda_context: Any, start: tuple[Start, str],
                                                               monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    _, workflow_id = start
    monkeypatch.setattr(agents_handler, '_start_client', lambda: _Unreachable(error))
    status, body = _call(lambda_context, 'POST', PATH, body=_body(workflow_id))
    assert (status, 'start the run again' in body['error'], 'run_id' in body) == (503, True, False)


class _Dropped(_Unreachable):
    """A call that reached the function and then lost its answer: the request's run id is kept for the test."""

    def __init__(self, error: Exception) -> None:
        super().__init__(error)
        self.run_id = ''

    def invoke(self, **request: Any) -> dict[str, Any]:
        self.run_id = json.loads(request['Payload'])['run_id']
        raise self.error


@pytest.mark.parametrize('error', [
    ReadTimeoutError(endpoint_url='https://lambda.example'),
    ConnectionClosedError(endpoint_url='https://lambda.example'),
], ids=['read timeout', 'dropped connection'])
def test_a_start_whose_answer_is_lost_is_503_naming_the_run(lambda_context: Any, start: tuple[Start, str],
                                                            monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    _, workflow_id = start
    dropped = _Dropped(error)
    monkeypatch.setattr(agents_handler, '_start_client', lambda: dropped)
    status, body = _call(lambda_context, 'POST', PATH, body=_body(workflow_id))
    assert (status, _may_have_started(body, dropped.run_id)) == (503, True)


class _Unreadable:
    """An invoke that went through, whose answer cannot be read (``read`` fails) or is not a JSON object."""

    def __init__(self, payload: bytes | None, function_error: str = '') -> None:
        self.payload, self.function_error, self.run_id = payload, function_error, ''

    def read(self) -> bytes:
        if self.payload is None:
            raise ReadTimeoutError(endpoint_url='https://lambda.example')
        return self.payload

    def invoke(self, **request: Any) -> dict[str, Any]:
        self.run_id = json.loads(request['Payload'])['run_id']
        answer: dict[str, Any] = {'StatusCode': 200, 'Payload': self}
        if self.function_error:
            answer['FunctionError'] = self.function_error
        return answer


@pytest.mark.parametrize(('payload', 'function_error'), [
    (None, ''), (b'<html>not json</html>', ''), (b'[1, 2]', ''), (b'"active"', ''), (b'not json', 'Unhandled'),
], ids=['read fails', 'not json', 'a list', 'a string', 'a failure whose answer is not json'])
def test_an_answer_that_cannot_be_read_is_503_naming_the_run(lambda_context: Any, start: tuple[Start, str],
                                                             monkeypatch: pytest.MonkeyPatch, payload: bytes | None,
                                                             function_error: str) -> None:
    _, workflow_id = start
    unreadable = _Unreadable(payload, function_error)
    monkeypatch.setattr(agents_handler, '_start_client', lambda: unreadable)
    status, body = _call(lambda_context, 'POST', PATH, body=_body(workflow_id))
    assert (status, _may_have_started(body, unreadable.run_id)) == (503, True)


def test_an_answer_for_another_run_is_503_naming_the_run(lambda_context: Any, start: tuple[Start, str],
                                                         monkeypatch: pytest.MonkeyPatch) -> None:
    _, workflow_id = start
    other = LambdaClient({'run_id': 'X', 'status': 'active'})
    monkeypatch.setattr(agents_handler, '_start_client', lambda: other)
    status, body = _call(lambda_context, 'POST', PATH, body=_body(workflow_id))
    run_id = json.loads(other.requests[0]['Payload'])['run_id']
    assert (status, _may_have_started(body, run_id)) == (503, True)


def test_the_start_client_waits_under_api_gateways_limit_and_never_retries() -> None:
    config = agents_handler._start_client().meta.config
    assert (config.read_timeout, config.retries['total_max_attempts']) == (
        agents_handler.START_READ_TIMEOUT_SECONDS, 1)
    assert agents_handler.START_READ_TIMEOUT_SECONDS < 29
