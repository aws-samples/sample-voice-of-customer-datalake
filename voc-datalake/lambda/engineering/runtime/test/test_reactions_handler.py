"""voc-engineering-runtime's reactions (7.10.00, runtime/handler.py): the ``reactions`` action (the run's schedule, a
person's hand trigger handed on), the one schedule at a run's end (no read there), and voc-engineering-start's
``ask_reactions``: an ended run only, once in a rolling hour, handed on, released when the hand-on fails, never the
read itself."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import boto3
import pytest

from engineering.learning.reactions_read import SCHEDULE_PREFIX
from engineering.learning.test.test_reactions import found
from engineering.learning.test.test_reactions_read import FakeScheduler
from engineering.run_links import PULL_REQUEST_SK, pull_request_link, writes_pk
from engineering.runtime import handler
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.test.conftest import RUN, TABLE
from shared import aws as shared_aws

TARGET = 'arn:aws:lambda:us-east-1:123456789012:function:voc-engineering-runtime'


def _ended(connection: str = 'conn-1') -> None:
    """RUN ended (done), with a connection (the start in ``wired`` named none)."""
    handler.lambda_handler({'action': 'end_run', 'run_id': RUN, 'status': 'done'}, None)
    boto3.client('dynamodb', region_name='us-east-1').update_item(
        TableName=TABLE, Key={'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': 'META'}},
        UpdateExpression='SET #c = :c', ExpressionAttributeNames={'#c': 'connection'},
        ExpressionAttributeValues={':c': {'S': connection}})


def _reads() -> list[dict[str, Any]]:
    return boto3.client('dynamodb', region_name='us-east-1').query(
        TableName=TABLE, KeyConditionExpression='pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues={':pk': {'S': f'WS#default#RUN#{RUN}'}, ':p': {'S': 'REACTIONS#'}})['Items']


def _broker(monkeypatch: pytest.MonkeyPatch, answer: object) -> list[str]:
    asked: list[str] = []

    def reactions(run_id: str) -> object:
        asked.append(run_id)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(handler, '_broker_reactions', reactions)
    return asked


def test_the_schedules_reactions_action_reads_and_records_the_ended_runs_reactions(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _ended()
    asked = _broker(monkeypatch, found())
    answer = handler.lambda_handler({'action': 'reactions', 'run_id': RUN, 'asked_by': 'schedule'}, None)
    assert (answer['status'], asked) == ('recorded', [RUN])
    assert [row['asked_by']['S'] for row in _reads()] == ['schedule']


def test_a_persons_hand_trigger_is_recorded_as_theirs(wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _ended()
    _broker(monkeypatch, found())
    handler.lambda_handler({'action': 'reactions', 'run_id': RUN, 'actor': 'admin-sub'}, None)
    assert [row['asked_by']['S'] for row in _reads()] == ['human:admin-sub']


@pytest.mark.parametrize('event', [{'action': 'reactions', 'run_id': 'not-a-run'},
                                   {'action': 'reactions', 'run_id': RUN}])
def test_a_reactions_read_that_fails_is_logged_and_answered_never_raised(
        wired: Any, monkeypatch: pytest.MonkeyPatch, event: dict[str, Any]) -> None:
    assert wired is not None
    _ended()
    _broker(monkeypatch, RuntimeError('the broker could not be reached'))
    assert handler.lambda_handler(event, None) == {'run_id': event['run_id'], 'status': 'failed'}
    assert _reads() == []


def _recorded_pull_request() -> None:
    """RUN's record keeps its pull request (the broker's row; the wired run's repository is example/app)."""
    link = pull_request_link('github', 'example/app', 7, 'https://github.com/example/app/pull/7',
                             f'voc-agent/{RUN}/fix', 'main')
    assert link is not None
    boto3.client('dynamodb', region_name='us-east-1').put_item(
        TableName=TABLE, Item={'pk': {'S': writes_pk('default', RUN)}, 'sk': {'S': PULL_REQUEST_SK},
                               'result': {'S': link.result()}, 'closed_at': {'N': '1'}})


def _scheduling(monkeypatch: pytest.MonkeyPatch, scheduler: Any) -> None:
    monkeypatch.setattr(handler, '_scheduler_client', lambda: scheduler)
    monkeypatch.setattr(handler, '_function_arn', f'{TARGET}:live')   # (an alias the end came in on)
    for name, value in {'ENGINEERING_REACTIONS_GROUP': 'voc-engineering-reactions',
                        'ENGINEERING_REACTIONS_ROLE_ARN': 'arn:aws:iam::123456789012:role/scheduler',
                        'ENGINEERING_REACTIONS_DELAY_DAYS': '5'}.items():
        monkeypatch.setenv(name, value)


