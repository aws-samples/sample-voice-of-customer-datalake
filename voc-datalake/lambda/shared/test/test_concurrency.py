"""shared.concurrency: bounded, order-preserving fan-out."""
import threading

import pytest

from shared.concurrency import concurrently, ordered_map


def test_results_come_back_in_input_order_even_when_completion_order_differs():
    # The first item finishes LAST: it waits until every other item has run.
    done = threading.Event()
    finished: list[int] = []

    def work(n: int) -> int:
        if n == 0:
            assert done.wait(5)
        finished.append(n)
        if len(finished) == 3:
            done.set()
        return n * 10

    assert ordered_map(work, [0, 1, 2, 3]) == [0, 10, 20, 30]
    assert finished[-1] == 0


def test_items_run_concurrently():
    barrier = threading.Barrier(3, timeout=5)
    assert ordered_map(lambda n: barrier.wait() >= 0 and n, [1, 2, 3]) == [1, 2, 3]


def test_concurrency_is_bounded_by_max_workers():
    lock = threading.Lock()
    state = {'now': 0, 'peak': 0}
    gate = threading.Barrier(2, timeout=5)

    def work(n: int) -> int:
        with lock:
            state['now'] += 1
            state['peak'] = max(state['peak'], state['now'])
        gate.wait()  # pairs of workers meet here; a third would never be admitted
        with lock:
            state['now'] -= 1
        return n

    assert ordered_map(work, range(6), max_workers=2) == list(range(6))
    assert state['peak'] == 2


def test_a_failure_propagates_like_the_serial_loop():
    def work(n: int) -> int:
        if n == 2:
            raise ValueError('boom')
        return n

    with pytest.raises(ValueError, match='boom'):
        ordered_map(work, [1, 2, 3])


@pytest.mark.parametrize('items', [[], [7]])
def test_zero_or_one_item_runs_inline(items):
    caller = threading.get_ident()
    assert ordered_map(lambda n: (n, threading.get_ident() == caller), items) == [(n, True) for n in items]


def test_concurrently_returns_a_typed_tuple_in_argument_order():
    barrier = threading.Barrier(3, timeout=5)

    def wait_then(value):
        return lambda: (barrier.wait(), value)[1]

    assert concurrently(wait_then('a'), wait_then(2), wait_then([3])) == ('a', 2, [3])
