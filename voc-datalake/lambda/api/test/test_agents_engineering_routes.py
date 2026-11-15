"""The Agents API's engineering routes: an engineering run's monitor, board, conversation and reports, and the
monitor's actions (signals, a person's answers).

On only with the engineering agents' table and bucket in the environment (404 otherwise); read by administrators only,
acting for themselves, until a connection can be shared: a plain user and a delegated (MCP) credential, even one an
administrator minted, get 403; an unknown run and a malformed id answer 404.
"""
from __future__ import annotations

import io
import json
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from agents_handler_fixtures import ADMIN, USER
from agents_handler_fixtures import api as _api
from agents_handler_fixtures import call as _call
from botocore.exceptions import ClientError

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
        self.unreachable = False   # (the call itself fails: a ClientError, not a refused entry)

    def put_events(self, Entries: list[dict[str, Any]]) -> dict[str, Any]:  # (boto3's keyword)
        if self.unreachable:
            raise ClientError({'Error': {'Code': 'ServiceUnavailable', 'Message': 'down'}}, 'PutEvents')
        if self.failed:
            return {'FailedEntryCount': 1, 'Entries': [{'ErrorCode': 'InternalFailure'}]}
        self.entries.extend(Entries)
        return {'FailedEntryCount': 0, 'Entries': [{'EventId': 'e-1'}]}


@dataclass
class Actions:
    """What the actions reach: the bus and the supervisor's function (its answer)."""
    bus: Bus
    runtime: LambdaClient


BOARD_FUNCTION = 'voc-engineering-board'


class Lambdas:
    """The Lambda client the routes get: the board function's direct invokes run the board's person path in process
    (on the same table, as its own role would); every other invoke is the supervisor's fake."""

    def __init__(self, runtime: LambdaClient, client: Any) -> None:
        self.runtime = runtime
        self.client = client
        self.board_requests: list[dict[str, Any]] = []

    def invoke(self, **request: Any) -> dict[str, Any]:
        if request['FunctionName'] != BOARD_FUNCTION:
            return self.runtime.invoke(**request)
        from engineering.board.api import person_request
        from engineering.board.store import BoardStore
        from engineering.bus.publish import new_event_id

        payload = json.loads(request['Payload'])
        self.board_requests.append(payload)
        answer = person_request(BoardStore(self.client, TABLE, new_id=new_event_id), payload['person'])
        return {'StatusCode': 200, 'Payload': io.BytesIO(json.dumps(answer).encode())}


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
    monkeypatch.setenv('ENGINEERING_BOARD_FUNCTION', BOARD_FUNCTION)
    reached = Actions(Bus(), LambdaClient({'agents': {'fixer-1': 'pause_requested'}, 'applied': {'fixer-1': True}}))
    with patch('shared.aws.get_eventbridge_client', return_value=reached.bus), \
            patch('shared.aws.get_lambda_client', return_value=Lambdas(reached.runtime, engineering.client)):
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
                                              'agent_id': 'fixer-1', 'attempt': 1, 'actor': 'admin-sub'}
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


# --- a person's board actions (engineering/board/api.py PersonBoard) ------------------------------------------------

def _board_task(engineering: EngineeringRun, task_id: str) -> dict[str, Any]:
    item = engineering.client.get_item(TableName=TABLE, Key={'pk': {'S': f'WS#default#RUN#{RUN}'},
                                                             'sk': {'S': f'TASK#{task_id}'}})['Item']
    return {key: next(iter(value.values())) for key, value in item.items()}


def test_an_admin_posts_a_task_published_as_themselves_from_the_api(lambda_context: Any, actions: Actions) -> None:
    status, body = _call(lambda_context, 'POST', f'{BASE}/board/tasks',
                         body={'role': 'hunter', 'title': 'Look at the export', 'spec': {'area': 'export'}})
    assert (status, body['task']['state'], body['duplicate']) == (200, 'open', False)
    (entry,) = actions.bus.entries
    detail = json.loads(entry['Detail'])
    assert (entry['Source'], entry['DetailType'], detail['from']) == (
        'voc.engineering/api', 'task.posted', {'kind': 'human', 'id': 'admin-sub'})
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks',
                 body={'role': 'coordinator', 'title': 'x', 'spec': {'a': 1}})[0] == 403


