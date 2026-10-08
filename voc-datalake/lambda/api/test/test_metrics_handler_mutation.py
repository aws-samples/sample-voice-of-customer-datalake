"""Mutation hardening for `api/metrics_handler.py`.

The eight earlier `test_metrics_*` files pin WHAT each route answers — totals,
orderings, the partial flags, the per-category gate. A mutation run found the
things they could not see:

* the SHAPE of every DynamoDB read: the page size (500), `ScanIndexForward`,
  the server-side source filter, the cursor hand-off, the `Limit=1` id lookup,
  the `gsi1-by-metric-type` key — a wrong key name or a dropped kwarg still
  returned the right numbers from a `MagicMock` table;
* every boundary as a literal: the 10,000-row ceiling on one partition, the soft
  cap on candidates (1,000), the `> 5`-character and `[:100]` issue key, the 20
  issues kept, the `[oldest, newest]` sort-key window with both ends inclusive,
  the review-basis cutoff day itself, `limit` clamped at 100 / 200 / 50, the
  `(offset + limit) * 2` candidate window, the `limit * 5` over-fetch;
* the defaults a caller never spells: `days` 7 on `/feedback` and 30 on
  `/metrics/*`, `limit` 50 / 100 / 8, a `count`-less aggregate row counting 0;
* each filter of `_ItemFilters` on its own, and the exact query-string key it
  reads;
* the per-request caches: the category scope is read once even when a route
  asks for it twice, and a walk resolved outside `lambda_handler` still gets a
  budget;
* the cold-start module state (`FEEDBACK_TABLE`, the two "not configured"
  messages) and the warning `_query_metric_window` logs on a short read.
"""
import importlib.util
import inspect
import os
import sys
from collections.abc import Callable, Generator
from datetime import UTC, datetime, timedelta
from types import ModuleType
from typing import Any, ClassVar
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Attr, Key
from category_access_fixtures import RESTRICTED_CLAIMS, RESTRICTED_SUB, restricted_to
from handler_events_fixtures import call_route
from urgency_index_fixtures import FEEDBACK_TABLE_NAME, batch_get_key_counts, wire_urgency_index

import metrics_handler
from metrics_handler import lambda_handler
from shared.api import DEFAULT_CATEGORIES, clear_categories_cache
from shared.category_access import UNRESTRICTED, CategoryScope, access_key
from shared.exceptions import ConfigurationError
from shared.feedback import window_cutoff
from shared.indexes import (
    AGGREGATES_BY_METRIC_TYPE_INDEX,
    FEEDBACK_BY_CATEGORY_INDEX,
    FEEDBACK_BY_DATE_INDEX,
    FEEDBACK_BY_ID_INDEX,
    FEEDBACK_BY_URGENCY_INDEX,
)
from shared.time_budget import WalkBudget

TODAY = datetime.now(UTC).strftime('%Y-%m-%d')
AT = datetime(2026, 3, 10, 12, 0, tzinfo=UTC)


def _days_ago(n: int) -> str:
    return (datetime.now(UTC) - timedelta(days=n)).strftime('%Y-%m-%d')


def _date_partitions_read(fb: MagicMock) -> list:
    """The gsi1pk key condition of every Query the feedback table received, in call order."""
    return [c.kwargs['KeyConditionExpression'] for c in fb.query.call_args_list]


def _one_partition_per_day(days: int) -> list:
    return [Key('gsi1pk').eq(f'DATE#{_days_ago(n)}') for n in range(days)]


def _page(items: list[dict], *, scanned: int | None = None, more: bool = False) -> dict:
    """One `Table.query` response; `scanned` sets `ScannedCount`, `more` leaves a cursor open."""
    page: dict = {'Items': items}
    if scanned is not None:
        page['ScannedCount'] = scanned
    if more:
        page['LastEvaluatedKey'] = {'pk': 'cursor', 'sk': items[-1]['sk'] if items else 'x'}
    return page


def _rows(n: int, **extra) -> list[dict]:
    return [{'pk': 'p', 'sk': f's{i}', 'feedback_id': f'f{i}', 'date': TODAY, **extra} for i in range(n)]


@pytest.fixture
def fb():
    with patch('metrics_handler.feedback_table') as table:
        yield table


@pytest.fixture
def agg():
    with patch('metrics_handler.aggregates_table') as table:
        table.get_item.return_value = {}
        table.query.return_value = {'Items': []}
        yield table


@pytest.fixture
def fresh_context():
    """A clean resolver context, so the lazily created caches are observed from empty."""
    metrics_handler.app.clear_context()
    yield
    metrics_handler.app.clear_context()


def _get(event_factory, context, path, **params):
    response, body = call_route(lambda_handler, event_factory, context, method='GET', path=path,
                                query_params={str(k): str(v) for k, v in params.items()})
    return response, body


# ============================================
# Cold-start module state
# ============================================


def _load_fresh(monkeypatch: pytest.MonkeyPatch, env: dict[str, str | None]) -> ModuleType:
    """Import a second copy of the module under `env`, without touching the shared one."""
    for name, value in env.items():
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    spec = importlib.util.spec_from_file_location(
        'metrics_handler_fresh', os.path.join(os.path.dirname(metrics_handler.__file__), 'metrics_handler.py'))
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules['metrics_handler_fresh'] = module
    try:
        spec.loader.exec_module(module)
    finally:
        del sys.modules['metrics_handler_fresh']
    return module


class TestTheTablesComeFromTheEnvironment:
    def test_both_tables_are_named_by_their_variables(self, monkeypatch):
        fresh = _load_fresh(monkeypatch, {'FEEDBACK_TABLE': 'fb-under-test', 'AGGREGATES_TABLE': 'agg-under-test'})
        assert fresh.FEEDBACK_TABLE == 'fb-under-test'
        assert fresh.AGGREGATES_TABLE == 'agg-under-test'
        assert fresh.feedback_table.name == 'fb-under-test'
        assert fresh.aggregates_table.name == 'agg-under-test'
        assert fresh._feedback_table() is fresh.feedback_table
        assert fresh._aggregates_table() is fresh.aggregates_table

    def test_an_unset_variable_leaves_the_table_absent_and_names_it_when_read(self, monkeypatch):
        fresh = _load_fresh(monkeypatch, {'FEEDBACK_TABLE': None, 'AGGREGATES_TABLE': None})
        assert fresh.FEEDBACK_TABLE == ''
        assert fresh.AGGREGATES_TABLE == ''
        assert fresh.feedback_table is None
        assert fresh.aggregates_table is None
        with pytest.raises(ConfigurationError) as feedback:
            fresh._feedback_table()
        assert feedback.value.message == 'Feedback table not configured'
        with pytest.raises(ConfigurationError) as aggregates:
            fresh._aggregates_table()
        assert aggregates.value.message == 'Aggregates table not configured'


class TestTheWalkHelpersAreTraced:
    @pytest.mark.parametrize('name', [
        '_scan_recent_items', 'list_feedback', 'get_urgent_feedback', 'get_entities', 'search_feedback',
        'get_feedback_access', 'get_feedback', 'get_similar_feedback', 'get_summary',
        'get_sentiment_metrics', 'get_category_metrics', 'get_source_metrics', 'get_persona_metrics',
        'get_github_metrics',
    ])
    def test_the_function_is_the_tracer_wrapper_around_the_named_function(self, name):
        func = getattr(metrics_handler, name)
        assert func.__code__.co_filename.endswith(os.path.join('tracing', 'tracer.py'))
        assert func.__wrapped__.__qualname__ == name


