"""The board API: the caller from its IAM identity, each operation's answer, and the event it publishes."""
from __future__ import annotations

import base64
import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from engineering.board import api as api_module
from engineering.board.api import BoardApi, handler
from engineering.board.inbox import Inbox
from engineering.board.test.table import RUN, TABLE, board, engineering_table
from engineering.board.test.test_inbox import notice
from engineering.bus.publish import EventBridgePublisher, PublishError
from engineering.bus.schema import MessageError, parse
from engineering.connectors.identity import Caller

ACCOUNT = '123456789012'
PATTERN = 'voc-eng-{role}-123456789012-us-east-1'
FIXER = Caller('fixer', RUN, 1)
COORDINATOR = Caller('coordinator', RUN, 0)
KEY = f'ws/default/runs/{RUN}/fixer-1/commits/a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4/core/attempt-1/findings-0.jsonl'
SPEC = {'issue': 7}


class Bus:
    """EventBridge's put_events, recorded; ``refuse`` makes it fail the entry."""

    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []
        self.refuse = False

    def put_events(self, Entries: list[dict[str, Any]]) -> dict[str, Any]:
        if self.refuse:
            return {'FailedEntryCount': 1, 'Entries': [{'ErrorCode': 'InternalFailure'}]}
        self.entries.extend(Entries)
        return {'FailedEntryCount': 0, 'Entries': [{'EventId': 'e'}]}

    def types(self) -> list[str]:
        return [entry['DetailType'] for entry in self.entries]


@pytest.fixture
def bus() -> Bus:
    return Bus()


def _api(client: Any, bus: Bus) -> BoardApi:
    return BoardApi(board(client), EventBridgePublisher(bus, 'voc-engineering', 'voc.engineering/board'),
                    Inbox(client, TABLE))


@pytest.fixture
def api(bus: Bus) -> Iterator[BoardApi]:
    with engineering_table() as client:
        yield _api(client, bus)


def call(api: BoardApi, caller: Caller, **body: Any) -> tuple[int, dict[str, Any]]:
    answer = api.handle_request(caller, json.dumps(body))
    return answer['statusCode'], json.loads(answer['body'])


def test_a_task_goes_from_posted_to_done_and_each_step_is_on_the_bus(api: BoardApi, bus: Bus) -> None:
    status, body = call(api, COORDINATOR, op='post', role='fixer', title='Fix the page size', spec={'issue': 7})
    assert status == 200
    task_id = body['task']['task_id']
    assert body['task']['posted_by'] == 'coordinator-0'
    assert call(api, FIXER, op='claim', task_id=task_id)[1]['task']['lease']['agent'] == 'fixer-1'
    assert call(api, FIXER, op='renew', task_id=task_id, epoch=1)[0] == 200
    assert call(api, FIXER, op='move', task_id=task_id, epoch=1, to='in_progress')[0] == 200
    status, body = call(api, FIXER, op='move', task_id=task_id, epoch=1, to='done', result_keys=[KEY])
    assert (status, body['task']['result_keys']) == (200, [KEY])
    assert bus.types() == ['task.posted', 'task.claimed', 'task.progress', 'task.done']
    posted, *_, done = (parse(json.loads(entry['Detail'])) for entry in bus.entries)
    assert (posted.to.kind, posted.to.id, posted.sender.id) == ('role', 'fixer', 'board')
    assert (done.to.kind, done.to.id, done.thread_id, done.refs.s3) == ('run', RUN, task_id, (KEY,))
    assert {entry['Source'] for entry in bus.entries} == {'voc.engineering/board'}


def event_ids(bus: Bus) -> list[str]:
    return [json.loads(entry['Detail'])['event_id'] for entry in bus.entries]


def test_a_duplicate_post_redelivers_the_same_event_while_the_task_is_open(api: BoardApi, bus: Bus) -> None:
    first = call(api, COORDINATOR, op='post', role='fixer', title='Fix it', spec={'issue': 7})[1]
    again = call(api, COORDINATOR, op='post', role='fixer', title='Fix it again', spec={'issue': 7})[1]
    assert again['task']['task_id'] == first['task']['task_id']
    assert (first['duplicate'], again['duplicate']) == (False, True)
    assert bus.types() == ['task.posted', 'task.posted']
    assert len(set(event_ids(bus))) == 1
    call(api, FIXER, op='claim', task_id=first['task']['task_id'])
    call(api, COORDINATOR, op='post', role='fixer', title='Fix it', spec={'issue': 7})
    assert bus.types() == ['task.posted', 'task.posted', 'task.claimed']
    child = call(api, COORDINATOR, op='post', role='fixer', title='Fix it', spec={'issue': 7},
                 parent_task=first['task']['task_id'])[1]
    assert (child['duplicate'], child['task']['depth']) == (False, 1)


