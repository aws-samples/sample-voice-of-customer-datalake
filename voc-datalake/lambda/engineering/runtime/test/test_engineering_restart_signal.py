"""A person's Restart of one agent of a live run (7.51.00): from its checkpoint (continued in a new session at once) or
afresh (its task re-posted at the next attempt, the stall path); busy and stale as every signal; a stop always wins."""
from __future__ import annotations

import json

import pytest

from engineering.runtime.checkpoints import checkpoint_prefix
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.test.conftest import BUCKET, COMMIT, RUN, World
from engineering.runtime.test.test_engineering_supervisor import SLEEP, _until


def _working(world: World, **launch: object) -> None:
    world.launch(code=SLEEP, **launch)   # type: ignore[arg-type]
    _until(world, 1000, lambda s: s.status == 'working', agent_id=str(launch.get('agent_id', 'fixer-1')))


def test_a_restart_from_its_checkpoint_continues_the_agent_in_a_new_session_at_once(world: World):
    _working(world)
    key = f'{checkpoint_prefix(RUN, "fixer-1", COMMIT, 1)}000002-ab12.json'
    world.s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps({'position': {'turn': 3}, 'notes': 'n'}))
    before = world.session()
    answer = world.supervisor.signal_detailed(RUN, 'fixer-1', 'restart', 1010, attempt=1, restart_from='checkpoint')
    after = world.session()
    assert answer == {'fixer-1': (after.status, True)}
    assert (after.continuation, after.restore_key, after.crashes) == (before.continuation + 1, key, 0)
    assert after.vm_id != before.vm_id
    assert world.board.reposted == []


def test_a_fresh_restart_reposts_the_task_and_ends_the_session_as_reposted(world: World):
    _working(world)
    answer = world.supervisor.signal_detailed(RUN, 'fixer-1', 'restart', 1010, attempt=1, restart_from='fresh')
    assert answer == {'fixer-1': ('reposted', True)}
    assert (world.board.reposted, world.board.attempts) == ([(f'{RUN}/task-1', 'restarted')], [1])
    assert 'continued' in world.bus.kinds()   # (the bus's run.agent_continued)


def test_a_restart_for_another_attempt_is_stale_and_one_under_another_move_is_busy(world: World):
    _working(world)
    assert world.supervisor.signal_detailed(RUN, 'fixer-1', 'restart', 1010, attempt=2, restart_from='fresh') == {
        'fixer-1': ('stale', False)}
    world.store.claim(world.session(), 1011, 300)
    assert world.supervisor.signal_detailed(RUN, 'fixer-1', 'restart', 1011, restart_from='checkpoint') == {
        'fixer-1': ('busy', False)}
    assert world.board.reposted == []


def test_a_stop_always_wins_over_a_restart(world: World):
    _working(world)
    world.supervisor.signal(RUN, 'fixer-1', 'stop_now', 1005)
    # The agent is stopped: nothing to restart (answered with its status, not applied) ...
    assert world.supervisor.signal_detailed(RUN, 'fixer-1', 'restart', 1006, restart_from='fresh') == {
        'fixer-1': ('stopped', False)}
    # ... and a stopped run restarts nobody.
    world.control.stops.add(RUN)
    with pytest.raises(RuntimeRefused, match='is stopped'):
        world.supervisor.signal_detailed(RUN, 'fixer-1', 'restart', 1007, restart_from='checkpoint')
    assert world.board.reposted == []


@pytest.mark.parametrize(('agent', 'restart_from', 'why'), [
    (None, 'checkpoint', 'names one agent'),
    ('fixer-1', 'yesterday', 'from one of'),
    ('coordinator-1', 'fresh', 'never afresh'),
])
def test_a_restart_names_one_agent_and_where_it_starts_and_the_coordinator_restarts_from_its_checkpoint(
        world: World, agent: str | None, restart_from: str, why: str):
    with pytest.raises(RuntimeRefused, match=why):
        world.supervisor.signal_detailed(RUN, agent, 'restart', 1001, restart_from=restart_from)
