"""The Agents API's engineering routes: an engineering run's monitor, board, conversation and reports, and the
monitor's actions (signals, a person's answers).

On only with the engineering agents' table and bucket in the environment (404 otherwise); read by administrators only,
acting for themselves, until a connection can be shared: a plain user and a delegated (MCP) credential, even one an
administrator minted, get 403; an unknown run and a malformed id answer 404.
"""
from __future__ import annotations

import json
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call

from engineering.runtime.runs import RunStore
from engineering.runtime.sessions import SessionStore
from engineering.test.run_fixture import BUCKET, FIXER, RUN, TABLE, EngineeringRun, LambdaClient, engineering_run

BASE = f'/agents/engineering/{RUN}'


@pytest.fixture
def run(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Any, EngineeringRun]]:
    with _api() as env:
        engineering = engineering_run()
        monkeypatch.setenv('ENGINEERING_AGENTS', 'on')
        monkeypatch.setenv('ENGINEERING_TABLE', TABLE)
        monkeypatch.setenv('ENGINEERING_WORKSPACE_BUCKET', BUCKET)
        with patch('shared.aws.get_dynamodb_client', return_value=engineering.client), \
                patch('shared.aws.get_s3_client', return_value=engineering.s3):
            yield env, engineering


def test_the_board_conversation_and_reports_read_through_the_routes(lambda_context: Any,
                                                                    run: tuple[Any, EngineeringRun]) -> None:
    _, engineering = run
    status, board = _call(lambda_context, 'GET', f'{BASE}/board')
    assert status == 200
    assert board['tasks'][0]['task_id'] == engineering.task_id
    status, page = _call(lambda_context, 'GET', f'{BASE}/conversation', query={'after': '1', 'limit': '1'})
    assert (status, [item['seq'] for item in page['items']], page['next_after']) == (200, [1, 2], 2)
    status, reports = _call(lambda_context, 'GET', f'{BASE}/reports')
    assert (status, reports['items'][0]['latest_version']) == (200, 1)
    status, report = _call(lambda_context, 'GET', f'{BASE}/reports/goal/{RUN}')
    assert (status, report['report']['version'], report['markdown']) == (200, 1, '## Goal report (v1)\n')
    assert _call(lambda_context, 'GET', f'{BASE}/reports/goal/{RUN}', query={'version': '1'})[0] == 200
    assert _call(lambda_context, 'GET', f'{BASE}/reports/goal/{RUN}', query={'version': '2'})[0] == 404


#: An MCP credential an administrator minted: delegated, so never an administrator here.
DELEGATED_ADMIN = {'sub': 'mcp:tok_1', 'cognito:username': 'alice', 'voc:acting_subject': 'admin-sub',
                   'cognito:groups': 'admins'}
#: A well-formed run id no run has.
UNKNOWN = '01JD0000000000000000000009'
PATHS = (f'{BASE}/board', f'{BASE}/conversation', f'{BASE}/reports', f'{BASE}/reports/goal/{RUN}')


@pytest.mark.usefixtures('run')
@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_every_read_is_403_for_anyone_but_an_administrator(lambda_context: Any, claims: dict[str, Any]) -> None:
    answers = [_call(lambda_context, 'GET', path, claims=claims) for path in (BASE, *PATHS)]
    assert [status for status, _ in answers] == [403] * (len(PATHS) + 1)
    # Even for a run that does not exist: a non-admin learns nothing about which runs exist.
    assert _call(lambda_context, 'GET', '/agents/engineering/no-run/board', claims=claims)[0] == 403