def test_a_retried_claim_or_move_redelivers_its_event(api: BoardApi, bus: Bus) -> None:
    task_id = call(api, COORDINATOR, op='post', role='fixer', title='Fix it', spec=SPEC)[1]['task']['task_id']
    for body in ({'op': 'claim'}, {'op': 'move', 'epoch': 1, 'to': 'in_progress'}):
        for _ in range(2):
            assert call(api, FIXER, task_id=task_id, **body)[0] == 200
    claimed, claimed_again, moved, moved_again = event_ids(bus)[1:]
    assert (claimed, moved) == (claimed_again, moved_again)
    assert claimed != moved


@pytest.mark.parametrize(('poster', 'role', 'status'), [
    (FIXER, 'final-go', 403), (FIXER, 'fixer', 403), (Caller('hunter', RUN, 2), 'fixer', 200),
    (Caller('hunter', RUN, 2), 'pr-reviewer', 403), (Caller('builder', RUN, 5), 'builder', 200),
    (COORDINATOR, 'final-go', 200),
])
def test_only_the_planners_post_and_only_for_their_roles(api: BoardApi, poster: Caller, role: str,
                                                         status: int) -> None:
    assert call(api, poster, op='post', role=role, title='A task', spec=SPEC)[0] == status


@pytest.mark.parametrize(('body', 'status'), [
    ({'op': 'post', 'role': 'stranger', 'title': 't', 'spec': SPEC}, 400),
    ({'op': 'post', 'role': 'fixer', 'title': '  ', 'spec': SPEC}, 400),
    ({'op': 'post', 'role': 'fixer', 'title': 'x' * 201, 'spec': SPEC}, 400),
    ({'op': 'post', 'role': 'fixer', 'title': 'key ghp_' + 'z' * 36, 'spec': SPEC}, 400),
    ({'op': 'post', 'role': 'fixer', 'title': 't', 'spec': []}, 400),
    ({'op': 'post', 'role': 'fixer', 'title': 't'}, 400),
    ({'op': 'post', 'role': 'fixer', 'title': 't', 'spec': SPEC, 'priority': True}, 400),
    ({'op': 'post', 'role': 'fixer', 'title': 't', 'spec': SPEC, 'priority': 10 ** 40}, 400),
    ({'op': 'post', 'role': 'fixer', 'title': 't', 'spec': SPEC, 'parent_task': 'none'}, 404),
    ({'op': 'claim', 'task_id': 'none'}, 404),
    ({'op': 'move', 'task_id': 'none', 'result_keys': 'k'}, 400),
    ({'op': 'drop', 'task_id': 'none'}, 400),
    ({'task_id': 'none'}, 400),
])
def test_bad_requests_answer_what_is_wrong(api: BoardApi, bus: Bus, body: dict[str, Any], status: int) -> None:
    assert call(api, COORDINATOR, **body)[0] == status
    assert bus.entries == []


def test_a_body_that_is_not_an_object_is_refused(api: BoardApi) -> None:
    assert api.handle_request(FIXER, '[1]')['statusCode'] == 400
    assert api.handle_request(FIXER, None)['statusCode'] == 400
    assert api.handle_request(FIXER, '{not json')['statusCode'] == 400


def test_another_roles_task_and_another_agents_lease_are_refused(api: BoardApi) -> None:
    task_id = call(api, COORDINATOR, op='post', role='hunter', title='Hunt', spec=SPEC)[1]['task']['task_id']
    assert call(api, FIXER, op='claim', task_id=task_id)[0] == 403
    hunter = Caller('hunter', RUN, 3)
    assert call(api, hunter, op='claim', task_id=task_id)[0] == 200
    assert call(api, Caller('hunter', RUN, 4), op='renew', task_id=task_id, epoch=1)[0] == 409


def test_a_refused_event_answers_503_after_the_write(api: BoardApi, bus: Bus) -> None:
    bus.refuse = True
    status, body = call(api, COORDINATOR, op='post', role='fixer', title='Fix it', spec=SPEC)
    assert status == 503
    assert 'retry' in body['error']
    bus.refuse = False
    assert call(api, COORDINATOR, op='post', role='fixer', title='Fix it', spec=SPEC)[0] == 200
    assert bus.types() == ['task.posted']


def test_an_aws_error_on_the_bus_answers_503_too(api: BoardApi, bus: Bus, monkeypatch: pytest.MonkeyPatch) -> None:
    throttled = ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'slow down'}}, 'PutEvents')
    monkeypatch.setattr(bus, 'put_events', MagicMock(side_effect=throttled))
    assert call(api, COORDINATOR, op='post', role='fixer', title='Fix it', spec=SPEC)[0] == 503


