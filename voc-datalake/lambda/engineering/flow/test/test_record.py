"""The run's flow record: its step rows read into the conductor's view, the run's copy kept once read, and a copy
the conductor cannot follow."""
from __future__ import annotations

from collections.abc import Callable

import pytest

from engineering.board.model import Task
from engineering.board.test.table import RUN, TABLE, engineering_table
from engineering.connectors.test.test_records import gate_record
from engineering.flow import record as record_module
from engineering.flow.conductor import UNREAD, Flow, FlowError
from engineering.flow.record import (
    DECISION,
    DONE,
    FAN_OUT,
    FlowRecord,
    board_state,
    cap_reached,
    decision_item,
    gate_verdicts,
    recorded_verdicts,
    run_flow,
    step_sk,
)
from engineering.flow.test.fixtures import TEMPLATES, put_flow
from engineering.quality_gate.record import GateRecord
from engineering.rows import run_pk


def _row(step: str, kind: str, **more: object) -> dict[str, object]:
    return {'step': {'S': step}, 'record': {'S': kind}, **more}


def test_the_step_rows_and_the_tasks_steps_are_the_conductors_view():
    tasks = [Task(task_id='t1', role='mapper', state='done', title='', spec='{}', spec_hash='', depth=0, priority=0,
                  attempt=1, flow_step='mapper', shard='core'),
             Task(task_id='t2', role='fixer', state='open', title='', spec='{}', spec_hash='', depth=0, priority=0,
                  attempt=1)]   # (a person's own task: no step, not the flow's)
    rows = [_row('map', FAN_OUT, shards={'L': [{'S': 'core'}, {'S': 'web'}]}), _row('plan', DONE),
            _row('gate', DECISION), _row('gate', DECISION), _row('x', 'not_yet_run')]
    state = board_state(tasks, rows, cap_reached=True)
    assert (state.fanned_out, state.completed, state.decisions, state.cap_reached) == (
        {'map': ('core', 'web')}, frozenset({'plan'}), {'gate': 2}, True)
    assert [(task.step, task.shard) for task in state.tasks] == [('mapper', 'core')]


@pytest.mark.parametrize(('meta', 'reached'), [
    (None, False), ({}, False), ({'max_tasks': {'N': '3'}}, False),
    ({'max_tasks': {'N': '3'}, 'task_count': {'N': '2'}}, False),
    ({'max_tasks': {'N': '3'}, 'task_count': {'N': '3'}}, True)])
def test_the_runs_task_cap_is_reached_at_its_count(meta: dict[str, object] | None, reached: bool):
    assert cap_reached(meta) is reached


def test_a_step_record_is_one_of_its_kinds_and_a_decision_names_who_and_when():
    assert step_sk('gate', DONE) == 'STEP#gate#done'
    with pytest.raises(ValueError, match='step record'):
        step_sk('gate', 'merged')
    item = decision_item('pk', 'gate', actor='admin-1', at='2026-11-14T10:00:00Z', nonce='ab12')
    assert (item['sk'], item['by'], item['record']) == ('STEP#gate#decision#2026-11-14T10:00:00Z#ab12', 'admin-1',
                                                        DECISION)


def test_a_copy_is_read_once_and_kept_and_a_record_is_written_once():
    with engineering_table() as client:
        put_flow(client, TABLE, RUN)
        record = FlowRecord(client, TABLE)
        flow = record.flow('default', RUN)
        assert flow is not None
        client.delete_item(TableName=TABLE, Key={'pk': {'S': run_pk('default', RUN)}, 'sk': {'S': 'FLOW'}})
        assert record.flow('default', RUN) is flow   # (create-only: once read, kept)
        assert FlowRecord(client, TABLE).flow('default', RUN) is None
        assert record.record('default', RUN, 'board', DONE, actor='coordinator-1', at='now') is True
        assert record.record('default', RUN, 'board', DONE, actor='coordinator-2', at='later') is False


