"""Session rows: the board's AGENT# rows, listed through the active runs, conditional moves, never another's attributes."""
from dataclasses import replace
from typing import Any

import pytest

from engineering.runtime.interface import MicroVm
from engineering.runtime.runs import RunCaps, RunNotActive, RunStore
from engineering.runtime.sessions import AgentSession, SessionStore, StaleSession
from engineering.runtime.test.conftest import RUN

SESSION = AgentSession(run_id=RUN, agent_id='fixer-1', role='fixer', task_id='task-1', language='python',
                       egress=('pypi.org',), connection='repo-1', commit='a' * 40, paths=('src',),
                       harness=('python3', '-m', 'harness'), vm_id='vm-1', endpoint='https://vm-1.example.org',
                       started_at=1000)
KEY = {'pk': f'WS#default#RUN#{RUN}', 'sk': 'AGENT#fixer-1'}


def _store(table: Any) -> tuple[SessionStore, RunStore]:
    runs = RunStore(table)
    runs.start(RUN, caps=RunCaps(max_tasks=10), now=0)
    return SessionStore(table, runs), runs


def test_a_created_session_is_listed_until_its_ended_run_is_released(aws):
    store, runs = _store(aws[1])
    created = store.create(SESSION)
    assert store.get(RUN, 'fixer-1') == created
    assert list(store.active()) == [created]
    runs.end(RUN, 'done', now=10)
    # Still live: the supervisor must see it to end its MicroVM.
    assert list(store.active()) == [created]
    runs.release(RUN)
    assert list(store.active()) == []


def test_no_session_is_created_once_its_run_has_ended_nor_twice(aws):
    store, runs = _store(aws[1])
    store.create(SESSION)
    with pytest.raises(StaleSession, match='exists'):
        store.create(SESSION)
    runs.end(RUN, 'stopped', now=10)
    with pytest.raises(RunNotActive, match='no agent is launched'):
        store.create(replace(SESSION, agent_id='fixer-2'))
    assert [session.agent_id for session in store.of_run(RUN)] == ['fixer-1']


def test_an_ended_session_leaves_the_active_list(aws):
    store, _ = _store(aws[1])
    store.save(replace(store.create(SESSION), status='done'))
    assert list(store.active()) == []
    assert store.of_run(RUN)[0].status == 'done'


def test_the_row_is_the_boards_agent_row_with_the_totals_the_reports_read(aws):
    store, _ = _store(aws[1])
    created = store.create(SESSION, {'model': 'model-a', 'skill_version': 'fixer@3'})
    store.save(replace(created, tokens={'model-a': {'in': 10, 'out': 4}, 'model-b': {'in': 1, 'out': 2}},
                       microvm_seconds=60))
    row = aws[1].get_item(Key=KEY)['Item']
    assert (row['role'], row['model'], row['skill_version'], row['microvm_seconds']) == ('fixer', 'model-a',
                                                                                         'fixer@3', 60)
    assert (row['input_tokens'], row['output_tokens']) == (11, 6)


def test_the_store_never_writes_over_what_others_add_to_the_row(aws):
    store, _ = _store(aws[1])
    created = store.create(SESSION)
    # The brokers add the cost they priced to the same row.
    aws[1].update_item(Key=KEY, UpdateExpression='ADD cost_usd :cost', ExpressionAttributeValues={':cost': 2})
    store.save(replace(created, status='working', exec_id=None, asked_at=None))
    assert aws[1].get_item(Key=KEY)['Item']['cost_usd'] == 2


def test_an_attribute_the_session_no_longer_has_is_removed(aws):
    store, _ = _store(aws[1])
    moved = store.save(replace(store.create(SESSION), exec_id='e1', asked_at=5))
    store.save(replace(moved, exec_id=None, asked_at=None))
    row = aws[1].get_item(Key=KEY)['Item']
    assert 'exec_id' not in row
    assert 'asked_at' not in row


def test_a_row_metered_before_the_session_was_written_is_no_session_until_it_is(aws):
    store, _ = _store(aws[1])
    aws[1].put_item(Item={**KEY, 'cost_usd': 1})
    assert (store.get(RUN, 'fixer-1'), store.of_run(RUN)) == (None, [])
    created = store.create(SESSION)
    assert store.get(RUN, 'fixer-1') == created
    assert aws[1].get_item(Key=KEY)['Item']['cost_usd'] == 1


def test_a_second_session_for_the_same_agent_is_refused(aws):
    store, _ = _store(aws[1])
    store.create(SESSION)
    with pytest.raises(StaleSession):
        store.create(SESSION)


def test_a_write_from_a_stale_read_is_refused(aws):
    store, _ = _store(aws[1])
    read = store.create(SESSION)
    store.save(replace(read, asked_at=1100))
    with pytest.raises(StaleSession):
        store.save(replace(read, status='done'))
    found = store.get(RUN, 'fixer-1')
    assert found is not None
    assert (found.asked_at, found.status, found.seq) == (1100, 'booting', 2)


def test_a_continuation_boots_again_in_the_new_microvm_from_its_checkpoint():
    later = replace(SESSION, status='working', boot_index=3, exec_id='e', asked_at=5, pause_requested_at=6)
    continued = later.on(MicroVm('vm-2', 'fixer-1', 'https://vm-2.example.org'), 2000, 'ckpt-key')
    assert (continued.vm_id, continued.started_at, continued.status, continued.continuation) == ('vm-2', 2000,
                                                                                                'booting', 1)
    assert (continued.boot_index, continued.exec_id, continued.asked_at, continued.restore_key) == (0, None, None,
                                                                                                    'ckpt-key')
    assert continued.spec('ckpt-key').restore_key == 'ckpt-key'
