"""Capacity of `GET /feedback/problems` on a large import: 30,000 reviews in ONE import day.

The customer case (5.46.00): 26,622 reviews imported over a few days, possibly 25,000+ in
one import day, viewed with "All time" or 90 days on either date basis. These tests feed
30,000 reviews with realistic, varied problem summaries through the real route and check:

- the answer is COMPLETE (not partial) when the reads are fast: no per-day or per-request
  cap cuts a 30,000-review day (`PROBLEM_READ`: 100,000 rows per partition and request);
- the tree (similarity merge included) is built well within the time left after the walk;
- the answer stays bounded: at most `MAX_PROBLEMS_LISTED` problems, a few MB at most.

The feedback table is an in-memory fake of the one Query shape the walk sends
(`gsi1-by-date`, Limit, ExclusiveStartKey, ProjectionExpression). It pages like DynamoDB:
a page stops at `Limit` rows or at 1 MB of FULL items read (DynamoDB counts the item
before the projection), so the page count it reports is what the real walk would send.
moto would take minutes to page 30,000 rows and measures nothing about DynamoDB itself.
The measured numbers are logged (`-o log_cli=true --log-cli-level=INFO`) for the release report.
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Iterator, Sequence
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, TypeVar
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import pk_sk_table

from metrics_handler import lambda_handler
from shared.api import clear_categories_cache
from shared.earliest_date import EARLIEST_DATE_KEY
from shared.problem_aggregation import MAX_PROBLEMS_LISTED

pytestmark = pytest.mark.slow

_T = TypeVar('_T')
# The measured numbers, for the release report: run with `-o log_cli=true --log-cli-level=INFO`.
logger = logging.getLogger(__name__)

REVIEWS_IN_ONE_DAY = 30_000
HISTORY_DAYS = 120
# DynamoDB's page size limit, counted on the full item read (before projection and filter).
PAGE_BYTES = 1024 * 1024
# A stored review: its text, translation, entities and model output. 2 KB is a typical item.
REVIEW_TEXT_CHARS = 1_400
# API Gateway gives 29 s and the walk may use 20 s of it, so building the tree must fit in what
# is left with room to spare. Measured on CPU time (see `_timed_problems`), generously.
TREE_CPU_SECONDS_BOUND = 6.0
# Lambda answers a synchronous invoke with at most 6 MB.
RESPONSE_BYTES_BOUND = 6 * 1024 * 1024
# The SPA's default type filter ("Problems only").
PROBLEMS_ONLY_DIMS = ('feedback_type:bug|service_failure|performance|usability|pricing_billing'
                      '|support_experience|~unset')

# Problem wordings: subject x complaint x detail gives thousands of distinct summaries that
# share some keywords (so the similarity merge has real work) without collapsing into a few.
SUBJECTS = ('package', 'order', 'delivery', 'refund', 'checkout', 'app', 'login', 'search',
            'payment', 'invoice', 'subscription', 'courier', 'tracking page', 'support chat',
            'mobile app', 'promo code', 'gift card', 'return label', 'seat selection', 'baggage')
COMPLAINTS = ('arrived late', 'never arrived', 'was damaged', 'charged twice', 'failed silently',
              'crashes on start', 'times out', 'shows the wrong price', 'is missing items',
              'took weeks', 'was cancelled without notice', 'keeps logging out', 'is very slow',
              'rejects valid cards', 'gives no confirmation', 'loses saved details', 'freezes',
              'sends duplicate emails', 'has confusing wording', 'ignores the delivery note')
DETAILS = ('after the latest update', 'during the holiday sale', 'on every second attempt',
           'for international orders', 'with no explanation', 'despite tracking showing delivered',
           'when paying by card', 'on older phones', 'for the third time this month',
           'while the agent was unreachable', 'after the price changed', 'at night',
           'in the evening rush', 'for premium members', 'when switching language', '')
CATEGORIES = {
    'delivery': ('shipping_speed', 'lost_parcels', 'damaged_items', 'courier_behaviour'),
    'billing': ('double_charge', 'refund_delay', 'pricing'),
    'app': ('crashes', 'performance', 'login', 'navigation'),
    'support': ('response_time', 'resolution'),
    'product': ('quality', 'missing_items'),
}
TYPES = ('bug', 'service_failure', 'performance', 'usability', 'pricing_billing',
         'support_experience', 'feature_request', 'praise', None)


def _day(offset: int) -> str:
    return (datetime.now(UTC) - timedelta(days=offset)).strftime('%Y-%m-%d')


class _Draw:
    """Deterministic picks for review ``n``: a hash of (n, salt), so every run builds the same day."""

    def __init__(self, n: int) -> None:
        self._n = n

    def unit(self, salt: str) -> float:
        digest = hashlib.blake2b(f'{self._n}:{salt}'.encode(), digest_size=8).digest()
        return int.from_bytes(digest) / 2 ** 64

    def choice(self, options: Sequence[_T], salt: str) -> _T:
        return options[int(self.unit(salt) * len(options))]


def _subcategory_for(draw: _Draw) -> tuple[str, str]:
    """Skewed like a real import: about a third of the reviews land in one subcategory."""
    if draw.unit('skew') < 0.35:
        return 'delivery', 'shipping_speed'
    category = draw.choice(tuple(CATEGORIES), 'category')
    return category, draw.choice(CATEGORIES[category], 'subcategory')


def _summary(draw: _Draw) -> str:
    return ' '.join(part for part in (
        f"The {draw.choice(SUBJECTS, 'subject')}", draw.choice(COMPLAINTS, 'complaint'),
        draw.choice(DETAILS, 'detail')) if part)


def _review(n: int, *, import_day: str) -> dict[str, Any]:
    draw = _Draw(n)
    category, subcategory = _subcategory_for(draw)
    kind = draw.choice(TYPES, 'type')
    fid = f'f{n:06d}'
    row: dict[str, Any] = {
        'pk': 'SOURCE#web', 'sk': f'FEEDBACK#{fid}', 'feedback_id': fid,
        'gsi1pk': f'DATE#{import_day}', 'gsi1sk': f'{import_day}T{n // 3600 % 24:02d}:{n // 60 % 60:02d}:{n % 60:02d}.{n:06d}',
        'date': import_day, 'source_platform': 'web', 'source_channel': 'reviews',
        # Written over the 400 days before the import.
        'source_created_at': f"{_day(1 + int(draw.unit('written') * 400))}T09:00:00Z",
        'sentiment_label': draw.choice(('negative', 'negative', 'mixed', 'neutral'), 'label'),
        'sentiment_score': Decimal(str(round(-0.95 + draw.unit('score') * 1.15, 3))),
        'urgency': 'high' if draw.unit('urgency') < 0.08 else 'low',
        'category': category, 'subcategory': subcategory,
        'problem_summary': _summary(draw),
        'problem_root_cause_hypothesis': f"Likely cause: {draw.choice(SUBJECTS, 'cause')} process gap",
        'rating': Decimal(1 + int(draw.unit('rating') * 3)),
        # The bulk of a stored review: never projected, but DynamoDB reads it for the 1 MB page limit.
        'original_text': 'x' * REVIEW_TEXT_CHARS,
    }
    if kind is not None:
        row['dimensions'] = {'feedback_type': kind}
    return row


def _item_bytes(item: dict[str, Any]) -> int:
    return len(json.dumps(item, default=str))


class _FakeDateIndex:
    """`feedback_table.query` for `gsi1-by-date`, paging like DynamoDB (Limit or 1 MB of full items)."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._partitions: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            self._partitions.setdefault(row['gsi1pk'], []).append(row)
        for partition in self._partitions.values():
            partition.sort(key=lambda r: r['gsi1sk'], reverse=True)
        self.pages = 0
        self.bytes_read = 0

    def query(self, **kwargs: Any) -> dict[str, Any]:
        assert kwargs['IndexName'] == 'gsi1-by-date'
        assert 'FilterExpression' not in kwargs, 'an unrestricted, channel-free walk pushes no filter down'
        _, partition_key = kwargs['KeyConditionExpression'].get_expression()['values']
        rows = self._partitions.get(partition_key, [])
        start = kwargs.get('ExclusiveStartKey', {}).get('_offset', 0)
        names = kwargs.get('ExpressionAttributeNames', {})
        fields = [names.get(name.strip(), name.strip()) for name in kwargs.get('ProjectionExpression', '').split(',') if name.strip()]
        page: list[dict[str, Any]] = []
        size = 0
        end = start
        while end < len(rows) and len(page) < kwargs['Limit'] and size < PAGE_BYTES:
            row = rows[end]
            size += _item_bytes(row)
            page.append({f: row[f] for f in fields if f in row} if fields else dict(row))
            end += 1
        self.pages += 1
        self.bytes_read += size
        response: dict[str, Any] = {'Items': page, 'Count': len(page), 'ScannedCount': len(page)}
        if end < len(rows):
            response['LastEvaluatedKey'] = {'_offset': end}
        return response