def test_an_aws_error_on_the_table_answers_503(api: BoardApi, monkeypatch: pytest.MonkeyPatch) -> None:
    throttled = ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'slow down'}}, 'GetItem')
    monkeypatch.setattr(api.store, 'claim', MagicMock(side_effect=throttled))
    status, body = call(api, FIXER, op='claim', task_id='task-1')
    assert (status, 'retry' in body['error']) == (503, True)


def test_the_cap_answers_429(bus: Bus) -> None:
    with engineering_table(max_tasks=1) as client:
        api = _api(client, bus)
        assert call(api, COORDINATOR, op='post', role='fixer', title='One', spec={'n': 1})[0] == 200
        assert call(api, COORDINATOR, op='post', role='fixer', title='Two', spec={'n': 2})[0] == 429


def test_the_publisher_checks_before_sending_and_raises_on_a_failed_entry() -> None:
    client = MagicMock()
    publisher = EventBridgePublisher(client, 'voc-engineering', 'voc.engineering/board')
    task = MagicMock(task_id='t', role='fixer', state='open', title='t', updated_by='a', attempt=1, result_keys=(),
                     updated_at='2026-11-12T09:00:00.250000+00:00')
    off_schema = api_module._event(task, 'not a run id!')
    with pytest.raises(MessageError, match='run_id'):
        publisher.publish(off_schema)
    client.put_events.assert_not_called()
    refusing = Bus()
    refusing.refuse = True
    with pytest.raises(PublishError, match='InternalFailure'):
        EventBridgePublisher(refusing, 'voc-engineering', 'voc.engineering/board').publish(
            api_module._event(task, RUN))


def lambda_event(arn: str, body: dict[str, Any]) -> dict[str, Any]:
    return {'requestContext': {'authorizer': {'iam': {'userArn': arn}}}, 'body': json.dumps(body)}


def test_the_handler_takes_the_caller_from_iam_only(bus: Bus, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv('AGENT_ROLE_NAME_PATTERN', PATTERN)
    monkeypatch.setenv('ENGINEERING_TABLE', TABLE)
    monkeypatch.setenv('ENGINEERING_BUS_NAME', 'voc-engineering')
    context = MagicMock(invoked_function_arn=f'arn:aws:lambda:us-east-1:{ACCOUNT}:function:voc-board')
    arn = f'arn:aws:sts::{ACCOUNT}:assumed-role/voc-eng-coordinator-123456789012-us-east-1/{RUN}.0'
    with engineering_table() as client, \
            patch('shared.aws.get_dynamodb_client', return_value=client), \
            patch('shared.aws.get_eventbridge_client', return_value=bus), \
            patch.object(api_module, '_api', None):
        answer = handler(lambda_event(arn, {'op': 'post', 'role': 'fixer', 'title': 'Fix', 'spec': SPEC}), context)
        assert answer['statusCode'] == 200
        assert json.loads(answer['body'])['agent'] == 'coordinator-0'
        forged = handler({'body': json.dumps({'op': 'post', 'role': 'fixer', 'title': 'x'})}, context)
        assert forged['statusCode'] == 403
        encoded = lambda_event(arn, {'op': 'post', 'role': 'hunter', 'title': 'Hunt', 'spec': SPEC})
        encoded.update(body=base64.b64encode(encoded['body'].encode()).decode(), isBase64Encoded=True)
        assert handler(encoded, context)['statusCode'] == 200
        assert handler({**encoded, 'body': 'not base64!'}, context)['statusCode'] == 400
    assert bus.types() == ['task.posted', 'task.posted']


def test_a_plain_body_is_taken_as_it_is() -> None:
    assert api_module._raw_body({'body': '{}'}) == '{}'
    assert api_module._raw_body({'body': '//4=', 'isBase64Encoded': True}) is None   # not UTF-8


def test_an_agent_reads_its_inbox_and_the_coordinator_the_conductors_too(bus: Bus) -> None:
    with engineering_table() as client:
        api = _api(client, bus)
        notice(client, 'agent:fixer-1', 3)
        notice(client, 'role:fixer', 1, task_id='task-1', type_='task.posted')
        notice(client, 'conductor', 2)
        notice(client, 'agent:fixer-2', 4)   # another agent's: never read
        status, body = call(api, FIXER, op='inbox')
        assert (status, [m['seq'] for m in body['messages']], body['next']) == (200, [1, 3], 0)
        assert body['messages'][0]['task_id'] == 'task-1'
        assert [m['seq'] for m in call(api, COORDINATOR, op='inbox')[1]['messages']] == [2]
        assert bus.entries == []   # (reading publishes nothing)


@pytest.mark.parametrize('body', [{'after': -1}, {'after': 'x'}, {'limit': 0}, {'limit': 51}, {'limit': True}])
def test_a_bad_cursor_or_limit_is_400(api: BoardApi, body: dict[str, Any]) -> None:
    status, answer = call(api, FIXER, op='inbox', **body)
    assert (status, '"after"' in answer['error'] or 'whole number' in answer['error']) == (400, True)
