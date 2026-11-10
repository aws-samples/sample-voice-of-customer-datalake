"""Capacity of the Dashboard / Categories aggregate routes on a large import (5.47.00).

With the review-date basis, or a source / channel / dims / tag filter, `/metrics/summary`,
`/metrics/categories`, `/metrics/sentiment`, `/metrics/sources`, `/metrics/personas`,
`/metrics/dimensions` and `/feedback/entities` count raw rows (the aggregator's counters are
bucketed by import date and keyed by none of those filters). They used to stop at the list
routes' 5,000 rows, so a 30,000-review import day showed 5,000 with `is_partial` and a
misleading `partial_reason: 'time_budget'`. They now read slim rows (`METRIC_ROW_FIELDS`) with
the `/feedback/problems` capacity (`AGGREGATE_READ_ROWS` = `PROBLEM_READ`: 100,000 rows per
request and per day), and a cap that still cuts says `row_cap` with `scanned_through` = the day
walked just before the cut day. The list routes keep their 5,000-row window.

The 30,000 reviews and the paging fake (1 MB of FULL items or `Limit` rows per page, as
DynamoDB pages) are the `/feedback/problems` capacity suite's. Measured numbers are logged
(`-o log_cli=true --log-cli-level=INFO`) for the release report.
"""
from __future__ import annotations

import logging
import time
from collections.abc import Iterator
from typing import Any

import pytest
from handler_events_fixtures import call_route
from test_metrics_problems_capacity import (
    PROBLEMS_ONLY_DIMS,
    REVIEWS_IN_ONE_DAY,
    _day,
    _FakeDateIndex,
    _one_big_import_day,
    capacity_world,
)

from metrics_handler import MAX_FEEDBACK_OFFSET, lambda_handler

pytestmark = pytest.mark.slow

logger = logging.getLogger(__name__)

# The walk itself (paging 30,000 slim rows through the fake) plus the tally. Generous: the gate
# runs pytest in parallel workers; measured well under 2 s per route on a laptop. 10 s (owner-approved,
# 5.56.00) leaves a shared CI runner room. Marked `timing`: runs apart, untraced.
ROUTE_CPU_SECONDS_BOUND = 10.0
HIDDEN_TYPES = frozenset({'feature_request', 'praise'})

# Each aggregate route and the number its answer reports for the reviews it counted.
AGGREGATE_ROUTES = [
    pytest.param('/metrics/summary', {}, lambda b: b['total_feedback'], id='summary'),
    pytest.param('/metrics/categories', {}, lambda b: sum(b['categories'].values()), id='categories'),
    pytest.param('/metrics/sentiment', {}, lambda b: b['total'], id='sentiment'),
    pytest.param('/metrics/sources', {}, lambda b: sum(b['sources'].values()), id='sources'),
    pytest.param('/metrics/personas', {}, lambda b: sum(b['personas'].values()), id='personas'),
    pytest.param('/metrics/dimensions', {'key': 'feedback_type'},
                 lambda b: sum(v['count'] for v in b['values'].values()) + b['unassigned'], id='dimensions'),
    pytest.param('/feedback/entities', {}, lambda b: b['feedback_count'], id='entities'),
]


@pytest.fixture(scope='module')
def big_day() -> list[dict[str, Any]]:
    return _one_big_import_day()


@pytest.fixture
def world(big_day: list[dict[str, Any]]) -> Iterator[_FakeDateIndex]:
    """The fake feedback index holding the big day (yesterday), moto aggregates with 120 days of history."""
    with capacity_world(big_day, 'aggregate-capacity') as index:
        yield index


def _timed_get(event, context, path: str, params: dict[str, str]) -> tuple[dict, float]:
    """The route's 200 body and this process's CPU seconds for the call."""
    cpu = time.process_time()
    response, body = call_route(lambda_handler, event, context, method='GET', path=path, query_params=params)
    elapsed = time.process_time() - cpu
    assert response['statusCode'] == 200, body
    return body, elapsed


