"""The Agents API's engineering routes: an engineering run's monitor, board, conversation and reports, and the
monitor's actions (signals through voc-engineering-start since 7.51.02, a person's answers on the bus).

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

import agents_handler
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
    """What the actions reach: the bus and voc-engineering-start (its answer to ``signal_run``)."""
    bus: Bus
    start: LambdaClient


BOARD_FUNCTION = 'voc-engineering-board'
START_FUNCTION = 'voc-engineering-start'
#: What of a run the overview says reaches it (7.51.02), each by its own flag.
FLAGS = ('steer_available', 'signals_available', 'stop_available')


class Lambdas:
    """The Lambda client the routes get: the board function's direct invokes run the board's person path in process
    (on the same table, as its own role would); every other invoke is ``other``'s."""

    def __init__(self, other: LambdaClient, client: Any) -> None:
        self.other = other
        self.client = client
        self.board_requests: list[dict[str, Any]] = []

    def invoke(self, **request: Any) -> dict[str, Any]:
        if request['FunctionName'] != BOARD_FUNCTION:
            return self.other.invoke(**request)
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
    monkeypatch.setenv('ENGINEERING_START_FUNCTION', START_FUNCTION)
    monkeypatch.setenv('ENGINEERING_BOARD_FUNCTION', BOARD_FUNCTION)
    reached = Actions(Bus(), LambdaClient({'run_id': RUN, 'status': 'sent', 'at': '2026-11-17T09:00:00Z'}))
    monkeypatch.setattr(agents_handler, '_start_client', lambda: reached.start)
    with patch('shared.aws.get_eventbridge_client', return_value=reached.bus), \
            patch('shared.aws.get_lambda_client', return_value=Lambdas(reached.start, engineering.client)):
        yield reached


@pytest.mark.usefixtures('actions')
def test_the_run_monitor_reads_the_run_and_the_supervisors_sessions(lambda_context: Any) -> None:
    status, view = _call(lambda_context, 'GET', BASE)
    assert status == 200
    assert (view['run']['run_id'], [agent['agent'] for agent in view['agents']]) == (RUN, ['fixer-1'])
    # (the bus for steering and answers, the start function for the signals and the Stop)
    assert ([view[flag] for flag in FLAGS], 'actions_available' in view) == ([True, True, True], False)
    assert _call(lambda_context, 'GET', '/agents/engineering/01JD0000000000000000000009')[0] == 404


@pytest.mark.usefixtures('actions')
@pytest.mark.parametrize(('missing', 'flags'), [('ENGINEERING_START_FUNCTION', [True, False, False]),
                                                ('ENGINEERING_BUS_NAME', [False, True, True])])
def test_the_overview_says_what_reaches_the_run_each_by_its_own_wiring(
        lambda_context: Any, monkeypatch: pytest.MonkeyPatch, missing: str, flags: list[bool]) -> None:
    monkeypatch.delenv(missing)
    status, view = _call(lambda_context, 'GET', BASE)
    assert (status, [view[flag] for flag in FLAGS]) == (200, flags)


@pytest.mark.parametrize('path', [f'/agents/engineering/{UNKNOWN}/signals', f'/agents/engineering/{UNKNOWN}/messages'])
@pytest.mark.parametrize('body', [{}, {'signal': 'save'}, {'to': 'conductor', 'text': 'Hi'}])
def test_an_unknown_run_is_404_before_the_body_is_read(lambda_context: Any, actions: Actions, path: str,
                                                       body: dict[str, str]) -> None:
    assert _call(lambda_context, 'POST', path, body=body)[0] == 404
    assert (actions.bus.entries, actions.start.requests) == ([], [])