def _one_big_import_day() -> list[dict[str, Any]]:
    """30,000 reviews imported yesterday, written over the 400 days before."""
    import_day = _day(1)
    return [_review(n, import_day=import_day) for n in range(REVIEWS_IN_ONE_DAY)]


@pytest.fixture(scope='module')
def big_day() -> list[dict[str, Any]]:
    return _one_big_import_day()


@contextmanager
def capacity_world(day: list[dict[str, Any]], aggregates_name: str) -> Iterator[_FakeDateIndex]:
    """The fake feedback index holding *day*, moto aggregates with 120 days of history.

    Shared with the aggregate-routes capacity suite (test_metrics_aggregate_capacity.py)."""
    with ExitStack() as stack:
        stack.enter_context(mock_aws())
        clear_categories_cache()
        aggregates = pk_sk_table(aggregates_name)
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config',
                                  'categories': [{'name': name} for name in CATEGORIES]})
        aggregates.put_item(Item={**EARLIEST_DATE_KEY, 'date': _day(HISTORY_DAYS)})
        index = _FakeDateIndex(day)
        stack.enter_context(patch('metrics_handler.feedback_table', index))
        stack.enter_context(patch('metrics_handler.aggregates_table', aggregates))
        yield index
    clear_categories_cache()


@pytest.fixture
def world(big_day: list[dict[str, Any]]) -> Iterator[_FakeDateIndex]:
    """The fake feedback index holding the big day, moto aggregates with 120 days of history."""
    with capacity_world(big_day, 'capacity-aggregates') as index:
        yield index


