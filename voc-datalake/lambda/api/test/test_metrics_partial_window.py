"""The metrics endpoints must MEASURE completeness, not assert it.

Every route in `metrics_handler.py` that publishes `is_partial` used to publish a
hardcoded `False` on its aggregates path — the default path, a plain `?days=N` —
because the flag was initialised to `False` beside the scan branch that sets it
and the aggregates branch never touched it. Measured symptom of finding "M4":
99 items of a 6,239-item corpus reported as a complete answer. Through MCP that
is worse than on the dashboard, where a human has the corpus total next to the
chart to notice with.

Two INDEPENDENT faults make an aggregates answer incomplete, and each has its
own tests here because neither implies the other:

1. Paging truncation, which `_query_metric_window` already detected and threw
   away (it logged and returned a short list). It now returns
   `(items, truncated)`, the convention `_scan_recent_items` /
   `_scan_window_items` already use.
2. The aggregate retention horizon, which nothing detected at all. Aggregate
   rows carry a 90-day TTL while `days` validates up to 365, so a window wider
   than `AGGREGATE_RETENTION_DAYS` reads a partition whose older rows DynamoDB
   has already deleted. Every read succeeds; the totals just under-report.

Which mutation makes each assertion here fail:

* `TestAggregatePathReportsPagingTruncation` — revert
  `_query_metric_window`'s `return items, True` to `return items` (and the
  callers' `or truncated` with it): the truncated cases report `False`.
  `test_an_untruncated_window_is_reported_complete` is the positive control that
  keeps this suite from passing by reporting `True` unconditionally.
* `TestWindowWiderThanAggregateRetention` — delete the
  `_window_exceeds_aggregate_retention(days)` seed from the aggregates branches
  (or weaken `>` to `>=`... which breaks the boundary test instead): a 365-day
  window reports `False`. The `days=90` case fails if the check is widened to
  flag windows the rows still cover.
* `TestEveryPublishingRouteIsWired` — add a route that returns `is_partial`
  without wiring it and the derived parametrization picks it up and fails; the
  derivation itself is guarded by
  `test_the_derivation_finds_the_routes_that_publish_the_flag`, without which an
  empty list would make every parametrized test vacuous.
* `TestScanPathIsUnchanged` — anti-overreach. Fails if the retention horizon or
  the paging flag is applied to the raw-item scan path, whose feedback rows keep
  a 365-day TTL and are therefore complete over the widest window callers may
  ask for, or if a partial aggregate read is "fixed" by falling back to scanning.
"""
import ast
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

from metrics_publishing_routes import (
    HANDLER_SOURCE as _HANDLER_SOURCE,
    handler_tree,
    routes_publishing_is_partial,
)
from shared.api import AGGREGATE_RETENTION_DAYS, MAX_FEEDBACK_WINDOW_DAYS, clear_categories_cache

# DERIVED from the handler source rather than listed here — see
# `metrics_publishing_routes`, which `test_mcp_delegation` reads too so there is
# one derivation and not two. `test_the_derivation_finds_the_routes_that_publish
# _the_flag` below is its positive control.
PUBLISHING_ROUTES = routes_publishing_is_partial()

_HELPER = '_query_metric_window'
# test/ → api/ → lambda/. Every Lambda package lives under here, so this is the
# scope in which "nobody else calls the helper" can be checked at all.
_LAMBDA_ROOT = Path(__file__).resolve().parents[2]


def _calls_to_helper(tree: ast.Module) -> list[ast.Call]:
    return [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == _HELPER
    ]


def _calls_unpacking_two_values(tree: ast.Module) -> list[ast.Call]:
    """Helper calls assigned straight into a two-name tuple target.

    `a, b = _query_metric_window(...)` qualifies. A call inside a `sum(...)`, a
    comprehension, or a single-name assignment does not — which is the point: the
    helper's return type changed from `list[dict]` to `tuple[list[dict], bool]`,
    and every one of those forms still parses, runs, and produces a wrong answer
    (iterating the 2-tuple, or counting the boolean as a row).
    """
    found: list[ast.Call] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Call):
            continue
        call = node.value
        if not (isinstance(call.func, ast.Name) and call.func.id == _HELPER):
            continue
        if all(
            isinstance(target, ast.Tuple) and len(target.elts) == 2
            for target in node.targets
        ):
            found.append(call)
    return found

