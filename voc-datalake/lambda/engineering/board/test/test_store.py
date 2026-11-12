"""The board's conditional writes on a moto table: caps, dedupe, leases and their epochs, the moves."""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

from engineering.board.store import (
    LEASE_S,
    MAX_DEPTH,
    MAX_KEY_LENGTH,
    MAX_RESULT_KEYS,
    BoardError,
    BoardStore,
    spec_hash,
)
from engineering.board.test.table import RUN, TABLE, board, engineering_table

WS = 'default'
AGENT_PREFIX = f'ws/{WS}/runs/{RUN}/fixer-1'
KEY = f'{AGENT_PREFIX}/commits/abc1234/attempt-1/patch.diff'


@pytest.fixture
def store() -> Iterator[BoardStore]:
    with engineering_table(max_tasks=3) as client:
        yield board(client)


def post(store: BoardStore, spec: dict[str, Any] | None = None, parent: str = '') -> Any:
    return store.post(WS, RUN, role='fixer', title='Fix the page size', spec=spec or {'issue': 1},
                      parent_task=parent, priority=0, actor='coordinator-0')


def kind(call: Any) -> str:
    with pytest.raises(BoardError) as caught:
        call()
    return caught.value.kind


def test_a_posted_task_is_open_and_read_back(store: BoardStore) -> None:
    posted = post(store)
    assert posted.created
    task = store.task(WS, RUN, posted.task.task_id)
    assert (task.state, task.attempt, task.depth, task.posted_by) == ('open', 1, 0, 'coordinator-0')
    assert task.view()['spec'] == {'issue': 1}
    assert task.view()['lease'] is None


def test_the_same_spec_is_answered_not_posted_twice(store: BoardStore) -> None:
    first = post(store, {'a': 1, 'b': 2})
    again = post(store, {'b': 2, 'a': 1})
    assert not again.created
    assert again.task.task_id == first.task.task_id
    assert spec_hash('fixer', '', {'a': 1}) != spec_hash('hunter', '', {'a': 1})
    assert spec_hash('fixer', '', {'a': 1}) != spec_hash('fixer', 'task-1', {'a': 1})


def test_a_task_without_a_spec_is_refused(store: BoardStore) -> None:
    assert kind(lambda: store.post(WS, RUN, role='fixer', title='t', spec={}, parent_task='', priority=0,
                                   actor='a')) == 'invalid'


def test_the_run_cap_and_an_unknown_run_refuse(store: BoardStore) -> None:
    for issue in range(3):
        post(store, {'issue': issue})
    assert kind(lambda: post(store, {'issue': 9})) == 'cap'
    assert kind(lambda: store.post(WS, 'no-run', role='fixer', title='t', spec={'a': 1}, parent_task='', priority=0,
                                   actor='a')) == 'not_found'


def test_a_run_without_a_task_cap_takes_no_task(store: BoardStore) -> None:
    store.client.put_item(TableName=TABLE, Item={'pk': {'S': f'WS#{WS}#RUN#uncapped'}, 'sk': {'S': 'META'}})
    with pytest.raises(BoardError, match='no task cap'):
        store.post(WS, 'uncapped', role='fixer', title='t', spec={'a': 1}, parent_task='', priority=0, actor='a')


def test_depth_and_size_are_capped() -> None:
    with engineering_table(max_tasks=10) as client:
        store = board(client)
        parent = ''
        for level in range(MAX_DEPTH + 1):
            parent = post(store, {'level': level}, parent).task.task_id
        assert store.task(WS, RUN, parent).depth == MAX_DEPTH
        assert kind(lambda: post(store, {'level': 'deeper'}, parent)) == 'cap'
        assert kind(lambda: post(store, {'blob': 'x' * 9000})) == 'invalid'
        assert kind(lambda: store.task(WS, RUN, 'nothing')) == 'not_found'


def test_a_claim_leases_the_task_to_its_role_only(store: BoardStore) -> None:
    task_id = post(store).task.task_id
    assert kind(lambda: store.claim(WS, RUN, task_id, role='hunter', agent='hunter-1')) == 'forbidden'
    claimed = store.claim(WS, RUN, task_id, role='fixer', agent='fixer-1')
    assert (claimed.state, claimed.lease_agent, claimed.lease_epoch) == ('claimed', 'fixer-1', 1)
    assert store.claim(WS, RUN, task_id, role='fixer', agent='fixer-1') == claimed
    assert kind(lambda: store.claim(WS, RUN, task_id, role='fixer', agent='fixer-2')) == 'conflict'


def test_only_the_holder_with_its_epoch_renews_and_moves(store: BoardStore) -> None:
    task_id = post(store).task.task_id
    store.claim(WS, RUN, task_id, role='fixer', agent='fixer-1')
    assert store.renew(WS, RUN, task_id, agent='fixer-1', epoch=1).lease_agent == 'fixer-1'
    assert kind(lambda: store.renew(WS, RUN, task_id, agent='fixer-1', epoch=2)) == 'conflict'
    assert kind(lambda: store.move(WS, RUN, task_id, agent='fixer-2', epoch=1, to_state='in_progress',
                                   result_keys=[])) == 'conflict'
    moving = store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state='in_progress', result_keys=[])
    assert moving.state == 'in_progress'
    done = store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state='done', result_keys=[KEY])
    assert (done.state, done.result_keys) == ('done', (KEY,))
    assert store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state='done', result_keys=[KEY]) == done
    assert kind(lambda: store.renew(WS, RUN, task_id, agent='fixer-1', epoch=1)) == 'conflict'
    assert kind(lambda: store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state='in_review',
                                   result_keys=[])) == 'conflict'