def test_a_runs_end_reads_nothing_and_creates_its_one_schedule_when_it_keeps_a_pull_request(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _ended()
    _recorded_pull_request()
    asked = _broker(monkeypatch, found())
    scheduler = FakeScheduler()
    _scheduling(monkeypatch, scheduler)
    monkeypatch.setattr(handler, 'clock', lambda: datetime(2026, 11, 13, 9, 30, tzinfo=UTC).timestamp())
    # (the action as the function's own invocation runs it, its ARN set; a second start makes no second schedule)
    handler.retrospective({'action': 'retrospective', 'run_id': RUN})
    handler.retrospective({'action': 'retrospective', 'run_id': RUN})
    assert [(made['Name'], made['ScheduleExpression'], made['Target']['Arn']) for made in scheduler.created] == [
        (f'{SCHEDULE_PREFIX}{RUN}', 'at(2026-11-18T09:30:00)', TARGET)]
    assert (asked, _reads()) == ([], [])


def test_a_run_with_no_pull_request_at_its_end_gets_no_schedule(wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _ended()
    scheduler = FakeScheduler()
    _scheduling(monkeypatch, scheduler)
    handler.retrospective({'action': 'retrospective', 'run_id': RUN})
    assert (scheduler.created, _reads()) == ([], [])


def test_a_schedule_that_cannot_be_created_never_fails_the_retrospective(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _ended()
    _recorded_pull_request()

    def unreachable() -> Any:
        raise RuntimeError('the scheduler could not be reached')

    monkeypatch.setattr(handler, '_scheduler_client', unreachable)
    monkeypatch.setattr(handler, '_function_arn', TARGET)
    monkeypatch.setenv('ENGINEERING_REACTIONS_GROUP', 'voc-engineering-reactions')
    monkeypatch.setenv('ENGINEERING_REACTIONS_ROLE_ARN', 'arn:aws:iam::123456789012:role/scheduler')
    answer = handler.retrospective({'action': 'retrospective', 'run_id': RUN})
    assert answer['run_id'] == RUN
    assert answer.get('status') != 'failed'


def test_the_broker_is_called_at_its_function_url_signed_as_the_runtimes_own_role(wired: Any) -> None:
    from engineering.learning import reactions_broker
    from engineering.runtime.test.conftest import BROKER_URL, NoPullRequest

    assert wired is not None
    opener = reactions_broker._OPENER
    assert isinstance(opener, NoPullRequest)
    assert handler._broker_reactions(RUN) is None
    [request] = opener.sent
    assert (request.full_url, 'Authorization' in request.headers) == (BROKER_URL, True)
    assert b'"operation":"reactions"' in request.data
    assert RUN.encode() in request.data


def test_the_runtimes_own_clients_are_built_once(aws: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert aws is not None
    monkeypatch.setenv('AWS_DEFAULT_REGION', 'us-east-1')
    assert handler._own_credentials() is handler._own_credentials()
    assert handler._scheduler_client() is handler._scheduler_client()


def _handing_on(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    calls: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(shared_aws, 'invoke_lambda_async', lambda name, payload: calls.append((name, payload)))
    monkeypatch.setenv('ENGINEERING_RUNTIME_FUNCTION', 'voc-engineering-runtime')
    return calls


def test_the_start_function_asks_for_an_ended_runs_reactions_once_an_hour_and_hands_the_read_on(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _ended()
    calls = _handing_on(monkeypatch)
    first = handler.start_handler({'action': 'ask_reactions', 'run_id': RUN, 'actor': 'admin-sub'}, None)
    again = handler.start_handler({'action': 'ask_reactions', 'run_id': RUN, 'actor': 'admin-sub'}, None)
    assert (first['status'], again['status'], 0 < again['retry_after'] <= 3600) == ('asked', 'too_soon', True)
    assert calls == [('voc-engineering-runtime', {'action': 'reactions', 'run_id': RUN, 'actor': 'admin-sub'})]


def test_an_ask_whose_read_cannot_be_handed_on_is_released_so_asking_again_works(
        wired: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    assert wired is not None
    _ended()
    monkeypatch.setenv('ENGINEERING_RUNTIME_FUNCTION', 'voc-engineering-runtime')

    def unreachable(_name: str, _payload: dict[str, Any]) -> None:
        raise RuntimeError('Lambda could not be reached')

    monkeypatch.setattr(shared_aws, 'invoke_lambda_async', unreachable)
    with pytest.raises(RuntimeError, match='could not be reached'):
        handler.start_handler({'action': 'ask_reactions', 'run_id': RUN, 'actor': 'admin-sub'}, None)
    calls = _handing_on(monkeypatch)
    assert handler.start_handler({'action': 'ask_reactions', 'run_id': RUN, 'actor': 'admin-sub'}, None)['status'] == (
        'asked')
    assert len(calls) == 1


@pytest.mark.parametrize(('event', 'refusal'), [
    ({'run_id': RUN, 'actor': 'admin-sub'}, 'has not ended'),
    ({'run_id': '01JD3R4NZXQ7Y2W8K4M6P9T0AC', 'actor': 'admin-sub'}, 'no such run'),
    ({'run_id': RUN}, 'names the person'),
])
def test_the_start_function_refuses_a_run_not_ended_unknown_or_asked_for_by_nobody(
        wired: Any, monkeypatch: pytest.MonkeyPatch, event: dict[str, Any], refusal: str) -> None:
    assert wired is not None
    calls = _handing_on(monkeypatch)
    with pytest.raises(RuntimeRefused, match=refusal):
        handler.start_handler({'action': 'ask_reactions', **event}, None)
    assert calls == []
