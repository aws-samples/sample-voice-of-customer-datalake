"""A Tenets run's end (7.52.00, runtime/tenets_end.py) and the triage's hard lock at a triage run's end
(runtime/triage_end.py), on moto: the understander's recorded tenets drafted once, and a triage citing a tenet that
is not accepted refused."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import boto3
import pytest
from moto import mock_aws

from engineering.knowledge.store import Actor
from engineering.knowledge.tenets import TenetsStore
from engineering.runtime.tenets_end import (
    DRAFTED,
    INVALID,
    KEPT,
    NO_CONNECTION,
    NO_TENETS,
    NOT_ENDED,
    draft_tenets,
    draft_tenets_at_end,
)
from engineering.runtime.triage_end import UNACCEPTED_TENET, WRITTEN, copy_triage

RUN = '01JD3R4NZXQ7Y2W8K4M6P9T0AB'
SHA = 'a' * 40
CONN = 'conn-harbor'
TABLE, AGENTS = 'voc-engineering-test', 'voc-agents-test'
KEY = f'ws/default/runs/{RUN}/understander-2/commits/{SHA}/_tenets/attempt-1/tenets.json'
TRIAGE_KEY = f'ws/default/runs/{RUN}/understander-2/commits/{SHA}/_triage/attempt-1/triage.json'
RECORD = {'summary': 'What the code holds to.', 'tenets': [
    {'id': 'T1', 'title': 'Fail closed', 'statement': 'Refuse an unknown state; mail ops@harbor-mail.net.',
     'citations': ['src/gate.py:12']}]}
ADMIN = Actor('admin-sub-1', 'person', admin=True)
NOW = datetime(2026, 11, 17, 12, 0, tzinfo=UTC)


@dataclass
class Workspace:
    objects: dict[str, bytes] = field(default_factory=dict)

    def read_bytes(self, key: str, limit: int) -> bytes | None:
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


def _meta(client: Any, *, status: str = 'done', connection: str = CONN, issue: bool = False) -> None:
    item: dict[str, Any] = {'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': 'META'}, 'run_id': {'S': RUN},
                            'status': {'S': status}, 'repo': {'S': 'example-org/harbor'}}
    if connection:
        item['connection'] = {'S': connection}
    if issue:
        item['issue'] = {'M': {'host': {'S': 'github'}, 'number': {'N': '42'}, 'verified': {'BOOL': True},
                               'url': {'S': 'https://github.com/example-org/harbor/issues/42'}}}
    client.put_item(TableName=TABLE, Item=item)


def _task(client: Any, keys: tuple[str, ...], *, role: str = 'understander', state: str = 'done') -> None:
    client.put_item(TableName=TABLE, Item={
        'pk': {'S': f'WS#default#RUN#{RUN}'}, 'sk': {'S': 'TASK#task-1'}, 'task_id': {'S': 'task-1'},
        'role': {'S': role}, 'state': {'S': state}, 'attempt': {'N': '1'},
        'updated_at': {'S': '2026-11-17T10:00:00+00:00'}, 'result_keys': {'SS': list(keys)}})


def _draft(client: Any, workspace: Workspace) -> str:
    return draft_tenets(RUN, client=client, table=TABLE, workspace=workspace, store=TenetsStore(client, TABLE))


def test_the_understanders_tenets_become_a_draft_once(client: Any) -> None:
    _meta(client)
    _task(client, (KEY,))
    workspace = Workspace({KEY: json.dumps(RECORD).encode()})
    assert _draft(client, workspace) == DRAFTED
    assert _draft(client, workspace) == KEPT   # (the run's row: once)
    store = TenetsStore(client, TABLE)
    (version,) = store.versions('default', CONN)
    assert (version.version, version.status, version.author, version.run_id, version.ids) == (
        1, 'draft', 'understander-2', RUN, ('T1',))
    statement = version.record['tenets'][0]['statement']
    assert 'ops@harbor-mail.net' not in statement   # (personal data replaced before it is stored)


@pytest.mark.parametrize(('setup', 'answer'), [
    ({'status': 'active'}, NOT_ENDED), ({'connection': ''}, NO_CONNECTION), ({'keys': ()}, NO_TENETS),
    ({'role': 'hunter'}, NO_TENETS), ({'state': 'failed'}, NO_TENETS), ({'body': b'not json'}, INVALID),
    ({'body': json.dumps({'tenets': []}).encode()}, INVALID), ({'body': None}, NO_TENETS),
])
def test_nothing_is_drafted_without_an_ended_runs_recorded_tenets(client: Any, setup: dict[str, Any],
                                                                  answer: str) -> None:
    _meta(client, status=setup.get('status', 'done'), connection=setup.get('connection', CONN))
    keys = setup.get('keys', (KEY,))
    if keys:
        _task(client, keys, role=setup.get('role', 'understander'), state=setup.get('state', 'done'))
    body = setup.get('body', json.dumps(RECORD).encode())
    assert _draft(client, Workspace({} if body is None else {KEY: body})) == answer
    assert TenetsStore(client, TABLE).versions('default', CONN) == []


def test_the_end_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('ENGINEERING_TABLE', raising=False)
    assert draft_tenets_at_end(RUN) == 'failed'


TRIAGE = {'schema': 'voc-triage/1', 'kind': 'bug', 'severity': 'S2', 'priority': 'P2', 'summary': 'floors',
          'paths': ['calc.py'], 'acceptance_criteria': ['divide(7, 2) == 3.5']}


def _copy(client: Any, cited: list[str]) -> str:
    _meta(client, issue=True)
    _task(client, (TRIAGE_KEY,))
    workspace = Workspace({TRIAGE_KEY: json.dumps({**TRIAGE, 'tenets': cited}).encode()})
    return copy_triage(RUN, client=client, table=TABLE, workspace=workspace, agents_table=AGENTS, now=NOW)


def _issue_row(client: Any) -> Any:
    return client.get_item(TableName=AGENTS, Key={'pk': {'S': 'ISSUE_TRIAGE#default'},
                                                  'sk': {'S': 'example-org/harbor#42'}}).get('Item')


def test_with_no_accepted_tenets_a_triage_citing_one_is_refused(client: Any) -> None:
    assert _copy(client, ['T1']) == UNACCEPTED_TENET
    assert _issue_row(client) is None


def test_a_triage_citing_only_accepted_tenets_is_kept_and_one_citing_another_refused(client: Any) -> None:
    store = TenetsStore(client, TABLE)
    store.draft('default', CONN, RECORD, author=Actor('understander-2', 'agent', connection=CONN))
    store.accept('default', CONN, 1, ADMIN)
    assert _copy(client, ['T1', 'T7']) == UNACCEPTED_TENET
    assert _issue_row(client) is None
    assert _copy(client, ['T1']) == WRITTEN
    assert json.loads(_issue_row(client)['triage']['S'])['tenets'] == ['T1']


def test_a_triage_citing_none_needs_no_accepted_tenets(client: Any) -> None:
    assert _copy(client, []) == WRITTEN