def test_an_admin_takes_moves_reprioritises_and_blocks_tasks(lambda_context: Any, run: tuple[Any, EngineeringRun],
                                                              actions: Actions) -> None:
    _, engineering = run
    task = engineering.task_id   # (claimed by fixer-1)
    status, body = _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/take', body={})
    assert (status, body['task']['lease']['agent']) == (200, 'human:admin-sub')
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/move', body={'to': 'needs_human'})[0] == 400
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/move', body={'to': 'in_progress'})[0] == 200
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/priority', body={'priority': 9})[0] == 200
    assert (_board_task(engineering, task)['state'], _board_task(engineering, task)['priority']) == ('in_progress', '9')
    status, body = _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/block', body={'reason': 'Wrong repo'})
    assert (status, body['task']['state']) == (200, 'needs_human')
    assert [entry['DetailType'] for entry in actions.bus.entries] == [
        'task.claimed', 'task.progress', 'task.progress', 'task.needs_human']
    assert {entry['Source'] for entry in actions.bus.entries} == {'voc.engineering/api'}
    # An ended task takes no more; a bad action and an unknown task say so.
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/priority', body={'priority': 1})[0] == 409
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/archive', body={})[0] == 400
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/task-9/take', body={})[0] == 404


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN])
def test_only_an_admin_acting_for_themselves_acts_on_the_board(lambda_context: Any, run: tuple[Any, EngineeringRun],
                                                                actions: Actions, claims: dict[str, str]) -> None:
    _, engineering = run
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks', claims=claims,
                 body={'role': 'hunter', 'title': 'x', 'spec': {'a': 1}})[0] == 403
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{engineering.task_id}/take', body={},
                 claims=claims)[0] == 403
    assert actions.bus.entries == []


def test_a_person_moves_only_a_task_they_took_and_a_lost_publish_is_retried(lambda_context: Any,
                                                                             run: tuple[Any, EngineeringRun],
                                                                             actions: Actions) -> None:
    _, engineering = run
    task = engineering.task_id
    status, body = _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/move', body={'to': 'in_progress'})
    assert (status, 'take it first' in json.dumps(body)) == (403, True)
    # "Needs a person" is a block's, which says why: never a bare move (a holder's or not).
    status, body = _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/move', body={'to': 'needs_human'})
    assert (status, 'by block, with a reason' in json.dumps(body)) == (400, True)
    actions.bus.failed = True
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/take', body={})[0] == 503
    assert _board_task(engineering, task)['lease_agent'] == 'human:admin-sub'   # (written before the publish)
    actions.bus.failed = False
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/take', body={})[0] == 200
    (entry,) = actions.bus.entries   # (the retry publishes the same change once)
    assert json.loads(entry['Detail'])['summary'].endswith('take by a person')
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/priority', body={})[0] == 400


@pytest.mark.parametrize(('action', 'body'),[('take', {}), ('block', {'reason': 'Wrong repo'})])
def test_another_persons_hold_is_ended_only_when_over_asks(lambda_context: Any, run: tuple[Any, EngineeringRun],
                                                           actions: Actions, action: str, body: dict[str, str]) -> None:
    _, engineering = run
    task = engineering.task_id
    other = {**ADMIN, 'sub': 'admin-2-sub', 'cognito:username': 'carol'}
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/take', body={}, claims=other)[0] == 200
    published = len(actions.bus.entries)
    path = f'{BASE}/board/tasks/{task}/{action}'
    assert _call(lambda_context, 'POST', path, body={**body, 'over': 'yes'})[0] == 400
    status, refused = _call(lambda_context, 'POST', path, body=body)
    assert (status, 'another person holds the task' in json.dumps(refused)) == (409, True)
    assert (len(actions.bus.entries), _board_task(engineering, task)['lease_agent']) == (published, 'human:admin-2-sub')
    assert _call(lambda_context, 'POST', path, body={**body, 'over': True})[0] == 200
    entry = actions.bus.entries[-1]
    assert (entry['Source'], json.loads(entry['Detail'])['from']) == (
        'voc.engineering/api', {'kind': 'human', 'id': 'admin-sub'})


