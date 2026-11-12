"""What a person reads of an engineering run: the board with its history, the conversation in pages, the reports."""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from engineering.reports.store import ReportStore
from engineering.test.run_fixture import RUN, TABLE, EngineeringRun, engineering_run
from engineering.views import EngineeringViews


@pytest.fixture
def run() -> Iterator[EngineeringRun]:
    with mock_aws():
        yield engineering_run()


@pytest.fixture
def views(run: EngineeringRun) -> EngineeringViews:
    return EngineeringViews(run.client, TABLE, run.workspace)


def test_the_board_shows_each_task_with_its_history(views: EngineeringViews, run: EngineeringRun) -> None:
    board = views.board(RUN)
    assert board is not None
    [task] = board['tasks']
    assert (task['task_id'], task['state'], task['lease']['agent']) == (run.task_id, 'claimed', 'fixer-1')
    assert [(m['state'], m['by'], m['op']) for m in task['history']] == [
        ('open', 'coordinator-0', 'post'), ('claimed', 'fixer-1', 'claim')]


def test_the_conversation_reads_in_pages(views: EngineeringViews) -> None:
    first = views.conversation(RUN, after=0, limit=2)
    assert first is not None
    assert [item['message']['summary'] for item in first['items']] == ['Message 0', 'Message 1']
    assert first['next_after'] == 2   # a full page moves on to its last seq
    rest = views.conversation(RUN, after=first['next_after'], limit=2)
    assert rest is not None
    assert ([item['seq'] for item in rest['items']], rest['next_after']) == ([3], 2)   # the tail: read again
    assert views.conversation(RUN, after=3, limit=2) == {'items': [], 'next_after': 3}


def test_a_message_that_commits_late_below_the_tail_is_still_read(views: EngineeringViews,
                                                                   run: EngineeringRun) -> None:
    # Seq 5 is taken before seq 6 but commits after it (two router invocations at once).
    for seq in (4, 6):
        run.client.put_item(TableName=TABLE, Item=_message_row(seq))
    page = views.conversation(RUN, after=3, limit=50)
    assert page is not None
    assert [item['seq'] for item in page['items']] == [4, 6]
    run.client.put_item(TableName=TABLE, Item=_message_row(5))
    again = views.conversation(RUN, after=page['next_after'], limit=50)
    assert again is not None
    assert 5 in [item['seq'] for item in again['items']]


def _message_row(seq: int) -> dict[str, Any]:
    return {'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': f'MSG#{seq:08d}'}, 'event_id': {'S': f'e{seq}'},
            'type': {'S': 'msg.question'}, 'at': {'S': '2026-11-12T09:00:00Z'}, 'message': {'S': '{}'}}


def test_the_reports_give_the_latest_written_version(views: EngineeringViews, run: EngineeringRun) -> None:
    store = ReportStore(run.client, TABLE, run.workspace)
    store.publish('default', RUN, 'goal', RUN, document=lambda v: ({'version': v}, f'v{v}'))
    assert views.reports(RUN) == {'items': [{'level': 'goal', 'subject': RUN, 'latest_version': 2}]}
    latest = views.report(RUN, 'goal', RUN, None)
    assert latest is not None
    assert (latest.document, latest.markdown) == ({'version': 2}, 'v2')
    first = views.report(RUN, 'goal', RUN, 1)
    assert first is not None
    assert first.markdown == '## Goal report (v1)\n'


@pytest.mark.parametrize(('level', 'subject', 'version'), [
    ('goal', RUN, 3), ('goal', RUN, 0), ('pr', '42', None), ('weekly', RUN, None), ('goal', '../x', None),
])
def test_a_report_that_is_not_there_is_none(views: EngineeringViews, level: str, subject: str,
                                            version: int | None) -> None:
    assert views.report(RUN, level, subject, version) is None


def test_a_version_counted_but_not_written_is_not_offered(views: EngineeringViews, run: EngineeringRun) -> None:
    run.client.update_item(TableName=TABLE, Key={'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': 'REPORT#pr#9'}},
                           UpdateExpression='ADD versions :one', ExpressionAttributeValues={':one': {'N': '1'}})
    reports = views.reports(RUN)
    assert reports is not None
    assert [item['level'] for item in reports['items']] == ['goal']
    run.s3.delete_object(Bucket='voc-engineering-workspace', Key=f'ws/default/reports/{RUN}/goal/{RUN}/v0001.md')
    assert views.report(RUN, 'goal', RUN, 1) is None


def test_an_unknown_run_reads_as_none(views: EngineeringViews) -> None:
    assert views.board('no-run') is None
    assert views.conversation('no-run', after=0, limit=5) is None
    assert views.reports('no-run') is None


def test_a_failed_pointer_update_that_is_not_a_race_is_raised(run: EngineeringRun) -> None:
    client: Any = MagicMock()
    client.update_item.side_effect = [{'Attributes': {'versions': {'N': '1'}}},
                                      ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'slow'}},
                                                  'UpdateItem')]
    with pytest.raises(ClientError):
        ReportStore(client, TABLE, run.workspace).publish('default', 'other-run', 'goal', 'other-run',
                                                          document=lambda v: ({'version': v}, 'md'))


def test_a_racing_older_version_does_not_become_the_latest(run: EngineeringRun) -> None:
    store = ReportStore(run.client, TABLE, run.workspace)
    run.client.update_item(TableName=TABLE, Key={'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': f'REPORT#goal#{RUN}'}},
                           UpdateExpression='SET latest_version = :v', ExpressionAttributeValues={':v': {'N': '5'}})
    store.publish('default', RUN, 'goal', RUN, document=lambda v: ({'version': v}, f'v{v}'))
    assert [entry.latest_version for entry in store.index('default', RUN)] == [5]
