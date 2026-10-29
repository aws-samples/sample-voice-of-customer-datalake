"""`GET /feedback/problems` follows the header window, and the multi-value `dims` filter, on moto.

The Problems page sends the header's ``days`` and ``date_basis`` like every other page.
The retired ``latest=N`` parameter (5.45.00) is ignored: an old link or client gets the
``days`` window, never a 400. ``dims=feedback_type:bug|~unset`` keeps either a bug or a
review with no type.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import ExitStack
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import pk_sk_table

from metrics_handler import lambda_handler
from shared.api import clear_categories_cache
from shared.earliest_date import EARLIEST_DATE_KEY

HISTORY_DAYS = 10


def _day(offset: int) -> str:
    return (datetime.now(UTC) - timedelta(days=offset)).strftime('%Y-%m-%d')


def _review(fid: str, n: int, *, imported: int, written: int, kind: str | None = None) -> dict[str, Any]:
    day = _day(imported)
    row: dict[str, Any] = {
        'pk': 'SOURCE#web', 'sk': f'FEEDBACK#{fid}', 'feedback_id': fid,
        'gsi1pk': f'DATE#{day}', 'gsi1sk': f'{day}T00:00:{n:02d}.000000', 'date': day,
        'source_platform': 'web', 'source_created_at': f'{_day(written)}T09:00:00Z',
        'sentiment_label': 'negative', 'sentiment_score': Decimal('-0.4'), 'urgency': 'low',
        'category': 'delivery', 'subcategory': 'shipping', 'problem_summary': f'Problem {fid}',
    }
    if kind is not None:
        row['dimensions'] = {'feedback_type': kind}
    return row


# Import day -> review date. `old` sits in the NEWEST import but was written 100 days ago.
REVIEWS = [
    _review('a', 1, imported=0, written=0, kind='bug'),
    _review('b', 2, imported=0, written=3),
    _review('old', 3, imported=0, written=100, kind='praise'),
    _review('c', 4, imported=2, written=2, kind='bug'),
    _review('d', 5, imported=2, written=5, kind='service_failure'),
    _review('e', 6, imported=6, written=6, kind='praise'),
]
EVERY_ID = {'a', 'b', 'old', 'c', 'd', 'e'}


@pytest.fixture
def world() -> Iterator[Any]:
    """moto tables wired into the handler, seeded with REVIEWS; yields the feedback table."""
    with ExitStack() as stack:
        stack.enter_context(mock_aws())
        clear_categories_cache()
        feedback = pk_sk_table('window-feedback', gsi1_index='gsi1-by-date')
        aggregates = pk_sk_table('window-aggregates')
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': [{'name': 'delivery'}]})
        aggregates.put_item(Item={**EARLIEST_DATE_KEY, 'date': _day(HISTORY_DAYS)})
        with feedback.batch_writer() as writer:
            for row in REVIEWS:
                writer.put_item(Item=row)
        stack.enter_context(patch('metrics_handler.feedback_table', feedback))
        stack.enter_context(patch('metrics_handler.aggregates_table', aggregates))
        yield feedback
    clear_categories_cache()


def _call(event, context, **params: str) -> tuple[dict, Any]:
    return call_route(lambda_handler, event, context, method='GET', path='/feedback/problems',
                      query_params={'similarity': 'off', **params})


def _problems(event, context, **params: str) -> dict:
    response, body = _call(event, context, **params)
    assert response['statusCode'] == 200, body
    return body


def _ids(body: dict) -> set[str]:
    """Every review id the tree counted (each problem group's sample ids)."""
    return {fid for c in body['categories'] for s in c['subcategories'] for p in s['problems']
            for fid in p['sample_ids']}


# ---------------------------------------------------------------- the header window


@pytest.mark.usefixtures('world')
class TestHeaderWindow:
    def test_all_time_on_the_review_basis_counts_every_review_however_old(self, api_gateway_event, lambda_context):
        body = _problems(api_gateway_event, lambda_context, days='0', date_basis='review')
        assert _ids(body) == EVERY_ID
        assert (body['feedback_count'], body['is_partial']) == (6, False)
        assert body['window'] == {'kind': 'days', 'days': 0, 'walk_days': HISTORY_DAYS + 1, 'date_basis': 'review'}

    def test_a_short_review_window_leaves_out_an_old_review_imported_today(self, api_gateway_event, lambda_context):
        body = _problems(api_gateway_event, lambda_context, days='4', date_basis='review')
        assert _ids(body) == {'a', 'b', 'c'}

    def test_a_short_import_window_keeps_everything_imported_in_it(self, api_gateway_event, lambda_context):
        body = _problems(api_gateway_event, lambda_context, days='1', date_basis='imported')
        assert _ids(body) == {'a', 'b', 'old'}
        assert body['period_days'] == 1

    @pytest.mark.parametrize('latest', ['2000', '0', 'abc'])
    def test_the_retired_latest_parameter_is_ignored_not_refused(self, api_gateway_event, lambda_context, latest):
        with_latest = _problems(api_gateway_event, lambda_context, days='1', latest=latest)
        without = _problems(api_gateway_event, lambda_context, days='1')
        assert with_latest == without
        assert with_latest['window']['kind'] == 'days'


def test_an_empty_history_answers_an_empty_tree(api_gateway_event, lambda_context):
    with mock_aws(), ExitStack() as stack:
        clear_categories_cache()
        feedback = pk_sk_table('empty-feedback', gsi1_index='gsi1-by-date')
        aggregates = pk_sk_table('empty-aggregates')
        aggregates.put_item(Item={**EARLIEST_DATE_KEY, 'date': _day(0)})
        stack.enter_context(patch('metrics_handler.feedback_table', feedback))
        stack.enter_context(patch('metrics_handler.aggregates_table', aggregates))
        body = _problems(api_gateway_event, lambda_context, days='0')
    clear_categories_cache()
    assert (body['feedback_count'], body['type_counts'], body['is_partial'], body['categories']) == (0, {}, False, [])


# ---------------------------------------------------------------- dims=a|~unset on the route


@pytest.mark.usefixtures('world')
class TestDimsChoicesOnTheRoute:
    def test_bug_or_unset_keeps_bugs_and_untyped_and_drops_the_rest(self, api_gateway_event, lambda_context):
        body = _problems(api_gateway_event, lambda_context, days='30', dims='feedback_type:bug|~unset')
        assert _ids(body) == {'a', 'b', 'c'}
        assert body['type_counts'] == {'bug': 2, 'untyped': 1}
        # Ranked by count, largest first.
        assert list(body['type_counts']) == ['bug', 'untyped']

    def test_the_problems_page_default_selection_is_accepted(self, api_gateway_event, lambda_context):
        # The SPA's real "Problems only" value (83 characters, longer than one dimension value).
        dims = ('feedback_type:bug|service_failure|performance|usability|pricing_billing'
                '|support_experience|~unset')
        body = _problems(api_gateway_event, lambda_context, days='30', dims=dims)
        assert _ids(body) == {'a', 'b', 'c', 'd'}

    def test_a_malformed_choice_is_a_400(self, api_gateway_event, lambda_context):
        response, _ = _call(api_gateway_event, lambda_context, days='30', dims='feedback_type:bug|a b')
        assert response['statusCode'] == 400

    def test_the_days_window_reports_its_block_and_type_counts(self, api_gateway_event, lambda_context):
        body = _problems(api_gateway_event, lambda_context, days='30')
        assert body['window'] == {'kind': 'days', 'days': 30, 'walk_days': HISTORY_DAYS + 1, 'date_basis': 'imported'}
        assert body['type_counts'] == {'bug': 2, 'praise': 2, 'untyped': 1, 'service_failure': 1}