def test_the_kept_copies_are_bounded(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(record_module, 'CACHED_FLOWS', 1)
    with engineering_table() as client:
        other = '01JD0000000000000000000001'
        put_flow(client, TABLE, RUN)
        put_flow(client, TABLE, other, 'feature')
        record = FlowRecord(client, TABLE)
        record.flow('default', RUN)
        record.flow('default', other)
        assert list(record._flows) == [('default', other)]   # (the bound itself is what is tested)


GATE_KEY = f'ws/default/runs/{RUN}/final-go-4/commits/{"a" * 40}/_gate/attempt-1/record.json'


def _final_go(task_id: str = 't1', state: str = 'done', *, keys: tuple[str, ...] = (GATE_KEY,)) -> Task:
    """A final-go task of the bug hunt's gate step, held by final-go-4, with the gate record it recorded."""
    return Task(task_id=task_id, role='final-go', state=state, title='', spec='{}', spec_hash='', depth=0, priority=0,
                attempt=1, lease_agent='final-go-4', result_keys=keys, updated_at='2026-11-14T10:00:00+00:00',
                flow_step='gate')


def _reader(verdict: str | None) -> tuple[list[str], Callable[[str], GateRecord | None]]:
    read: list[str] = []

    def record(key: str) -> GateRecord | None:
        read.append(key)
        return None if verdict is None else GateRecord.from_dict(gate_record(verdict))
    return read, record


@pytest.mark.parametrize(('task', 'record', 'expected'), [
    (_final_go(), 'GO', 'go'),
    (_final_go(), 'NO-GO', 'no_go'),          # (ended done, its record says NO-GO: the fail arrow)
    (_final_go(), 'STOPPED', 'no_go'),
    (_final_go(), None, 'no_go'),             # (its record missing or off its schema)
    (_final_go(keys=()), 'GO', 'no_go'),      # (no record recorded)
    (_final_go(state='failed'), 'GO', 'no_go'),
], ids=['go', 'no-go-record', 'stopped', 'record-missing', 'no-record-key', 'task-failed'])
def test_a_gates_verdict_is_the_go_ledgers_read_of_its_deciding_record(task: Task, record: str | None,
                                                                       expected: str):
    flow = Flow.from_definition(TEMPLATES['bug-hunt-and-fix'])
    read, reader = _reader(record)
    assert gate_verdicts(flow, [task], 'default', RUN, reader, {}) == {'gate': expected}
    assert read == ([GATE_KEY] if task.state == 'done' and task.result_keys else [])


def test_without_a_reader_a_gates_verdict_is_the_one_the_board_recorded_else_never_a_go():
    flow = Flow.from_definition(TEMPLATES['bug-hunt-and-fix'])
    assert gate_verdicts(flow, [_final_go()], 'default', RUN, None, {}) == {'gate': UNREAD}
    assert gate_verdicts(flow, [_final_go()], 'default', RUN, None, {('gate', 't1'): 'go'}) == {'gate': 'go'}
    # (a verdict recorded for an older final go never stands for a newer one)
    assert gate_verdicts(flow, [_final_go('t2')], 'default', RUN, None, {('gate', 't1'): 'go'}) == {'gate': UNREAD}
    assert gate_verdicts(flow, [], 'default', RUN, None, {}) == {}


def test_the_board_records_a_gates_verdict_for_the_readers_without_the_records():
    with engineering_table() as client:
        put_flow(client, TABLE, RUN)
        record = FlowRecord(client, TABLE)
        tasks = [_final_go()]
        plan = record.plan('default', RUN, tasks, None, read=_reader('NO-GO')[1])
        assert plan is not None
        record.record_verdicts('default', RUN, plan, tasks, actor='coordinator-1', at='now')
        record.record_verdicts('default', RUN, plan, tasks, actor='coordinator-1', at='later')   # (once)
        rows = [row for row in record.rows('default', RUN) if row['record']['S'] == 'verdict']
        assert [(row['sk']['S'], row['verdict']['S'], row['at']['S']) for row in rows] == [
            ('STEP#gate#verdict#t1', 'no_go', 'now')]
        assert record.plan('default', RUN, tasks, None) is not None
        assert recorded_verdicts(rows) == {('gate', 't1'): 'no_go'}


def test_a_copy_the_conductor_cannot_follow_is_said_so_and_its_readers_go_on_without_it():
    with engineering_table() as client:
        put_flow(client, TABLE, RUN, definition='[1]')
        with pytest.raises(FlowError, match='not a definition'):
            FlowRecord(client, TABLE).flow('default', RUN)
        assert run_flow(client, TABLE, 'default', RUN, None) is None
        put_flow(client, TABLE, RUN, definition='{')
        with pytest.raises(FlowError, match='cannot be read'):
            FlowRecord(client, TABLE).flow('default', RUN)
        assert run_flow(client, TABLE, 'default', '01JD0000000000000000000002', None) is None
