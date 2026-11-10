"""The review-date window is the REQUESTED one, never the import history (moto).

Live regression: reviews imported TODAY but written 200 days ago vanished on
``date_basis=review``. The earliest-import watermark was today, so every window
was clamped to one day (right for walking the import-date index) and that clamped
day count also became the review-date cutoff, so "all time" and "365 days" both
meant "written today". The fix keeps the clamped walk but takes the review-date
cutoff from the days the caller asked for (``shared.api.requested_window_cutoff``,
none for ``days=0``). These cases pin it on every route that takes ``date_basis``.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import ExitStack
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import pk_sk_table

from metrics_handler import lambda_handler
from shared.api import clear_categories_cache, requested_window_cutoff
from shared.earliest_date import EARLIEST_DATE_KEY

# Two reviews written 200 days ago, one written 10 days ago, one written today:
# every one of them imported today (the watermark says the history starts today).
OLD_IDS = {'old_a', 'old_b'}
RECENT_ID = 'recent'
FRESH_ID = 'fresh'
ALL_IDS = OLD_IDS | {RECENT_ID, FRESH_ID}


def _day(offset: int) -> str:
    return (datetime.now(UTC) - timedelta(days=offset)).strftime('%Y-%m-%d')


def _review(fid: str, n: int, *, imported: int, written: int, **fields: Any) -> dict[str, Any]:
    day = _day(imported)
    return {
        'pk': 'SOURCE#web', 'sk': f'FEEDBACK#{fid}', 'feedback_id': fid,
        'gsi1pk': f'DATE#{day}', 'gsi1sk': f'{day}T00:00:{n:02d}.000000', 'date': day,
        'source_platform': 'web', 'source_created_at': f'{_day(written)}T08:00:00Z',
        'sentiment_label': 'negative', 'sentiment_score': Decimal('-0.5'), 'urgency': 'low',
        'category': 'delivery', 'subcategory': 'shipping', 'problem_summary': f'Problem {fid}',
        'original_text': f'text {fid}', **fields,
    }


def _seed(feedback, aggregates, *, earliest: str | None) -> None:
    rows = [
        _review('old_a', 1, imported=0, written=200),
        _review('old_b', 2, imported=0, written=200, category='billing'),
        _review(RECENT_ID, 3, imported=0, written=10),
        _review(FRESH_ID, 4, imported=0, written=0, urgency='high'),
    ]
    with feedback.batch_writer() as writer:
        for row in rows:
            writer.put_item(Item=row)
    if earliest is not None:
        aggregates.put_item(Item={**EARLIEST_DATE_KEY, 'date': earliest})


@pytest.fixture
def tables() -> Iterator[tuple[Any, Any]]:
    """moto feedback + aggregates tables wired into the handler, no data yet."""
    with ExitStack() as stack:
        stack.enter_context(mock_aws())
        clear_categories_cache()
        feedback = pk_sk_table('review-window-feedback', gsi1_index='gsi1-by-date')
        aggregates = pk_sk_table('review-window-aggregates')
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config',
                                  'categories': [{'name': 'delivery'}, {'name': 'billing'}]})
        stack.enter_context(patch('metrics_handler.feedback_table', feedback))
        stack.enter_context(patch('metrics_handler.aggregates_table', aggregates))
        yield feedback, aggregates
    clear_categories_cache()


@pytest.fixture
def imported_today(tables) -> None:
    """The live shape: every review imported today, the watermark today."""
    _seed(*tables, earliest=_day(0))


def _get(event, context, path: str, **params: str) -> dict:
    response, body = call_route(lambda_handler, event, context, method='GET', path=path, query_params=params)
    assert response['statusCode'] == 200, body
    return body


def _listed_ids(event, context, **params: str) -> set[str]:
    body = _get(event, context, '/feedback', limit='100', **params)
    return {item['feedback_id'] for item in body['items']}


def _problem_ids(event, context, **params: str) -> set[str]:
    body = _get(event, context, '/feedback/problems', similarity='off', **params)
    return {p['problem'].removeprefix('Problem ')
            for c in body['categories'] for s in c['subcategories'] for p in s['problems']}


# ---------------------------------------------------------------- requested_window_cutoff


class TestRequestedWindowCutoff:
    TODAY = date(2026, 10, 29)

    def test_all_time_has_no_cutoff(self):
        assert requested_window_cutoff(0, self.TODAY) == ''

    def test_a_one_day_window_starts_today(self):
        assert requested_window_cutoff(1, self.TODAY) == '2026-10-29'

    def test_a_thirty_day_window_starts_twenty_nine_days_back(self):
        assert requested_window_cutoff(30, self.TODAY) == '2026-09-30'

    def test_a_year_crosses_the_year_boundary(self):
        assert requested_window_cutoff(365, self.TODAY) == '2025-10-30'


# ---------------------------------------------------------------- GET /feedback


@pytest.mark.usefixtures('imported_today')
class TestListFeedback:
    @pytest.mark.parametrize('days', ['0', '365'])
    def test_long_windows_keep_reviews_written_before_the_first_import(self, api_gateway_event, lambda_context, days):
        assert _listed_ids(api_gateway_event, lambda_context, days=days, date_basis='review') == ALL_IDS

    def test_thirty_days_drops_the_200_day_old_reviews_only(self, api_gateway_event, lambda_context):
        ids = _listed_ids(api_gateway_event, lambda_context, days='30', date_basis='review')
        assert ids == {RECENT_ID, FRESH_ID}

    def test_seven_days_drops_the_ten_day_old_review_too(self, api_gateway_event, lambda_context):
        assert _listed_ids(api_gateway_event, lambda_context, days='7', date_basis='review') == {FRESH_ID}

    def test_the_import_basis_keeps_every_review_imported_today(self, api_gateway_event, lambda_context):
        assert _listed_ids(api_gateway_event, lambda_context, days='30', date_basis='imported') == ALL_IDS

    def test_a_post_filtered_walk_uses_the_requested_cutoff(self, api_gateway_event, lambda_context):
        # `source` makes the walk read the full candidate window before the cutoff applies.
        ids = _listed_ids(api_gateway_event, lambda_context, days='365', date_basis='review', source='web')
        assert ids == ALL_IDS


# ---------------------------------------------------------------- GET /feedback/problems


@pytest.mark.usefixtures('imported_today')
class TestProblems:
    @pytest.mark.parametrize('days', ['0', '365'])
    def test_long_windows_count_reviews_written_before_the_first_import(self, api_gateway_event, lambda_context, days):
        assert _problem_ids(api_gateway_event, lambda_context, days=days, date_basis='review') == ALL_IDS

    def test_thirty_days_counts_the_recent_reviews_only(self, api_gateway_event, lambda_context):
        ids = _problem_ids(api_gateway_event, lambda_context, days='30', date_basis='review')
        assert ids == {RECENT_ID, FRESH_ID}

    def test_the_import_basis_counts_every_review_imported_today(self, api_gateway_event, lambda_context):
        assert _problem_ids(api_gateway_event, lambda_context, days='30', date_basis='imported') == ALL_IDS

    def test_the_window_block_reports_the_request_and_the_walk(self, api_gateway_event, lambda_context):
        body = _get(api_gateway_event, lambda_context, '/feedback/problems', days='365', date_basis='review')
        assert body['window'] == {'kind': 'days', 'days': 365, 'walk_days': 1, 'date_basis': 'review'}
        # `period_days` is the walk (one import day), not the 365 days asked for.
        assert (body['period_days'], body['feedback_count'], body['is_partial']) == (1, 4, False)

    def test_all_time_reports_the_requested_zero(self, api_gateway_event, lambda_context):
        body = _get(api_gateway_event, lambda_context, '/feedback/problems', days='0', date_basis='review')
        assert body['window'] == {'kind': 'days', 'days': 0, 'walk_days': 1, 'date_basis': 'review'}


# ---------------------------------------------------------------- GET /metrics/summary


@pytest.mark.usefixtures('imported_today')
class TestSummary:
    @pytest.mark.parametrize('days', ['0', '365'])
    def test_long_windows_total_every_review(self, api_gateway_event, lambda_context, days):
        body = _get(api_gateway_event, lambda_context, '/metrics/summary', days=days, date_basis='review')
        assert body['total_feedback'] == 4
        # Bucketed by REVIEW date: the 200-day-old pair is its own day.
        assert {t['date']: t['count'] for t in body['daily_totals']} == {_day(0): 1, _day(10): 1, _day(200): 2}
        assert body['urgent_count'] == 1

    def test_thirty_days_totals_the_recent_reviews_only(self, api_gateway_event, lambda_context):
        body = _get(api_gateway_event, lambda_context, '/metrics/summary', days='30', date_basis='review')
        assert body['total_feedback'] == 2
        assert {t['date'] for t in body['daily_totals']} == {_day(0), _day(10)}

    def test_period_days_is_the_clamped_walk(self, api_gateway_event, lambda_context):
        body = _get(api_gateway_event, lambda_context, '/metrics/summary', days='365', date_basis='review')
        assert body['period_days'] == 1


# ---------------------------------------------------------------- the other date_basis routes


@pytest.mark.usefixtures('imported_today')
class TestOtherBasisRoutes:
    @pytest.mark.parametrize(('days', 'expected'), [('0', 4), ('365', 4), ('30', 2)])
    def test_entities_count_on_the_requested_review_window(self, api_gateway_event, lambda_context, days, expected):
        body = _get(api_gateway_event, lambda_context, '/feedback/entities', days=days, date_basis='review')
        assert body['feedback_count'] == expected

    @pytest.mark.parametrize(('days', 'expected'), [
        ('0', {'delivery': 3, 'billing': 1}),
        ('365', {'delivery': 3, 'billing': 1}),
        ('30', {'delivery': 2}),
    ])
    def test_categories_count_on_the_requested_review_window(self, api_gateway_event, lambda_context, days, expected):
        body = _get(api_gateway_event, lambda_context, '/metrics/categories', days=days, date_basis='review')
        assert {k: v for k, v in body['categories'].items() if v} == expected

    @pytest.mark.parametrize(('days', 'expected'), [('0', 4), ('365', 4), ('30', 2)])
    def test_sentiment_counts_on_the_requested_review_window(self, api_gateway_event, lambda_context, days, expected):
        body = _get(api_gateway_event, lambda_context, '/metrics/sentiment', days=days, date_basis='review')
        assert body['total'] == expected

    def test_search_uses_the_requested_review_window(self, api_gateway_event, lambda_context):
        long = _get(api_gateway_event, lambda_context, '/feedback/search', q='text', days='365', date_basis='review')
        short = _get(api_gateway_event, lambda_context, '/feedback/search', q='text', days='30', date_basis='review')
        assert {i['feedback_id'] for i in long['items']} == ALL_IDS
        assert {i['feedback_id'] for i in short['items']} == {RECENT_ID, FRESH_ID}


# ---------------------------------------------------------------- other watermark shapes


def test_without_a_watermark_all_time_still_keeps_old_reviews(tables, api_gateway_event, lambda_context):
    _seed(*tables, earliest=None)
    assert _listed_ids(api_gateway_event, lambda_context, days='0', date_basis='review') == ALL_IDS
    assert _problem_ids(api_gateway_event, lambda_context, days='30', date_basis='review') == {RECENT_ID, FRESH_ID}


def test_a_long_history_gives_the_same_answer(tables, api_gateway_event, lambda_context):
    # The watermark 400 days back: nothing is clamped, the requested cutoff is the walk's.
    _seed(*tables, earliest=_day(400))
    assert _problem_ids(api_gateway_event, lambda_context, days='365', date_basis='review') == ALL_IDS
    assert _problem_ids(api_gateway_event, lambda_context, days='30', date_basis='review') == {RECENT_ID, FRESH_ID}