@pytest.mark.usefixtures('run')
def test_an_unknown_run_is_404_for_an_administrator(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', '/agents/engineering/01JD0000000000000000000009/board')[0] == 404
    assert _call(lambda_context, 'GET', '/agents/engineering/no-run/conversation')[0] == 404
    assert _call(lambda_context, 'GET', '/agents/engineering/no-run/reports')[0] == 404


@pytest.mark.parametrize('path', [f'{BASE}/reports/weekly/{RUN}', f'{BASE}/reports/pr/42',
                                  '/agents/engineering/run%20x/board'])
@pytest.mark.usefixtures('run')
def test_a_report_or_run_that_is_not_there_is_404(lambda_context: Any, path: str) -> None:
    assert _call(lambda_context, 'GET', path)[0] == 404


@pytest.mark.usefixtures('run')
def test_numbers_out_of_bounds_are_clamped_like_every_agents_route(lambda_context: Any) -> None:
    status, page = _call(lambda_context, 'GET', f'{BASE}/conversation', query={'limit': '9999', 'after': '-4'})
    assert (status, [item['seq'] for item in page['items']]) == (200, [1, 2, 3])


@pytest.mark.usefixtures('run')
@pytest.mark.parametrize('version', ['abc', '0', '10000', '-1', '²'])
def test_a_version_off_its_range_is_400(lambda_context: Any, version: str) -> None:
    assert _call(lambda_context, 'GET', f'{BASE}/reports/goal/{RUN}', query={'version': version})[0] == 400


@pytest.mark.usefixtures('run')
@pytest.mark.parametrize('missing', ['ENGINEERING_AGENTS', 'ENGINEERING_TABLE', 'ENGINEERING_WORKSPACE_BUCKET'])
def test_every_route_is_404_while_the_engineering_agents_are_off(lambda_context: Any, monkeypatch: pytest.MonkeyPatch,
                                                                 missing: str) -> None:
    monkeypatch.delenv(missing)
    for path in (BASE, *PATHS):
        assert _call(lambda_context, 'GET', path)[0] == 404
        assert _call(lambda_context, 'GET', path, claims=USER)[0] == 404   # off: the module is not there for anyone
    for path in (f'{BASE}/signals', f'{BASE}/messages'):
        for claims in (ADMIN, USER):   # (the 404 comes first: a non-admin learns nothing either)
            assert _call(lambda_context, 'POST', path, body={'signal': 'save'}, claims=claims)[0] == 404


@pytest.mark.usefixtures('run')
def test_without_the_engineering_package_every_route_is_404_not_500(lambda_context: Any,
                                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    """A deployment with the module off ships no ``engineering`` package: nothing may import it before the 404."""
    monkeypatch.delenv('ENGINEERING_AGENTS')
    absent = dict.fromkeys(name for name in list(sys.modules) if name.split('.')[0] == 'engineering')
    with patch.dict(sys.modules, {**absent, 'engineering': None}):
        assert _call(lambda_context, 'GET', BASE)[0] == 404
        for path in (f'{BASE}/signals', f'{BASE}/messages'):
            assert _call(lambda_context, 'POST', path, body={'signal': 'save'})[0] == 404


class Bus:
    """EventBridge as the routes see it: records each entry; ``failed`` makes it refuse them."""

    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []
        self.failed = False

    def put_events(self, Entries: list[dict[str, Any]]) -> dict[str, Any]:  # (boto3's keyword)
        if self.failed:
            return {'FailedEntryCount': 1, 'Entries': [{'ErrorCode': 'InternalFailure'}]}
        self.entries.extend(Entries)
        return {'FailedEntryCount': 0, 'Entries': [{'EventId': 'e-1'}]}


@dataclass
class Actions:
    """What the actions reach: the bus and the supervisor's function (its answer)."""
    bus: Bus
    runtime: LambdaClient


@pytest.fixture
def actions(monkeypatch: pytest.MonkeyPatch, run: tuple[Any, EngineeringRun]) -> Iterator[Actions]:
    _, engineering = run
    # The supervisor's session row, in the run's partition, written while the run is active (as its start leaves it).
    engineering.client.update_item(
        TableName=TABLE, Key={'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': 'META'}},
        UpdateExpression='SET #status = :active', ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={':active': {'S': 'active'}})
    table = boto3.resource('dynamodb', region_name='us-east-1').Table(TABLE)
    SessionStore(table, RunStore(table)).create(FIXER)
    monkeypatch.setenv('ENGINEERING_BUS_NAME', 'voc-engineering')
    monkeypatch.setenv('ENGINEERING_RUNTIME_FUNCTION', 'voc-engineering-runtime')
    reached = Actions(Bus(), LambdaClient({'agents': {'fixer-1': 'pause_requested'}, 'applied': {'fixer-1': True}}))
    with patch('shared.aws.get_eventbridge_client', return_value=reached.bus), \
            patch('shared.aws.get_lambda_client', return_value=reached.runtime):
        yield reached


@pytest.mark.usefixtures('actions')
def test_the_run_monitor_reads_the_run_and_the_supervisors_sessions(lambda_context: Any) -> None:
    status, view = _call(lambda_context, 'GET', BASE)
    assert status == 200
    assert (view['run']['run_id'], [agent['agent'] for agent in view['agents']]) == (RUN, ['fixer-1'])
    assert view['actions_available'] is True
    assert _call(lambda_context, 'GET', '/agents/engineering/01JD0000000000000000000009')[0] == 404


@pytest.mark.usefixtures('actions')
@pytest.mark.parametrize('missing', ['ENGINEERING_RUNTIME_FUNCTION', 'ENGINEERING_BUS_NAME'])
def test_the_overview_says_the_actions_are_unavailable_until_the_runtime_and_the_bus_are_named(
        lambda_context: Any, monkeypatch: pytest.MonkeyPatch, missing: str) -> None:
    monkeypatch.delenv(missing)
    status, view = _call(lambda_context, 'GET', BASE)
    assert (status, view['actions_available']) == (200, False)


@pytest.mark.parametrize('path', [f'/agents/engineering/{UNKNOWN}/signals', f'/agents/engineering/{UNKNOWN}/messages'])
@pytest.mark.parametrize('body', [{}, {'signal': 'save'}, {'to': 'conductor', 'text': 'Hi'}])
def test_an_unknown_run_is_404_before_the_body_is_read(lambda_context: Any, actions: Actions, path: str,
                                                       body: dict[str, str]) -> None:
    assert _call(lambda_context, 'POST', path, body=body)[0] == 404
    assert (actions.bus.entries, actions.runtime.requests) == ([], [])


def test_an_admin_signals_the_agent_on_a_task_at_the_attempt_seen(lambda_context: Any,
                                                                  run: tuple[Any, EngineeringRun],
                                                                  actions: Actions) -> None:
    _, engineering = run
    status, body = _call(lambda_context, 'POST', f'{BASE}/signals',
                         body={'signal': 'pause', 'task_id': engineering.task_id, 'attempt': 1})
    assert (status, body['signal']['target'], body['signal']['agents']) == (
        200, {'kind': 'agent', 'id': 'fixer-1'}, {'fixer-1': 'pause_requested'})
    assert body['signal']['applied'] == {'fixer-1': True}
    (invoked,) = actions.runtime.requests
    assert json.loads(invoked['Payload']) == {'action': 'signal', 'run_id': RUN, 'signal': 'pause',
                                              'agent_id': 'fixer-1', 'attempt': 1}
    entry, _outcome = actions.bus.entries
    assert (entry['Source'], entry['DetailType']) == ('voc.engineering/api', 'signal.pause')
    assert 'by alice' in json.loads(entry['Detail'])['summary']
    stale = _call(lambda_context, 'POST', f'{BASE}/signals',
                  body={'signal': 'pause', 'task_id': engineering.task_id, 'attempt': 2})
    assert stale[0] == 409
    assert _call(lambda_context, 'POST', f'{BASE}/signals', body={'signal': 'stop_now'})[0] == 400


def test_the_supervisor_refusing_answers_409_with_its_reason(lambda_context: Any, actions: Actions) -> None:
    actions.runtime.payload = {'errorType': 'RuntimeRefused', 'errorMessage': 'run R has spent its budget'}
    actions.runtime.function_error = 'Unhandled'
    status, body = _call(lambda_context, 'POST', f'{BASE}/signals', body={'signal': 'resume'})
    assert (status, 'spent its budget' in json.dumps(body)) == (409, True)
    request, outcome = (json.loads(entry['Detail']) for entry in actions.bus.entries)   # (asked, and its answer)
    assert (request['type'], 'not applied: run R has spent its budget' in outcome['summary']) == (
        'signal.resume', True)


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN])
def test_only_an_admin_acting_for_themselves_signals_or_answers(lambda_context: Any, actions: Actions,
                                                                claims: dict[str, str]) -> None:
    assert _call(lambda_context, 'POST', f'{BASE}/signals', body={'signal': 'save'}, claims=claims)[0] == 403
    assert _call(lambda_context, 'POST', f'{BASE}/messages', body={'to': 'conductor', 'text': 'Hi'},
                 claims=claims)[0] == 403
    assert (actions.bus.entries, actions.runtime.requests) == ([], [])


