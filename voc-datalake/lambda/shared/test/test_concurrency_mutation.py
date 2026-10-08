"""shared.concurrency: the pool size and the inline cut-off, pinned exactly.

The mutation run found that the behaviour tests (real threads meeting at
barriers) could not see HOW BIG the pool is: a default cap of 9 instead of 8, a
floor of 2 workers instead of 1, or two items run inline instead of on a pool
all still return the right results in the right order. They also could not see
the ``@overload`` stubs of ``concurrently`` go missing, since the runtime
implementation is the same. A recording fake executor pins the size the module
asks for, with no threads and no waits.
"""
import typing
from collections.abc import Callable, Iterable, Iterator

import pytest

from shared import concurrency
from shared.concurrency import concurrently, ordered_map


class RecordingExecutor:
    """Stands in for ThreadPoolExecutor: records max_workers, maps serially."""

    def __init__(self, sizes: list[int], max_workers: int) -> None:
        sizes.append(max_workers)

    def __enter__(self) -> 'RecordingExecutor':
        return self

    def __exit__(self, *_exc_info: object) -> None:
        return None

    def map(self, fn: Callable[[int], int], items: Iterable[int]) -> Iterator[int]:
        return map(fn, items)


@pytest.fixture
def pool_sizes(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """The max_workers of every pool the module opens, in order."""
    sizes: list[int] = []
    monkeypatch.setattr(
        concurrency, 'ThreadPoolExecutor', lambda max_workers: RecordingExecutor(sizes, max_workers),
    )
    return sizes


def _double(n: int) -> int:
    return n * 2


class TestThePoolIsSizedToTheWork:
    @pytest.mark.parametrize(('count', 'expected'), [(2, 2), (3, 3), (8, 8), (9, 8), (20, 8)])
    def test_default_cap_is_eight_workers(self, pool_sizes: list[int], count: int, expected: int):
        assert ordered_map(_double, range(count)) == [n * 2 for n in range(count)]
        assert pool_sizes == [expected]

    @pytest.mark.parametrize(('max_workers', 'expected'), [(1, 1), (0, 1), (-3, 1), (2, 2), (5, 3)])
    def test_explicit_cap_is_floored_at_one_and_capped_at_the_item_count(
        self, pool_sizes: list[int], max_workers: int, expected: int,
    ):
        assert ordered_map(_double, [1, 2, 3], max_workers=max_workers) == [2, 4, 6]
        assert pool_sizes == [expected]


class TestOnlyZeroOrOneItemRunsInline:
    @pytest.mark.parametrize('items', [[], [4]])
    def test_no_pool_for_zero_or_one_item(self, pool_sizes: list[int], items: list[int]):
        assert ordered_map(_double, items) == [n * 2 for n in items]
        assert pool_sizes == []

    def test_two_items_use_a_pool_of_two(self, pool_sizes: list[int]):
        assert concurrently(lambda: 'a', lambda: 'b') == ('a', 'b')
        assert pool_sizes == [2]


def test_concurrently_declares_its_two_three_and_four_call_overloads():
    arities = [len(typing.get_type_hints(stub)) - 1 for stub in typing.get_overloads(concurrently)]
    assert arities == [2, 3, 4]