# ============================================
# _query_partition
# ============================================


class TestOnePartitionPage:
    def _query(self, fb, pages, max_matched=10, source=None):
        fb.query.side_effect = pages
        return metrics_handler._query_partition(
            FEEDBACK_BY_DATE_INDEX, Key('gsi1pk').eq('DATE#2026-03-10'), max_matched=max_matched, source=source)

    def test_the_read_is_a_500_row_page_newest_first_with_no_filter_by_default(self, fb):
        items, has_more = self._query(fb, [_page(_rows(2))])
        fb.query.assert_called_once_with(
            IndexName=FEEDBACK_BY_DATE_INDEX,
            KeyConditionExpression=Key('gsi1pk').eq('DATE#2026-03-10'),
            Limit=500,
            ScanIndexForward=False,
        )
        assert items == _rows(2)
        assert has_more is False

    def test_a_source_is_pushed_down_as_a_server_side_filter(self, fb):
        self._query(fb, [_page([])], source='webscraper')
        assert fb.query.call_args.kwargs['FilterExpression'] == Attr('source_platform').eq('webscraper')

    def test_the_second_page_resumes_from_the_first_pages_cursor(self, fb):
        first = _page(_rows(1), more=True)
        items, has_more = self._query(fb, [first, _page(_rows(1))], max_matched=10)
        assert fb.query.call_count == 2
        assert 'ExclusiveStartKey' not in fb.query.call_args_list[0].kwargs
        assert fb.query.call_args_list[1].kwargs['ExclusiveStartKey'] == first['LastEvaluatedKey']
        assert len(items) == 2
        assert has_more is False

    def test_a_page_that_exactly_fills_the_budget_stops_the_read_and_reports_more(self, fb):
        items, has_more = self._query(fb, [_page(_rows(3), more=True), _page(_rows(3))], max_matched=3)
        assert fb.query.call_count == 1
        assert items == _rows(3)
        assert has_more is True

    def test_the_rows_beyond_the_budget_are_cut_even_when_the_partition_is_exhausted(self, fb):
        items, has_more = self._query(fb, [_page(_rows(5))], max_matched=3)
        assert items == _rows(3)
        assert has_more is False

    def test_the_scan_ceiling_is_ten_thousand_examined_rows(self, fb):
        """9,999 + 9,999 crosses it, so the third page is never asked for."""
        pages = [_page(_rows(1), scanned=9_999, more=True)] * 3
        items, has_more = self._query(fb, pages, max_matched=100)
        assert fb.query.call_count == 2
        assert has_more is True
        assert len(items) == 2

    def test_without_a_scanned_count_the_rows_returned_are_what_is_counted(self, fb):
        pages = [_page(_rows(5_000), more=True)] * 4
        items, has_more = self._query(fb, pages, max_matched=20_000)
        assert fb.query.call_count == 2
        assert len(items) == 10_000
        assert has_more is True


# ============================================
# _scan_recent_items / _scan_window_items
# ============================================


@pytest.mark.usefixtures('fresh_context')
class TestTheDayWalk:
    def test_each_day_is_read_from_its_own_date_partition(self, fb):
        fb.query.return_value = _page([])
        metrics_handler._scan_recent_items(2)
        assert _date_partitions_read(fb) == _one_partition_per_day(2)

    def test_a_day_may_only_use_what_is_left_of_the_soft_cap(self, fb):
        fb.query.return_value = _page(_rows(3))
        items, is_partial = metrics_handler._scan_recent_items(3, soft_cap=5)
        assert len(items) == 5
        assert fb.query.call_count == 2
        assert is_partial is True

    def test_a_per_day_limit_samples_each_day_up_to_the_soft_cap(self, fb):
        fb.query.return_value = _page(_rows(300))
        items, is_partial = metrics_handler._scan_recent_items(
            10, per_day_limit=300, soft_cap=metrics_handler.CANDIDATES_SOFT_CAP)
        assert len(items) == 1_000
        assert fb.query.call_count == 4
        assert is_partial is True

    def test_filling_the_cap_on_the_last_day_is_not_partial(self, fb):
        fb.query.side_effect = [_page(_rows(1)), _page(_rows(4))]
        items, is_partial = metrics_handler._scan_recent_items(2, soft_cap=5)
        assert len(items) == 5
        assert is_partial is False

    def test_filling_the_cap_with_a_day_still_unread_is_partial(self, fb):
        fb.query.side_effect = [_page(_rows(1)), _page(_rows(4)), _page(_rows(1))]
        items, is_partial = metrics_handler._scan_recent_items(3, soft_cap=5)
        assert len(items) == 5
        assert fb.query.call_count == 2
        assert is_partial is True

    def test_a_partition_with_rows_left_behind_makes_the_walk_partial(self, fb):
        fb.query.side_effect = [_page(_rows(1), more=True), _page([])]
        items, is_partial = metrics_handler._scan_recent_items(2, soft_cap=1)
        assert len(items) == 1
        assert is_partial is True

    def test_a_complete_walk_is_not_partial(self, fb):
        fb.query.return_value = _page(_rows(1))
        items, is_partial = metrics_handler._scan_recent_items(3)
        assert len(items) == 3
        assert is_partial is False

    def test_the_review_window_keeps_an_item_written_on_the_cutoff_day_itself(self, fb):
        on_cutoff = {'feedback_id': 'edge', 'date': TODAY, 'source_created_at': f'{_days_ago(2)}T23:00:00Z'}
        before = {'feedback_id': 'old', 'date': TODAY, 'source_created_at': f'{_days_ago(3)}T00:00:00Z'}
        fb.query.side_effect = [_page([on_cutoff, before]), _page([]), _page([])]
        items, _ = metrics_handler._scan_window_items(3, 'review')
        assert [i['feedback_id'] for i in items] == ['edge']


class TestThePerRequestCaches:
    @pytest.mark.usefixtures('fresh_context')
    def test_a_walk_outside_the_handler_still_gets_one_budget(self):
        first = metrics_handler._walk_budget()
        assert isinstance(first, WalkBudget)
        assert metrics_handler._walk_budget() is first
        assert metrics_handler._walk_partial_fields() == {}

    def test_the_scope_is_resolved_once_when_a_route_reads_it_twice(self, api_gateway_event, lambda_context):
        """`/feedback/{id}/similar` asks for the scope in `_feedback_by_id` and again for the results."""
        fb_table = MagicMock()
        fb_table.query.return_value = {'Items': [{'feedback_id': 'd1', 'category': 'delivery'}]}
        aggregates = restricted_to('delivery')
        scope = CategoryScope(all=False, categories=frozenset({'delivery'}))
        with patch('metrics_handler.feedback_table', fb_table), \
                patch('metrics_handler.aggregates_table', aggregates), \
                patch('metrics_handler.scope_for_event', return_value=scope) as resolve:
            response, body = call_route(lambda_handler, api_gateway_event, lambda_context, method='GET',
                                        path='/feedback/d1/similar', claims=RESTRICTED_CLAIMS)
        assert response['statusCode'] == 200
        assert body['count'] == 0
        resolve.assert_called_once()
        assert resolve.call_args.args[1] is aggregates

    def test_the_access_row_is_read_once_per_request(self, api_gateway_event, lambda_context):
        fb_table = MagicMock()
        fb_table.query.return_value = {'Items': [{'feedback_id': 'd1', 'category': 'delivery'}]}
        aggregates = restricted_to('delivery')
        with patch('metrics_handler.feedback_table', fb_table), patch('metrics_handler.aggregates_table', aggregates):
            call_route(lambda_handler, api_gateway_event, lambda_context, method='GET',
                       path='/feedback/d1/similar', claims=RESTRICTED_CLAIMS)
        access_reads = [c for c in aggregates.get_item.call_args_list if c.kwargs['Key'] == access_key(RESTRICTED_SUB)]
        assert len(access_reads) == 1


