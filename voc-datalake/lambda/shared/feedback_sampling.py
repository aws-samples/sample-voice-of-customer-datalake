"""Even sampling of the feedback a window matches, for the LLM context paths.

Persona, research and document generation can only put a few hundred reviews in
front of a model, while a window routinely matches tens of thousands. The old
read walked the days newest first and stopped at ``3 x limit`` raw rows, so the
sample was simply the NEWEST rows: one bulk import of 25,229 reviews on one day
made every persona out of that day alone, whatever window and filters were set.

So the read is now three steps (ported from #429 by @aws-bryan):

1. ``read_pool`` reads EVERY partition of the window, projected to ``POOL_FIELDS``
   (the table keys plus what the filters read), and keeps the rows the caller's
   filters admit. Bounded by ``POOL_MAX_ROWS`` rows read and by the request's
   ``WalkBudget``; a pool cut short by either is flagged ``capped``.
2. ``sample_evenly`` picks a deterministic, evenly strided sample of the pool,
   so every day (and every source, category, ...) is represented in proportion
   to how much of the match it holds.
3. ``fetch_full`` fetches only the sampled rows in full, by table key
   (BatchGetItem), keeping the sample's order.

The DynamoDB page limit (1 MB) applies BEFORE the projection, so the projection
does not save read capacity; it saves transfer and, above all, deserialisation,
which is what bounds a 50,000-row read in a Lambda.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from boto3.dynamodb.conditions import ConditionBase

from shared.batch_get import batch_get_all
from shared.channel_index import ChannelIndexUnavailable, walk_channel
from shared.logging import logger
from shared.time_budget import WalkBudget

__all__ = [
    'MAX_INPUT_FEEDBACK_IDS',
    'POOL_MAX_ROWS',
    'FeedbackPool',
    'Partition',
    'fetch_full',
    'input_feedback_ids',
    'read_channel_pool',
    'read_pool',
    'sample_evenly',
]

# Raw rows one pool read may hold. A projected row is a few hundred bytes, so this
# is memory-safe in every Lambda that samples; past it the pool is `capped` and the
# sample covers the newest part of the window only (logged, never silent).
POOL_MAX_ROWS: Final = 50_000

# What a pool row carries: the table keys the sample is fetched by, the ids and
# dates, and every field a filter or the category scope reads (sources, channel,
# category, sentiment, dims, tags, rating). `gsi5-by-channel` projects all of them.
POOL_FIELDS: Final = (
    'pk', 'sk', 'feedback_id', 'date', 'source_created_at', 'source_platform', 'source_channel',
    'category', 'sentiment_label', 'dimensions', 'tags', 'rating',
)


class SampleFetchFailed(RuntimeError):
    """BatchGetItem left sampled keys unprocessed after its retries."""


@dataclass(frozen=True)
class Partition:
    """One index partition of the window: ``(index, key condition)``.

    ``dated`` marks a day partition, which counts toward the walk's
    days-with-data limit (``max_dated``) when it returns any row.
    """

    index_name: str
    key_condition: ConditionBase
    dated: bool = False


@dataclass(frozen=True)
class FeedbackPool:
    """The admitted rows of one window, in read order (newest day first).

    ``read`` is how many raw rows were read; ``capped`` means the read stopped at
    the row cap or the time budget, so ``rows`` is a lower bound on the match.
    """

    rows: list[dict]
    read: int
    capped: bool


def _projection(fields: Sequence[str]) -> dict[str, Any]:
    """``ProjectionExpression`` + names for ``fields``; every name aliased (`date` is reserved)."""
    aliases = {f'#f{i}': name for i, name in enumerate(fields)}
    return {'ProjectionExpression': ', '.join(aliases), 'ExpressionAttributeNames': aliases}


def _read_partition(
    table: Any, partition: Partition, *, row_condition: ConditionBase | None,
    budget: WalkBudget, room: int,
) -> tuple[list[dict], bool]:
    """One partition's rows (projected), newest first: ``(rows, stopped_early)``.

    Stops early at ``room`` rows or once the budget is spent, at a page boundary.
    """
    kwargs: dict[str, Any] = {
        'IndexName': partition.index_name,
        'KeyConditionExpression': partition.key_condition,
        'ScanIndexForward': False,
        **_projection(POOL_FIELDS),
    }
    if row_condition is not None:
        kwargs['FilterExpression'] = row_condition
    rows: list[dict] = []
    while True:
        response = table.query(**kwargs)
        rows.extend(response.get('Items', []))
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return rows[:room], len(rows) > room
        if len(rows) >= room or budget.exhausted():
            return rows[:room], True
        kwargs['ExclusiveStartKey'] = last_key


def read_pool(
    table: Any,
    partitions: Iterable[Partition],
    *,
    admit: Callable[[Mapping[str, Any]], bool],
    budget: WalkBudget,
    row_condition: ConditionBase | None = None,
    max_rows: int = POOL_MAX_ROWS,
    max_dated: int = 0,
    stop_after: int = 0,
) -> FeedbackPool:
    """Every row of ``partitions`` that ``admit`` accepts, in partition order.

    ``row_condition`` is pushed down as the FilterExpression (the channel), so the
    row cap counts matching rows. ``max_dated`` (0 = none) ends a day walk after
    that many day partitions returned rows, exactly like the old walk's limit.
    ``stop_after`` (0 = none) ends the read once that many rows were admitted.
    """
    rows: list[dict] = []
    read = 0
    dated = 0
    for partition in partitions:
        part, stopped = _read_partition(
            table, partition, row_condition=row_condition, budget=budget, room=max_rows - read,
        )
        read += len(part)
        rows.extend(row for row in part if admit(row))
        dated += 1 if partition.dated and part else 0
        if stopped or read >= max_rows or budget.exhausted():
            return FeedbackPool(rows=rows, read=read, capped=True)
        if (max_dated and dated >= max_dated) or (stop_after and len(rows) >= stop_after):
            break
    return FeedbackPool(rows=rows, read=read, capped=False)


def read_channel_pool(
    table: Any,
    channel: str,
    cutoff_date: str,
    *,
    admit: Callable[[Mapping[str, Any]], bool],
    budget: WalkBudget,
    max_rows: int = POOL_MAX_ROWS,
) -> FeedbackPool | None:
    """The window's rows of one channel through ``gsi5-by-channel`` (slim rows), or None.

    None when the index does not exist yet (a deployment mid-upgrade): the caller
    then walks the days with the channel pushed down instead.
    """
    try:
        rows, partial = walk_channel(table, channel, cutoff_date, budget, cap=max_rows)
    except ChannelIndexUnavailable:
        logger.warning('[FEEDBACK] gsi5-by-channel is missing; sampling the channel through the day walk')
        return None
    return FeedbackPool(rows=[row for row in rows if admit(row)], read=len(rows), capped=partial)


def sample_evenly(rows: Sequence[dict], size: int) -> list[dict]:
    """``size`` rows spread evenly across ``rows``: the first ``size`` of :func:`spread_order`.

    Deterministic (no randomness), so the same filters over the same data choose the
    same items and a regenerated set is comparable with the last one. NESTED: the
    sample of ``n`` is the first ``n`` of every larger sample, so pages sliced by
    offset/limit never overlap or skip, and a trimmed tail still leaves an even sample.
    """
    if size <= 0:
        return []
    return [rows[i] for i in spread_order(len(rows))[:size]]


def _bit_reversed(value: int, bits: int) -> int:
    out = 0
    for _ in range(bits):
        out = (out << 1) | (value & 1)
        value >>= 1
    return out


def spread_order(count: int) -> list[int]:
    """The positions ``0..count-1`` ordered so that EVERY prefix is spread across the range.

    The callers trim the sample from its tail (the prompt's token budget, the 500 stored
    ids). In date order that tail is the oldest days, so a trimmed sample was the newest
    day again (found live: 872 reviews sampled over 7 days, the model read the first 500,
    all from today). Bit-reversal order (0, n/2, n/4, 3n/4, ...) keeps any prefix an even
    sample of the whole, so a trim drops evenly from every part of the window.
    """
    if count <= 1:
        return list(range(count))
    bits = (count - 1).bit_length()
    return [p for p in (_bit_reversed(i, bits) for i in range(1 << bits)) if p < count]


def _row_key(row: Mapping[str, Any]) -> tuple[Any, Any]:
    return row.get('pk'), row.get('sk')


def fetch_full(table: Any, rows: Sequence[Mapping[str, Any]]) -> list[dict]:
    """The full items behind ``rows`` (pool rows), in ``rows``' order.

    A row whose item vanished since the pool read (a deletion in between) is
    dropped and counted in the log. Raises :class:`SampleFetchFailed` when
    DynamoDB leaves keys unprocessed after the retries: a sample that quietly
    lost rows would shift what the model reads without anyone knowing.
    """
    keys: dict[tuple[Any, Any], dict[str, Any]] = {}
    for row in rows:
        pk, sk = _row_key(row)
        if isinstance(pk, str) and isinstance(sk, str):
            keys.setdefault((pk, sk), {'pk': pk, 'sk': sk})
    if not keys:
        return []
    found = {
        _row_key(item): item
        for item in batch_get_all(table, list(keys.values()), failure=SampleFetchFailed(
            'BatchGetItem left sampled feedback keys unprocessed'))
    }
    items = [found[key] for key in keys if key in found]
    if len(items) < len(keys):
        logger.warning(
            '[FEEDBACK] Sampled feedback vanished before it could be fetched',
            extra={'missing': len(keys) - len(items), 'sampled': len(keys)},
        )
    return items


# Ids recorded per generated artefact (persona, research report): the corpus the
# model actually read (#236). Every LLM-context fetch limit is far below this
# (persona ~145 items on a 200K-token model), so it bounds the stored row, not the record.
MAX_INPUT_FEEDBACK_IDS: Final = 500


def input_feedback_ids(items: Sequence[Mapping[str, Any]], used: int | None = None) -> list[str]:
    """The ``feedback_id`` of the first ``used`` items (all when None), in prompt order, capped.

    The formatted context numbers the items in order and every trim cuts its
    tail, so the first ``used`` items are exactly the ones the model saw.
    """
    head = items if used is None else items[:max(used, 0)]
    ids = [item.get('feedback_id') for item in head]
    return [fid for fid in ids if isinstance(fid, str) and fid][:MAX_INPUT_FEEDBACK_IDS]
