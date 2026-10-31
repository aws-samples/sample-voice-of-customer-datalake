"""The wizards' live "N reviews match" line: how much feedback a generation would read.

Ported from #429 by @aws-bryan. ``POST /projects/{id}/feedback-preview`` answers it in
two modes, which the persona and research wizards request at the same time:

- ``exact`` reads the SAME pool the generation samples from (``shared.feedback``
  ``context_request`` + ``read_context_pool``: one window, one predicate, one category
  scope), so the number cannot disagree with the run. It sits on a 29 s REST call, so the
  read stops at ``EXACT_BUDGET_SECONDS`` and then reports a lower bound
  (``matched_is_lower_bound``). A bulk import keeps a corpus in one day partition, which
  DynamoDB serves at a few thousand rows a second, so this takes seconds on a big corpus.
- ``estimate`` scans ``ESTIMATE_SAMPLE_PAGES`` pages of the feedback-id index (each row is
  its own partition keyed by a hash, so a scan reads rows in an order unrelated to when
  they were imported: a random sample), keeps the rows the request admits, and scales by
  the index's ``ItemCount``. About 0.3 s. Too thin a sample answers ``matched: None``
  rather than a misleading zero; the wizard then waits for the exact count.

Answers are cached per container for ``CACHE_SECONDS``, keyed on the project, the
selection (order-independent) and the caller's category scope. An exact count also
answers a later estimate request; a lower bound is never cached.
"""
from __future__ import annotations

import json
import math
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

from shared.category_access import SCOPE_CONFIG_KEY
from shared.feedback import context_request, read_context_pool, window_cutoff
from shared.feedback_sampling import POOL_FIELDS
from shared.indexes import FEEDBACK_BY_ID_INDEX
from shared.time_budget import WalkBudget

MODE_EXACT: Final = 'exact'
MODE_ESTIMATE: Final = 'estimate'
PREVIEW_MODES: Final = (MODE_EXACT, MODE_ESTIMATE)

#: The exact read's ceiling: API Gateway gives up at 29 s, so this leaves room for the rest.
EXACT_BUDGET_SECONDS: Final = 20
#: Scan pages (1 MB each) behind one estimate.
ESTIMATE_SAMPLE_PAGES: Final = 4
#: Fewer matching sample rows than this is too noisy to show.
ESTIMATE_MIN_SAMPLE_MATCHES: Final = 20
#: How long an answer is reused, and how many are kept per container.
CACHE_SECONDS: Final = 300
CACHE_MAX_ENTRIES: Final = 128
#: How long the index's ItemCount (refreshed by DynamoDB about every six hours) is reused.
INDEX_COUNT_TTL_SECONDS: Final = 600

#: The filter keys a count depends on (the caller's category scope included).
_SCOPE_KEYS: Final = ('days', 'date_basis', 'sources', 'categories', 'sentiments', 'channel', 'dims', 'tag',
                      SCOPE_CONFIG_KEY)

Clock = Callable[[], float]

_cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_index_counts: dict[str, tuple[float, int]] = {}


def _canonical(value: object) -> object:
    """``value`` with lists sorted and dict keys ordered: one selection, one cache key."""
    if isinstance(value, Mapping):
        return {str(key): _canonical(value[key]) for key in sorted(value, key=str)}
    if isinstance(value, list | tuple):
        return sorted((_canonical(item) for item in value), key=lambda item: json.dumps(item, default=str))
    return value


def cache_key(project_id: str, filters: Mapping[str, Any], mode: str) -> str:
    """One cache entry per project, mode, selection (click order ignored) and category scope."""
    scope = {key: _canonical(filters.get(key)) for key in _SCOPE_KEYS}
    return json.dumps({'project': project_id, 'mode': mode, 'scope': scope}, sort_keys=True, default=str)


def _cached(key: str, now: float) -> dict[str, Any] | None:
    hit = _cache.get(key)
    if hit is None or now - hit[0] >= CACHE_SECONDS:
        return None
    return hit[1]


def _store(key: str, now: float, result: dict[str, Any]) -> None:
    _cache.pop(key, None)
    _cache[key] = (now, result)
    while len(_cache) > CACHE_MAX_ENTRIES:
        _cache.popitem(last=False)  # insertion order is age order


def _answer(matched: int | None, *, lower_bound: bool, estimated: bool) -> dict[str, Any]:
    return {'matched': matched, 'matched_is_lower_bound': lower_bound, 'estimated': estimated}


def exact_count(feedback_table: Any, filters: dict, *, clock: Clock = time.monotonic) -> dict[str, Any]:
    """How many reviews the generation's own read admits, within ``EXACT_BUDGET_SECONDS``."""
    request = context_request(feedback_table, filters)
    if request is None:
        return _answer(0, lower_bound=False, estimated=False)
    pool = read_context_pool(feedback_table, request, budget=WalkBudget(seconds=EXACT_BUDGET_SECONDS, clock=clock))
    return _answer(len(pool.rows), lower_bound=pool.capped, estimated=False)