def test_an_admin_answers_the_conductor_or_an_agent_of_the_run(lambda_context: Any, actions: Actions) -> None:
    status, body = _call(lambda_context, 'POST', f'{BASE}/messages', body={'to': 'conductor', 'text': 'Skip docs'})
    assert (status, actions.bus.entries[0]['DetailType']) == (200, 'msg.answer')
    assert body['message']['thread_id'].startswith('human-')
    assert _call(lambda_context, 'POST', f'{BASE}/messages',
                 body={'to': 'agent', 'agent': 'fixer-1', 'text': 'Yes'})[0] == 200
    assert _call(lambda_context, 'POST', f'{BASE}/messages',
                 body={'to': 'agent', 'agent': 'fixer-9', 'text': 'Hi'})[0] == 404


def test_a_bus_that_refuses_or_a_missing_runtime_answers_503(lambda_context: Any, monkeypatch: pytest.MonkeyPatch,
                                                             actions: Actions) -> None:
    actions.bus.failed = True
    assert _call(lambda_context, 'POST', f'{BASE}/messages', body={'to': 'conductor', 'text': 'Hi'})[0] == 503
    monkeypatch.delenv('ENGINEERING_RUNTIME_FUNCTION')
    assert _call(lambda_context, 'POST', f'{BASE}/signals', body={'signal': 'save'})[0] == 503