def _problems_only(big_day: list[dict[str, Any]]) -> int:
    """Reviews the SPA's default "Problems only" type filter admits (untyped included)."""
    return sum(1 for row in big_day if row.get('dimensions', {}).get('feedback_type') not in HIDDEN_TYPES)


class TestThirtyThousandReviewsInOneImportDay:
    @pytest.mark.timing
    @pytest.mark.parametrize(('path', 'extra', 'counted'), AGGREGATE_ROUTES)
    def test_the_review_basis_with_a_dims_filter_counts_the_whole_day(
            self, world, api_gateway_event, lambda_context, big_day, path, extra, counted):
        params = {'days': '0', 'date_basis': 'review', 'dims': PROBLEMS_ONLY_DIMS, **extra}
        body, cpu = _timed_get(api_gateway_event, lambda_context, path, params)
        logger.info(f'[aggregate capacity] {path} review basis + dims: CPU {cpu:.2f} s, '
                    f'counted {counted(body)}, query pages {world.pages}')
        assert (counted(body), body['is_partial']) == (_problems_only(big_day), False)
        assert 'partial_reason' not in body
        assert 'scanned_through' not in body
        assert cpu < ROUTE_CPU_SECONDS_BOUND

    @pytest.mark.parametrize(('path', 'extra', 'counted'), AGGREGATE_ROUTES)
    @pytest.mark.usefixtures('world')
    def test_the_review_basis_alone_counts_every_review(
            self, api_gateway_event, lambda_context, path, extra, counted):
        body, _ = _timed_get(api_gateway_event, lambda_context, path,
                             {'days': '0', 'date_basis': 'review', **extra})
        assert (counted(body), body['is_partial']) == (REVIEWS_IN_ONE_DAY, False)

    @pytest.mark.timing
    @pytest.mark.usefixtures('world')
    def test_the_list_route_keeps_its_five_thousand_row_window(
            self, api_gateway_event, lambda_context, monkeypatch):
        # The page's full reviews are fetched by key from the real table; the window is what counts here.
        monkeypatch.setattr('metrics_handler._batch_get_feedback', lambda rows: (rows, False))
        body, _ = _timed_get(api_gateway_event, lambda_context, '/feedback',
                             {'days': '0', 'date_basis': 'review', 'dims': PROBLEMS_ONLY_DIMS, 'limit': '10'})
        assert body['is_partial_window'] is True
        assert body['total'] <= MAX_FEEDBACK_OFFSET


@pytest.mark.usefixtures('world')
class TestACapThatStillCutsSaysSo:
    """Past the aggregate capacity the answer is partial on a ROW cap, never a time budget."""

    def test_a_cut_on_the_big_day_names_the_day_walked_before_it(
            self, api_gateway_event, lambda_context, monkeypatch):
        monkeypatch.setattr('metrics_handler.AGGREGATE_READ_ROWS', 10_000)
        body, _ = _timed_get(api_gateway_event, lambda_context, '/metrics/summary',
                             {'days': '0', 'date_basis': 'review'})
        assert (body['is_partial'], body['partial_reason']) == (True, 'row_cap')
        # The walk reads today (empty, in full), then the cap cuts yesterday (the big day).
        assert body['scanned_through'] == _day(0)
        assert body['total_feedback'] == 10_000

    def test_a_cut_on_the_first_day_walked_claims_no_day(
            self, api_gateway_event, lambda_context, monkeypatch, big_day):
        monkeypatch.setattr('metrics_handler.AGGREGATE_READ_ROWS', 10_000)
        today = _day(0)
        moved = [{**row, 'gsi1pk': f'DATE#{today}', 'date': today} for row in big_day]
        monkeypatch.setattr('metrics_handler.feedback_table', _FakeDateIndex(moved))
        body, _ = _timed_get(api_gateway_event, lambda_context, '/metrics/categories',
                             {'days': '0', 'date_basis': 'review'})
        assert (body['is_partial'], body['partial_reason']) == (True, 'row_cap')
        assert 'scanned_through' not in body