def test_an_admin_gives_an_ai_assisted_run_its_go_once_without_the_bus(lambda_context: Any,
                                                                         run: tuple[Any, EngineeringRun],
                                                                         actions: Actions,
                                                                         monkeypatch: pytest.MonkeyPatch) -> None:
    _, engineering = run
    monkeypatch.delenv('ENGINEERING_BUS_NAME')   # (the row is the record: no event, so no bus needed)
    status, body = _call(lambda_context, 'POST', f'{BASE}/go', body={})
    assert (status, body['go']['by'], body['go']['created']) == (200, 'human:admin-sub', True)
    other = {**ADMIN, 'sub': 'admin-2-sub', 'cognito:username': 'carol'}
    status, again = _call(lambda_context, 'POST', f'{BASE}/go', body={}, claims=other)
    assert (status, again['go']['by'], again['go']['created']) == (200, 'human:admin-sub', False)
    row = engineering.client.get_item(TableName=TABLE, Key={'pk': {'S': f'WS#default#RUN#{RUN}'},
                                                            'sk': {'S': 'GO#person'}})['Item']
    assert row['by'] == {'S': 'human:admin-sub'}
    assert actions.bus.entries == []


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN])
def test_only_an_admin_acting_for_themselves_gives_a_go(lambda_context: Any, run: tuple[Any, EngineeringRun],
                                                         actions: Actions, claims: dict[str, str]) -> None:
    _, engineering = run
    assert _call(lambda_context, 'POST', f'{BASE}/go', body={}, claims=claims)[0] == 403
    assert 'Item' not in engineering.client.get_item(TableName=TABLE, Key={'pk': {'S': f'WS#default#RUN#{RUN}'},
                                                                           'sk': {'S': 'GO#person'}})
    assert actions.bus.entries == []


def test_an_ended_or_unknown_run_takes_no_go(lambda_context: Any, run: tuple[Any, EngineeringRun],
                                             actions: Actions) -> None:
    _, engineering = run
    assert _call(lambda_context, 'POST', f'/agents/engineering/{UNKNOWN}/go', body={})[0] == 404
    engineering.client.update_item(
        TableName=TABLE, Key={'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': 'META'}},
        UpdateExpression='SET ended_at = :at', ExpressionAttributeValues={':at': {'S': '2026-11-13T12:00:00Z'}})
    assert _call(lambda_context, 'POST', f'{BASE}/go', body={})[0] == 409
    assert actions.runtime.requests == []


@pytest.mark.parametrize('events', [[{'not': 'an event'}], ['a person event']])
def test_a_go_whose_board_hands_back_an_event_is_the_boards_fault(lambda_context: Any, actions: Actions,
                                                                   monkeypatch: pytest.MonkeyPatch,
                                                                   events: list[object]) -> None:
    import agents_handler
    from engineering.board import api as board_api

    real = board_api.person_request
    monkeypatch.setattr(board_api, 'person_request', lambda store, person: {**real(store, person), 'events': events})
    if events == ['a person event']:   # (one the API would take for the person's: a go still sends none)
        monkeypatch.setattr(agents_handler, '_persons_events', lambda raw, *_: list(raw))
    assert _call(lambda_context, 'POST', f'{BASE}/go', body={})[0] == 503
    assert actions.bus.entries == []


def _taken(lambda_context: Any, engineering: EngineeringRun) -> str:
    """The run's task, taken by the signed-in admin."""
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{engineering.task_id}/take', body={})[0] == 200
    return engineering.task_id


def test_a_no_op_publishes_nothing_and_a_retry_publishes_the_same_event(lambda_context: Any,
                                                                         run: tuple[Any, EngineeringRun],
                                                                         actions: Actions) -> None:
    _, engineering = run
    task = _taken(lambda_context, engineering)
    current = _board_task(engineering, task)['priority']
    # The priority it already has, after their take: answered (200), nothing written, nothing said.
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/priority', body={'priority': int(current)})[0] == 200
    assert [entry['DetailType'] for entry in actions.bus.entries] == ['task.claimed']
    # Their take again: the same change, so the same event (a redelivery the conversation keeps once).
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/take', body={})[0] == 200
    first, again = (json.loads(entry['Detail'])['event_id'] for entry in actions.bus.entries)
    assert first == again


