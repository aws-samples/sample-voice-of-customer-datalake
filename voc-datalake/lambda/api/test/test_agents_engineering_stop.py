"""The Agents API's Stop of a whole engineering run (``POST /agents/engineering/<run_id>/stop``, 7.50.03).

An administrator acting for themselves stops the run through voc-engineering-start's ``stop_run`` (the one function
this role invokes for a run's controls), which needs neither the runtime nor the bus here: a deployment whose monitor
cannot send signals (``actions_available: false``, every deployment until the stack wires them) still stops its runs.
Once the run has ended, its engineering agent's run ends with it at once, its lock released. 403 for anyone else,
404 while the module is off or for an unknown run, 409 for a run that has ended, 503 when the start function cannot be
reached.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

import pytest
from agents_handler_fixtures import USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from agents_handler_fixtures import create as _create

import agents_handler
from engineering.board.test.table import set_status
from engineering.test.run_fixture import BUCKET, RUN, TABLE, LambdaClient, engineering_run
from shared import agents_store as store

PATH = f'/agents/engineering/{RUN}/stop'
START_FUNCTION = 'voc-engineering-start'
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}
STOPPED = {'run_id': RUN, 'status': 'stopped', 'mode': 'stop', 'tasks_closed': ['coordinate'], 'holds_released': [],
           'saving': [], 'already': False, 'fell_back': False, 'agents': {}}


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Any, Any]]:
    """The agents tables and the engineering run, at a person's decision point (as the stuck run of 7.50.03)."""
    with _api() as env:
        engineering = engineering_run()
        set_status(engineering.client, 'needs_human')
        monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
        monkeypatch.setenv('ENGINEERING_TABLE', TABLE)
        monkeypatch.setenv('ENGINEERING_WORKSPACE_BUCKET', BUCKET)
        monkeypatch.setenv('ENGINEERING_START_FUNCTION', START_FUNCTION)
        with patch('shared.aws.get_dynamodb_client', return_value=engineering.client), \
                patch('shared.aws.get_s3_client', return_value=engineering.s3):
            yield env, engineering


def _start(monkeypatch: pytest.MonkeyPatch, payload: Any, function_error: str = '') -> LambdaClient:
    client = LambdaClient(payload, function_error)
    monkeypatch.setattr(agents_handler, '_start_client', lambda: client)
    return client


def _agent_run(env: Any, engineering: Any, lambda_context: Any) -> tuple[str, str]:
    """An agent whose run is this engineering run's (its lock held), and the run's start row naming it (``via``)."""
    agent = _create(lambda_context)
    run = store.start_run(env.agents, agent, store.RunStart(
        trigger='manual', requested_by='a', workflow_revision=1,
        run_fields={'kind': 'engineering', 'engineering_run_id': RUN}), now=datetime(2026, 11, 17, 4, 21, tzinfo=UTC))
    assert run is not None
    store.mark_engineering_running(env.agents, agent['agent_id'], run['run_id'])
    engineering.client.put_item(TableName=TABLE, Item={
        'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': 'RUNLOG#2026-11-17T04:21:45Z#active#ab12cd34'},
        'kind': {'S': 'run_status'}, 'status': {'S': 'active'}, 'actor': {'S': 'admin-sub'},
        'via': {'M': {'agent_id': {'S': agent['agent_id']}, 'agent_run_id': {'S': run['run_id']},
                      'trigger': {'S': 'manual'}}}})
    return agent['agent_id'], run['run_id']