# ============================================
# _query_metric_window / _metric_window_totals / _metric_type_totals
# ============================================


class TestTheMetricWindowReads:
    def test_a_short_read_is_logged_with_its_partition_window_and_row_count(self, agg):
        agg.query.return_value = _page([{'sk': '2026-03-10', 'count': 1}], more=True)
        with patch('metrics_handler.logger') as log:
            _items, truncated = metrics_handler._query_metric_window('METRIC#urgent', 3, AT)
        assert truncated is True
        log.warning.assert_called_once_with(
            'Metric window paging hit its bound; returning a partial window',
            extra={'pk': 'METRIC#urgent', 'days': 3, 'items': 3},
        )

    def test_a_row_without_a_count_adds_nothing_to_its_partition_total(self, agg):
        agg.query.side_effect = lambda **_kw: _page([{'sk': '2026-03-10'}, {'sk': '2026-03-09', 'count': '4'}])
        totals, is_partial = metrics_handler._metric_window_totals('METRIC#daily_sentiment#', ['positive'], 3, AT)
        assert totals == {'positive': 4}
        assert is_partial is False

    def test_a_short_read_of_any_name_makes_the_totals_partial(self, agg):
        def by_name(**kw):
            equals, _ = kw['KeyConditionExpression'].get_expression()['values']
            pk = equals.get_expression()['values'][1]
            return _page([{'sk': '2026-03-10', 'count': 1}], more=pk.endswith('#b'))

        agg.query.side_effect = by_name
        totals, is_partial = metrics_handler._metric_window_totals('METRIC#x#', ['a', 'b', 'c'], 1, AT)
        assert totals == {'a': 1, 'b': 1, 'c': 1}
        assert is_partial is True

    def test_the_type_index_is_read_once_by_metric_type(self, agg):
        metrics_handler._metric_type_totals('source', 'METRIC#daily_source#', 7, AT)
        agg.query.assert_called_once_with(
            IndexName=AGGREGATES_BY_METRIC_TYPE_INDEX,
            KeyConditionExpression=Key('metric_type').eq('source'),
        )

    def test_the_window_keeps_both_ends_and_drops_the_days_beside_them(self, agg):
        rows = [
            {'pk': 'METRIC#daily_source#web', 'sk': '2026-03-07', 'count': 100},   # the day before the window
            {'pk': 'METRIC#daily_source#web', 'sk': '2026-03-08', 'count': 1},     # oldest day, kept
            {'pk': 'METRIC#daily_source#web', 'sk': '2026-03-10', 'count': 2},     # newest day, kept
            {'pk': 'METRIC#daily_source#web', 'sk': '2026-03-11', 'count': 100},   # tomorrow
            {'pk': 'METRIC#daily_source#app', 'sk': '2026-03-09'},                 # no count: 0
            {'pk': 'METRIC#daily_source#app', 'count': 100},                       # no sort key: ignored
        ]
        agg.query.return_value = _page(rows)
        totals, is_partial = metrics_handler._metric_type_totals('source', 'METRIC#daily_source#', 3, AT)
        assert totals == {'web': 3, 'app': 0}
        assert is_partial is False

    def test_a_cursor_left_open_is_reported(self, agg):
        agg.query.return_value = _page([], more=True)
        _, is_partial = metrics_handler._metric_type_totals('source', 'METRIC#daily_source#', 3, AT)
        assert is_partial is True


# ============================================
# _ItemFilters
# ============================================


def _issue(**attrs) -> dict:
    return {'date': TODAY, 'source_platform': 'github_issues', 'issue_attributes': attrs}


class TestEachItemFilterOnItsOwn:
    @pytest.mark.parametrize(('params', 'item', 'admitted'), [
        ({}, {'date': TODAY}, True),
        ({}, {'date': _days_ago(6)}, True),
        ({}, {'date': _days_ago(7)}, False),
        ({'date_basis': 'review'}, {'date': TODAY, 'source_created_at': f'{_days_ago(7)}T00:00:00Z'}, False),
        ({'source': 'web'}, {'date': TODAY, 'source_platform': 'web'}, True),
        ({'source': 'web'}, {'date': TODAY, 'source_platform': 'app'}, False),
        ({'source': 'web'}, {'date': TODAY}, False),
        ({'sentiment': 'negative'}, {'date': TODAY, 'sentiment_label': 'negative'}, True),
        ({'sentiment': 'negative'}, {'date': TODAY, 'sentiment_label': 'positive'}, False),
        ({'sentiment': 'negative'}, {'date': TODAY}, False),
        ({'category': 'delivery'}, {'date': TODAY, 'category': 'delivery'}, True),
        ({'category': 'delivery'}, {'date': TODAY, 'category': 'billing'}, False),
        ({'category': 'delivery'}, {'date': TODAY}, False),
        ({'version': '2.0.0'}, _issue(software_version='2.0.0'), True),
        ({'version': '2.0.0'}, _issue(software_version='1.0.0'), False),
        ({'label': 'bug'}, _issue(labels=['Bug']), True),
        ({'label': 'bug'}, _issue(labels=['feature']), False),
    ])
    def test_admits(self, params, item, admitted):
        assert metrics_handler._ItemFilters(params, 7).admits(item) is admitted

    def test_the_scope_rejects_an_item_outside_it(self):
        filters = metrics_handler._ItemFilters({}, 7, CategoryScope(all=False, categories=frozenset({'delivery'})))
        assert filters.admits({'date': TODAY, 'category': 'delivery'}) is True
        assert filters.admits({'date': TODAY, 'category': 'billing'}) is False

    def test_the_filters_read_exactly_these_query_keys(self):
        params = {'source': 's', 'sentiment': 'n', 'category': 'c', 'version': 'v', 'label': 'l',
                  'date_basis': 'review'}
        filters = metrics_handler._ItemFilters(params, 3)
        assert (filters.source, filters.sentiment, filters.category, filters.version, filters.label) == (
            's', 'n', 'c', 'v', 'l')
        assert filters.date_basis == 'review'
        assert filters.cutoff_date == _days_ago(2)
        assert filters.scope is UNRESTRICTED


# ============================================
# Entity helpers
# ============================================


class TestIssueCounts:
    def test_a_summary_needs_more_than_five_characters(self):
        counted = metrics_handler._issue_counts([
            {'problem_summary': 'abcde'}, {'problem_summary': 'abcdef'}, {'problem_summary': ''}, {},
            {'problem_summary': None},
        ])
        assert counted == {'abcdef': 1}

    def test_the_key_is_the_first_hundred_characters_lowercased_and_trimmed(self):
        shared = 'A' * 100
        counted = metrics_handler._issue_counts([
            {'problem_summary': f'  {shared[:98]}  '}, {'problem_summary': shared + 'x'}, {'problem_summary': shared + 'y'},
            {'problem_summary': 'Other thing'},
        ])
        assert counted == {'a' * 98: 1, 'a' * 100: 2, 'other thing': 1}