# Every one of them reaches its aggregates path on a plain `?days=N`: no
# `source`, and the default 'imported' date basis. That is the path that used to
# assert completeness, and the only extra parameter any of them needs.
INSIDE_RETENTION_DAYS = AGGREGATE_RETENTION_DAYS - 1


def _today() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%d')


def _aggregate_page(truncated: bool) -> dict:
    """One page of aggregate rows, optionally with a cursor still open.

    A single row shaped to satisfy every reader: `_query_metric_window` wants
    `sk`/`count`, and the `gsi1-by-metric-type` readers want `pk`. `sk` is today
    so the in-memory date-range filters keep it.
    """
    row = {'pk': 'METRIC#daily_source#webscraper', 'sk': _today(), 'count': 1}
    page: dict = {'Items': [row]}
    if truncated:
        page['LastEvaluatedKey'] = {'pk': row['pk'], 'sk': row['sk']}
    return page


def _call_route(path: str, days: int, agg, fb, event_factory, context) -> dict:
    """Drive one route down its aggregates path and return the parsed body."""
    # `get_configured_categories` memoises module-side, so a value another test
    # module left behind would decide which category partitions are read. Cleared
    # both ways, as the other metrics tests do.
    clear_categories_cache()
    agg.get_item.return_value = {}
    fb.query.return_value = {'Items': [], 'ScannedCount': 0}
    from metrics_handler import lambda_handler

    try:
        response = lambda_handler(
            event_factory(method='GET', path=path, query_params={'days': str(days)}),
            context,
        )
    finally:
        clear_categories_cache()
    assert response['statusCode'] == 200, response['body']
    return json.loads(response['body'])


class TestEveryPublishingRouteIsWired:
    """The derivation these parametrized suites stand on."""

    def test_the_derivation_finds_the_routes_that_publish_the_flag(self):
        """The positive control.

        An empty or short derivation would make every parametrized case below
        pass by never running, which is the failure mode this whole file exists
        to close. The six named here are the response sites `is_partial` was
        already published from; a seventh is welcome and belongs in this list
        once it is wired.
        """
        assert set(PUBLISHING_ROUTES) == {
            '/feedback/entities',
            '/metrics/summary',
            '/metrics/sentiment',
            '/metrics/categories',
            '/metrics/sources',
            '/metrics/personas',
        }, PUBLISHING_ROUTES

    @pytest.mark.parametrize('path', sorted(PUBLISHING_ROUTES))
    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_the_flag_is_present_and_boolean(
        self, agg, fb, path, api_gateway_event, lambda_context
    ):
        """An absent flag reads as "complete" exactly like a false one."""
        agg.query.return_value = _aggregate_page(truncated=False)
        body = _call_route(path, INSIDE_RETENTION_DAYS, agg, fb,
                           api_gateway_event, lambda_context)

        assert 'is_partial' in body, f'{path} publishes no is_partial'
        assert isinstance(body['is_partial'], bool)


class TestEveryCallerUnpacksTheTruncationFlag:
    """A caller that ignores the second return value is a NEW silent defect.

    The parametrized suites above can only see routes that publish `is_partial`,
    so a caller that does not publish it — a future route, or a helper reading the
    same partitions — is exactly the case they cannot catch. And the failure is
    not a crash at the call: `sum(int(i.get('count', 0)) for i in helper(...))`
    over a 2-tuple raises inside the generator, while `items = helper(...)`
    followed by `len(items)` silently answers 2.
    """

    def test_the_derivation_sees_the_calls(self):
        """The positive control: an empty derivation would make the check below
        pass by never running."""
        tree = handler_tree()

        callers = sorted(
            node.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and _calls_to_helper(ast.Module(body=node.body, type_ignores=[]))
        )
        assert callers == [
            'get_category_metrics', 'get_entities', 'get_sentiment_metrics', 'get_summary',
        ], callers

    def test_no_call_site_drops_the_flag(self):
        tree = handler_tree()
        all_calls = _calls_to_helper(tree)
        unpacked = {id(call) for call in _calls_unpacking_two_values(tree)}

        dropped = sorted(call.lineno for call in all_calls if id(call) not in unpacked)
        assert dropped == [], (
            f'{_HELPER} returns (items, truncated); the call(s) at '
            f'{_HANDLER_SOURCE.name} line(s) {dropped} do not unpack both, so a '
            'truncated read is either reported as rows or dropped on the floor'
        )

    def test_nothing_outside_this_handler_calls_the_helper(self):
        """The helper is private to `metrics_handler`, and its return type changed.

        An importer in another Lambda package would iterate the 2-tuple and blow
        up on `item.get(...)` at runtime, not in this suite — nothing else here
        looks outside this file.
        """
        importers = sorted(
            str(path.relative_to(_LAMBDA_ROOT))
            for path in _LAMBDA_ROOT.rglob('*.py')
            if path != _HANDLER_SOURCE
            and 'test' not in path.parts
            and not path.name.startswith('test_')
            and _HELPER in path.read_text(encoding='utf-8')
        )
        assert importers == [], (
            f'{_HELPER} is called outside metrics_handler.py ({importers}); those '
            'call sites are not covered by the AST check above'
        )