def test_a_person_releases_a_task_they_took_and_its_role_is_told(lambda_context: Any,
                                                                 run: tuple[Any, EngineeringRun],
                                                                 actions: Actions) -> None:
    _, engineering = run
    path = f'{BASE}/board/tasks/{engineering.task_id}/release'
    assert _call(lambda_context, 'POST', path, body={})[0] == 403   # (not theirs)
    task = _taken(lambda_context, engineering)
    status, body = _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/release', body={})
    assert (status, body['task']['state'], body['task']['attempt'], body['task']['lease']) == (200, 'open', 2, None)
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/release', body={})[0] == 200   # (a retry)
    claimed, posted, again = (json.loads(entry['Detail']) for entry in actions.bus.entries)
    assert (claimed['type'], posted['type'], posted['to'], posted['from']) == (
        'task.claimed', 'task.posted', {'kind': 'role', 'id': 'fixer'}, {'kind': 'human', 'id': 'admin-sub'})
    assert again['event_id'] == posted['event_id']


def test_an_equal_post_after_a_later_change_is_answered_and_publishes_nothing(lambda_context: Any,
                                                                             actions: Actions) -> None:
    post = {'role': 'hunter', 'title': 'Look at the export', 'spec': {'area': 'export'}}
    task = _call(lambda_context, 'POST', f'{BASE}/board/tasks', body=post)[1]['task']['task_id']
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks', body=post)[0] == 200   # (a retry: the same event)
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/priority', body={'priority': 3})[0] == 200
    status, body = _call(lambda_context, 'POST', f'{BASE}/board/tasks', body=post)
    assert (status, body['duplicate']) == (200, True)
    details = [json.loads(entry['Detail']) for entry in actions.bus.entries]
    assert [detail['type'] for detail in details] == ['task.posted', 'task.posted', 'task.progress']
    assert details[0]['event_id'] == details[1]['event_id']


def test_a_bus_that_cannot_be_reached_after_the_write_says_the_board_changed(lambda_context: Any,
                                                                             run: tuple[Any, EngineeringRun],
                                                                             actions: Actions) -> None:
    _, engineering = run
    actions.bus.unreachable = True
    status, body = _call(lambda_context, 'POST', f'{BASE}/board/tasks/{engineering.task_id}/take', body={})
    assert (status, 'the board changed but its event was not published' in json.dumps(body)) == (503, True)
    assert _board_task(engineering, engineering.task_id)['lease_agent'] == 'human:admin-sub'
    post = {'role': 'hunter', 'title': 'Look at the export', 'spec': {'area': 'export'}}
    status, body = _call(lambda_context, 'POST', f'{BASE}/board/tasks', body=post)
    assert (status, 'the board changed but its event was not published' in json.dumps(body)) == (503, True)
    # The bus back: each retried once, each published once (the take's event and the post's).
    actions.bus.unreachable = False
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{engineering.task_id}/take', body={})[0] == 200
    status, body = _call(lambda_context, 'POST', f'{BASE}/board/tasks', body=post)
    assert (status, body['duplicate']) == (200, True)
    assert [entry['DetailType'] for entry in actions.bus.entries] == ['task.claimed', 'task.posted']


def test_a_person_re_prioritises_an_open_task_and_its_role_is_not_told_again(lambda_context: Any,
                                                                              actions: Actions) -> None:
    status, body = _call(lambda_context, 'POST', f'{BASE}/board/tasks',
                         body={'role': 'hunter', 'title': 'Look at the export', 'spec': {'area': 'export'}})
    task = body['task']['task_id']
    status, body = _call(lambda_context, 'POST', f'{BASE}/board/tasks/{task}/priority', body={'priority': 3})
    assert (status, body['task']['state'], body['task']['priority']) == (200, 'open', 3)
    posted, changed = (json.loads(entry['Detail']) for entry in actions.bus.entries)
    assert (posted['type'], posted['to']['kind'], changed['type'], changed['to']['kind']) == (
        'task.posted', 'role', 'task.progress', 'run')
    assert changed['summary'].endswith('priority by a person')