class TestEntitiesPayload:
    def test_every_breakdown_is_ranked_and_issues_are_capped_at_twenty(self):
        issues = {f'issue {i}': i for i in range(1, 22)}  # 21 issues, counts 1..21
        payload = metrics_handler._entities_payload({'a': 1, 'b': 3}, issues, {'p': 2, 'q': 5}, {'web': 1, 'app': 9})
        assert payload['keywords'] == {}
        assert list(payload['categories'].items()) == [('b', 3), ('a', 1)]
        assert list(payload['personas'].items()) == [('q', 5), ('p', 2)]
        assert list(payload['sources'].items()) == [('app', 9), ('web', 1)]
        assert list(payload['issues'].items()) == [(f'issue {i}', i) for i in range(21, 1, -1)]
        assert len(payload['issues']) == 20
        assert set(payload) == {'keywords', 'categories', 'issues', 'personas', 'sources'}


# ============================================
# Route-level literals
# ============================================


class TestFeedbackById:
    def test_the_lookup_is_one_row_by_feedback_id(self, fb, api_gateway_event, lambda_context):
        fb.query.return_value = {'Items': [{'feedback_id': 'abc'}]}
        response, body = _get(api_gateway_event, lambda_context, '/feedback/abc')
        assert response['statusCode'] == 200
        assert body == {'feedback_id': 'abc'}
        fb.query.assert_called_once_with(
            IndexName=FEEDBACK_BY_ID_INDEX, KeyConditionExpression=Key('feedback_id').eq('abc'), Limit=1)

    def test_a_missing_item_is_named_in_the_404(self, fb, api_gateway_event, lambda_context):
        fb.query.return_value = {'Items': []}
        response, body = _get(api_gateway_event, lambda_context, '/feedback/nope')
        assert response['statusCode'] == 404
        assert body == {'statusCode': 404, 'message': 'Feedback nope not found'}


@pytest.mark.usefixtures('agg')
class TestListFeedbackDefaultsAndBounds:
    def test_the_default_window_is_seven_days(self, fb, api_gateway_event, lambda_context):
        fb.query.return_value = _page([])
        _, body = _get(api_gateway_event, lambda_context, '/feedback')
        assert fb.query.call_count == 7
        assert body['limit'] == 50
        assert body['offset'] == 0

    @pytest.mark.parametrize(('requested', 'limit'), [(100, 100), (101, 100), (1, 1), (0, 1)])
    def test_limit_is_clamped_to_one_through_one_hundred(self, fb, api_gateway_event, lambda_context,
                                                          requested, limit):
        fb.query.return_value = _page([])
        _, body = _get(api_gateway_event, lambda_context, '/feedback', days=1, limit=requested)
        assert body['limit'] == limit

    def test_the_unfiltered_candidate_window_is_twice_offset_plus_limit(self, fb, api_gateway_event,
                                                                        lambda_context):
        """offset 100 + limit 50 -> 300 candidates read, so a 300-row day is counted in full."""
        fb.query.return_value = _page(_rows(300))
        _, body = _get(api_gateway_event, lambda_context, '/feedback', days=1, offset=100, limit=50)
        assert body['total'] == 300
        assert body['count'] == 50
        assert body['is_partial_window'] is False

    def test_the_unfiltered_candidate_window_is_at_least_one_hundred(self, fb, api_gateway_event,
                                                                     lambda_context):
        fb.query.return_value = _page(_rows(150))
        _, body = _get(api_gateway_event, lambda_context, '/feedback', days=1, limit=10)
        assert body['total'] == 100


@pytest.mark.usefixtures('agg')
class TestMetricsWindowDefault:
    @pytest.mark.parametrize('path', ['/metrics/summary', '/metrics/sentiment', '/metrics/categories',
                                      '/metrics/sources', '/metrics/personas'])
    def test_the_default_window_is_thirty_days(self, fb, path, api_gateway_event, lambda_context):
        fb.query.return_value = _page([])
        response, body = _get(api_gateway_event, lambda_context, path)
        assert response['statusCode'] == 200, response['body']
        assert body['period_days'] == 30


# ============================================
# Lines 621-1254: the route bodies
# ============================================
#
# A second run over the rest of the module. The earlier tests pin the numbers each
# route answers; the survivors were, again, the shape of what it READS and the
# literal it answers with:
#
# * the partition each route queries (`CATEGORY#`, `DATE#`, `URGENCY#high`, the
#   three summary `METRIC#` pks, the `source` / `persona` metric types) — a
#   `MagicMock` table answers a wrong key as happily as the right one;
# * the per-route budgets: `limit * 5` on `/feedback/urgent`, `limit + 10` on
#   `/similar`, fifty rows of at most seven days for the issue sample, three hundred
#   rows per day for search, the second day's share of `/feedback`'s cap;
# * the response keys and defaults no test spelled (`period_days` on a scan branch,
#   `other` / `unknown` / `neutral` buckets, a count-less aggregate row counting 0,
#   `has_legacy_persona_buckets` on each branch);
# * the arithmetic: three decimal places, percentages of one item, a day's average
#   seeded from zero, OR-ing the partial flag across every partition a route reads;
# * the loop control: a refused item or a half-keyed GSI row CONTINUES the walk.


def _query_key(kwargs: dict) -> str:
    """Which aggregates partition a `Table.query` asked for.

    `METRIC#...` for a base-table window read, `metric_type=<type>` for the
    `gsi1-by-metric-type` read.
    """
    values = kwargs['KeyConditionExpression'].get_expression()['values']
    if kwargs.get('IndexName') == AGGREGATES_BY_METRIC_TYPE_INDEX:
        return f'metric_type={values[1]}'
    return values[0].get_expression()['values'][1]


def _answer_aggregates(agg: MagicMock, rows: dict[str, list[dict]], short: frozenset[str] = frozenset()) -> None:
    """`agg.query` answers `rows` by `_query_key`; a key in `short` leaves its cursor open."""
    def query(**kwargs):
        key = _query_key(kwargs)
        return _page(rows.get(key, []), more=key in short)

    agg.query.side_effect = query


@pytest.fixture
def aggregates(agg: MagicMock) -> Generator[MagicMock]:
    """`agg`, with the configured-categories cache cleared on both sides."""
    clear_categories_cache()
    yield agg
    clear_categories_cache()


def _ids(body: dict) -> list[str]:
    return [item['feedback_id'] for item in body['items']]


