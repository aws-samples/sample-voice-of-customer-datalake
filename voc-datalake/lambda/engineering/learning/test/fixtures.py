"""Test support: a fictional ended run on moto, with its board, its agents' session rows and one gate record.

The run (``RUN``, connection ``conn-harbor``) has, on its board:

- ``t-slug`` (fixer): attempt 1 held by fixer-2, re-posted by the supervisor as ``stalled`` (a time-out); attempt 2
  held by fixer-3, to review once, then done;
- ``t-gate`` (final-go, under ``t-slug``): held by final-go-7, done, with a gate record that says NO-GO after two
  rounds (so ``t-slug``'s attempt 2 is a NO-GO, with three review rounds);
- ``t-units`` (fixer): held by fixer-4 (another skill version), failed;
- ``t-feature`` (builder, no skill yet): attempt 1 held by builder-5, re-posted as ``crashed``; attempt 2 held by
  builder-6, needs a person;
- ``t-person`` (fixer): taken by a person, done: nobody's skill;
- ``coordinate``: held by coordinator-1, done.
"""
from __future__ import annotations

import json
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

import boto3
from moto import mock_aws

from engineering.board.model import Move
from engineering.board.test.table import TABLE, create_table
from engineering.quality_gate.record import FinalGoRecord, GateRecord, RoundRecord
from engineering.quality_gate.review import Finding
from engineering.workspace.store import WorkspaceStore

WS = 'default'
RUN = '01JD0000000000000000000000'
CONN = 'conn-harbor'
BUCKET = 'voc-eng-workspace-test'
SHA = 'a1b2c3d4' * 5
GATE_KEY = f'ws/{WS}/runs/{RUN}/final-go-7/commits/{SHA}/_gate/attempt-1/record.json'
#: A credential-shaped string an agent's output could carry (fictional, the redaction tests' kind).
SECRET = 'AKIA' + 'Q' * 16


def meta(status: str = 'done', connection: str = CONN, run_id: str = RUN) -> dict[str, Any]:
    return {'pk': {'S': f'WS#{WS}#RUN#{run_id}'}, 'sk': {'S': 'META'}, 'run_id': {'S': run_id},
            'status': {'S': status}, 'connection': {'S': connection}, 'max_tasks': {'N': '50'},
            'started_at': {'S': '2026-11-13T08:00:00Z'}, 'ended_at': {'S': '2026-11-13T09:00:00Z'}}


def task_item(task_id: str, role: str, state: str, *, attempt: int = 1, parent: str = '', priority: int = 0,
              result_keys: Sequence[str] = (), title: str = '') -> dict[str, Any]:
    item: dict[str, Any] = {
        'pk': {'S': f'WS#{WS}#RUN#{RUN}'}, 'sk': {'S': f'TASK#{task_id}'}, 'task_id': {'S': task_id},
        'role': {'S': role}, 'state': {'S': state}, 'title': {'S': title or f'Work on {task_id}'},
        'spec': {'S': json.dumps({'goal': f'the {task_id} work'})}, 'spec_hash': {'S': 'h'}, 'depth': {'N': '0'},
        'priority': {'N': str(priority)}, 'attempt': {'N': str(attempt)}, 'posted_by': {'S': 'coordinator-1'},
        'updated_by': {'S': 'x'}, 'updated_at': {'S': '2026-11-13T08:30:00+00:00'}}
    if parent:
        item['parent_task'] = {'S': parent}
    if result_keys:
        item['result_keys'] = {'SS': list(result_keys)}
    return item


def agent_item(agent: str, role: str, version: str, *, seconds: int = 60, cost: str = '0.5', crashes: int = 0,
               inspect: dict[str, Any] | None = None) -> dict[str, Any]:
    item: dict[str, Any] = {'pk': {'S': f'WS#{WS}#RUN#{RUN}'}, 'sk': {'S': f'AGENT#{agent}'}, 'role': {'S': role},
                            'skill_version': {'S': version}, 'microvm_seconds': {'N': str(seconds)},
                            'cost_usd': {'N': cost}, 'crashes': {'N': str(crashes)}, 'seq': {'N': '3'}}
    if inspect is not None:
        item['inspect'] = {'M': {key: _attr(value) for key, value in inspect.items()}}
    return item


