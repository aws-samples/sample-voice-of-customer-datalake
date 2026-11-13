"""The run's record read on moto: its META, board, agents and the gate records its final-go tasks named."""
from __future__ import annotations

import json
from decimal import Decimal

import pytest

from engineering.board.test.table import TABLE
from engineering.learning.records import MAX_GATE_RECORDS, RunRecordReader
from engineering.learning.test.fixtures import (
    BUCKET,
    CONN,
    GATE_KEY,
    RUN,
    SECRET,
    SHA,
    WS,
    ended_run,
    gate_record,
    task_item,
)


def test_the_record_is_the_runs_own_rows_and_its_named_gate_record() -> None:
    with ended_run() as (client, workspace):
        run = RunRecordReader(client, TABLE, workspace).read(WS, RUN)
    assert run is not None
    assert (run.connection, run.status, run.started_at, run.ended_at) == (
        CONN, 'done', '2026-11-13T08:00:00Z', '2026-11-13T09:00:00Z')
    assert {task.task_id for task in run.tasks} == {'t-slug', 't-gate', 't-units', 't-feature', 't-person',
                                                    'coordinate'}
    assert [move.op for move in run.history['t-feature']] == ['launch', 'claim', 'repost', 'claim', 'move']
    # A launch's hold with no session is not an agent.
    assert 'fixer-9' not in {agent.agent for agent in run.agents}
    builder = next(agent for agent in run.agents if agent.agent == 'builder-5')
    assert (builder.role, builder.skill_version, builder.crashes, builder.cost_usd) == ('builder', '', 2,
                                                                                       Decimal('0.05'))
    assert builder.last_failure.startswith('the MicroVM stopped answering exit 137, timed out False; stderr: killed')
    assert SECRET not in builder.last_failure
    [gate] = run.gates
    assert (gate.task_id, gate.attempt, gate.verdict, gate.no_go, gate.rounds) == ('t-gate', 1, 'NO-GO', True, 2)
    assert gate.reasons == ('The suite was not run on the whole package.',
                            'open blocking finding: The slug is still cut mid-word at the limit')


def test_no_record_for_a_run_that_does_not_exist() -> None:
    with ended_run() as (client, workspace):
        assert RunRecordReader(client, TABLE, workspace).read(WS, '01JD0000000000000000000099') is None


def test_a_gate_record_unread_or_off_the_schema_is_left_out() -> None:
    with ended_run() as (client, workspace):
        workspace.s3.put_object(Bucket=BUCKET, Key=GATE_KEY.replace('attempt-1', 'attempt-2'), Body=b'{"schema": 1}')
        missing = GATE_KEY.replace('attempt-1', 'attempt-3')
        other = f'ws/{WS}/runs/{RUN}/final-go-7/commits/{SHA}/_logs/attempt-1/log.txt'
        # Another run's record (a valid one, in the bucket): never read for this run.
        foreign = GATE_KEY.replace(RUN, '01JD0000000000000000000077')
        workspace.s3.put_object(Bucket=BUCKET, Key=foreign, Body=json.dumps(gate_record().to_dict()).encode())
        client.put_item(TableName=TABLE, Item=task_item('t-gate', 'final-go', 'done', parent='t-slug', result_keys=(
            GATE_KEY, GATE_KEY.replace('attempt-1', 'attempt-2'), missing, other, foreign, 'not-a-key')))
        run = RunRecordReader(client, TABLE, workspace).read(WS, RUN)
    assert run is not None
    assert [gate.attempt for gate in run.gates] == [1]


def test_at_most_a_bounded_number_of_gate_records_is_read_the_latest_attempts_first(
        monkeypatch: pytest.MonkeyPatch) -> None:
    with ended_run() as (client, workspace):
        keys = [GATE_KEY.replace('attempt-1', f'attempt-{n}') for n in range(1, 33)]
        for key in keys:
            workspace.s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps({'schema': 'nope'}).encode())
        # Two final-go tasks, 16 records each (a task keeps at most 16 result keys).
        for task_id, named in (('t-gate', keys[:16]), ('t-gate-2', keys[16:])):
            client.put_item(TableName=TABLE, Item=task_item(task_id, 'final-go', 'done', parent='t-slug',
                                                            result_keys=named))
        reads: list[str] = []
        original = workspace.read_text

        def counted(key: str) -> str | None:
            reads.append(key)
            return original(key)

        monkeypatch.setattr(workspace, 'read_text', counted)
        run = RunRecordReader(client, TABLE, workspace).read(WS, RUN)
    assert run is not None
    assert run.gates == ()
    assert len(reads) == MAX_GATE_RECORDS
    assert reads[0] == keys[-1]