@pytest.mark.usefixtures('agg')
class TestListFeedbackReadsItsPartitions:
    def test_a_category_alone_reads_its_category_partition(self, fb, api_gateway_event, lambda_context):
        fb.query.return_value = _page([])
        _get(api_gateway_event, lambda_context, '/feedback', category='delivery', days=3)
        fb.query.assert_called_once_with(
            IndexName=FEEDBACK_BY_CATEGORY_INDEX,
            KeyConditionExpression=Key('gsi2pk').eq('CATEGORY#delivery'),
            Limit=500,
            ScanIndexForward=False,
        )

    def test_each_day_is_read_from_its_own_date_partition(self, fb, api_gateway_event, lambda_context):
        fb.query.return_value = _page([])
        _get(api_gateway_event, lambda_context, '/feedback', days=2)
        assert _date_partitions_read(fb) == _one_partition_per_day(2)

    def test_a_later_day_only_gets_what_the_earlier_days_left_of_the_cap(self, fb, api_gateway_event,
                                                                         lambda_context):
        """60 rows, then 100, under the 100-row cap: the second day is cut to 40."""
        fb.query.side_effect = [_page(_rows(60)), _page(_rows(100))]
        _, body = _get(api_gateway_event, lambda_context, '/feedback', days=2, limit=10)
        assert body['total'] == 100
        assert body['is_partial_window'] is False

    def test_the_imported_basis_trusts_the_date_partition(self, fb, api_gateway_event, lambda_context):
        """No cutoff post-filter without a category: a row the partition holds is listed whatever its `date`."""
        fb.query.return_value = _page([{'feedback_id': 'f', 'date': _days_ago(40)}])
        _, body = _get(api_gateway_event, lambda_context, '/feedback', days=1)
        assert body['total'] == 1

    def test_the_category_partition_keeps_the_cutoff_day_and_drops_the_day_before(self, fb, api_gateway_event,
                                                                                  lambda_context):
        fb.query.return_value = _page([
            {'feedback_id': 'edge', 'date': _days_ago(2)}, {'feedback_id': 'old', 'date': _days_ago(3)},
        ])
        _, body = _get(api_gateway_event, lambda_context, '/feedback', category='delivery', days=3)
        assert _ids(body) == ['edge']

    def test_with_a_source_the_category_is_filtered_in_memory_off_the_date_partition(self, fb, api_gateway_event,
                                                                                     lambda_context):
        fb.query.return_value = _page([
            {'feedback_id': 'd', 'date': TODAY, 'source_platform': 'web', 'category': 'delivery'},
            {'feedback_id': 'b', 'date': TODAY, 'source_platform': 'web', 'category': 'billing'},
            {'feedback_id': 'n', 'date': TODAY, 'source_platform': 'web'},
        ])
        _, body = _get(api_gateway_event, lambda_context, '/feedback', category='delivery', source='web', days=1)
        assert _ids(body) == ['d']
        assert fb.query.call_args.kwargs['IndexName'] == FEEDBACK_BY_DATE_INDEX


@pytest.mark.usefixtures('agg')
class TestUrgentFeedbackReadsTheUrgencyPartition:
    """The urgency GSI is paged by `_query_partition` and hydrated by BatchGetItem (#267-2).

    The candidate budget is `max_matched` — the rows the paged read keeps — so it is
    observed as the keys the one BatchGetItem asks for, not as the query's `Limit`
    (always the 500-row page now).
    """

    def _urgent(self, fb: MagicMock, rows: list[dict[str, Any]], api_gateway_event: Any, lambda_context: Any,
                **params: Any) -> dict[str, Any]:
        wire_urgency_index(fb, rows)
        _, body = _get(api_gateway_event, lambda_context, '/feedback/urgent', **params)
        return body

    def test_the_default_read_is_the_thirty_day_partition_newest_first(self, fb, api_gateway_event, lambda_context):
        body = self._urgent(fb, [], api_gateway_event, lambda_context)
        fb.query.assert_called_once_with(
            IndexName=FEEDBACK_BY_URGENCY_INDEX,
            KeyConditionExpression=Key('gsi3pk').eq('URGENCY#high') & Key('gsi3sk').gte(window_cutoff(30)),
            Limit=500,
            ScanIndexForward=False,
        )
        fb.meta.client.batch_get_item.assert_not_called()
        assert body == {'count': 0, 'items': []}

    def test_the_default_budget_is_fifty_candidates(self, fb, api_gateway_event, lambda_context):
        body = self._urgent(fb, _rows(60), api_gateway_event, lambda_context)
        assert batch_get_key_counts(fb) == [50]
        assert body['count'] == 50

    @pytest.mark.parametrize(('requested', 'limit'), [(100, 100), (101, 100)])
    def test_limit_is_clamped_at_one_hundred(self, fb, api_gateway_event, lambda_context, requested, limit):
        self._urgent(fb, _rows(120), api_gateway_event, lambda_context, limit=requested)
        assert batch_get_key_counts(fb) == [limit]

    @pytest.mark.parametrize('params', [
        {'sentiment': 'negative'}, {'category': 'delivery'}, {'date_basis': 'review'},
    ])
    def test_any_one_post_filter_over_fetches_five_times_the_limit(self, fb, api_gateway_event, lambda_context,
                                                                   params):
        self._urgent(fb, _rows(60), api_gateway_event, lambda_context, limit=10, **params)
        assert batch_get_key_counts(fb) == [50]

    def test_a_source_is_pushed_down_so_it_does_not_over_fetch(self, fb, api_gateway_event, lambda_context):
        self._urgent(fb, _rows(60), api_gateway_event, lambda_context, limit=10, source='web')
        assert fb.query.call_args.kwargs['FilterExpression'] == Attr('source_platform').eq('web')
        assert batch_get_key_counts(fb) == [10]

    def test_a_restricted_caller_over_fetches_too(self, fb, api_gateway_event, lambda_context):
        wire_urgency_index(fb, _rows(60))
        with patch('metrics_handler.aggregates_table', restricted_to('delivery')):
            call_route(lambda_handler, api_gateway_event, lambda_context, method='GET', path='/feedback/urgent',
                       query_params={'limit': '10'}, claims=RESTRICTED_CLAIMS)
        assert batch_get_key_counts(fb) == [50]

    def test_the_default_window_is_thirty_days(self, fb, api_gateway_event, lambda_context):
        # The double ignores the `gsi3sk` bound, so this pins the in-memory window too.
        rows = [{'pk': 'p', 'sk': 'in', 'feedback_id': 'in', 'date': _days_ago(29)},
                {'pk': 'p', 'sk': 'out', 'feedback_id': 'out', 'date': _days_ago(30)}]
        assert _ids(self._urgent(fb, rows, api_gateway_event, lambda_context)) == ['in']

    def test_a_row_missing_either_key_is_skipped_without_a_lookup_and_the_walk_goes_on(
            self, fb, api_gateway_event, lambda_context):
        wire_urgency_index(fb, [{'pk': 'p', 'sk': 'ok', 'feedback_id': 'ok', 'date': TODAY}])
        fb.query.return_value = {'Items': [{'pk': 'p'}, {'sk': 's'}, {'pk': 'p', 'sk': 'ok'}]}
        _, body = _get(api_gateway_event, lambda_context, '/feedback/urgent')
        fb.meta.client.batch_get_item.assert_called_once_with(
            RequestItems={FEEDBACK_TABLE_NAME: {'Keys': [{'pk': 'p', 'sk': 'ok'}]}})
        fb.get_item.assert_not_called()
        assert _ids(body) == ['ok']

    def test_an_item_the_filters_refuse_does_not_end_the_walk(self, fb, api_gateway_event, lambda_context):
        rows = [{'pk': 'p', 'sk': 'a', 'feedback_id': 'a', 'date': TODAY, 'source_platform': 'app'},
                {'pk': 'p', 'sk': 'b', 'feedback_id': 'b', 'date': TODAY, 'source_platform': 'web'},
                {'pk': 'p', 'sk': 'c', 'feedback_id': 'c', 'date': TODAY, 'source_platform': 'web'}]
        assert _ids(self._urgent(fb, rows, api_gateway_event, lambda_context, source='web')) == ['b', 'c']


@pytest.mark.usefixtures('agg')
class TestEntitiesFromTheScan:
    def test_the_default_window_is_seven_days_and_the_answer_is_this_exact_shape(self, fb, api_gateway_event,
                                                                                lambda_context):
        fb.query.return_value = _page([])
        _, body = _get(api_gateway_event, lambda_context, '/feedback/entities', source='web')
        assert fb.query.call_count == 7
        assert body == {
            'period_days': 7,
            'feedback_count': 0,
            'is_partial': False,
            'has_legacy_persona_buckets': False,
            'entities': {'keywords': {}, 'categories': {}, 'issues': {}, 'personas': {}, 'sources': {},
                         'channels': {}, 'tags': {}, 'dimensions': {}},
        }

    def test_an_item_without_the_fields_lands_in_other_unknown_and_unknown(self, fb, api_gateway_event,
                                                                          lambda_context):
        fb.query.return_value = _page([{'date': TODAY}])
        _, body = _get(api_gateway_event, lambda_context, '/feedback/entities', source='web', days=1)
        assert body['feedback_count'] == 1
        assert body['entities']['categories'] == {'other': 1}
        assert body['entities']['sources'] == {'unknown': 1}
        assert body['entities']['personas'] == {'unknown': 1}


