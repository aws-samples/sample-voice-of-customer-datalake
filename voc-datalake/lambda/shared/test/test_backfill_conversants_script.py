"""``scripts/conversations/backfill_conversants.py``: list the owners of the workspace conversations kept before 7.19.00.

Against moto: a dry run writes nothing; ``--apply`` lists each owner of a ``WS#{ws}#USER#{sub}`` conversation once,
with their earliest ``created_at``, through the chat routes' own writer, and nobody for the deployment's ``USER#``
partitions, a Stop marker alone or a malformed key; a second run lists nobody (idempotent), and a row a save wrote
meanwhile is kept. Lives under ``lambda/`` so the default ``testpaths`` runs it; the script is loaded by path.
"""
from __future__ import annotations

import sys

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws

from shared.test.repo_paths import load_module_from_path, repo_root

_SCRIPT = repo_root() / 'scripts' / 'conversations' / 'backfill_conversants.py'
WS_A = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
WS_B = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D9'
NOW = '2026-11-13T12:00:00+00:00'


@pytest.fixture(scope='module')
def backfill():
    module = load_module_from_path('backfill_conversants', _SCRIPT)
    try:
        yield module
    finally:
        sys.modules.pop(module.__name__, None)


@pytest.fixture
def table():
    with mock_aws():
        yield boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='conversations', BillingMode='PAY_PER_REQUEST',
            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
            AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                                  {'AttributeName': 'sk', 'AttributeType': 'S'}])


def _seed(table) -> None:
    rows = [
        (f'WS#{WS_A}#USER#sub-ada', 'CONV#c1', '2026-10-02T00:00:00+00:00'),
        (f'WS#{WS_A}#USER#sub-ada', 'CONV#c2', '2026-09-30T00:00:00+00:00'),
        (f'WS#{WS_A}#USER#sub-ada', 'RUNCANCEL#c2', None),
        (f'WS#{WS_A}#USER#sub-cal', 'CONV#c3', None),
        (f'WS#{WS_B}#USER#sub-bea', 'CONV#c4', '2026-10-05T00:00:00+00:00'),
        (f'WS#{WS_B}#USER#sub-dov', 'RUNCANCEL#c5', None),
        ('USER#sub-ada', 'CONV#c6', '2026-01-01T00:00:00+00:00'),
        ('WS#not-a-workspace#USER#sub-eve', 'CONV#c7', '2026-10-01T00:00:00+00:00'),
        (f'WS#{WS_A}#OTHER#sub-ada', 'CONV#c8', '2026-10-01T00:00:00+00:00'),
        ('AUDIT#delete', 'CONV#c9', '2026-10-01T00:00:00+00:00'),
    ]
    for pk, sk, created in rows:
        table.put_item(Item={'pk': pk, 'sk': sk, **({'created_at': created} if created else {})})


def _conversants(table, ws: str) -> dict[str, str]:
    items = table.query(KeyConditionExpression=Key('pk').eq(f'WS#{ws}#CONVERSANTS'))['Items']
    return {str(item['sk']): str(item['first_at']) for item in items}


def _everything(table) -> list[dict]:
    return sorted(table.scan()['Items'], key=lambda item: (item['pk'], item['sk']))


def test_a_dry_run_reports_each_owner_and_writes_nothing(backfill, table):
    _seed(table)
    before = _everything(table)
    lines: list[str] = []
    report = backfill.run(table, apply=False, now=lambda: NOW, out=lines.append)
    assert (report.conversations, report.owners, report.listed, report.already_listed, report.skipped) == (4, 3, 3, 0, 2)
    assert lines == [f'{WS_A}  sub-ada  first_at 2026-09-30T00:00:00+00:00', f'{WS_A}  sub-cal  first_at {NOW}',
                     f'{WS_B}  sub-bea  first_at 2026-10-05T00:00:00+00:00']
    assert _everything(table) == before