def test_an_admin_signals_the_agent_on_a_task_at_the_attempt_seen(lambda_context: Any,
                                                                  run: tuple[Any, EngineeringRun],
                                                                  actions: Actions) -> None:
    _, engineering = run
    status, body = _call(lambda_context, 'POST', f'{BASE}/signals',
                         body={'signal': 'pause', 'task_id': engineering.task_id, 'attempt': 1})
    assert (status, body['signal']['target'], body['signal']['status']) == (
        200, {'kind': 'agent', 'id': 'fixer-1'}, 'sent')
    # voc-engineering-start's signal_run (never the runtime's function), which records it and hands it on.
    (invoked,) = actions.start.requests
    assert (invoked['FunctionName'], json.loads(invoked['Payload'])) == (START_FUNCTION, {
        'action': 'signal_run', 'run_id': RUN, 'signal': 'pause', 'actor': 'admin-sub', 'agent_id': 'fixer-1',
        'task_id': engineering.task_id, 'attempt': 1})
    # Nothing on the bus: the API's source says only steering and answers there (7.51.02).
    assert actions.bus.entries == []
    stale = _call(lambda_context, 'POST', f'{BASE}/signals',
                  body={'signal': 'pause', 'task_id': engineering.task_id, 'attempt': 2})
    assert stale[0] == 409
    assert _call(lambda_context, 'POST', f'{BASE}/signals', body={'signal': 'stop_now'})[0] == 400


def test_the_start_function_refusing_a_signal_answers_409_with_its_reason(lambda_context: Any,
                                                                         actions: Actions) -> None:
    actions.start.payload = {'errorType': 'RuntimeRefused', 'errorMessage': 'run R is being stopped'}
    actions.start.function_error = 'Unhandled'
    status, body = _call(lambda_context, 'POST', f'{BASE}/signals', body={'signal': 'resume'})
    assert (status, 'being stopped' in json.dumps(body), actions.bus.entries) == (409, True, [])
    actions.start.payload = {'errorType': 'KeyError'}
    assert _call(lambda_context, 'POST', f'{BASE}/signals', body={'signal': 'resume'})[0] == 503


@pytest.mark.parametrize('claims', [USER, DELEGATED_ADMIN])
def test_only_an_admin_acting_for_themselves_signals_or_answers(lambda_context: Any, actions: Actions,
                                                                claims: dict[str, str]) -> None:
    assert _call(lambda_context, 'POST', f'{BASE}/signals', body={'signal': 'save'}, claims=claims)[0] == 403
    assert _call(lambda_context, 'POST', f'{BASE}/messages', body={'to': 'conductor', 'text': 'Hi'},
                 claims=claims)[0] == 403
    assert (actions.bus.entries, actions.start.requests) == ([], [])


def test_an_admin_answers_the_conductor_or_an_agent_of_the_run(lambda_context: Any, actions: Actions) -> None:
    status, body = _call(lambda_context, 'POST', f'{BASE}/messages', body={'to': 'conductor', 'text': 'Skip docs'})
    # (the API's own source, the answer's own detail type: what its grant on the bus is held to, 7.51.02)
    assert (status, actions.bus.entries[0]['Source'], actions.bus.entries[0]['DetailType']) == (
        200, 'voc.engineering/api', 'msg.answer')
    assert body['message']['thread_id'].startswith('human-')
    # (7.51.00: an answer to an agent replies on the thread its own question opened, the fixture's t-1)
    assert _call(lambda_context, 'POST', f'{BASE}/messages',
                 body={'to': 'agent', 'agent': 'fixer-1', 'text': 'Yes', 'thread_id': 't-1'})[0] == 200
    assert _call(lambda_context, 'POST', f'{BASE}/messages',
                 body={'to': 'agent', 'agent': 'fixer-1', 'text': 'Yes'})[0] == 400
    assert _call(lambda_context, 'POST', f'{BASE}/messages',
                 body={'to': 'agent', 'agent': 'fixer-9', 'text': 'Hi', 'thread_id': 't-1'})[0] == 404


# --- a person's go on the run (engineering/board/api.py person_request) -------------------------------------------

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
    assert actions.start.requests == []