def test_an_ended_run_takes_no_board_action(lambda_context: Any, run: tuple[Any, EngineeringRun],
                                            actions: Actions) -> None:
    _, engineering = run
    engineering.client.update_item(
        TableName=TABLE, Key={'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': 'META'}},
        UpdateExpression='SET ended_at = :at', ExpressionAttributeValues={':at': {'S': '2026-11-12T10:00:00Z'}})
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{engineering.task_id}/take', body={})[0] == 409
    assert actions.bus.entries == []


def test_board_actions_need_the_bus_and_are_404_while_the_module_is_off(lambda_context: Any,
                                                                       monkeypatch: pytest.MonkeyPatch,
                                                                       actions: Actions) -> None:
    monkeypatch.delenv('ENGINEERING_BUS_NAME')
    body = {'role': 'hunter', 'title': 'x', 'spec': {'a': 1}}
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks', body=body)[0] == 503
    monkeypatch.delenv('ENGINEERING_AGENTS')
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks', body=body, claims=USER)[0] == 404
    assert actions.bus.entries == []


def test_board_actions_go_through_the_board_function_as_the_person(lambda_context: Any, run: tuple[Any, EngineeringRun],
                                                                   actions: Actions,
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    _, engineering = run
    lambdas = Lambdas(actions.runtime, engineering.client)
    monkeypatch.setattr('shared.aws.get_lambda_client', lambda: lambdas)
    path = f'{BASE}/board/tasks/{engineering.task_id}/priority'
    assert _call(lambda_context, 'POST', path, body={'priority': 4})[0] == 200
    (request,) = lambdas.board_requests
    # The board's own role writes; the API names the person, the run and the action (its gate checked them).
    assert request == {'person': {'op': 'act', 'task_id': engineering.task_id, 'action': 'priority', 'run_id': RUN,
                                  'subject': 'admin-sub', 'body': {'priority': 4}}}


def test_a_board_function_not_named_or_failing_is_a_503_and_nothing_is_sent(lambda_context: Any,
                                                                            run: tuple[Any, EngineeringRun],
                                                                            actions: Actions,
                                                                            monkeypatch: pytest.MonkeyPatch) -> None:
    _, engineering = run
    path = f'{BASE}/board/tasks/{engineering.task_id}/take'
    monkeypatch.delenv('ENGINEERING_BOARD_FUNCTION')
    status, body = _call(lambda_context, 'POST', path, body={})
    assert (status, 'names no board function' in json.dumps(body)) == (503, True)
    monkeypatch.setenv('ENGINEERING_BOARD_FUNCTION', BOARD_FUNCTION)
    throttled = MagicMock()
    throttled.invoke.side_effect = ClientError({'Error': {'Code': 'TooManyRequestsException', 'Message': 'x'}}, 'Invoke')
    monkeypatch.setattr('shared.aws.get_lambda_client', lambda: throttled)
    assert _call(lambda_context, 'POST', path, body={})[0] == 503
    assert (actions.bus.entries, _board_task(engineering, engineering.task_id).get('lease_agent')) == ([], 'fixer-1')


class _FailsAfterWriting(Lambdas):
    """The board writes, then its function fails (a timeout after the write): a FunctionError comes back."""

    def invoke(self, **request: Any) -> dict[str, Any]:
        super().invoke(**request)
        return {'StatusCode': 200, 'FunctionError': 'Unhandled', 'Payload': io.BytesIO(b'{"errorMessage": "timeout"}')}


def test_a_board_that_fails_after_writing_is_a_503_and_the_retry_sends_the_event_once(
        lambda_context: Any, run: tuple[Any, EngineeringRun], actions: Actions, monkeypatch: pytest.MonkeyPatch) -> None:
    _, engineering = run
    path = f'{BASE}/board/tasks/{engineering.task_id}/take'
    monkeypatch.setattr('shared.aws.get_lambda_client', lambda: _FailsAfterWriting(actions.runtime, engineering.client))
    assert _call(lambda_context, 'POST', path, body={})[0] == 503
    assert (actions.bus.entries, _board_task(engineering, engineering.task_id)['lease_agent']) == ([], 'human:admin-sub')
    monkeypatch.setattr('shared.aws.get_lambda_client', lambda: Lambdas(actions.runtime, engineering.client))
    assert _call(lambda_context, 'POST', path, body={})[0] == 200   # (answered as it is: the same change)
    (entry,) = actions.bus.entries
    assert json.loads(entry['Detail'])['summary'].endswith('take by a person')


@pytest.mark.parametrize('forge', ['type', 'sender', 'run', 'task', 'two', 'schema', 'summary', 'credential',
                                   'no answer'])
def test_an_event_the_board_hands_back_that_is_not_the_persons_action_is_never_sent(
        lambda_context: Any, run: tuple[Any, EngineeringRun], actions: Actions, monkeypatch: pytest.MonkeyPatch,
        forge: str) -> None:
    _, engineering = run
    real = Lambdas(actions.runtime, engineering.client)

    class Forging(Lambdas):
        def invoke(self, **request: Any) -> dict[str, Any]:
            answer = json.loads(real.invoke(**request)['Payload'].read())
            (event,) = answer['events']
            forged = {'type': {**event, 'type': 'signal.stop_now'},
                      'sender': {**event, 'from': {'kind': 'human', 'id': 'other-admin'}},
                      'run': {**event, 'run_id': '01JD0000000000000000000009'},
                      'task': {**event, 'task_id': 'task-9'},
                      # (not voc-msg/1: the board's fault, never the person's words, which it checks before writing)
                      'schema': {**event, 'schema': 'voc-msg/0'},
                      'summary': {**event, 'summary': 'x' * 2048},
                      'credential': {**event, 'summary': 'AKIA' + 'Q' * 16}}
            if forge == 'no answer':   # (an ok with no answer: the board's fault too)
                del answer['answer']
            else:
                answer['events'] = [event, event] if forge == 'two' else [forged[forge]]
            return {'StatusCode': 200, 'Payload': io.BytesIO(json.dumps(answer).encode())}

    monkeypatch.setattr('shared.aws.get_lambda_client', lambda: Forging(actions.runtime, engineering.client))
    assert _call(lambda_context, 'POST', f'{BASE}/board/tasks/{engineering.task_id}/take', body={})[0] == 503
    assert actions.bus.entries == []


def test_a_bus_that_refuses_or_a_missing_runtime_answers_503(lambda_context: Any, monkeypatch: pytest.MonkeyPatch,
                                                             actions: Actions) -> None:
    actions.bus.failed = True
    assert _call(lambda_context, 'POST', f'{BASE}/messages', body={'to': 'conductor', 'text': 'Hi'})[0] == 503
    monkeypatch.delenv('ENGINEERING_RUNTIME_FUNCTION')
    assert _call(lambda_context, 'POST', f'{BASE}/signals', body={'signal': 'save'})[0] == 503


# --- the spend ledger's read (engineering/spend.py) ----------------------------------------------------------------

def test_the_months_spend_is_read_grouped_for_an_admin(lambda_context: Any, run: tuple[Any, EngineeringRun]) -> None:
    from datetime import UTC, datetime
    from decimal import Decimal

    from engineering.spend import MICROVM, Usage, Where, ledger_updates

    _, engineering = run
    at = datetime(2026, 11, 13, tzinfo=UTC)
    engineering.client.transact_write_items(TransactItems=[
        _typed(update) for update in ledger_updates(
            TABLE, at, Where(RUN, 'fixer-2', 'wf_fix', 'example/app'),
            {MICROVM: Usage(usd=Decimal('1.25'), microvm_seconds=60), 'model-a': Usage(tokens_in=9, tokens_out=3)})])
    # (the static route, never read as a run id)
    status, body = _call(lambda_context, 'GET', '/agents/engineering/spend', query={'month': '2026-11', 'by': 'model'})
    assert (status, body['total']['usd'], [group['key'] for group in body['groups']]) == (
        200, 1.25, ['microvm', 'model-a'])
    status, body = _call(lambda_context, 'GET', '/agents/engineering/spend',
                         query={'month': '2026-11', 'workflow': 'wf_other'})
    assert (status, body['by'], body['groups']) == (200, 'workflow', [])
    for query in ({'month': '2026-13'}, {'by': 'cost'}, {'workflow': 'a#b'}):
        assert _call(lambda_context, 'GET', '/agents/engineering/spend', query=query)[0] == 400
    # No month: this one (UTC), by workflow.
    status, body = _call(lambda_context, 'GET', '/agents/engineering/spend')
    assert (status, body['month'], body['by']) == (200, datetime.now(UTC).strftime('%Y-%m'), 'workflow')


@pytest.mark.usefixtures('run')
def test_a_spend_read_the_table_refuses_is_a_503(lambda_context: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from engineering import spend

    def refused(*_: Any, **__: Any) -> None:
        raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'x'}}, 'Query')

    monkeypatch.setattr(spend, 'iter_query', refused)
    assert _call(lambda_context, 'GET', '/agents/engineering/spend')[0] == 503