class TestEntitiesFromTheAggregates:
    def test_the_counts_come_from_these_partitions(self, fb, aggregates, api_gateway_event, lambda_context):
        fb.query.return_value = _page([])
        _answer_aggregates(aggregates, {
            'METRIC#daily_category#delivery': [{'sk': TODAY, 'count': 2}],
            'METRIC#daily_category#billing': [{'sk': TODAY, 'count': 1}],
            'METRIC#daily_category#pricing': [{'sk': TODAY, 'count': 0}],
            'metric_type=source': [{'pk': 'METRIC#daily_source#web', 'sk': TODAY, 'count': 5}],
            'metric_type=persona': [{'pk': 'METRIC#persona#advocate', 'sk': TODAY, 'count': 4}],
            'METRIC#daily_total': [{'sk': TODAY, 'count': 3}, {'sk': _days_ago(1), 'count': 4}, {'sk': _days_ago(2)}],
        })
        _, body = _get(api_gateway_event, lambda_context, '/feedback/entities', days=7)
        assert body['feedback_count'] == 7
        assert body['entities']['categories'] == {'delivery': 2, 'billing': 1}
        assert body['entities']['sources'] == {'web': 5}
        assert body['entities']['personas'] == {'advocate': 4}
        assert body['has_legacy_persona_buckets'] is False
        assert body['is_partial'] is False
        assert set(body) == {'period_days', 'feedback_count', 'is_partial', 'has_legacy_persona_buckets', 'entities'}
        assert {_query_key(c.kwargs) for c in aggregates.query.call_args_list} == (
            {'METRIC#daily_total', 'metric_type=source', 'metric_type=persona',
             'metric_type=channel', 'metric_type=tag'}
            | {f'METRIC#daily_category#{name}' for name in DEFAULT_CATEGORIES}
        )

    def test_a_legacy_persona_row_is_reported(self, fb, aggregates, api_gateway_event, lambda_context):
        fb.query.return_value = _page([])
        _answer_aggregates(aggregates, {
            'metric_type=persona': [{'pk': 'METRIC#persona#Unknown', 'sk': TODAY, 'count': 1}],
        })
        _, body = _get(api_gateway_event, lambda_context, '/feedback/entities', days=1)
        assert body['has_legacy_persona_buckets'] is True
        assert body['entities']['personas'] == {'Unknown': 1}

    @pytest.mark.parametrize('short', [
        'METRIC#daily_total', 'metric_type=source', 'metric_type=persona', 'METRIC#daily_category#delivery',
    ])
    def test_a_short_read_of_any_partition_makes_the_entities_partial(self, fb, aggregates, api_gateway_event,
                                                                      lambda_context, short):
        fb.query.return_value = _page([])
        _answer_aggregates(aggregates, {}, short=frozenset({short}))
        _, body = _get(api_gateway_event, lambda_context, '/feedback/entities', days=2)
        assert body['is_partial'] is True

    @pytest.mark.usefixtures('aggregates')
    def test_issues_are_sampled_from_the_fifty_newest_rows_of_at_most_seven_days(self, fb, api_gateway_event,
                                                                                  lambda_context):
        fb.query.return_value = _page([{'problem_summary': 'Checkout fails'}])
        _, body = _get(api_gateway_event, lambda_context, '/feedback/entities', days=10)
        assert [c.kwargs for c in fb.query.call_args_list] == [
            {
                'IndexName': FEEDBACK_BY_DATE_INDEX,
                'KeyConditionExpression': Key('gsi1pk').eq(f'DATE#{_days_ago(i)}'),
                'Limit': 50,
                'ScanIndexForward': False,
            }
            for i in range(7)
        ]
        assert body['entities']['issues'] == {'checkout fails': 7}

    @pytest.mark.usefixtures('aggregates')
    @pytest.mark.parametrize(('limit', 'days_read'), [(None, 2), (10, 1), (150, 3), (200, 4), (201, 4)])
    def test_the_sample_stops_once_limit_rows_are_in_hand(self, fb, api_gateway_event, lambda_context,
                                                          limit, days_read):
        """Fifty rows a day: `limit` defaults to 100 and is clamped at 200."""
        fb.query.return_value = _page(_rows(50))
        params = {'days': 7} if limit is None else {'days': 7, 'limit': limit}
        _get(api_gateway_event, lambda_context, '/feedback/entities', **params)
        assert fb.query.call_count == days_read


@pytest.mark.usefixtures('agg')
class TestSearchLiterals:
    def test_no_term_is_answered_without_a_read(self, fb, api_gateway_event, lambda_context):
        _, body = _get(api_gateway_event, lambda_context, '/feedback/search')
        assert body == {'count': 0, 'items': [], 'entities': {}, 'query': ''}
        fb.query.assert_not_called()

    def test_the_refusal_names_the_minimum_and_the_length_received(self, api_gateway_event, lambda_context):
        response, body = _get(api_gateway_event, lambda_context, '/feedback/search', q=' a ')
        assert response['statusCode'] == 400
        assert body == {
            'success': False, 'error': 'Search query must be at least 2 characters after trimming; received 1.',
        }

    def test_the_default_window_is_thirty_days(self, fb, api_gateway_event, lambda_context):
        fb.query.return_value = _page([])
        _get(api_gateway_event, lambda_context, '/feedback/search', q='ab')
        assert fb.query.call_count == 30

    def test_a_day_is_sampled_at_its_three_hundred_newest_rows(self, fb, api_gateway_event, lambda_context):
        """The 301st row of a day is never searched."""
        rows = [*_rows(300, original_text='hay'),
                {'pk': 'p', 'sk': 'last', 'feedback_id': 'last', 'date': TODAY, 'original_text': 'needle'}]
        fb.query.return_value = _page(rows)
        _, body = _get(api_gateway_event, lambda_context, '/feedback/search', q='needle', days=1)
        assert body['count'] == 0

    @pytest.mark.parametrize(('requested', 'count'), [(None, 50), (100, 100), (101, 100), (10, 10)])
    def test_limit_defaults_to_fifty_and_is_clamped_at_one_hundred(self, fb, api_gateway_event, lambda_context,
                                                                    requested, count):
        fb.query.return_value = _page(_rows(120, original_text='a needle here'))
        params = {'q': 'needle', 'days': 1} if requested is None else {'q': 'needle', 'days': 1, 'limit': requested}
        _, body = _get(api_gateway_event, lambda_context, '/feedback/search', **params)
        assert body['count'] == count
        assert len(body['items']) == count

    @pytest.mark.parametrize('field', ['original_text', 'title', 'problem_summary'])
    def test_a_match_in_any_one_field_is_found_case_insensitively(self, fb, api_gateway_event, lambda_context,
                                                                  field):
        fb.query.return_value = _page([
            {'feedback_id': 'hit', 'date': TODAY, field: 'The NEEDLE'},
            {'feedback_id': 'miss', 'date': TODAY, 'original_text': 'hay', 'title': 'hay', 'problem_summary': 'hay'},
        ])
        _, body = _get(api_gateway_event, lambda_context, '/feedback/search', q='needle', days=1)
        assert _ids(body) == ['hit']

    def test_an_empty_field_never_matches(self, fb, api_gateway_event, lambda_context):
        fb.query.return_value = _page([
            {'feedback_id': 'f', 'date': TODAY, 'original_text': None, 'title': None, 'problem_summary': None},
        ])
        _, body = _get(api_gateway_event, lambda_context, '/feedback/search', q='xxxx', days=1)
        assert body['count'] == 0

    def test_an_item_the_filters_refuse_does_not_end_the_search(self, fb, api_gateway_event, lambda_context):
        fb.query.return_value = _page([
            {'feedback_id': 'a', 'date': TODAY, 'source_platform': 'app', 'original_text': 'needle'},
            {'feedback_id': 'b', 'date': TODAY, 'source_platform': 'web', 'original_text': 'needle'},
        ])
        _, body = _get(api_gateway_event, lambda_context, '/feedback/search', q='needle', days=1, source='web')
        assert _ids(body) == ['b']

    def test_the_entities_are_ranked_tallies_with_their_defaults(self, fb, api_gateway_event, lambda_context):
        full = {'date': TODAY, 'original_text': 'needle', 'category': 'delivery', 'source_platform': 'web',
                'sentiment_label': 'negative'}
        fb.query.return_value = _page([
            {'feedback_id': 'a', **full}, {'feedback_id': 'b', 'date': TODAY, 'original_text': 'needle'},
            {'feedback_id': 'c', **full},
        ])
        _, body = _get(api_gateway_event, lambda_context, '/feedback/search', q='needle', days=1)
        assert body['entities'] == {
            'categories': {'delivery': 2, 'other': 1},
            'sources': {'web': 2, 'unknown': 1},
            'sentiments': {'negative': 2, 'neutral': 1},
        }
        assert body['query'] == 'needle'
        assert set(body) == {'count', 'items', 'entities', 'query', 'is_partial_window'}