def test_a_lease_that_ran_out_lets_its_holder_do_nothing_more() -> None:
    clock = [datetime(2026, 11, 12, 9, 0, tzinfo=UTC)]
    with engineering_table() as client:
        store = BoardStore(client, TABLE, new_id=lambda: 'task-1', now=lambda: clock[0])
        post(store)
        store.claim(WS, RUN, 'task-1', role='fixer', agent='fixer-1')
        clock[0] += timedelta(seconds=LEASE_S - 1)
        store.renew(WS, RUN, 'task-1', agent='fixer-1', epoch=1)
        clock[0] += timedelta(seconds=LEASE_S + 1)
        assert kind(lambda: store.renew(WS, RUN, 'task-1', agent='fixer-1', epoch=1)) == 'conflict'
        assert kind(lambda: store.move(WS, RUN, 'task-1', agent='fixer-1', epoch=1, to_state='done',
                                       result_keys=[])) == 'conflict'


def test_a_task_keeps_a_bounded_set_of_result_keys(store: BoardStore) -> None:
    task_id = post(store).task.task_id
    store.claim(WS, RUN, task_id, role='fixer', agent='fixer-1')
    first = [f'{KEY}.{n}' for n in range(MAX_RESULT_KEYS)]
    store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state='in_progress', result_keys=first)
    assert len(store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state='in_review',
                          result_keys=first[:2]).result_keys) == MAX_RESULT_KEYS
    assert kind(lambda: store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state='done',
                                   result_keys=[f'{KEY}.more'])) == 'cap'
    assert kind(lambda: store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state='done',
                                   result_keys=[KEY + 'x' * MAX_KEY_LENGTH])) == 'invalid'
    # Someone else's call is refused as not theirs, whatever it carries.
    assert kind(lambda: store.move(WS, RUN, task_id, agent='fixer-1', epoch=2, to_state='done',
                                   result_keys=[f'{AGENT_PREFIX}/attempt-2/more'])) == 'conflict'


def test_the_key_cap_holds_against_a_move_that_raced_the_read(store: BoardStore,
                                                              monkeypatch: pytest.MonkeyPatch) -> None:
    task_id = post(store).task.task_id
    store.claim(WS, RUN, task_id, role='fixer', agent='fixer-1')
    stale = store.task(WS, RUN, task_id)
    store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state='in_progress',
               result_keys=[f'{KEY}.{n}' for n in range(MAX_RESULT_KEYS - 1)])
    reads = [stale]
    real_task = store.task
    monkeypatch.setattr(store, 'task', lambda *key: reads.pop() if reads else real_task(*key))
    assert kind(lambda: store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state='in_review',
                                   result_keys=[f'{KEY}.a', f'{KEY}.b'])) == 'conflict'
    assert len(real_task(WS, RUN, task_id).result_keys) == MAX_RESULT_KEYS - 1


def test_a_repeated_move_that_adds_keys_is_not_taken_for_a_retry(store: BoardStore) -> None:
    task_id = post(store).task.task_id
    store.claim(WS, RUN, task_id, role='fixer', agent='fixer-1')
    store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state='in_progress', result_keys=[KEY])
    assert kind(lambda: store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state='in_progress',
                                   result_keys=[f'{KEY}.new'])) == 'conflict'
    assert store.task(WS, RUN, task_id).result_keys == (KEY,)


@pytest.mark.parametrize(('to', 'keys'), [
    ('open', []), ('claimed', []), ('done', ['ws/default/runs/other/fixer-1/attempt-1/x']),
    ('done', [f'{AGENT_PREFIX}/../fixer-2/attempt-1/x']), ('done', [3]), ('done', [f'{AGENT_PREFIX}/attempt-2/x']),
    ('done', [f'{AGENT_PREFIX}/x']), ('done', [f'{AGENT_PREFIX}/attempt-1/a"b']),
])
def test_a_move_off_the_map_or_outside_the_prefix_is_invalid(store: BoardStore, to: str, keys: list[Any]) -> None:
    task_id = post(store).task.task_id
    store.claim(WS, RUN, task_id, role='fixer', agent='fixer-1')
    assert kind(lambda: store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state=to,
                                   result_keys=keys)) == 'invalid'


def test_other_dynamodb_errors_are_raised() -> None:
    client = MagicMock()
    client.get_item.return_value = {'Item': {'task_id': {'S': 't'}, 'role': {'S': 'fixer'}, 'state': {'S': 'open'}}}
    throttled = ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'slow down'}}, 'UpdateItem')
    client.update_item.side_effect = throttled
    client.transact_write_items.side_effect = throttled
    store = BoardStore(client, TABLE, new_id=lambda: 'task-1')
    with pytest.raises(ClientError):
        store.claim(WS, RUN, 't', role='fixer', agent='fixer-1')
    with pytest.raises(ClientError):
        post(store)