@dataclass(frozen=True)
class _Measured:
    """One route call: its answer, serialized size, wall time and this process's CPU time."""

    body: dict
    size: int
    wall_seconds: float
    cpu_seconds: float


def _timed_problems(event, context, **params: str) -> _Measured:
    """Call the route once and measure it. The bound is on CPU time: the gate runs pytest in
    parallel workers, so wall time there measures the machine's load, not the route."""
    wall, cpu = time.perf_counter(), time.process_time()
    response, body = call_route(lambda_handler, event, context, method='GET', path='/feedback/problems',
                                query_params=params)
    measured = _Measured(body, len(response['body'].encode()), time.perf_counter() - wall, time.process_time() - cpu)
    assert response['statusCode'] == 200, body
    return measured


def _listed(body: dict) -> int:
    """Problems the answer lists (the largest, when `problems_truncated`)."""
    return sum(len(s['problems']) for c in body['categories'] for s in c['subcategories'])


def _report(label: str, index: _FakeDateIndex, run: _Measured) -> None:
    body = run.body
    logger.info(f"[capacity] {label}: CPU {run.cpu_seconds:.2f} s (wall {run.wall_seconds:.2f} s), "
                f"reviews {body['feedback_count']}, problems "
                f"{body['problem_count']} (listed {_listed(body)}, truncated {body['problems_truncated']}), "
                f"similarity_partial {body['similarity_partial']}, response {run.size / 1024:.0f} KB, "
                f"query pages {index.pages}, full-item bytes read {index.bytes_read / 1024 / 1024:.1f} MB")


