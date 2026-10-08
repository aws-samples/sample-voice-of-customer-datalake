"""The metrics endpoints must MEASURE completeness, not assert it.

Every route in `metrics_handler.py` that publishes `is_partial` used to publish a
hardcoded `False` on its aggregates path, because the flag was initialised beside
the scan branch and the aggregates branch never touched it (finding "M4": 99 items
of a 6,239-item corpus reported as complete).

What makes an answer incomplete now, each with its own tests:

1. Paging truncation of an aggregate read (`_query_metric_window` returns
   `(items, truncated)`, the convention of `_scan_recent_items`/`_scan_window_items`).
2. An unpaged `gsi1-by-metric-type` read leaving a cursor open.
3. A per-day `gsi1-by-date` walk stopped by the request's wall-clock budget
   (`shared/time_budget.py`): `is_partial` (or `is_partial_window` on `/feedback`
   and `/feedback/search`) plus `partial_reason: 'time_budget'` and
   `scanned_through`.

The aggregate RETENTION horizon is gone: nothing is ever deleted, so a window of
any width (0 = all time, resolved through the earliest-data watermark) is complete
unless one of the above happened. `TestAnyWindowIsAnsweredFromAggregatesInFull`
fails if a by-construction partial flag comes back.
"""
import ast
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from handler_events_fixtures import call_route
from metrics_publishing_routes import (
    HANDLER_SOURCE as _HANDLER_SOURCE,
)
from metrics_publishing_routes import (
    handler_tree,
    routes_publishing_is_partial,
)

from shared.api import MAX_FEEDBACK_WINDOW_DAYS, clear_categories_cache

# DERIVED from the handler source rather than listed here — see
# `metrics_publishing_routes`. `test_the_derivation_finds_the_routes_that_publish
# _the_flag` below is its positive control.
PUBLISHING_ROUTES = routes_publishing_is_partial()
# Publishing routes with NO aggregates path: they always walk raw items, so the
# aggregate-paging suites below have nothing to truncate there. The time-budget
# and presence suites still cover them through PUBLISHING_ROUTES.
SCAN_ONLY_ROUTES = frozenset({'/metrics/github'})
AGGREGATE_ROUTES = sorted(set(PUBLISHING_ROUTES) - SCAN_ONLY_ROUTES)

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
WINDOW_DAYS = 30


def _today() -> str:
    return datetime.now(UTC).strftime('%Y-%m-%d')


def _get(event_factory, context, path: str, params: dict) -> dict:
    """GET one metrics route with `params` and return the parsed body."""
    from metrics_handler import lambda_handler
    _, body = call_route(
        lambda_handler, event_factory, context, method='GET', path=path, query_params=params,
    )
    return body


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


# A route's required parameters beyond `days`.
ROUTE_PARAMS = {'/metrics/dimensions': {'key': 'product'}}
# `/metrics/dimensions` needs one configured dimension; every other settings read is empty.
_DIMENSIONS_ROW = {'Item': {'dimensions': [{'key': 'product', 'values': [{'name': 'App'}]}]}}


def _settings_rows(**kwargs) -> dict:
    return _DIMENSIONS_ROW if kwargs.get('Key', {}).get('pk') == 'SETTINGS#dimensions' else {}