def test_apply_lists_each_owner_once_with_their_first_conversation(backfill, table):
    _seed(table)
    before = _everything(table)
    report = backfill.run(table, apply=True, now=lambda: NOW, out=lambda _line: None)
    assert (report.listed, report.already_listed) == (3, 0)
    assert _conversants(table, WS_A) == {'sub-ada': '2026-09-30T00:00:00+00:00', 'sub-cal': NOW}
    assert _conversants(table, WS_B) == {'sub-bea': '2026-10-05T00:00:00+00:00'}
    # Nothing else changed: only the owner rows were added.
    after = [item for item in _everything(table) if not str(item['pk']).endswith('#CONVERSANTS')]
    assert after == before


def test_a_second_run_lists_nobody(backfill, table):
    _seed(table)
    backfill.run(table, apply=True, now=lambda: NOW, out=lambda _line: None)
    once = _everything(table)
    report = backfill.run(table, apply=True, now=lambda: '2027-01-01T00:00:00+00:00', out=lambda _line: None)
    assert (report.owners, report.listed, report.already_listed) == (3, 0, 3)
    assert _everything(table) == once
    dry = backfill.run(table, apply=False, now=lambda: NOW, out=lambda _line: None)
    assert (dry.listed, dry.already_listed) == (0, 3)


def test_a_row_a_save_wrote_meanwhile_is_kept(backfill, table):
    _seed(table)
    table.put_item(Item={'pk': f'WS#{WS_A}#CONVERSANTS', 'sk': 'sub-ada', 'first_at': '2026-11-13T08:00:00+00:00'})
    report = backfill.run(table, apply=True, now=lambda: NOW, out=lambda _line: None)
    assert (report.listed, report.already_listed) == (2, 1)
    assert _conversants(table, WS_A)['sub-ada'] == '2026-11-13T08:00:00+00:00'


def test_an_empty_table_lists_nobody(backfill, table):
    report = backfill.run(table, apply=True, now=lambda: NOW, out=lambda _line: None)
    assert (report.conversations, report.owners, report.listed) == (0, 0, 0)
    assert _everything(table) == []


@pytest.mark.parametrize('partition', ['USER#sub-ada', f'WS#{WS_A}#USER#', f'WS#{WS_A}#CONVERSANTS', 'WS#x#USER#a', None])
def test_only_a_members_conversation_partition_names_an_owner(backfill, partition):
    assert backfill.owner_of(partition) is None


def test_the_owner_of_a_member_partition(backfill):
    owner = backfill.owner_of(f'WS#{WS_A}#USER#sub-ada')
    assert (owner.scope.ws, owner.sub) == (WS_A, 'sub-ada')


def test_the_command_line_is_a_dry_run_by_default(backfill):
    assert backfill.parse_args(['--conversations-table', 't']).apply is False
    assert backfill.parse_args(['--conversations-table', 't', '--apply']).apply is True


class _Stack:
    def __init__(self, outputs: list[dict]):
        self.outputs = outputs
        self.asked: list[str] = []

    def describe_stacks(self, StackName: str) -> dict:
        self.asked.append(StackName)
        return {'Stacks': [{'Outputs': self.outputs}]}


def test_the_table_is_the_flag_else_the_core_stack_output(backfill, monkeypatch):
    monkeypatch.delenv('CONVERSATIONS_TABLE', raising=False)
    stack = _Stack([{'OutputKey': 'FeedbackTableName', 'OutputValue': 'fb'},
                    {'OutputKey': 'ConversationsTableName', 'OutputValue': 'conv-out'}])
    assert backfill.table_name(backfill.parse_args(['--conversations-table', 'conv-flag']), stack) == 'conv-flag'
    assert stack.asked == []
    assert backfill.table_name(backfill.parse_args(['--stack', 'MyCore']), stack) == 'conv-out'
    assert stack.asked == ['MyCore']
    with pytest.raises(SystemExit, match='ConversationsTableName'):
        backfill.table_name(backfill.parse_args([]), _Stack([]))


def test_the_summary_says_what_was_or_would_be_listed(backfill):
    report = backfill.Report(conversations=4, owners=3, listed=2, already_listed=1, skipped=2)
    assert backfill.summary(report, True) == (
        '4 workspace conversations, 3 owners: listed 2, 1 already listed, 2 other WS# rows left alone')
    assert 'would list (dry run; --apply writes) 2' in backfill.summary(report, False)