class TestAggregatePathReportsPagingTruncation:
    """Fault 1: the paging bound, which the helper detected and discarded."""

    @pytest.mark.parametrize('path', sorted(PUBLISHING_ROUTES))
    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_truncated_aggregate_read_is_reported_partial(
        self, agg, fb, path, api_gateway_event, lambda_context
    ):
        """Every page hands back another cursor, so every read stops short."""
        agg.query.return_value = _aggregate_page(truncated=True)
        body = _call_route(path, INSIDE_RETENTION_DAYS, agg, fb,
                           api_gateway_event, lambda_context)

        assert body['is_partial'] is True, (
            f'{path} read a truncated window and called it complete'
        )

    @pytest.mark.parametrize('path', sorted(PUBLISHING_ROUTES))
    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_an_untruncated_window_is_reported_complete(
        self, agg, fb, path, api_gateway_event, lambda_context
    ):
        """The positive control for the case above.

        Without it the wiring could satisfy every other test in this file by
        reporting `True` unconditionally, which is the same defect pointing the
        other way: a flag that is always set carries no information and gets
        ignored.
        """
        agg.query.return_value = _aggregate_page(truncated=False)
        body = _call_route(path, INSIDE_RETENTION_DAYS, agg, fb,
                           api_gateway_event, lambda_context)

        assert body['is_partial'] is False, (
            f'{path} reported a complete window as partial'
        )

    @patch('metrics_handler.aggregates_table')
    def test_the_helper_returns_the_flag_beside_the_items(self, agg):
        """`(items, truncated)` — the shape the scan helpers already return, so a
        route taking either path ORs one kind of flag rather than reconciling
        two."""
        from metrics_handler import _query_metric_window

        agg.query.return_value = _aggregate_page(truncated=True)
        items, truncated = _query_metric_window(
            'METRIC#urgent', 3, datetime(2026, 3, 10, tzinfo=timezone.utc))

        assert truncated is True
        assert len(items) == 3, 'the bound still caps pages at `days`'

    @patch('metrics_handler.aggregates_table')
    def test_one_truncated_partition_out_of_many_makes_the_answer_partial(
        self, agg, api_gateway_event, lambda_context
    ):
        """`/metrics/sentiment` reads four partitions; a short read of any one
        understates `total` and every percentage, so the flag ORs across them
        instead of being attributed to the last one read."""
        # Keyed off the partition rather than call order, so exactly ONE of the
        # four labels reads short and the other three are complete. A flat list
        # of pages would instead be consumed by whichever partition paged first.
        def one_short_partition(**kwargs):
            # The pk is the FIRST value of the `pk = ... AND sk BETWEEN ...`
            # condition the helper builds; reached through the public
            # `get_expression` rather than a repr, which is an object address.
            equals, _between = kwargs['KeyConditionExpression'].get_expression()['values']
            pk = equals.get_expression()['values'][1]
            return _aggregate_page(truncated=pk.endswith('daily_sentiment#negative'))

        agg.query.side_effect = one_short_partition

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET', path='/metrics/sentiment',
            query_params={'days': str(INSIDE_RETENTION_DAYS)},
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['is_partial'] is True


