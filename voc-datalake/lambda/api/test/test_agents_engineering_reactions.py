"""The Agents API's hand trigger of an ended run's reactions read (``POST /agents/engineering/<run_id>/reactions``,
7.10.00), and the run monitor's latest reactions.

An administrator acting for themselves asks; the route checks the run has ended, then asks voc-engineering-start's
``ask_reactions`` (the one function this role invokes for a run), which claims the hour and hands the read on: 202.
403 for anyone else (a delegated credential an administrator minted included), 404 while the module is off or for an
unknown run, 409 while the run has not ended, 429 when the hour's ask is taken.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from agents_handler_fixtures import USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call

import agents_handler
from engineering.board.test.table import set_status
from engineering.learning.reactions import ReactionsStore, checked
from engineering.learning.test.test_reactions import found
from engineering.test.run_fixture import BUCKET, RUN, TABLE, EngineeringRun, LambdaClient, engineering_run

PATH = f'/agents/engineering/{RUN}/reactions'
START_FUNCTION = 'voc-engineering-start'
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch) -> Iterator[EngineeringRun]:
    with _api():
        engineering = engineering_run()
        monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
        monkeypatch.setenv('ENGINEERING_TABLE', TABLE)
        monkeypatch.setenv('ENGINEERING_WORKSPACE_BUCKET', BUCKET)
        monkeypatch.setenv('ENGINEERING_START_FUNCTION', START_FUNCTION)
        with patch('shared.aws.get_dynamodb_client', return_value=engineering.client), \
                patch('shared.aws.get_s3_client', return_value=engineering.s3):
            yield engineering


def _end(engineering: EngineeringRun, status: str = 'done') -> None:
    set_status(engineering.client, status)


def _start(monkeypatch: pytest.MonkeyPatch, payload: Any, function_error: str = '') -> LambdaClient:
    client = LambdaClient(payload, function_error)
    monkeypatch.setattr(agents_handler, '_start_client', lambda: client)
    return client


def test_an_admin_asks_for_an_ended_runs_reactions_through_the_start_function(
        lambda_context: Any, run: EngineeringRun, monkeypatch: pytest.MonkeyPatch) -> None:
    _end(run)
    client = _start(monkeypatch, {'run_id': RUN, 'status': 'asked'})
    assert _call(lambda_context, 'POST', PATH, body={}) == (202, {'reactions': {'status': 'asked'}})
    (request,) = client.requests
    assert (request['FunctionName'], request['InvocationType']) == (START_FUNCTION, 'RequestResponse')
    assert json.loads(request['Payload']) == {'action': 'ask_reactions', 'run_id': RUN, 'actor': 'admin-sub'}


def test_429_once_this_hours_ask_is_taken(lambda_context: Any, run: EngineeringRun,
                                         monkeypatch: pytest.MonkeyPatch) -> None:
    _end(run, 'failed')
    _start(monkeypatch, {'run_id': RUN, 'status': 'too_soon', 'retry_after': 1200})
    status, body = _call(lambda_context, 'POST', PATH, body={})
    assert (status, body['retry_after']) == (429, 1200)
    assert 'this hour already' in body['error']


@pytest.mark.parametrize('status', ['active', 'needs_human'])
def test_409_while_the_run_has_not_ended_and_nothing_is_asked(lambda_context: Any, run: EngineeringRun,
                                                              monkeypatch: pytest.MonkeyPatch, status: str) -> None:
    _end(run, status)
    client = _start(monkeypatch, {'status': 'asked'})
    assert _call(lambda_context, 'POST', PATH, body={})[0] == 409
    assert client.requests == []


@pytest.mark.usefixtures('run')
@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_403_for_anyone_but_an_administrator_acting_for_themselves(lambda_context: Any, claims: dict[str, Any],
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    client = _start(monkeypatch, {'status': 'asked'})
    assert _call(lambda_context, 'POST', PATH, body={}, claims=claims)[0] == 403
    assert client.requests == []


def test_404_while_the_module_is_off_or_for_an_unknown_run(lambda_context: Any, run: EngineeringRun,
                                                         monkeypatch: pytest.MonkeyPatch) -> None:
    _end(run)
    assert _call(lambda_context, 'POST', '/agents/engineering/01JD0000000000000000000009/reactions', body={})[0] == 404
    monkeypatch.delenv('ENGINEERING_AGENTS')
    assert _call(lambda_context, 'POST', PATH, body={})[0] == 404


@pytest.mark.parametrize(('payload', 'error', 'status'), [
    ({'errorType': 'RuntimeRefused', 'errorMessage': "the run has not ended"}, 'Unhandled', 409),
    ({'errorType': 'KeyError', 'errorMessage': 'ENGINEERING_TABLE'}, 'Unhandled', 503),
    ({'status': 'surprising'}, '', 503),
])
def test_the_start_functions_refusal_is_409_and_any_other_failure_503(
        lambda_context: Any, run: EngineeringRun, monkeypatch: pytest.MonkeyPatch, payload: dict[str, Any],
        error: str, status: int) -> None:
    _end(run)
    _start(monkeypatch, payload, error)
    assert _call(lambda_context, 'POST', PATH, body={})[0] == status


def test_a_start_function_that_cannot_be_reached_is_503(lambda_context: Any, run: EngineeringRun,
                                                       monkeypatch: pytest.MonkeyPatch) -> None:
    from botocore.exceptions import ClientError

    class Unreachable:
        def invoke(self, **_: Any) -> Any:
            raise ClientError({'Error': {'Code': 'TooManyRequestsException', 'Message': 'slow'}}, 'Invoke')

    _end(run)
    monkeypatch.setattr(agents_handler, '_start_client', Unreachable)
    status, body = _call(lambda_context, 'POST', PATH, body={})
    assert (status, 'ask again' in json.dumps(body)) == (503, True)


def test_a_body_is_refused_and_an_unnamed_start_function_is_503(lambda_context: Any, run: EngineeringRun,
                                                                monkeypatch: pytest.MonkeyPatch) -> None:
    _end(run)
    _start(monkeypatch, {'status': 'asked'})
    assert _call(lambda_context, 'POST', PATH, body={'now': True})[0] == 400
    monkeypatch.delenv('ENGINEERING_START_FUNCTION')
    assert _call(lambda_context, 'POST', PATH, body={})[0] == 503


def test_the_run_monitor_shows_the_latest_reactions(lambda_context: Any, run: EngineeringRun) -> None:
    assert _call(lambda_context, 'GET', f'/agents/engineering/{RUN}')[1]['reactions'] is None
    kept = checked(found())
    assert kept is not None
    ReactionsStore(run.client, TABLE).record('default', RUN, kept, 'schedule')
    shown = _call(lambda_context, 'GET', f'/agents/engineering/{RUN}')[1]['reactions']
    assert (shown['asked_by'], shown['state'], shown['reverted']) == ('schedule', 'merged', True)
    assert shown['counts']['changes_requested'] == 2