def _call_route(path: str, days: int, agg, fb, event_factory, context) -> dict:
    """Drive one route down its aggregates path and return the parsed body."""
    # `get_configured_categories` memoises module-side, so a value another test
    # module left behind would decide which category partitions are read. Cleared
    # both ways, as the other metrics tests do.
    clear_categories_cache()
    agg.get_item.side_effect = _settings_rows
    fb.query.return_value = {'Items': [], 'ScannedCount': 0}
    from metrics_handler import lambda_handler

    params = {'days': str(days), **ROUTE_PARAMS.get(path, {})}
    try:
        response = lambda_handler(
            event_factory(method='GET', path=path, query_params=params),
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
            # GitHub Issues per-release breakdown: a raw-item walk, so it carries
            # the walk's partial flag like the scan branches of the routes above.
            '/metrics/github',
            # Per-value counts of one configured dimension.
            '/metrics/dimensions',
        }, PUBLISHING_ROUTES

    @pytest.mark.parametrize('path', sorted(PUBLISHING_ROUTES))
    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_the_flag_is_present_and_boolean(
        self, agg, fb, path, api_gateway_event, lambda_context
    ):
        """An absent flag reads as "complete" exactly like a false one."""
        agg.query.return_value = _aggregate_page(truncated=False)
        body = _call_route(path, WINDOW_DAYS, agg, fb,
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
        pass by never running.

        `_metric_window_pair` is now the ONLY direct caller: every partition read —
        `_metric_window_totals` (`/metrics/sentiment`, `/metrics/categories`, the
        category half of `/feedback/entities`), `_summary_from_aggregates` and the
        total in `get_entities` — goes through it (via `_metric_windows`, which
        runs them concurrently), and it unpacks the pair it hands on.
        """
        tree = handler_tree()

        callers = sorted(
            node.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and _calls_to_helper(ast.Module(body=node.body, type_ignores=[]))
        )
        assert callers == ['_metric_window_pair'], callers

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

    @pytest.mark.parametrize('path', AGGREGATE_ROUTES)
    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_truncated_aggregate_read_is_reported_partial(
        self, agg, fb, path, api_gateway_event, lambda_context
    ):
        """Every page hands back another cursor, so every read stops short."""
        agg.query.return_value = _aggregate_page(truncated=True)
        body = _call_route(path, WINDOW_DAYS, agg, fb,
                           api_gateway_event, lambda_context)

        assert body['is_partial'] is True, (
            f'{path} read a truncated window and called it complete'
        )

    @pytest.mark.parametrize('path', AGGREGATE_ROUTES)
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
        body = _call_route(path, WINDOW_DAYS, agg, fb,
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
            'METRIC#urgent', 3, datetime(2026, 3, 10, tzinfo=UTC))

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
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/metrics/sentiment',
            query_params={'days': str(WINDOW_DAYS)},
        )

        assert body['is_partial'] is True


class TestAnyWindowIsAnsweredFromAggregatesInFull:
    """Aggregate rows are never deleted (no TTL), so no window is partial by construction.

    This class replaces the retired retention horizon (`AGGREGATE_RETENTION_DAYS`):
    a window of any width, all-time included, is answered from the aggregate
    partitions and reported complete unless a READ was truncated.
    """

    @pytest.mark.parametrize('path', AGGREGATE_ROUTES)
    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_the_widest_window_is_complete(
        self, agg, fb, path, api_gateway_event, lambda_context
    ):
        agg.query.return_value = _aggregate_page(truncated=False)
        body = _call_route(path, MAX_FEEDBACK_WINDOW_DAYS, agg, fb,
                           api_gateway_event, lambda_context)

        assert body['is_partial'] is False, (
            f'{path} called a complete {MAX_FEEDBACK_WINDOW_DAYS}-day window partial'
        )
        assert 'partial_reason' not in body

    def test_the_retention_predicate_is_gone(self):
        import metrics_handler

        assert not hasattr(metrics_handler, '_window_exceeds_aggregate_retention')

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_the_wide_window_is_still_answered_from_aggregates(
        self, agg, fb, api_gateway_event, lambda_context
    ):
        """A wide window must not silently fall back to a raw-item scan, which is
        a different, budget-bounded set of numbers arriving under the same name."""
        agg.query.return_value = _aggregate_page(truncated=False)
        body = _call_route('/metrics/categories', MAX_FEEDBACK_WINDOW_DAYS, agg, fb,
                           api_gateway_event, lambda_context)

        assert body['is_partial'] is False
        assert body['period_days'] == MAX_FEEDBACK_WINDOW_DAYS
        fb.query.assert_not_called()


class TestAllTimeWindowsResolveThroughTheWatermark:
    """`days=0` is all time: from the earliest-data watermark to today."""

    @staticmethod
    def _watermark(days_ago: int) -> dict:
        earliest = (datetime.now(UTC) - timedelta(days=days_ago)).strftime('%Y-%m-%d')
        return {'Item': {'pk': 'METRIC#meta', 'sk': 'earliest_date', 'date': earliest}}

    @patch('metrics_handler.feedback_table', new=MagicMock())
    @patch('metrics_handler.aggregates_table')
    def test_days_zero_reads_exactly_the_history(
        self, agg, api_gateway_event, lambda_context
    ):
        from boto3.dynamodb.conditions import Key

        agg.get_item.return_value = self._watermark(days_ago=9)
        agg.query.return_value = {'Items': []}
        body = _get(api_gateway_event, lambda_context, '/metrics/summary', {'days': '0'})

        assert body['period_days'] == 10
        today = datetime.now(UTC)
        oldest = (today - timedelta(days=9)).strftime('%Y-%m-%d')
        assert agg.query.call_args_list[0].kwargs['KeyConditionExpression'] == (
            Key('pk').eq('METRIC#daily_total')
            & Key('sk').between(oldest, today.strftime('%Y-%m-%d'))
        )
        agg.get_item.assert_called_once_with(Key={'pk': 'METRIC#meta', 'sk': 'earliest_date'})

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_window_past_the_history_is_narrowed_to_it(
        self, agg, fb, api_gateway_event, lambda_context
    ):
        """A scan path walks the history, not 9,999 empty day partitions."""
        agg.get_item.return_value = self._watermark(days_ago=4)
        fb.query.return_value = {'Items': [], 'ScannedCount': 0}
        body = _get(api_gateway_event, lambda_context, '/metrics/categories',
                    {'days': str(MAX_FEEDBACK_WINDOW_DAYS), 'source': 'webscraper'})

        assert body['period_days'] == 5
        assert fb.query.call_count == 5

    @patch('metrics_handler.feedback_table', new=MagicMock())
    @patch('metrics_handler.aggregates_table')
    def test_without_a_watermark_all_time_falls_back_to_a_year(
        self, agg, api_gateway_event, lambda_context
    ):
        from shared.api import ALL_TIME_FALLBACK_DAYS

        agg.get_item.return_value = {}
        agg.query.return_value = {'Items': []}
        body = _get(api_gateway_event, lambda_context, '/metrics/summary', {'days': '0'})

        assert body['period_days'] == ALL_TIME_FALLBACK_DAYS


class TestPerDayWalksStopOnTheTimeBudget:
    """Per-day `gsi1-by-date` walks are bounded by wall-clock time, and say so."""

    @staticmethod
    def _exhausted_after_first_day(monkeypatch):
        """A budget whose clock runs out once the first day has been read."""
        import metrics_handler
        from shared.time_budget import WalkBudget

        ticks = iter(range(1000))

        def clock() -> float:
            # 0 at construction, then 100 s per reading: past the deadline at once.
            return next(ticks) * 100.0

        class ExhaustedBudget(WalkBudget):
            def __init__(self):
                super().__init__(clock=clock)

        monkeypatch.setattr(metrics_handler, 'WalkBudget', ExhaustedBudget)

    @classmethod
    def _get_exhausted(cls, agg, fb, monkeypatch, event_factory, context, path, params) -> dict:
        """GET `path` over 30 days with a budget that runs out after the first day."""
        cls._exhausted_after_first_day(monkeypatch)
        agg.get_item.return_value = {}
        fb.query.return_value = {'Items': [], 'ScannedCount': 0}
        return _get(event_factory, context, path, {'days': '30', **params})

    @pytest.mark.parametrize(('path', 'params'), [
        ('/metrics/categories', {'source': 'webscraper'}),
        ('/metrics/sentiment', {'source': 'webscraper'}),
        ('/metrics/sources', {'date_basis': 'review'}),
        ('/metrics/personas', {'date_basis': 'review'}),
        ('/metrics/summary', {'date_basis': 'review'}),
        ('/feedback/entities', {'source': 'webscraper'}),
    ])
    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_scan_routes_report_the_budget_stop(
        self, agg, fb, path, params, monkeypatch, api_gateway_event, lambda_context
    ):
        body = self._get_exhausted(agg, fb, monkeypatch, api_gateway_event, lambda_context, path, params)

        assert body['is_partial'] is True
        assert body['partial_reason'] == 'time_budget'
        assert body['scanned_through'] == _today()
        assert fb.query.call_count == 1, 'the walk must stop once the budget is spent'

    @pytest.mark.parametrize(('path', 'params'), [
        ('/feedback', {}),
        ('/feedback/search', {'q': 'late'}),
    ])
    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_list_routes_report_the_budget_stop(
        self, agg, fb, path, params, monkeypatch, api_gateway_event, lambda_context
    ):
        """These routes name their flag `is_partial_window`; the reason rides beside it."""
        body = self._get_exhausted(agg, fb, monkeypatch, api_gateway_event, lambda_context, path, params)

        assert body['is_partial_window'] is True
        assert body['partial_reason'] == 'time_budget'
        assert body['scanned_through'] == _today()

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_a_walk_inside_the_budget_carries_no_reason(
        self, agg, fb, api_gateway_event, lambda_context
    ):
        agg.get_item.return_value = {}
        fb.query.return_value = {'Items': [], 'ScannedCount': 0}
        body = _get(api_gateway_event, lambda_context, '/metrics/categories',
                    {'days': '30', 'source': 'webscraper'})

        assert body['is_partial'] is False
        assert 'partial_reason' not in body
        assert 'scanned_through' not in body
        assert fb.query.call_count == 30


class TestScanPathIsUnchanged:
    """Anti-overreach: the aggregate-read signals must not leak onto the raw-item path."""

    @patch('metrics_handler.aggregates_table', new=MagicMock())
    @patch('metrics_handler.feedback_table')
    def test_a_complete_scan_of_the_widest_window_is_complete(
        self, fb, api_gateway_event, lambda_context
    ):
        fb.query.return_value = {'Items': [], 'ScannedCount': 0}
        body = _get(api_gateway_event, lambda_context, '/metrics/categories',
                    {'days': str(MAX_FEEDBACK_WINDOW_DAYS), 'source': 'webscraper'})

        assert body['is_partial'] is False

    @patch('metrics_handler.aggregates_table')
    @patch('metrics_handler.feedback_table')
    def test_a_truncated_scan_still_reports_itself(
        self, fb, agg, api_gateway_event, lambda_context
    ):
        """The behaviour that already worked, pinned so the rewiring cannot have
        replaced the scan's flag with the aggregates one."""
        today = datetime.now(UTC)
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
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/metrics/categories',
            query_params={'days': '30', 'source': 'webscraper'},
        )

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
        today = datetime.now(UTC)
        first_page = {
            'Items': [{
                'feedback_id': 'a-1', 'date': today.strftime('%Y-%m-%d'),
                'source_created_at': today.isoformat(),
            }],
            'ScannedCount': 1,
        }
        pages = iter([first_page])
        # Every later day partition is empty; a function rather than a list so the
        # widest window cannot run out of canned pages.
        fb.query.side_effect = lambda **_kwargs: next(pages, {'Items': [], 'ScannedCount': 0})

        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/metrics/summary',
            query_params={'days': str(MAX_FEEDBACK_WINDOW_DAYS), 'date_basis': 'review'},
        )

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
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path=path, query_params={'days': '7'},
        )

        assert body['is_partial'] is True
        assert agg.query.call_count == 1, 'the read must not have been widened'

    @pytest.mark.parametrize('path', ['/metrics/sources', '/metrics/personas'])
    @patch('metrics_handler.aggregates_table')
    def test_a_single_complete_page_is_not_partial(
        self, agg, path, api_gateway_event, lambda_context
    ):
        agg.query.return_value = _aggregate_page(truncated=False)

        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path=path, query_params={'days': '7'},
        )

        assert body['is_partial'] is False