class TestWindowWiderThanAggregateRetention:
    """Fault 2: the retention horizon, which nothing detected at all.

    Not a variant of fault 1. Paging truncation is a property of one read that
    may or may not happen; this holds for the request itself even when every
    read succeeds and returns every row that still exists.
    """

    @pytest.mark.parametrize('path', sorted(PUBLISHING_ROUTES))
    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_window_beyond_the_retention_is_partial_by_construction(
        self, agg, fb, path, api_gateway_event, lambda_context
    ):
        agg.query.return_value = _aggregate_page(truncated=False)
        body = _call_route(path, MAX_FEEDBACK_WINDOW_DAYS, agg, fb,
                           api_gateway_event, lambda_context)

        assert body['is_partial'] is True, (
            f'{path} answered a {MAX_FEEDBACK_WINDOW_DAYS}-day window from '
            f'{AGGREGATE_RETENTION_DAYS} days of surviving rows and called it complete'
        )

    @pytest.mark.parametrize('path', sorted(PUBLISHING_ROUTES))
    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_window_the_rows_still_cover_is_complete(
        self, agg, fb, path, api_gateway_event, lambda_context
    ):
        """At exactly the retention the rows still cover the window, so flagging
        it would cry partial over a complete answer and teach callers to ignore
        the flag."""
        agg.query.return_value = _aggregate_page(truncated=False)
        body = _call_route(path, AGGREGATE_RETENTION_DAYS, agg, fb,
                           api_gateway_event, lambda_context)

        assert body['is_partial'] is False, (
            f'{path} called a {AGGREGATE_RETENTION_DAYS}-day window partial'
        )

    def test_the_predicate_is_about_the_request_not_about_a_read(self):
        """Exercised directly, because the boundary is the whole claim."""
        from metrics_handler import _window_exceeds_aggregate_retention

        assert _window_exceeds_aggregate_retention(AGGREGATE_RETENTION_DAYS + 1) is True
        assert _window_exceeds_aggregate_retention(AGGREGATE_RETENTION_DAYS) is False
        assert _window_exceeds_aggregate_retention(1) is False

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_the_wide_window_is_still_answered_from_aggregates(
        self, agg, fb, api_gateway_event, lambda_context
    ):
        """Reporting the horizon must not widen or narrow what is read.

        The honest answer to "this window exceeds what aggregates retain" is to
        say so, not to silently fall back to a raw-item scan — which is a
        different, budget-bounded set of numbers arriving under the same name.
        """
        agg.query.return_value = _aggregate_page(truncated=False)
        body = _call_route('/metrics/categories', MAX_FEEDBACK_WINDOW_DAYS, agg, fb,
                           api_gateway_event, lambda_context)

        assert body['is_partial'] is True
        assert body['period_days'] == MAX_FEEDBACK_WINDOW_DAYS
        fb.query.assert_not_called()


class TestScanPathIsUnchanged:
    """Anti-overreach: neither new signal may leak onto the raw-item path.

    Feedback rows are written with a 365-day TTL, so a scan reaches back as far
    as `validate_days` allows. Only the 90-day AGGREGATE rows are the shorter
    horizon, so applying it to a scan would report complete answers as partial.
    """

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_a_complete_scan_of_the_widest_window_is_complete(
        self, fb, agg, api_gateway_event, lambda_context
    ):
        fb.query.return_value = {'Items': [], 'ScannedCount': 0}

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET', path='/metrics/categories',
            query_params={'days': str(MAX_FEEDBACK_WINDOW_DAYS), 'source': 'webscraper'},
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['is_partial'] is False

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_a_truncated_scan_still_reports_itself(
        self, fb, agg, api_gateway_event, lambda_context
    ):
        """The behaviour that already worked, pinned so the rewiring cannot have
        replaced the scan's flag with the aggregates one."""
        today = datetime.now(timezone.utc)
        fb.query.side_effect = [
            {
                'Items': [{
                    'feedback_id': 'a-1', 'category': 'delivery',
                    'source_platform': 'webscraper',
                    'date': today.strftime('%Y-%m-%d'),
                    'source_created_at': today.isoformat(),
                }],
                'ScannedCount': 10000,
                'LastEvaluatedKey': {'pk': 'more'},
            }
        ] + [{'Items': [], 'ScannedCount': 0}] * 400

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET', path='/metrics/categories',
            query_params={'days': '30', 'source': 'webscraper'},
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['is_partial'] is True
        assert body['categories'] == {'delivery': 1}
        # The scan path reads raw items only; a per-partition truncation must not
        # be answered by also reading aggregates.
        agg.query.assert_not_called()

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_the_review_basis_summary_still_reports_its_own_scan(
        self, fb, agg, api_gateway_event, lambda_context
    ):
        today = datetime.now(timezone.utc)
        fb.query.side_effect = [{
            'Items': [{
                'feedback_id': 'a-1', 'date': today.strftime('%Y-%m-%d'),
                'source_created_at': today.isoformat(),
            }],
            'ScannedCount': 1,
        }] + [{'Items': [], 'ScannedCount': 0}] * 400

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET', path='/metrics/summary',
            query_params={'days': str(MAX_FEEDBACK_WINDOW_DAYS), 'date_basis': 'review'},
        )
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['is_partial'] is False
        assert body['total_feedback'] == 1
        agg.query.assert_not_called()


