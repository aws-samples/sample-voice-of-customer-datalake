"""A run's reactions read (learning/reactions_read.py, 7.10.00): an ended run's broker answer recorded once per read,
nothing for a run with no recorded pull request, the human edits as new rows beside the scorecards only when a read
says something new (summed by ``version_card``, never a scorecard row changed), and the run's ONE schedule, which
deletes itself after it runs."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from engineering.board.test.table import TABLE, create_table
from engineering.learning.reactions import ReactionsStore
from engineering.learning.reactions_read import (
    DEFAULT_DELAY_DAYS,
    NO_CONNECTION,
    NO_PULL_REQUEST,
    NO_RUN,
    NOT_ENDED,
    RECORDED,
    SCHEDULE_PREFIX,
    ReactionsRead,
    ReactionsSchedule,
    delay_days,
    has_pull_request,
    unqualified,
)
from engineering.learning.scorecard import ScorecardStore, score_pk
from engineering.learning.test.fixtures import CONN, RUN, WS, agent_item, meta
from engineering.learning.test.test_reactions import found

AT = datetime(2026, 11, 13, 9, 30, tzinfo=UTC)
TARGET = 'arn:aws:lambda:us-east-1:111111111111:function:voc-engineering-runtime'
SCHEDULER_ROLE = 'arn:aws:iam::111111111111:role/voc-engineering-reactions-scheduler'


@dataclass
class World:
    client: Any
    answers: list[object]
    asked: list[str] = field(default_factory=list)

    def broker(self, run_id: str) -> object:
        self.asked.append(run_id)
        return self.answers.pop(0)

    def read(self, minute: int = 30) -> ReactionsRead:
        now = AT.replace(minute=minute)
        return ReactionsRead(client=self.client, table=TABLE, broker=self.broker,
                             store=ReactionsStore(self.client, TABLE, now=lambda: now),
                             scorecards=ScorecardStore(self.client, TABLE, now=lambda: now))

    def rows(self, prefix: str, pk: str = f'WS#{WS}#RUN#{RUN}') -> list[dict[str, Any]]:
        return self.client.query(TableName=TABLE, KeyConditionExpression='pk = :pk AND begins_with(sk, :p)',
                                 ExpressionAttributeValues={':pk': {'S': pk}, ':p': {'S': prefix}})['Items']


@pytest.fixture
def world() -> Iterator[World]:
    with mock_aws():
        client = create_table()
        client.put_item(TableName=TABLE, Item=meta())
        for item in (agent_item('fixer-2', 'fixer', 'fixer@1'), agent_item('fixer-3', 'fixer', 'fixer@1'),
                     agent_item('pr-author-4', 'pr-author', 'pr-author@1')):
            client.put_item(TableName=TABLE, Item=item)
        yield World(client, [])


def test_an_ended_runs_read_is_recorded_as_a_new_row_with_who_asked(world: World) -> None:
    world.answers = [found()]
    answer = world.read().read(WS, RUN, 'schedule')
    assert (answer['status'], answer['read_at'], answer['kept'], world.asked) == (
        RECORDED, '2026-11-13T09:30:00.000000Z', 4, [RUN])
    [row] = world.rows('REACTIONS#')
    assert (row['asked_by']['S'], json.loads(row['reactions']['S'])['revert_commit']) == ('schedule', 'b' * 40)


def test_a_run_with_no_recorded_pull_request_records_nothing_and_says_so(world: World) -> None:
    world.answers = [None]
    assert world.read().read(WS, RUN, 'run_end')['status'] == NO_PULL_REQUEST
    assert world.rows('REACTIONS#') == []


@pytest.mark.parametrize(('item', 'status'), [
    (meta(status='active'), NOT_ENDED), (meta(status='needs_human'), NOT_ENDED), (meta(connection=''), NO_CONNECTION),
])
def test_a_run_that_has_not_ended_or_has_no_connection_asks_the_broker_nothing(world: World, item: dict[str, Any],
                                                                               status: str) -> None:
    world.client.put_item(TableName=TABLE, Item=item)
    assert world.read().read(WS, RUN, 'run_end')['status'] == status
    assert world.asked == []
    assert world.read().read(WS, '01JD0000000000000000000099', 'run_end')['status'] == NO_RUN


def test_the_human_edits_are_new_rows_beside_each_versions_scorecards_only_when_a_read_says_something_new(
        world: World) -> None:
    world.answers = [found(), found(), found(reverted=False, revert_commit='')]
    first = world.read(30).read(WS, RUN, 'run_end')
    again = world.read(31).read(WS, RUN, 'schedule')
    undone = world.read(32).read(WS, RUN, 'human:admin-sub')
    # (two versions took part: fixer@1 and pr-author@1; the same read again writes nothing new)
    assert [first['human_rows'], again['human_rows'], undone['human_rows']] == [2, 0, 2]
    rows = world.rows(f'HUMAN#{RUN}#', score_pk(WS, CONN, 'fixer', 'fixer@1'))
    assert [(row['changes_requested']['N'], row['reverted']['N']) for row in rows] == [('2', '1'), ('2', '0')]
    assert world.rows('RUN#', score_pk(WS, CONN, 'fixer', 'fixer@1')) == []   # (no scorecard row written or changed)


def test_a_human_edits_write_that_fails_is_repaired_by_the_next_read(world: World,
                                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    world.answers = [found(), found()]
    read = world.read(30)

    def throttled(*_args: Any, **_kwargs: Any) -> bool:
        raise ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'slow down'}}, 'PutItem')

    monkeypatch.setattr(ScorecardStore, 'write_human', throttled)
    with pytest.raises(ClientError):
        read.read(WS, RUN, 'schedule')
    # (the read's row was not written either: the run's latest read is still none)
    assert world.rows('REACTIONS#') == []
    monkeypatch.undo()
    again = world.read(31).read(WS, RUN, 'schedule')
    assert (again['human_rows'], len(world.rows('REACTIONS#'))) == (2, 1)


def test_a_versions_card_sums_each_runs_newest_human_edits(world: World) -> None:
    from engineering.learning.retrospective import ScoreLine
    from engineering.learning.test.test_scorecard import run

    scorecards = ScorecardStore(world.client, TABLE, now=lambda: AT)
    scorecards.write(run(), ScoreLine('fixer', 'fixer@1', tasks_done=1))
    world.answers = [found(), found(reverted=False, revert_commit='',
                                    edits_after_merge={'people_commits': 3, 'files': [], 'paths_read': 1,
                                                       'paths_total': 1})]
    world.read(30).read(WS, RUN, 'schedule')
    world.read(31).read(WS, RUN, 'schedule')
    card = scorecards.version_card(WS, CONN, 'fixer', 'fixer@1')
    assert (card.runs, card.runs_with_human_edits, card.changes_requested) == (1, 1, 2)
    assert (card.people_commits_after_merge, card.reverts, card.human_more) == (3, 0, False)


def test_a_run_has_a_pull_request_only_when_its_record_keeps_one(world: World) -> None:
    from engineering.run_links import PULL_REQUEST_SK, pull_request_link, writes_pk

    assert has_pull_request(world.client, TABLE, WS, RUN) is False
    world.client.update_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WS}#RUN#{RUN}'}, 'sk': {'S': 'META'}},
                             UpdateExpression='SET repo = :r', ExpressionAttributeValues={':r': {'S': 'example-org/app'}})
    link = pull_request_link('github', 'example-org/app', 7, 'https://github.com/example-org/app/pull/7',
                             f'voc-agent/{RUN}/fix', 'main')
    assert link is not None
    world.client.put_item(TableName=TABLE, Item={'pk': {'S': writes_pk(WS, RUN)}, 'sk': {'S': PULL_REQUEST_SK},
                                                 'result': {'S': link.result()}, 'closed_at': {'N': '1'}})
    assert has_pull_request(world.client, TABLE, WS, RUN) is True
    assert has_pull_request(world.client, TABLE, WS, '01JD0000000000000000000099') is False


def test_the_schedule_invokes_the_unqualified_function() -> None:
    assert unqualified(f'{TARGET}:live') == TARGET
    assert unqualified(TARGET) == TARGET


@dataclass
class FakeScheduler:
    created: list[dict[str, Any]] = field(default_factory=list)

    def create_schedule(self, **request: Any) -> dict[str, str]:
        if any(made['Name'] == request['Name'] for made in self.created):
            raise ClientError({'Error': {'Code': 'ConflictException', 'Message': 'exists'}}, 'CreateSchedule')
        self.created.append(request)
        return {'ScheduleArn': f'arn:aws:scheduler:us-east-1:111111111111:schedule/g/{request["Name"]}'}


def test_one_schedule_per_run_at_its_end_plus_the_delay_that_deletes_itself_after_it_runs() -> None:
    scheduler = FakeScheduler()
    schedule = ReactionsSchedule(scheduler, 'voc-engineering-reactions', SCHEDULER_ROLE, days=3)
    assert (schedule.create(RUN, TARGET, AT), schedule.create(RUN, TARGET, AT)) == (True, False)
    [made] = scheduler.created
    assert (made['Name'], made['GroupName'], made['ScheduleExpression']) == (
        f'{SCHEDULE_PREFIX}{RUN}', 'voc-engineering-reactions', 'at(2026-11-16T09:30:00)')
    assert (made['ActionAfterCompletion'], made['ScheduleExpressionTimezone'], made['FlexibleTimeWindow']) == (
        'DELETE', 'UTC', {'Mode': 'OFF'})
    assert made['Target'] == {'Arn': TARGET, 'RoleArn': SCHEDULER_ROLE, 'RetryPolicy': {'MaximumRetryAttempts': 0},
                              'Input': json.dumps({'action': 'reactions', 'run_id': RUN, 'asked_by': 'schedule'})}


def test_a_schedule_the_service_refuses_otherwise_is_raised() -> None:
    class Refusing:
        def create_schedule(self, **_: Any) -> None:
            raise ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'CreateSchedule')

    with pytest.raises(ClientError):
        ReactionsSchedule(Refusing(), 'g', SCHEDULER_ROLE).create(RUN, TARGET, AT)


@pytest.mark.parametrize(('raw', 'days'), [(None, DEFAULT_DELAY_DAYS), ('', DEFAULT_DELAY_DAYS), ('1', 1), ('30', 30)])
def test_the_delay_is_whole_days_from_one_to_thirty(raw: str | None, days: int) -> None:
    assert delay_days(raw) == days


@pytest.mark.parametrize('raw', ['0', '31', '2.5', 'soon', '-1'])
def test_a_delay_off_its_bounds_is_refused(raw: str) -> None:
    with pytest.raises(ValueError, match='1-30 whole days'):
        delay_days(raw)
