"""Bounded, order-preserving concurrency for independent network reads.

Request-path handlers often make several INDEPENDENT reads (one DynamoDB
partition per category, one per log source, two Cognito listings) and used to
make them one after another, so the response waited for the sum of the
round-trips instead of the slowest one. ``ordered_map`` runs them on a small
thread pool and hands the results back in INPUT order, so callers that sum,
OR or merge the results behave exactly as the serial loop did.

Threads, not asyncio: boto3 is blocking, and botocore clients are thread-safe.
A DynamoDB ``Table`` resource's ``query``/``get_item`` actions only forward to
its client and never mutate the resource, so sharing one across workers is
safe for those reads (do NOT call ``load()``/``reload()`` from a worker).

Exceptions propagate exactly like the serial loop: the first failing item (in
input order) re-raises in the caller, and the pool is drained before returning.
"""
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, overload

# Default cap. Small enough to stay far below DynamoDB/Cognito per-account
# request rates for one API call, large enough that a typical fan-out (≤ 10
# categories, a handful of sources) runs in one wave.
DEFAULT_MAX_WORKERS = 8


def ordered_map[T, R](fn: Callable[[T], R], items: Iterable[T], max_workers: int = DEFAULT_MAX_WORKERS) -> list[R]:
    """``[fn(item) for item in items]``, run concurrently, results in input order.

    One item (or none) runs inline: there is nothing to overlap, so no pool.
    """
    work = list(items)
    if len(work) <= 1:
        return [fn(item) for item in work]
    workers = max(1, min(len(work), max_workers))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        # `map` yields in submission order and re-raises a worker's exception
        # when its result is reached.
        return list(pool.map(fn, work))


@overload
def concurrently[A, B](a: Callable[[], A], b: Callable[[], B], /) -> tuple[A, B]: ...
@overload
def concurrently[A, B, C](a: Callable[[], A], b: Callable[[], B], c: Callable[[], C], /) -> tuple[A, B, C]: ...
@overload
def concurrently[A, B, C, D](
    a: Callable[[], A], b: Callable[[], B], c: Callable[[], C], d: Callable[[], D], /,
) -> tuple[A, B, C, D]: ...
def concurrently(*calls: Callable[[], Any]) -> tuple[Any, ...]:
    """Run two to four DIFFERENT independent zero-argument reads concurrently.

    Results come back as a tuple in argument order, each keeping its own type
    (the overloads), for call sites where ``ordered_map`` over one function
    does not fit — e.g. a category fan-out beside a total read.
    """
    return tuple(ordered_map(_call, calls))


def _call[R](fn: Callable[[], R]) -> R:
    return fn()