@pytest.mark.parametrize('events', [[{'not': 'an event'}], ['a person event']])
def test_a_go_whose_board_hands_back_an_event_is_the_boards_fault(lambda_context: Any, actions: Actions,
                                                                   monkeypatch: pytest.MonkeyPatch,
                                                                   events: list[object]) -> None:
    from engineering.board import api as board_api

    real = board_api.person_request
    monkeypatch.setattr(board_api, 'person_request', lambda store, person: {**real(store, person), 'events': events})
    assert _call(lambda_context, 'POST', f'{BASE}/go', body={})[0] == 503
    assert actions.bus.entries == []


def _go_row(engineering: EngineeringRun) -> dict[str, Any]:
    return engineering.client.get_item(TableName=TABLE, Key={'pk': {'S': f'WS#default#RUN#{RUN}'},
                                                             'sk': {'S': 'GO#person'}}).get('Item') or {}


def test_a_go_goes_through_the_board_function_as_the_person(lambda_context: Any, run: tuple[Any, EngineeringRun],
                                                           actions: Actions, monkeypatch: pytest.MonkeyPatch) -> None:
    _, engineering = run
    lambdas = Lambdas(actions.start, engineering.client)
    monkeypatch.setattr('shared.aws.get_lambda_client', lambda: lambdas)
    assert _call(lambda_context, 'POST', f'{BASE}/go', body={'reason': 'Looks right'})[0] == 200
    # The board's own role writes; the API names the person and the run (its gate checked them).
    assert lambdas.board_requests == [{'person': {'op': 'go', 'run_id': RUN, 'subject': 'admin-sub',
                                                  'body': {'reason': 'Looks right'}}}]