def _indexed_count(feedback_table: Any, now: float) -> int:
    """The feedback-id index's ItemCount (a DescribeTable), reused for ``INDEX_COUNT_TTL_SECONDS``."""
    name = str(feedback_table.name)
    hit = _index_counts.get(name)
    if hit is not None and now - hit[0] < INDEX_COUNT_TTL_SECONDS:
        return hit[1]
    table = feedback_table.meta.client.describe_table(TableName=name).get('Table', {})
    count = next((int(index.get('ItemCount') or 0) for index in table.get('GlobalSecondaryIndexes') or []
                  if index.get('IndexName') == FEEDBACK_BY_ID_INDEX), 0)
    _index_counts[name] = (now, count)
    return count


def _scan_sample(feedback_table: Any, pages: int) -> tuple[list[dict], bool]:
    """``(rows, complete)``: up to ``pages`` scan pages of the feedback-id index, projected."""
    aliases = {f'#f{i}': name for i, name in enumerate(POOL_FIELDS)}
    kwargs: dict[str, Any] = {
        'IndexName': FEEDBACK_BY_ID_INDEX,
        'ProjectionExpression': ', '.join(aliases),
        'ExpressionAttributeNames': aliases,
    }
    rows: list[dict] = []
    for _ in range(pages):
        response = feedback_table.scan(**kwargs)
        rows.extend(item for item in response.get('Items', []) if isinstance(item, dict))
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return rows, True
        kwargs['ExclusiveStartKey'] = last_key
    return rows, False


def import_floor(request: Any, sample: Sequence[Mapping[str, Any]]) -> str:
    """The oldest import date the exact read would reach, judged from the sample.

    A category or channel read covers the whole calendar window. The day walk covers it
    too, but stops after ``max_dated_days`` days that held feedback (an all-time or long
    window): the sample's newest such days stand in for the walk's.
    """
    cutoff = window_cutoff(request.days)
    if request.by_category or request.extra.channel:
        return cutoff
    dates = sorted({date for date in (str(row.get('date') or '') for row in sample) if date >= cutoff},
                   reverse=True)
    if len(dates) > request.max_dated_days:
        return dates[request.max_dated_days - 1]
    return cutoff


#: Significant digits an estimate keeps.
ESTIMATE_SIGNIFICANT_DIGITS = 2


def _round_significant(value: float) -> int:
    """28,202 -> 28,000: an estimate does not claim precision it does not have."""
    if value < 1:
        return 0
    step = 10 ** max(math.floor(math.log10(value)) - (ESTIMATE_SIGNIFICANT_DIGITS - 1), 0)
    return int(round(value / step) * step)


def estimate_count(
    feedback_table: Any, filters: dict, *, pages: int = ESTIMATE_SAMPLE_PAGES, clock: Clock = time.monotonic,
) -> dict[str, Any]:
    """A sampled estimate of :func:`exact_count`; ``matched`` None when the sample is too thin."""
    request = context_request(feedback_table, filters)
    if request is None:
        return _answer(0, lower_bound=False, estimated=False)
    sample, complete = _scan_sample(feedback_table, pages)
    floor = import_floor(request, sample)
    matched = sum(1 for row in sample if str(row.get('date') or '') >= floor and request.admits(row))
    if complete:
        # The sample was the whole index: still an estimate (the exact read's caps can differ).
        return _answer(matched or None, lower_bound=False, estimated=True)
    total = _indexed_count(feedback_table, clock())
    if matched < ESTIMATE_MIN_SAMPLE_MATCHES or total <= 0 or not sample:
        return _answer(None, lower_bound=False, estimated=True)
    return _answer(_round_significant(matched / len(sample) * total), lower_bound=False, estimated=True)


def preview_feedback(
    feedback_table: Any, project_id: str, filters: dict, mode: str, *, clock: Clock = time.monotonic,
) -> dict[str, Any]:
    """The answer for ``mode``, from the cache when it holds one (an exact count beats an estimate)."""
    if mode not in PREVIEW_MODES:
        raise ValueError(f"mode must be one of: {', '.join(PREVIEW_MODES)}")
    now = clock()
    exact_key = cache_key(project_id, filters, MODE_EXACT)
    cached = _cached(exact_key, now)
    if cached is None and mode == MODE_ESTIMATE:
        cached = _cached(cache_key(project_id, filters, MODE_ESTIMATE), now)
    if cached is not None:
        return dict(cached)
    if mode == MODE_ESTIMATE:
        result = estimate_count(feedback_table, filters, clock=clock)
        _store(cache_key(project_id, filters, MODE_ESTIMATE), now, result)
        return dict(result)
    result = exact_count(feedback_table, filters, clock=clock)
    if not result['matched_is_lower_bound']:
        _store(exact_key, now, result)
    return dict(result)