class TestUnpagedIndexReadsReportTruncation:
    """The `gsi1-by-metric-type` readers page not at all, so 1 MB is their bound.

    Same class of fact as the paging bound — rows exist that were not counted —
    and it was discarded the same way. Reported rather than followed: paging
    these reads would change which data the answer is computed from, which this
    change deliberately does not do.
    """

    @pytest.mark.parametrize('path', ['/metrics/sources', '/metrics/personas'])
    @patch('metrics_handler.aggregates_table')
    def test_a_cursor_left_open_by_the_single_query_is_reported(
        self, agg, path, api_gateway_event, lambda_context
    ):
        agg.query.return_value = _aggregate_page(truncated=True)

        from metrics_handler import lambda_handler
        event = api_gateway_event(method='GET', path=path, query_params={'days': '7'})
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['is_partial'] is True
        assert agg.query.call_count == 1, 'the read must not have been widened'

    @pytest.mark.parametrize('path', ['/metrics/sources', '/metrics/personas'])
    @patch('metrics_handler.aggregates_table')
    def test_a_single_complete_page_is_not_partial(
        self, agg, path, api_gateway_event, lambda_context
    ):
        agg.query.return_value = _aggregate_page(truncated=False)

        from metrics_handler import lambda_handler
        event = api_gateway_event(method='GET', path=path, query_params={'days': '7'})
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert body['is_partial'] is False


class TestWindowBoundsAreUnchanged:
    """No window silently widened or narrowed: same dates, same request count."""

    @patch('metrics_handler.aggregates_table')
    def test_the_queried_date_range_is_the_requested_window(self, agg):
        from boto3.dynamodb.conditions import Key
        from metrics_handler import _query_metric_window

        agg.query.return_value = {'Items': []}
        _query_metric_window('METRIC#urgent', 7,
                             datetime(2026, 3, 10, tzinfo=timezone.utc))

        assert agg.query.call_args.kwargs['KeyConditionExpression'] == (
            Key('pk').eq('METRIC#urgent') & Key('sk').between('2026-03-04', '2026-03-10')
        )

    @patch('metrics_handler.aggregates_table')
    def test_summary_still_costs_three_queries_at_any_window(
        self, agg, api_gateway_event, lambda_context
    ):
        """Including a window past the retention horizon: the flag is computed
        from `days`, not bought with extra reads."""
        from metrics_handler import lambda_handler

        for days in ('1', '7', '90', '365'):
            agg.reset_mock()
            agg.query.return_value = _aggregate_page(truncated=False)
            event = api_gateway_event(
                method='GET', path='/metrics/summary', query_params={'days': days})
            assert lambda_handler(event, lambda_context)['statusCode'] == 200
            assert agg.query.call_count == 3, f'at days={days}'

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_partial_window_still_carries_the_counts_it_did_read(
        self, agg, fb, api_gateway_event, lambda_context
    ):
        """Partial means "a lower bound", not "no answer" — the numbers that were
        read are still returned."""
        agg.query.return_value = _aggregate_page(truncated=True)
        body = _call_route('/metrics/sentiment', INSIDE_RETENTION_DAYS, agg, fb,
                           api_gateway_event, lambda_context)

        assert body['is_partial'] is True
        assert body['total'] > 0


class TestDailySeriesOrderSurvivesTheNewReturnShape:
    """`ScanIndexForward=False` is load-bearing for the charts, and unpacking a
    tuple is exactly the sort of edit that quietly reorders a series."""

    @patch('metrics_handler.aggregates_table')
    def test_summary_keeps_daily_totals_newest_first(
        self, agg, api_gateway_event, lambda_context
    ):
        newest = datetime.now(timezone.utc)
        older = newest - timedelta(days=1)
        agg.query.return_value = {'Items': [
            {'sk': newest.strftime('%Y-%m-%d'), 'count': 2, 'sum': 1.0},
            {'sk': older.strftime('%Y-%m-%d'), 'count': 1, 'sum': 0.5},
        ]}

        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET', path='/metrics/summary', query_params={'days': '7'})
        body = json.loads(lambda_handler(event, lambda_context)['body'])

        assert [t['date'] for t in body['daily_totals']] == [
            newest.strftime('%Y-%m-%d'), older.strftime('%Y-%m-%d'),
        ]
        assert agg.query.call_args.kwargs['ScanIndexForward'] is False