@pytest.mark.usefixtures('actions')
def test_a_board_function_not_named_or_failing_is_a_503_for_a_go(lambda_context: Any, run: tuple[Any, EngineeringRun],
                                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    _, engineering = run
    monkeypatch.delenv('ENGINEERING_BOARD_FUNCTION')
    status, body = _call(lambda_context, 'POST', f'{BASE}/go', body={})
    assert (status, 'names no board function' in json.dumps(body)) == (503, True)
    monkeypatch.setenv('ENGINEERING_BOARD_FUNCTION', BOARD_FUNCTION)
    throttled = MagicMock()
    throttled.invoke.side_effect = ClientError({'Error': {'Code': 'TooManyRequestsException', 'Message': 'x'}}, 'Invoke')
    monkeypatch.setattr('shared.aws.get_lambda_client', lambda: throttled)
    assert _call(lambda_context, 'POST', f'{BASE}/go', body={})[0] == 503
    assert _go_row(engineering) == {}


class _FailsAfterWriting(Lambdas):
    """The board writes, then its function fails (a timeout after the write): a FunctionError comes back."""

    def invoke(self, **request: Any) -> dict[str, Any]:
        super().invoke(**request)
        return {'StatusCode': 200, 'FunctionError': 'Unhandled', 'Payload': io.BytesIO(b'{"errorMessage": "timeout"}')}


def test_a_board_that_fails_after_writing_a_go_is_a_503_and_the_retry_answers_it(
        lambda_context: Any, run: tuple[Any, EngineeringRun], actions: Actions, monkeypatch: pytest.MonkeyPatch) -> None:
    _, engineering = run
    monkeypatch.setattr('shared.aws.get_lambda_client', lambda: _FailsAfterWriting(actions.start, engineering.client))
    assert _call(lambda_context, 'POST', f'{BASE}/go', body={})[0] == 503
    assert _go_row(engineering)['by'] == {'S': 'human:admin-sub'}   # (written before the failure)
    monkeypatch.setattr('shared.aws.get_lambda_client', lambda: Lambdas(actions.start, engineering.client))
    status, body = _call(lambda_context, 'POST', f'{BASE}/go', body={})
    assert (status, body['go']['created']) == (200, False)   # (answered as it is: the same go)


@pytest.mark.parametrize('answer', [{'status': 'ok'}, {'status': 'ok', 'answer': 'go'}, 'not an object'],
                         ids=['no answer', 'not an object', 'not a mapping'])
@pytest.mark.usefixtures('actions')
def test_a_go_the_board_answers_off_its_shape_is_the_boards_fault(lambda_context: Any, monkeypatch: pytest.MonkeyPatch,
                                                                  answer: object) -> None:
    from engineering.board import api as board_api

    monkeypatch.setattr(board_api, 'person_request', lambda _store, _person: answer)
    assert _call(lambda_context, 'POST', f'{BASE}/go', body={})[0] == 503


@pytest.mark.usefixtures('actions')
def test_a_board_that_answers_a_go_with_no_json_is_a_503(lambda_context: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    garbled = MagicMock()
    garbled.invoke.return_value = {'StatusCode': 200, 'Payload': io.BytesIO(b'not json')}
    monkeypatch.setattr('shared.aws.get_lambda_client', lambda: garbled)
    assert _call(lambda_context, 'POST', f'{BASE}/go', body={})[0] == 503


@pytest.mark.parametrize(('kind', 'status'), [('invalid', 400), ('conflict', 409), ('forbidden', 403), ('cap', 429),
                                              ('unavailable', 503), ('something else', 503)])
@pytest.mark.usefixtures('actions')
def test_a_go_the_board_refuses_answers_its_kind(lambda_context: Any, monkeypatch: pytest.MonkeyPatch, kind: str,
                                                 status: int) -> None:
    from engineering.board import api as board_api

    monkeypatch.setattr(board_api, 'person_request',
                        lambda _store, _person: {'status': 'refused', 'kind': kind, 'message': 'no'})
    assert _call(lambda_context, 'POST', f'{BASE}/go', body={})[0] == status


@pytest.mark.parametrize('path', ['board/tasks', 'board/tasks/task-1/take', 'board/tasks/task-1/priority'])
def test_a_persons_board_actions_are_no_route_any_more(lambda_context: Any, actions: Actions, path: str) -> None:
    # (7.58.00) They answered 503 on every deployment (their task.* would go out from the API's source, which the bus
    # takes only steering and answers from): the routes are gone, and the overview says no board_available.
    assert _call(lambda_context, 'POST', f'{BASE}/{path}', body={})[0] == 404
    assert actions.bus.entries == []
    assert 'board_available' not in _call(lambda_context, 'GET', BASE)[1]


# --- the bus and the start function ---------------------------------------------------------------------------------

def test_a_bus_that_refuses_or_a_missing_start_function_answers_503(lambda_context: Any,
                                                                    monkeypatch: pytest.MonkeyPatch,
                                                                    actions: Actions) -> None:
    actions.bus.failed = True
    assert _call(lambda_context, 'POST', f'{BASE}/messages', body={'to': 'conductor', 'text': 'Hi'})[0] == 503
    monkeypatch.delenv('ENGINEERING_START_FUNCTION')
    assert _call(lambda_context, 'POST', f'{BASE}/signals', body={'signal': 'save'})[0] == 503
    assert actions.start.requests == []


def test_an_admin_steers_the_orchestrator_from_the_apis_own_source(lambda_context: Any, actions: Actions) -> None:
    status, body = _call(lambda_context, 'POST', f'{BASE}/steer', body={'text': 'Keep the signature', 'about': 'fixer-1'})
    (entry,) = actions.bus.entries
    detail = json.loads(entry['Detail'])
    assert (status, entry['Source'], entry['DetailType'], detail['type'], detail['to']) == (
        202, 'voc.engineering/api', 'msg.steer', 'msg.steer', {'kind': 'conductor', 'id': RUN})
    assert body['message']['thread_id'].startswith('steer-')


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