def test_an_admin_stops_a_run_waiting_for_a_person_through_the_start_function(
        lambda_context: Any, run: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    env, engineering = run
    agent_id, agent_run_id = _agent_run(env, engineering, lambda_context)
    client = _start(monkeypatch, STOPPED)
    status, body = _call(lambda_context, 'POST', PATH, body={})
    assert (status, body['stop']['status'], body['stop']['tasks_closed']) == (200, 'stopped', ['coordinate'])
    (request,) = client.requests
    assert (request['FunctionName'], json.loads(request['Payload'])) == (
        START_FUNCTION, {'action': 'stop_run', 'run_id': RUN, 'mode': 'stop', 'actor': 'admin-sub'})
    # Its engineering agent's run ends with it, cancelled, and its lock is released: the agent may run again now.
    assert body['stop']['agent_run'] == {'agent_id': agent_id, 'run_id': agent_run_id, 'ended': True}
    ended = store.get_run(env.agents, agent_id, agent_run_id)
    assert ended is not None
    assert ended['status'] == 'cancelled'
    assert store.get_agent(env.agents, agent_id).get('active_run_id') is None


def test_a_stop_now_is_confirmed_and_a_stop_still_saving_ends_no_agent_run(
        lambda_context: Any, run: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    env, engineering = run
    agent_id, agent_run_id = _agent_run(env, engineering, lambda_context)
    assert _call(lambda_context, 'POST', PATH, body={'now': True})[0] == 400   # (no confirm)
    client = _start(monkeypatch, {**STOPPED, 'status': 'stopping', 'saving': ['fixer-1'], 'tasks_closed': []})
    status, body = _call(lambda_context, 'POST', PATH, body={'now': True, 'confirm': True})
    assert (status, body['stop']['status'], body['stop']['agent_run']) == (200, 'stopping', None)
    assert json.loads(client.requests[0]['Payload'])['mode'] == 'stop_now'
    still = store.get_run(env.agents, agent_id, agent_run_id)
    assert still is not None
    assert still['status'] == 'running'   # (its engineering run has not ended yet: the heartbeat ends it after)


def test_the_overview_offers_the_stop_where_signals_cannot_reach_the_run(lambda_context: Any,
                                                                         run: tuple[Any, Any]) -> None:
    assert run is not None
    status, view = _call(lambda_context, 'GET', f'/agents/engineering/{RUN}')
    assert (status, view['actions_available'], view['stop_available'], view['run']['waiting_at']) == (
        200, False, True, '')


def test_a_whole_run_shut_down_signal_is_the_stop_and_ends_the_agents_run_too(
        lambda_context: Any, run: tuple[Any, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    env, engineering = run
    agent_id, agent_run_id = _agent_run(env, engineering, lambda_context)
    _start(monkeypatch, STOPPED)
    status, body = _call(lambda_context, 'POST', f'/agents/engineering/{RUN}/signals', body={'signal': 'shutdown'})
    assert (status, body['signal']['run']['status']) == (200, 'stopped')
    ended = store.get_run(env.agents, agent_id, agent_run_id)
    assert ended is not None
    assert ended['status'] == 'cancelled'


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN])
def test_only_an_admin_acting_for_themselves_stops_a_run(lambda_context: Any, run: tuple[Any, Any],
                                                         monkeypatch: pytest.MonkeyPatch, claims: dict[str, str]) -> None:
    assert run is not None
    client = _start(monkeypatch, STOPPED)
    assert _call(lambda_context, 'POST', PATH, body={}, claims=claims)[0] == 403
    assert client.requests == []


def test_an_ended_or_unknown_run_takes_no_stop(lambda_context: Any, run: tuple[Any, Any],
                                               monkeypatch: pytest.MonkeyPatch) -> None:
    _, engineering = run
    client = _start(monkeypatch, STOPPED)
    assert _call(lambda_context, 'POST', '/agents/engineering/01JD0000000000000000000009/stop', body={})[0] == 404
    engineering.client.update_item(TableName=TABLE, Key={'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': 'META'}},
                                   UpdateExpression='SET ended_at = :e',
                                   ExpressionAttributeValues={':e': {'S': '2026-11-17T05:00:00Z'}})
    assert _call(lambda_context, 'POST', PATH, body={})[0] == 409
    assert client.requests == []


@pytest.mark.parametrize(('payload', 'function_error', 'answer'), [
    ({'errorType': 'RuntimeRefused', 'errorMessage': 'no run R'}, 'Unhandled', 409),
    ({'errorType': 'ClientError'}, 'Unhandled', 503),
])
def test_the_start_function_refusing_or_failing_says_so(lambda_context: Any, run: tuple[Any, Any],
                                                        monkeypatch: pytest.MonkeyPatch, payload: Any,
                                                        function_error: str, answer: int) -> None:
    assert run is not None
    _start(monkeypatch, payload, function_error)
    assert _call(lambda_context, 'POST', PATH, body={})[0] == answer


def test_without_the_start_function_the_stop_is_unavailable(lambda_context: Any, run: tuple[Any, Any],
                                                            monkeypatch: pytest.MonkeyPatch) -> None:
    assert run is not None
    monkeypatch.delenv('ENGINEERING_START_FUNCTION')
    assert _call(lambda_context, 'POST', PATH, body={})[0] == 503
    assert _call(lambda_context, 'GET', f'/agents/engineering/{RUN}')[1]['stop_available'] is False
