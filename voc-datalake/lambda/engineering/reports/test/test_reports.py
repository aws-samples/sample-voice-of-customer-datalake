"""Reports end to end on moto: a run's table rows, its tasks' result keys and their objects, built through the handler."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws

from engineering.board.model import Task
from engineering.board.store import BoardStore
from engineering.board.test.table import RUN, TABLE, engineering_table
from engineering.quality_gate.test.test_record import _record
from engineering.reports import handler as handler_module
from engineering.reports.build import gather
from engineering.reports.facts import FactsReader
from engineering.reports.handler import Reports, handler
from engineering.reports.store import ReportError
from engineering.workspace.store import WorkspaceStore

BUCKET = 'voc-engineering-workspace'
SHA, OTHER = 'a1b2c3d4' * 5, 'f6e5d4c3' * 5
PK = f'WS#default#RUN#{RUN}'


def finding(**changes: Any) -> str:
    return json.dumps({'schema': 'voc-finding/1', 'file': 'src/paging.py', 'line': 12, 'severity': 'blocking',
                       'rule': 'off-by-one', 'title': 'The last page is dropped', 'evidence': 'range(n - 1)',
                       **changes})


def shard(agent: str, sha: str, package: str = 'core') -> str:
    return f'ws/default/runs/{RUN}/{agent}/commits/{sha}/{package}/attempt-1/shard-0.jsonl'


@dataclass
class Run:
    client: Any
    s3: Any
    reports: Reports


def _task(board: BoardStore, role: str, title: str, agent: str, keys: list[str], to: str = 'done') -> None:
    task = board.post('default', RUN, role=role, title=title, spec={'title': title}, parent_task='', priority=0,
                      actor='coordinator-0').task
    board.claim('default', RUN, task.task_id, role=role, agent=agent)
    board.move('default', RUN, task.task_id, agent=agent, epoch=1, to_state='in_progress', result_keys=[])
    board.move('default', RUN, task.task_id, agent=agent, epoch=1, to_state=to, result_keys=keys)


@pytest.fixture
def run() -> Iterator[Run]:
    with engineering_table() as client:
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        client.update_item(TableName=TABLE, Key={'pk': {'S': PK}, 'sk': {'S': 'META'}},
                           UpdateExpression='SET goal = :g, repo = :r, flow = :f, #s = :s, started_at = :a, ended_at = :b',
                           ExpressionAttributeNames={'#s': 'status'},
                           ExpressionAttributeValues={':g': {'S': 'Fix the page size bug'}, ':r': {'S': 'acme/shop'},
                                                      ':f': {'S': 'bug-hunt'}, ':s': {'S': 'ended'},
                                                      ':a': {'S': '2026-11-12T09:00:00+00:00'},
                                                      ':b': {'S': '2026-11-12T09:30:00+00:00'}})
        for agent, role, cost in (('hunter-1', 'hunter', '0.25'), ('final-go-2', 'final-go', '0.5')):
            client.put_item(TableName=TABLE, Item={
                'pk': {'S': PK}, 'sk': {'S': f'AGENT#{agent}'}, 'role': {'S': role}, 'skill_version': {'S': 'v3'},
                'model': {'S': 'model-a'}, 'microvm_seconds': {'N': '60'}, 'input_tokens': {'N': '1000'},
                'output_tokens': {'N': '200'}, 'cost_usd': {'N': cost}})
        for seq in range(3):
            client.put_item(TableName=TABLE, Item={'pk': {'S': PK}, 'sk': {'S': f'MSG#{seq:08d}'}})
        s3.put_object(Bucket=BUCKET, Key=shard('hunter-1', SHA), Body='\n'.join(
            [finding(), finding(severity='nit', line=3), 'off the schema']).encode())
        s3.put_object(Bucket=BUCKET, Key=shard('hunter-1', OTHER, 'crates=2Fweb'), Body=finding(file='web.rs').encode())
        gate_key = f'ws/default/runs/{RUN}/final-go-2/commits/{SHA}/_gate/attempt-1/record.json'
        s3.put_object(Bucket=BUCKET, Key=gate_key, Body=json.dumps(_record().to_dict()).encode())
        board = BoardStore(client, TABLE, new_id=iter(f'task-{n}' for n in range(1, 99)).__next__)
        _task(board, 'hunter', 'Hunt the paging module', 'hunter-1', [shard('hunter-1', SHA),
                                                                       shard('hunter-1', OTHER, 'crates=2Fweb')])
        _task(board, 'final-go', 'Final go', 'final-go-2', [gate_key])
        yield Run(client, s3, Reports(client, TABLE, WorkspaceStore(s3, BUCKET)))


def stored(run: Run, key: str) -> str:
    return run.s3.get_object(Bucket=BUCKET, Key=key)['Body'].read().decode()


def test_the_pr_report_carries_the_findings_the_cost_the_agents_and_the_gate(run: Run) -> None:
    answer = run.reports.build(RUN, 'pr', '42', SHA)
    assert answer == {'status': 'published', 'version': 1, 'key': f'ws/default/reports/{RUN}/pr/42/v0001.json',
                      'markdown_key': f'ws/default/reports/{RUN}/pr/42/v0001.md'}
    report = json.loads(stored(run, answer['key']))
    assert report['findings']['total'] == 3
    assert report['findings']['skipped_lines'] == 1
    assert {f['package'] for f in report['findings']['top']} == {'core', 'crates/web'}
    assert report['head'] == SHA
    assert report['findings']['top'][0]['severity'] == 'blocking'
    assert report['cost'] == {'events': 3, 'microvm_seconds': 120, 'input_tokens': 2000, 'output_tokens': 400,
                              'usd': '0.75'}
    assert report['time']['seconds'] == 1800
    assert [a['skill_version'] for a in report['agents']] == ['v3', 'v3']
    assert report['gate'] == {'verdict': 'GO', 'tree_hash': 'b' * 40, 'rounds': 3, 'max_rounds': 3,
                              'final_go': 'GO', 'open_blocking': 0}
    assert [task['role'] for task in report['tasks']['tree']] == ['hunter', 'final-go']
    hunt = report['tasks']['tree'][0]['history']
    assert [(m['state'], m['by'], m['op'], m['result_keys']) for m in hunt] == [
        ('open', 'coordinator-0', 'post', 0), ('claimed', 'hunter-1', 'claim', 0),
        ('in_progress', 'hunter-1', 'move', 0), ('done', 'hunter-1', 'move', 2)]
    markdown = stored(run, answer['key'].replace('.json', '.md'))
    assert markdown.startswith('## Pull request report: `42` (v1)')
    assert '## Quality gate' in markdown
    assert 'The last page is dropped' in markdown


def test_a_key_recorded_on_two_tasks_is_counted_once(run: Run) -> None:
    board = BoardStore(run.client, TABLE, new_id=lambda: 'task-again')
    _task(board, 'hunter', 'Hunt the paging module again', 'hunter-1', [shard('hunter-1', SHA)])
    report = json.loads(stored(run, run.reports.build(RUN, 'goal', RUN)['key']))
    assert (report['findings']['total'], report['findings']['skipped_lines']) == (3, 1)


def test_each_build_is_a_new_version(run: Run) -> None:
    assert run.reports.build(RUN, 'goal', RUN)['version'] == 1
    second = run.reports.build(RUN, 'goal', RUN)
    assert second['version'] == 2
    assert json.loads(stored(run, second['key']))['gate'] is None


def test_a_commit_report_covers_its_commit_only(run: Run) -> None:
    report = json.loads(stored(run, run.reports.build(RUN, 'commit', OTHER)['key']))
    assert (report['findings']['total'], report['findings']['skipped_lines']) == (1, 0)
    assert 'tree' not in report['tasks']
    assert report['tasks']['by_state'] == {'done': 2}
    own = json.loads(stored(run, run.reports.build(RUN, 'commit', SHA)['key']))
    assert (own['findings']['total'], own['findings']['skipped_lines'], own['gate']) == (2, 1, None)


def test_a_pr_report_takes_only_the_gate_record_of_its_head(run: Run) -> None:
    report = json.loads(stored(run, run.reports.build(RUN, 'pr', '43', OTHER)['key']))
    assert report['gate'] is None


def test_a_version_the_bucket_already_has_is_refused(run: Run) -> None:
    run.reports.build(RUN, 'goal', RUN)
    run.client.delete_item(TableName=TABLE, Key={'pk': {'S': PK}, 'sk': {'S': f'REPORT#goal#{RUN}'}})
    with pytest.raises(ReportError, match='already exists'):
        run.reports.build(RUN, 'goal', RUN)


def test_a_report_of_no_run_or_a_bad_request_is_refused(run: Run, monkeypatch: pytest.MonkeyPatch) -> None:
    assert run.reports.build('no-run', 'goal', 'no-run') == {'status': 'refused', 'reason': 'no such run'}
    monkeypatch.setattr(handler_module, '_reports', run.reports)
    for event in ({}, {'run_id': RUN, 'level': 'pr', 'subject': '0', 'head': SHA},
                  {'run_id': RUN, 'level': 'pr', 'subject': '42'}, {'run_id': RUN, 'level': 'goal', 'subject': 'x'},
                  {'run_id': RUN, 'level': 'commit', 'subject': SHA[:7]}, {'run_id': '../x', 'level': 'goal'},
                  {'run_id': RUN, 'level': 'commit', 'subject': SHA, 'head': SHA}, {'run_id': 7, 'level': 'goal'}):
        assert handler(event, None)['status'] == 'refused'
    assert handler({'run_id': RUN, 'level': 'pr', 'subject': '42', 'head': SHA}, None)['version'] == 1


def test_a_gate_record_off_the_schema_or_not_from_final_go_is_left_out(run: Run) -> None:
    run.s3.put_object(Bucket=BUCKET, Key=f'ws/default/runs/{RUN}/final-go-2/commits/{SHA}/_gate/attempt-1/record.json',
                      Body=b'{"schema": "voc-gate-record/1", "verdict": 3}')
    report = json.loads(stored(run, run.reports.build(RUN, 'pr', '7', SHA)['key']))
    assert report['gate'] is None
    assert '## Quality gate' not in stored(run, f'ws/default/reports/{RUN}/pr/7/v0001.md')


def _gate_task(role: str, state: str, attempt: int, agent: str = 'final-go-2', ended: str = '',
               sha: str = SHA) -> Task:
    key = f'ws/default/runs/{RUN}/{agent}/commits/{sha}/_gate/attempt-{attempt}/record.json'
    return Task(task_id=f't-{role}-{state}-{attempt}-{ended}', role=role, state=state, title='Final go', spec='{}',
                spec_hash='h', depth=0, priority=0, attempt=attempt, result_keys=(key,), updated_at=ended)


def test_the_gate_record_comes_from_an_ended_final_go_task_and_its_latest_attempt() -> None:
    facts = FactsReader(MagicMock(), TABLE)
    facts.client.get_item.return_value = {'Item': {}}
    facts.client.query.return_value = {'Items': [], 'Count': 0}
    run_facts = facts.read('default', RUN)
    assert run_facts is not None

    def record(verdict: str, accepted_by: str = '') -> str:
        return json.dumps(_record(verdict=verdict, accepted_by=accepted_by).to_dict())

    texts = {_gate_task('final-go', 'done', 1).result_keys[0]: record('NO-GO'),
             _gate_task('final-go', 'done', 2).result_keys[0]: record('GO'),
             _gate_task('hunter', 'done', 3, agent='hunter-1').result_keys[0]: record('GO', 'a hunter')}
    reads: list[str] = []

    def read(key: str) -> str | None:
        reads.append(key)
        return texts.get(key)

    def gate_of(*tasks: Task, head: str = SHA) -> str | None:
        found = gather(run_facts, tasks, read, head=head).gate
        return None if found is None else f'{found.verdict}{found.accepted_by}'

    assert gate_of(_gate_task('final-go', 'done', 1), _gate_task('final-go', 'done', 2)) == 'GO'
    assert gate_of(_gate_task('final-go', 'done', 2), _gate_task('final-go', 'done', 1)) == 'GO'
    # Across tasks, the last to end wins, whatever its attempt.
    assert gate_of(_gate_task('final-go', 'done', 2, ended='2026-11-12T09:00:00'),
                   _gate_task('final-go', 'done', 1, ended='2026-11-12T10:00:00')) == 'NO-GO'
    reads.clear()
    assert gate_of(_gate_task('hunter', 'done', 3, agent='hunter-1')) is None
    assert gate_of(_gate_task('final-go', 'in_review', 1)) is None
    assert gate_of(_gate_task('final-go', 'done', 2), head=OTHER) is None
    assert reads == []   # nothing the report does not use is read
    # A stopped gate counts too; who accepted the change comes from the run's decision, never the agent's record.
    texts[_gate_task('final-go', 'needs_human', 1).result_keys[0]] = record('STOPPED', 'an owner')
    assert gate_of(_gate_task('final-go', 'needs_human', 1)) == 'STOPPED'


def test_the_handler_builds_its_clients_from_the_environment(run: Run, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(handler_module, '_reports', None)
    monkeypatch.setenv('ENGINEERING_TABLE', TABLE)
    monkeypatch.setenv('ENGINEERING_WORKSPACE_BUCKET', BUCKET)
    with patch('shared.aws.get_dynamodb_client', return_value=run.client), \
            patch('shared.aws.get_s3_client', return_value=run.s3):
        assert handler({'run_id': RUN, 'level': 'goal', 'subject': RUN}, None)['status'] == 'published'
    monkeypatch.setattr(handler_module, '_reports', None)


def test_a_recorded_key_whose_object_is_gone_and_times_that_do_not_parse(run: Run) -> None:
    run.s3.delete_object(Bucket=BUCKET, Key=shard('hunter-1', OTHER, 'crates=2Fweb'))
    run.client.update_item(TableName=TABLE, Key={'pk': {'S': PK}, 'sk': {'S': 'META'}},
                           UpdateExpression='SET ended_at = :b', ExpressionAttributeValues={':b': {'S': 'soon'}})
    report = json.loads(stored(run, run.reports.build(RUN, 'goal', RUN)['key']))
    assert (report['findings']['total'], report['time']['seconds']) == (2, None)
    run.client.update_item(TableName=TABLE, Key={'pk': {'S': PK}, 'sk': {'S': 'META'}},   # one naive, one with offset
                           UpdateExpression='SET ended_at = :b',
                           ExpressionAttributeValues={':b': {'S': '2026-11-12T09:30:00'}})
    assert json.loads(stored(run, run.reports.build(RUN, 'goal', RUN)['key']))['time']['seconds'] is None


def test_facts_and_tasks_follow_every_page() -> None:
    client: Any = MagicMock()
    client.get_item.return_value = {'Item': {}}
    client.query.side_effect = [
        {'Items': [{'sk': {'S': 'AGENT#a-1'}, 'cost_usd': {'N': 'not a number'}}], 'LastEvaluatedKey': {'k': 1}},
        {'Items': [{'sk': {'S': 'AGENT#a-2'}}]}, {'Count': 2}]
    facts = FactsReader(client, TABLE).read('default', RUN)
    assert facts is not None
    assert [(a.agent, a.cost_usd) for a in facts.agents] == [('a-1', 0), ('a-2', 0)]
    assert client.query.call_args_list[1].kwargs['ExclusiveStartKey'] == {'k': 1}
    client.query.side_effect = [{'Items': [{'task_id': {'S': 't-1'}}], 'LastEvaluatedKey': {'k': 1}},
                                {'Items': [{'task_id': {'S': 't-2'}}]}]
    tasks = BoardStore(client, TABLE, new_id=lambda: 'x').tasks('default', RUN)
    assert [task.task_id for task in tasks] == ['t-1', 't-2']


def test_facts_read_what_is_there_and_zero_for_the_rest() -> None:
    with mock_aws():
        client = boto3.client('dynamodb', region_name='us-east-1')
        client.create_table(TableName=TABLE, BillingMode='PAY_PER_REQUEST',
                            KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'},
                                       {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
                            AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                                                  {'AttributeName': 'sk', 'AttributeType': 'S'}])
        client.put_item(TableName=TABLE, Item={'pk': {'S': PK}, 'sk': {'S': 'META'}})
        client.put_item(TableName=TABLE, Item={'pk': {'S': PK}, 'sk': {'S': 'AGENT#a-1'}, 'cost_usd': {'N': '-1'}})
        facts = FactsReader(client, TABLE).read('default', RUN)
    assert facts is not None
    assert (facts.goal, facts.events, facts.agents[0].cost_usd, facts.agents[0].role) == ('', 0, 0, '')