@pytest.mark.usefixtures('agg')
class TestSimilarFeedbackReads:
    def _similar(self, fb, source_item: dict, neighbours: list[dict], api_gateway_event, lambda_context, **params):
        fb.query.side_effect = [{'Items': [source_item]}, {'Items': neighbours}]
        return _get(api_gateway_event, lambda_context, '/feedback/abc/similar', **params)

    def test_the_neighbours_are_the_eighteen_newest_of_the_items_category_eight_returned(
            self, fb, api_gateway_event, lambda_context):
        _, body = self._similar(fb, {'feedback_id': 'abc', 'category': 'delivery'}, _rows(20, category='delivery'),
                                api_gateway_event, lambda_context)
        assert fb.query.call_args_list[1].kwargs == {
            'IndexName': FEEDBACK_BY_CATEGORY_INDEX,
            'KeyConditionExpression': Key('gsi2pk').eq('CATEGORY#delivery'),
            'Limit': 18,
            'ScanIndexForward': False,
        }
        assert body['source_feedback_id'] == 'abc'
        assert body['count'] == 8
        assert _ids(body) == [f'f{i}' for i in range(8)]

    def test_an_uncategorised_item_looks_in_other(self, fb, api_gateway_event, lambda_context):
        self._similar(fb, {'feedback_id': 'abc'}, [], api_gateway_event, lambda_context)
        assert fb.query.call_args_list[1].kwargs['KeyConditionExpression'] == Key('gsi2pk').eq('CATEGORY#other')

    @pytest.mark.parametrize(('requested', 'limit'), [(2, 2), (50, 50), (51, 50)])
    def test_limit_is_honoured_and_clamped_at_fifty(self, fb, api_gateway_event, lambda_context, requested, limit):
        _, body = self._similar(fb, {'feedback_id': 'abc', 'category': 'delivery'}, _rows(70, category='delivery'),
                                api_gateway_event, lambda_context, limit=requested)
        assert fb.query.call_args_list[1].kwargs['Limit'] == limit + 10
        assert body['count'] == limit


@pytest.mark.usefixtures('fresh_context', 'agg')
class TestSummaryDerivedFromItems:
    def test_each_day_averages_its_scored_items_and_counts_its_urgent_ones(self, fb):
        d0, d1 = TODAY, _days_ago(1)
        fb.query.side_effect = [
            _page([
                {'date': d0, 'sentiment_score': 1, 'urgency': 'high'},
                {'date': d0, 'sentiment_score': 0, 'urgency': 'high'},
                {'date': d0, 'sentiment_score': 0},
                {'date': d0},  # unscored: counted, never averaged
            ]),
            _page([{'date': d1, 'sentiment_score': 0.5, 'urgency': 'low'}]),
        ]
        totals, sentiment, urgent, is_partial = metrics_handler._summary_from_items(2, 'imported')
        assert totals == [{'date': d0, 'count': 4}, {'date': d1, 'count': 1}]
        assert sentiment == [
            {'date': d0, 'avg_sentiment': 0.333, 'count': 3},
            {'date': d1, 'avg_sentiment': 0.5, 'count': 1},
        ]
        assert urgent == 2
        assert is_partial is False


class TestSummaryFromTheAggregates:
    ROWS: ClassVar[dict[str, list[dict]]] = {
        'METRIC#daily_total': [{'sk': TODAY, 'count': 3}, {'sk': _days_ago(1), 'count': 1}, {'sk': _days_ago(2)}],
        'METRIC#daily_sentiment_avg': [
            {'sk': TODAY, 'sum': 1, 'count': 3},
            {'sk': _days_ago(1), 'sum': 1, 'count': 1},
            {'sk': _days_ago(2), 'count': 0},   # nothing scored: no row
            {'sk': _days_ago(3)},               # no count at all: no row
            {'sk': _days_ago(4), 'count': 2},   # no sum: averages 0
        ],
        'METRIC#urgent': [{'sk': TODAY, 'count': 2}, {'sk': _days_ago(1)}],
    }

    def test_the_three_partitions_are_totalled_and_averaged_to_three_places(self, aggregates, api_gateway_event,
                                                                             lambda_context):
        _answer_aggregates(aggregates, self.ROWS)
        _, body = _get(api_gateway_event, lambda_context, '/metrics/summary', days=7)
        assert body['total_feedback'] == 4
        assert body['daily_totals'] == [
            {'date': TODAY, 'count': 3}, {'date': _days_ago(1), 'count': 1}, {'date': _days_ago(2), 'count': 0},
        ]
        assert body['daily_sentiment'] == [
            {'date': TODAY, 'avg_sentiment': 0.333, 'count': 3},
            {'date': _days_ago(1), 'avg_sentiment': 1.0, 'count': 1},
            {'date': _days_ago(4), 'avg_sentiment': 0.0, 'count': 2},
        ]
        assert body['avg_sentiment'] == 0.5   # (0.333 * 3 + 1.0 * 1 + 0.0 * 2) / 4
        assert body['urgent_count'] == 2
        assert body['is_partial'] is False
        assert {_query_key(c.kwargs) for c in aggregates.query.call_args_list} == set(self.ROWS)

    def test_a_single_item_is_averaged_over_one(self, aggregates, api_gateway_event, lambda_context):
        _answer_aggregates(aggregates, {
            'METRIC#daily_total': [{'sk': TODAY, 'count': 1}],
            'METRIC#daily_sentiment_avg': [{'sk': TODAY, 'sum': 0.6, 'count': 1}],
        })
        _, body = _get(api_gateway_event, lambda_context, '/metrics/summary', days=1)
        assert body['avg_sentiment'] == 0.6

    @pytest.mark.parametrize('short', ['METRIC#daily_total', 'METRIC#daily_sentiment_avg', 'METRIC#urgent'])
    def test_a_short_read_of_any_partition_makes_the_summary_partial(self, aggregates, api_gateway_event,
                                                                     lambda_context, short):
        _answer_aggregates(aggregates, {}, short=frozenset({short}))
        _, body = _get(api_gateway_event, lambda_context, '/metrics/summary', days=2)
        assert body['is_partial'] is True


