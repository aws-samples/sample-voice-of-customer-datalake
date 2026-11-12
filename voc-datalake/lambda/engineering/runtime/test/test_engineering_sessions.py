"""Session rows: listed while live, conditional moves, nothing but ids and times."""
from dataclasses import replace

import pytest

from engineering.runtime.interface import MicroVm
from engineering.runtime.sessions import AgentSession, SessionStore, StaleSession

SESSION = AgentSession(run_id='01JD3R4NZXQ7Y2W8K4M6P9T0AB', agent_id='fixer-1', role='fixer', task_id='task-1', language='python',
                       egress=('pypi.org',), connection='repo-1', commit='a' * 40, paths=('src',),
                       harness=('python3', '-m', 'harness'), vm_id='vm-1', endpoint='https://vm-1.example.org',
                       started_at=1000)


def test_a_created_session_reads_back_and_is_listed_while_live(aws):
    store = SessionStore(aws[1])
    created = store.create(SESSION)
    assert store.get('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1') == created
    assert list(store.active()) == [created]


def test_an_ended_session_leaves_the_active_list(aws):
    store = SessionStore(aws[1])
    store.save(replace(store.create(SESSION), status='done'))
    assert list(store.active()) == []
    row = aws[1].get_item(Key={'pk': 'ENGRUN#01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'sk': 'AGENT#fixer-1'})['Item']
    assert 'gsi1pk' not in row


def test_a_second_session_for_the_same_agent_is_refused(aws):
    store = SessionStore(aws[1])
    store.create(SESSION)
    with pytest.raises(StaleSession):
        store.create(SESSION)


def test_a_write_from_a_stale_read_is_refused(aws):
    store = SessionStore(aws[1])
    read = store.create(SESSION)
    store.save(replace(read, asked_at=1100))
    with pytest.raises(StaleSession):
        store.save(replace(read, status='done'))
    found = store.get('01JD3R4NZXQ7Y2W8K4M6P9T0AB', 'fixer-1')
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