WINDOWS = [
    pytest.param({'days': '0', 'date_basis': 'review'}, id='all-time-review-basis'),
    pytest.param({'days': '0', 'date_basis': 'imported'}, id='all-time-import-basis'),
    pytest.param({'days': '90', 'date_basis': 'imported'}, id='90-days-import-basis'),
]


class TestThirtyThousandReviewsInOneImportDay:
    @pytest.mark.parametrize('window', WINDOWS)
    def test_the_whole_day_is_counted_and_the_answer_is_complete(self, world, api_gateway_event, lambda_context, window):
        run = _timed_problems(api_gateway_event, lambda_context, similarity='off', **window)
        _report(f"{window['days']} days / {window['date_basis']}, similarity off", world, run)
        assert (run.body['feedback_count'], run.body['is_partial']) == (REVIEWS_IN_ONE_DAY, False)
        assert 'partial_reason' not in run.body
        assert sum(run.body['type_counts'].values()) == REVIEWS_IN_ONE_DAY

    @pytest.mark.parametrize('similarity', ['med', 'low'])
    def test_the_similarity_merge_finishes_well_within_the_time_left_after_the_walk(
            self, world, api_gateway_event, lambda_context, similarity):
        run = _timed_problems(api_gateway_event, lambda_context, days='0', date_basis='review', similarity=similarity)
        _report(f'all time, similarity {similarity}', world, run)
        assert run.cpu_seconds < TREE_CPU_SECONDS_BOUND
        assert (run.body['feedback_count'], run.body['is_partial']) == (REVIEWS_IN_ONE_DAY, False)

    def test_the_answer_stays_bounded_with_every_total_exact(self, world, api_gateway_event, lambda_context):
        run = _timed_problems(api_gateway_event, lambda_context, days='0', similarity='off')
        _report('all time, similarity off (widest tree)', world, run)
        assert _listed(run.body) <= MAX_PROBLEMS_LISTED
        assert run.body['problems_truncated'] is (run.body['problem_count'] > MAX_PROBLEMS_LISTED)
        assert run.size < RESPONSE_BYTES_BOUND
        assert sum(c['total_items'] for c in run.body['categories']) == REVIEWS_IN_ONE_DAY

    def test_the_problems_only_default_reads_the_day_in_full_and_keeps_untyped_reviews(
            self, world, api_gateway_event, lambda_context, big_day):
        run = _timed_problems(api_gateway_event, lambda_context, days='0', date_basis='review', dims=PROBLEMS_ONLY_DIMS)
        _report('all time, Problems only (the page default)', world, run)
        hidden = {'feature_request', 'praise'}
        expected = sum(1 for row in big_day if row.get('dimensions', {}).get('feedback_type') not in hidden)
        assert (run.body['feedback_count'], run.body['is_partial']) == (expected, False)

    def test_the_walk_sends_one_page_per_megabyte_of_reviews(self, world, api_gateway_event, lambda_context, big_day):
        run = _timed_problems(api_gateway_event, lambda_context, days='0', similarity='off')
        full_bytes = sum(_item_bytes(row) for row in big_day)
        # One query per empty day of the window, and the big day in pages bounded by DynamoDB's
        # 1 MB of full items, not by the 2,000-row page limit.
        empty_days = run.body['window']['walk_days'] - 1
        assert world.pages - empty_days == pytest.approx(full_bytes / PAGE_BYTES, abs=2)