@pytest.mark.usefixtures('agg')
class TestSentimentBreakdown:
    def test_the_scan_branch_counts_each_label_and_defaults_to_neutral(self, fb, api_gateway_event, lambda_context):
        fb.query.return_value = _page([
            {'date': TODAY, 'sentiment_label': 'negative'}, {'date': TODAY, 'sentiment_label': 'negative'},
            {'date': TODAY}, {'date': TODAY, 'sentiment_label': 'odd'},
        ])
        _, body = _get(api_gateway_event, lambda_context, '/metrics/sentiment', source='web', days=1)
        assert body['breakdown'] == {'positive': 0, 'neutral': 1, 'negative': 2, 'mixed': 0}
        assert body['total'] == 3
        assert body['percentages'] == {'positive': 0.0, 'neutral': 33.3, 'negative': 66.7, 'mixed': 0.0}

    def test_one_item_is_one_hundred_percent(self, fb, api_gateway_event, lambda_context):
        fb.query.return_value = _page([{'date': TODAY, 'sentiment_label': 'positive'}])
        _, body = _get(api_gateway_event, lambda_context, '/metrics/sentiment', source='web', days=1)
        assert body['percentages'] == {'positive': 100.0, 'neutral': 0.0, 'negative': 0.0, 'mixed': 0.0}


class TestCategoryBreakdown:
    def test_a_config_without_names_falls_back_to_the_default_categories(self, aggregates, api_gateway_event,
                                                                         lambda_context):
        config = {'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': [{'description': 'nameless'}]}
        aggregates.get_item.side_effect = lambda Key, **_kw: (
            {'Item': config} if Key == {'pk': config['pk'], 'sk': config['sk']} else {})
        _answer_aggregates(aggregates, {})
        response, _ = _get(api_gateway_event, lambda_context, '/metrics/categories', days=1)
        assert response['statusCode'] == 200
        assert {_query_key(c.kwargs) for c in aggregates.query.call_args_list} == {
            f'METRIC#daily_category#{name}' for name in DEFAULT_CATEGORIES}

    def test_a_category_with_nothing_is_left_out_and_one_item_is_kept(self, aggregates, api_gateway_event,
                                                                      lambda_context):
        _answer_aggregates(aggregates, {
            'METRIC#daily_category#delivery': [{'sk': TODAY, 'count': 1}],
            'METRIC#daily_category#billing': [{'sk': TODAY, 'count': 0}],
        })
        _, body = _get(api_gateway_event, lambda_context, '/metrics/categories', days=1)
        assert body['categories'] == {'delivery': 1}

    @pytest.mark.usefixtures('agg')
    def test_the_scan_branch_buckets_an_uncategorised_item_as_other(self, fb, api_gateway_event, lambda_context):
        fb.query.return_value = _page([
            {'date': TODAY}, {'date': TODAY, 'category': 'delivery'}, {'date': TODAY, 'category': 'delivery'},
        ])
        _, body = _get(api_gateway_event, lambda_context, '/metrics/categories', source='web', days=1)
        assert body['categories'] == {'delivery': 2, 'other': 1}


class TestSourceBreakdown:
    @pytest.mark.usefixtures('agg')
    def test_the_review_basis_buckets_an_item_without_a_platform_as_unknown(self, fb, api_gateway_event,
                                                                            lambda_context):
        fb.query.return_value = _page([{'date': TODAY, 'source_created_at': f'{TODAY}T00:00:00Z'}])
        _, body = _get(api_gateway_event, lambda_context, '/metrics/sources', date_basis='review', days=1)
        assert body['sources'] == {'unknown': 1}

    def test_the_default_basis_reads_the_source_rows_of_the_type_index(self, aggregates, api_gateway_event,
                                                                        lambda_context):
        _answer_aggregates(aggregates, {
            'metric_type=source': [{'pk': 'METRIC#daily_source#web', 'sk': TODAY, 'count': 3}],
        })
        _, body = _get(api_gateway_event, lambda_context, '/metrics/sources', days=1)
        aggregates.query.assert_called_once_with(
            IndexName=AGGREGATES_BY_METRIC_TYPE_INDEX, KeyConditionExpression=Key('metric_type').eq('source'))
        assert body['sources'] == {'web': 3}


class TestPersonaBreakdown:
    @pytest.mark.usefixtures('agg')
    def test_the_review_basis_answer_names_its_window_and_never_reports_legacy_buckets(
            self, fb, api_gateway_event, lambda_context):
        written = f'{TODAY}T00:00:00Z'
        fb.query.side_effect = [_page([
            {'date': TODAY, 'source_created_at': written, 'persona_type': 'advocate'},
            {'date': TODAY, 'source_created_at': written},
        ]), _page([]), _page([])]
        _, body = _get(api_gateway_event, lambda_context, '/metrics/personas', date_basis='review', days=3)
        assert body == {
            'period_days': 3,
            'is_partial': False,
            'has_legacy_persona_buckets': False,
            'personas': {'advocate': 1, 'unknown': 1},
        }

    def test_the_default_basis_reads_the_persona_rows_and_flags_a_legacy_bucket(self, aggregates, api_gateway_event,
                                                                                lambda_context):
        _answer_aggregates(aggregates, {
            'metric_type=persona': [
                {'pk': 'METRIC#persona#advocate', 'sk': TODAY, 'count': 2},
                {'pk': 'METRIC#persona#Unknown', 'sk': TODAY, 'count': 1},
            ],
        })
        _, body = _get(api_gateway_event, lambda_context, '/metrics/personas', days=1)
        aggregates.query.assert_called_once_with(
            IndexName=AGGREGATES_BY_METRIC_TYPE_INDEX, KeyConditionExpression=Key('metric_type').eq('persona'))
        assert body == {
            'period_days': 1,
            'is_partial': False,
            'has_legacy_persona_buckets': True,
            'personas': {'advocate': 2, 'Unknown': 1},
        }


@pytest.mark.usefixtures('agg')
class TestGithubMetricsNameTheirWindow:
    def test_period_days_is_the_requested_window(self, fb, api_gateway_event, lambda_context):
        fb.query.return_value = _page([])
        _, body = _get(api_gateway_event, lambda_context, '/metrics/github', days=5)
        assert body['period_days'] == 5


class TestTheHandlerIsWrappedByApiHandler:
    def test_the_decorator_chain_passes_through_shared_api_and_ends_at_this_module(self):
        chain: list[str] = []

        def record(wrapper: Callable[..., Any]) -> bool:
            chain.append(wrapper.__code__.co_filename)
            return False

        func = inspect.unwrap(metrics_handler.lambda_handler, stop=record)
        # api_handler's innermost layer is the per-request invocation_cost wrapper.
        assert chain[-1].endswith(os.path.join('shared', 'invocation_cost.py'))
        assert func.__code__.co_filename == metrics_handler.__file__
        assert func.__qualname__ == 'lambda_handler'
