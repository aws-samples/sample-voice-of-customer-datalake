"""A triage run's end (runtime/triage_end.py, 7.50.00): its understander's recorded voc-triage/1 copied, create-only,
to the issue's trusted row in voc-agents (moto)."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import boto3
import pytest
from moto import mock_aws

from engineering.runtime import triage_end
from engineering.runtime.triage_end import (
    INVALID,
    KEPT,
    NO_ISSUE,
    NO_TRIAGE,
    NOT_ENDED,
    WRITTEN,
    copy_triage,
    copy_triage_at_end,
)
from shared import agents_store

RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0AB'
SHA = 'a' * 40
REPO = 'example-org/shop'
TABLE, AGENTS = 'voc-engineering-test', 'voc-agents-test'
KEY = f'ws/default/runs/{RUN}/understander-2/commits/{SHA}/_triage/attempt-1/triage.json'
TRIAGE = {'kind': 'bug', 'severity': 'S2', 'priority': 'P2', 'summary': 'divide(7, 2) floors to 3',
          'paths': ['src/calc.py'], 'acceptance_criteria': ['divide(7, 2) == 3.5']}
NOW = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)


@dataclass
class Workspace:
    objects: dict[str, bytes] = field(default_factory=dict)
    asked: list[str] = field(default_factory=list)

    def read_bytes(self, key: str, limit: int) -> bytes | None:
        self.asked.append(key)
        body = self.objects.get(key)
        return None if body is None else body[:limit]


@pytest.fixture
def client() -> Iterator[Any]:
    with mock_aws():
        dynamodb = boto3.client('dynamodb', region_name='us-east-1')
        for name in (TABLE, AGENTS):
            dynamodb.create_table(TableName=name, BillingMode='PAY_PER_REQUEST',
                                  KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'},
                                             {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
                                  AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                                                        {'AttributeName': 'sk', 'AttributeType': 'S'}])
        yield dynamodb


def _meta(client: Any, *, status: str = 'done', issue: bool = True) -> None:
    item: dict[str, Any] = {'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': 'META'}, 'run_id': {'S': RUN},
                            'status': {'S': status}, 'repo': {'S': REPO}}
    if issue:
        item['issue'] = {'M': {'host': {'S': 'github'}, 'number': {'N': '42'}, 'verified': {'BOOL': True},
                               'url': {'S': f'https://github.com/{REPO}/issues/42'}}}
    client.put_item(TableName=TABLE, Item=item)


def _task(client: Any, task_id: str, *, role: str = 'understander', state: str = 'done',
          keys: tuple[str, ...] = (KEY,), updated_at: str = '2026-11-16T10:00:00+00:00') -> None:
    item: dict[str, Any] = {'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': f'TASK#{task_id}'},
                            'task_id': {'S': task_id}, 'role': {'S': role}, 'state': {'S': state},
                            'attempt': {'N': '1'}, 'updated_at': {'S': updated_at}}
    if keys:
        item['result_keys'] = {'SS': list(keys)}
    client.put_item(TableName=TABLE, Item=item)


def _copy(client: Any, workspace: Workspace) -> str:
    return copy_triage(RUN, client=client, table=TABLE, workspace=workspace, agents_table=AGENTS, now=NOW)


def _row(client: Any) -> dict[str, Any] | None:
    key = agents_store.issue_triage_key(REPO, 42)
    return client.get_item(TableName=AGENTS, Key={name: {'S': value} for name, value in key.items()}).get('Item')


def test_the_understanders_triage_becomes_the_issues_trusted_row_once(client: Any) -> None:
    _meta(client)
    _task(client, 'triage-1')
    workspace = Workspace({KEY: json.dumps(TRIAGE).encode()})
    assert _copy(client, workspace) == WRITTEN
    row = _row(client)
    assert row is not None
    assert {name: row[name]['S'] for name in ('kind', 'severity', 'priority', 'run_id', 'task_id', 'agent_id',
                                               'repository', 'written_by')} == {
        'kind': 'bug', 'severity': 'S2', 'priority': 'P2', 'run_id': RUN, 'task_id': 'triage-1',
        'agent_id': 'understander-2', 'repository': REPO, 'written_by': 'voc-engineering-runtime'}
    assert json.loads(row['triage']['S'])['schema'] == 'voc-triage/1'
    assert row['written_at']['S'] == NOW.isoformat()
    # The heartbeat's read of it (shared/agents_store.py).
    assert _copy(client, Workspace({KEY: json.dumps({**TRIAGE, 'kind': 'feature'}).encode()})) == KEPT
    assert _row(client)['kind']['S'] == 'bug'   # (D1: the first triage stands)


@pytest.mark.parametrize(('status', 'issue', 'outcome'), [
    ('active', True, NOT_ENDED), ('needs_human', True, NOT_ENDED), ('done', False, NO_ISSUE)])
def test_only_an_ended_run_of_an_issue_writes_one(client: Any, status: str, issue: bool, outcome: str) -> None:
    _meta(client, status=status, issue=issue)
    _task(client, 'triage-1')
    workspace = Workspace({KEY: json.dumps(TRIAGE).encode()})
    assert _copy(client, workspace) == outcome
    assert workspace.asked == []
    assert _row(client) is None


@pytest.mark.parametrize('task', [
    {'role': 'hunter'}, {'state': 'failed'}, {'keys': ()},
    {'keys': (KEY.replace('understander-2', 'hunter-2'),)},
    {'keys': (KEY.replace(RUN, '01JD3R4NZXQ7Y2W8K4M6P9T0AC'),)},
    {'keys': (KEY.replace('triage.json', 'other.json'),)},
    {'keys': (KEY.replace('_triage', '_gate'),)},
])
def test_only_a_done_understanders_own_triage_of_this_run_counts(client: Any, task: dict[str, Any]) -> None:
    _meta(client)
    _task(client, 'triage-1', **task)
    assert _copy(client, Workspace({KEY: json.dumps(TRIAGE).encode()})) == NO_TRIAGE
    assert _row(client) is None


def test_the_newest_understanders_triage_is_the_one_copied(client: Any) -> None:
    _meta(client)
    older = KEY.replace('understander-2', 'understander-1')
    _task(client, 'triage-1', keys=(older,), updated_at='2026-11-16T09:00:00+00:00')
    _task(client, 'triage-2')
    workspace = Workspace({older: json.dumps({**TRIAGE, 'kind': 'feature'}).encode(),
                           KEY: json.dumps(TRIAGE).encode()})
    assert _copy(client, workspace) == WRITTEN
    assert (_row(client)['kind']['S'], _row(client)['task_id']['S']) == ('bug', 'triage-2')


@pytest.mark.parametrize(('body', 'outcome'), [
    (None, NO_TRIAGE), (b'not json', INVALID), (json.dumps({**TRIAGE, 'kind': 'chore'}).encode(), INVALID)])
def test_a_missing_or_off_shape_record_writes_nothing(client: Any, body: bytes | None, outcome: str) -> None:
    _meta(client)
    _task(client, 'triage-1')
    assert _copy(client, Workspace({} if body is None else {KEY: body})) == outcome
    assert _row(client) is None


def test_a_failure_is_logged_and_answered_never_raised(client: Any) -> None:
    _meta(client)
    _task(client, 'triage-1')
    workspace = Workspace({KEY: json.dumps(TRIAGE).encode()})
    assert copy_triage(RUN, client=client, table=TABLE, workspace=workspace, agents_table='no-such-table',
                       now=NOW) == 'failed'


def test_without_its_settings_the_end_copies_nothing_and_goes_on(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ('ENGINEERING_TABLE', 'ENGINEERING_WORKSPACE_BUCKET', 'ENGINEERING_SETTINGS_TABLE'):
        monkeypatch.delenv(name, raising=False)
    assert copy_triage_at_end(RUN) == 'failed'
    assert triage_end.WRITER == 'voc-engineering-runtime'