def _attr(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {'BOOL': value}
    if isinstance(value, int):
        return {'N': str(value)}
    if isinstance(value, dict):
        return {'M': {key: _attr(inner) for key, inner in value.items()}}
    return {'S': str(value)}


@dataclass(frozen=True)
class Step:
    task_id: str
    state: str
    actor: str
    attempt: int
    op: str
    reason: str = ''


STEPS: tuple[Step, ...] = (
    Step('t-slug', 'open', 'coordinator-1', 1, 'post'),
    Step('t-slug', 'claimed', 'fixer-2', 1, 'claim'),
    Step('t-slug', 'in_progress', 'fixer-2', 1, 'move'),
    Step('t-slug', 'open', 'supervisor', 2, 'repost', 'stalled'),
    Step('t-slug', 'claimed', 'fixer-3', 2, 'claim'),
    Step('t-slug', 'in_review', 'fixer-3', 2, 'move'),
    Step('t-slug', 'in_progress', 'fixer-3', 2, 'move'),
    Step('t-slug', 'done', 'fixer-3', 2, 'move'),
    Step('t-gate', 'claimed', 'final-go-7', 1, 'claim'),
    Step('t-gate', 'done', 'final-go-7', 1, 'move'),
    Step('t-units', 'claimed', 'fixer-4', 1, 'claim'),
    Step('t-units', 'failed', 'fixer-4', 1, 'move'),
    Step('t-feature', 'open', 'coordinator-1', 1, 'launch', 'launched builder-5'),
    Step('t-feature', 'claimed', 'builder-5', 1, 'claim'),
    Step('t-feature', 'open', 'supervisor', 2, 'repost', 'crashed'),
    Step('t-feature', 'claimed', 'builder-6', 2, 'claim'),
    Step('t-feature', 'needs_human', 'builder-6', 2, 'move'),
    Step('t-person', 'claimed', 'human:admin-sub-1', 1, 'take'),
    Step('t-person', 'done', 'human:admin-sub-1', 1, 'move'),
    Step('coordinate', 'claimed', 'coordinator-1', 1, 'claim'),
    Step('coordinate', 'done', 'coordinator-1', 1, 'move'),
)


def moves() -> list[Move]:
    return [Move(step.task_id, step.state, step.actor, f'2026-11-13T08:{index:02d}:00+00:00', step.attempt, step.op,
                 reason=step.reason) for index, step in enumerate(STEPS)]


def tasks() -> list[dict[str, Any]]:
    return [task_item('t-slug', 'fixer', 'done', attempt=2, priority=5, title='Fix the slug helper'),
            task_item('t-gate', 'final-go', 'done', parent='t-slug', result_keys=(GATE_KEY,)),
            task_item('t-units', 'fixer', 'failed', title='Fix the units parser'),
            task_item('t-feature', 'builder', 'needs_human', attempt=2, title='Build the duration field'),
            task_item('t-person', 'fixer', 'done'),
            task_item('coordinate', 'coordinator', 'done')]


def agents() -> list[dict[str, Any]]:
    crashed = {'last_failure': 'the MicroVM stopped answering',
               'last_exit': {'exit_code': 137, 'timed_out': False, 'stderr_tail': f'killed; key {SECRET}'}}
    return [agent_item('fixer-2', 'fixer', 'fixer@1', seconds=100, cost='0.25'),
            agent_item('fixer-3', 'fixer', 'fixer@1', seconds=200, cost='0.75'),
            agent_item('fixer-4', 'fixer', 'fixer@2', seconds=50, cost='0.1'),
            agent_item('builder-5', 'builder', '', seconds=30, cost='0.05', crashes=2, inspect=crashed),
            agent_item('builder-6', 'builder', '', seconds=40, cost='0.05'),
            agent_item('final-go-7', 'final-go', 'final-go@1', seconds=20, cost='0.4'),
            agent_item('coordinator-1', 'coordinator', 'coordinator@1', seconds=300, cost='0.3'),
            # A launch's hold with no session written: not an agent.
            {'pk': {'S': f'WS#{WS}#RUN#{RUN}'}, 'sk': {'S': 'AGENT#fixer-9'}, 'launching_until': {'N': '0'}}]


def gate_record() -> GateRecord:
    """A NO-GO after two rounds, with one open blocking finding."""
    finding = Finding(id='R2-correctness-1', round=2, reviewer='correctness', severity='blocking',
                      title='The slug is still cut mid-word at the limit')
    return GateRecord(verdict='NO-GO', tree_hash='', packs=('python',), max_rounds=3,
                      rounds=(RoundRecord(1, (), True, ()), RoundRecord(2, (), True, (finding.id,))),
                      findings=(finding,), outcomes={}, reviewers=('correctness',), model_calls=3,
                      final_go=FinalGoRecord(agent='final-go-7', model_id='m', go=False,
                                             reasons=('The suite was not run on the whole package.',)))


def seed(client: Any, s3: Any, *, status: str = 'done', connection: str = CONN) -> None:
    """The run's rows and its gate record."""
    client.put_item(TableName=TABLE, Item=meta(status, connection))
    for item in (*tasks(), *agents(), *(move.item(WS, RUN) for move in moves())):
        client.put_item(TableName=TABLE, Item=item)
    s3.put_object(Bucket=BUCKET, Key=GATE_KEY, Body=json.dumps(gate_record().to_dict()).encode())


@contextmanager
def ended_run(*, status: str = 'done', connection: str = CONN) -> Generator[tuple[Any, WorkspaceStore]]:
    """moto's voc-engineering with the run seeded, and the workspace store on its bucket."""
    with mock_aws():
        client = create_table()
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        seed(client, s3, status=status, connection=connection)
        yield client, WorkspaceStore(s3, BUCKET, denied_is_missing=True)