class TestWindowBoundsAreUnchanged:
    """No window silently widened or narrowed: same dates, same request count."""

    @patch('metrics_handler.aggregates_table')
    def test_the_queried_date_range_is_the_requested_window(self, agg):
        from boto3.dynamodb.conditions import Key

        from metrics_handler import _query_metric_window

        agg.query.return_value = {'Items': []}
        _query_metric_window('METRIC#urgent', 7,
                             datetime(2026, 3, 10, tzinfo=UTC))

        assert agg.query.call_args.kwargs['KeyConditionExpression'] == (
            Key('pk').eq('METRIC#urgent') & Key('sk').between('2026-03-04', '2026-03-10')
        )

    @patch('metrics_handler.aggregates_table')
    def test_summary_still_costs_three_queries_at_any_window(
        self, agg, api_gateway_event, lambda_context
    ):
        """At any window, all-time and the widest included: the flag is computed
        from the reads, not bought with extra ones."""
        from metrics_handler import lambda_handler

        for days in ('0', '1', '7', '90', '365', str(MAX_FEEDBACK_WINDOW_DAYS)):
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
        body = _call_route('/metrics/sentiment', WINDOW_DAYS, agg, fb,
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
        newest = datetime.now(UTC)
        older = newest - timedelta(days=1)
        agg.query.return_value = {'Items': [
            {'sk': newest.strftime('%Y-%m-%d'), 'count': 2, 'sum': 1.0},
            {'sk': older.strftime('%Y-%m-%d'), 'count': 1, 'sum': 0.5},
        ]}

        from metrics_handler import lambda_handler
        _, body = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/metrics/summary', query_params={'days': '7'},
        )

        day_order = [t['date'] for t in body['daily_totals']]
        assert day_order == [newest.strftime('%Y-%m-%d'), older.strftime('%Y-%m-%d')]
        assert agg.query.call_args.kwargs['ScanIndexForward'] is False