@pytest.mark.usefixtures('run')
@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN])
def test_only_an_admin_acting_for_themselves_reads_the_spend(lambda_context: Any, claims: dict[str, str]) -> None:
    assert _call(lambda_context, 'GET', '/agents/engineering/spend', claims=claims)[0] == 403


@pytest.mark.usefixtures('run')
def test_the_spend_is_404_while_the_module_is_off(lambda_context: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('ENGINEERING_AGENTS')
    assert _call(lambda_context, 'GET', '/agents/engineering/spend')[0] == 404


def _typed(update: dict[str, Any]) -> dict[str, Any]:
    """A plain-valued transaction entry (the resource's form) for the low-level client."""
    from boto3.dynamodb.types import TypeSerializer

    serialize = TypeSerializer().serialize
    entry = dict(update['Update'])
    entry['Key'] = {key: serialize(value) for key, value in entry['Key'].items()}
    entry['ExpressionAttributeValues'] = {key: serialize(value) for key, value in entry['ExpressionAttributeValues'].items()}
    return {'Update': entry}


SETTINGS = '/agents/engineering/settings'


@pytest.mark.usefixtures('run')
def test_an_administrator_turns_the_hard_cap_on_and_reads_it_as_saved(lambda_context: Any) -> None:
    assert _call(lambda_context, 'GET', SETTINGS) == (200, {'hard_cap': False, 'updated_at': None, 'updated_by': None})
    status, saved = _call(lambda_context, 'PUT', SETTINGS, body={'hard_cap': True})
    assert (status, saved['hard_cap'], saved['updated_by']) == (200, True, 'alice')   # (the caller's own name)
    assert _call(lambda_context, 'GET', SETTINGS)[1] == saved


@pytest.mark.usefixtures('run')
@pytest.mark.parametrize('body', [{}, {'hard_cap': 'yes'}, {'hard_cap': 1}, {'hard_cap': True, 'more': 1}])
def test_a_hard_cap_change_is_true_or_false_only(lambda_context: Any, body: dict[str, Any]) -> None:
    assert _call(lambda_context, 'PUT', SETTINGS, body=body)[0] == 400


@pytest.mark.usefixtures('run')
@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN], ids=['plain user', 'MCP credential of an admin'])
def test_the_hard_cap_is_an_administrators_alone(lambda_context: Any, claims: dict[str, Any]) -> None:
    assert _call(lambda_context, 'GET', SETTINGS, claims=claims)[0] == 403
    assert _call(lambda_context, 'PUT', SETTINGS, claims=claims, body={'hard_cap': True})[0] == 403


@pytest.mark.usefixtures('run')
def test_the_hard_cap_is_404_while_the_module_is_off_and_503_when_its_read_fails(
        lambda_context: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from botocore.exceptions import BotoCoreError

    monkeypatch.setattr('engineering.settings.read_hard_cap', MagicMock(side_effect=BotoCoreError()))
    assert _call(lambda_context, 'GET', SETTINGS)[0] == 503
    monkeypatch.delenv('ENGINEERING_AGENTS')
    assert (_call(lambda_context, 'GET', SETTINGS)[0], _call(lambda_context, 'PUT', SETTINGS, body={'hard_cap': True})[0]) \
        == (404, 404)
