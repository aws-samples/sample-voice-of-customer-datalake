"""`GET /feedback/problems`: the Problem Analysis tree over the WHOLE window, on moto.

Live finding (5.24.01): the page paged `/feedback` in the browser and stopped at the
newest 2,000 reviews, so on a 26,622-review workspace every count it showed was a
fraction. The route reads every review of the window as slim rows and aggregates
them; these cases pin exact counts past both old limits (the browser's 2,000 and the
day walk's 5,000-row cap, lowered here), the caller's scope, the filters, and an
honest partial answer when the walk budget runs out.
"""
from __future__ import annotations

from contextlib import ExitStack
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from unittest.mock import patch

import pytest
from category_access_fixtures import RESTRICTED_CLAIMS, RESTRICTED_SUB
from handler_events_fixtures import call_route
from moto import mock_aws
from moto_helpers import pk_sk_table

from metrics_handler import lambda_handler
from shared.api import clear_categories_cache
from shared.category_access import access_key
from shared.problem_aggregation import PROBLEM_FIELDS, SlimRead
from shared.time_budget import WalkBudget


def _day(offset: int) -> str:
    return (datetime.now(UTC) - timedelta(days=offset)).strftime('%Y-%m-%d')


def _review(fid: str, day: str, n: int, **fields: Any) -> dict[str, Any]:
    source = fields.pop('source', 'web')
    return {
        'pk': f'SOURCE#{source}', 'sk': f'FEEDBACK#{fid}', 'feedback_id': fid,
        'gsi1pk': f'DATE#{day}', 'gsi1sk': f'{day}T00:{n // 60 % 60:02d}:{n % 60:02d}.{n:06d}', 'date': day,
        'source_platform': source, 'source_created_at': f'{day}T00:00:00Z',
        'sentiment_label': 'negative', 'sentiment_score': Decimal('-0.5'), 'urgency': 'low',
        'original_text': 'x' * 400, **fields,
    }


def _bulk(table, rows: list[dict[str, Any]]) -> None:
    with table.batch_writer() as writer:
        for row in rows:
            writer.put_item(Item=row)


@pytest.fixture
def world():
    """moto feedback + aggregates tables wired into the handler; yields the feedback table."""
    with ExitStack() as stack:
        stack.enter_context(mock_aws())
        clear_categories_cache()
        feedback = pk_sk_table('problems-feedback', gsi1_index='gsi1-by-date')
        aggregates = pk_sk_table('problems-aggregates')
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config',
                                  'categories': [{'name': 'delivery'}, {'name': 'billing'}]})
        aggregates.put_item(Item={**access_key(RESTRICTED_SUB), 'categories': ['delivery']})
        stack.enter_context(patch('metrics_handler.feedback_table', feedback))
        stack.enter_context(patch('metrics_handler.aggregates_table', aggregates))
        yield feedback
    clear_categories_cache()


def _problems(event, context, claims: dict | None = None, **params: str) -> dict:
    kwargs: dict[str, Any] = {'claims': claims} if claims else {}
    response, body = call_route(lambda_handler, event, context, method='GET', path='/feedback/problems',
                                query_params={'days': '7', **params}, **kwargs)
    assert response['statusCode'] == 200, body
    return body


def _tree(body: dict) -> dict[tuple[str, str], list[tuple[str, int, int]]]:
    return {
        (c['category'], s['subcategory']): [(p['problem'], p['count'], p['urgent_count']) for p in s['problems']]
        for c in body['categories'] for s in c['subcategories']
    }


class _Unhurried(WalkBudget):
    """A walk budget moto under a loaded parallel run cannot exhaust: these cases are about row caps."""

    def __init__(self) -> None:
        super().__init__(seconds=600)


def _seed_big_day(table, total: int) -> None:
    """`total` reviews today: 3/5 'Slow delivery times' (1 in 10 urgent), 2/5 billing, plus 5 with no problem."""
    rows = []
    for n in range(total):
        if n % 5 < 3:
            rows.append(_review(f'd{n}', _day(0), n, category='delivery', subcategory='shipping',
                                problem_summary='Slow delivery times', urgency='high' if n % 10 == 0 else 'low'))
        else:
            rows.append(_review(f'b{n}', _day(0), n, category='billing', subcategory='refunds',
                                problem_summary='Refund never arrived', source='app'))
    rows += [_review(f'none{n}', _day(0), total + n, category='billing') for n in range(5)]
    _bulk(table, rows)


def test_a_day_past_the_old_browser_limit_is_counted_exactly(world, api_gateway_event, lambda_context):
    _seed_big_day(world, 2_500)
    with patch('metrics_handler.WalkBudget', _Unhurried):
        body = _problems(api_gateway_event, lambda_context)
    assert _tree(body) == {
        ('delivery', 'shipping'): [('Slow delivery times', 1_500, 250)],
        ('billing', 'refunds'): [('Refund never arrived', 1_000, 0)],
    }
    assert (body['feedback_count'], body['problem_count'], body['is_partial']) == (2_500, 2, False)
    assert body['subcategories'] == ['refunds', 'shipping']


def test_a_day_past_the_list_walk_cap_is_read_in_full(world, api_gateway_event, lambda_context):
    # The day walk the list routes use is lowered to 600 rows: the slim read is not bound by it.
    _seed_big_day(world, 1_200)
    with patch('metrics_handler.MAX_FEEDBACK_OFFSET', 600), patch('metrics_handler.MAX_SCANNED_PER_PARTITION', 600), \
            patch('metrics_handler.WalkBudget', _Unhurried):
        body = _problems(api_gateway_event, lambda_context)
    assert (body['feedback_count'], body['is_partial']) == (1_200, False)


def test_the_slim_read_has_its_own_cap_and_says_when_it_hit_it(world, api_gateway_event, lambda_context):
    _seed_big_day(world, 300)
    small = SlimRead(fields=PROBLEM_FIELDS, soft_cap=100, max_scanned_per_partition=100, page_limit=50)
    with patch('metrics_handler.PROBLEM_READ', small):
        body = _problems(api_gateway_event, lambda_context)
    assert body['is_partial'] is True
    assert body['feedback_count'] <= 100


def test_rows_are_projected_to_the_fields_the_tree_reads(world, api_gateway_event, lambda_context):
    _bulk(world, [_review('d1', _day(0), 1, category='delivery', problem_summary='Late parcel')])
    calls: list[dict[str, Any]] = []
    real_query = world.query

    def spy(**kwargs: Any) -> Any:
        calls.append(kwargs)
        return real_query(**kwargs)

    with patch.object(world, 'query', side_effect=spy):
        _problems(api_gateway_event, lambda_context, days='1')
    projected = calls[0]['ProjectionExpression'].split(', ')
    assert sorted(calls[0]['ExpressionAttributeNames'][p] for p in projected) == sorted(PROBLEM_FIELDS)
    assert 'original_text' not in calls[0]['ExpressionAttributeNames'].values()


def _seed_mixed(table) -> None:
    _bulk(table, [
        _review('d1', _day(0), 1, category='delivery', subcategory='shipping', problem_summary='Slow delivery times',
                urgency='high', source_channel='social', problem_root_cause_hypothesis='Carrier backlog'),
        _review('d2', _day(1), 2, category='delivery', subcategory='shipping', problem_summary='Delivery too slow',
                source='app'),
        _review('d3', _day(1), 3, category='delivery', subcategory='packaging', problem_summary='Box arrived crushed'),
        _review('b1', _day(0), 4, category='billing', subcategory='refunds', problem_summary='Refund never arrived',
                urgency='high'),
        # Written 20 days ago, imported today: inside an import-basis week, outside a review-basis one.
        {**_review('old', _day(0), 5, category='billing', subcategory='refunds', problem_summary='Charged twice'),
         'source_created_at': f'{_day(20)}T00:00:00Z'},
    ])


def test_similar_problems_merge_at_the_requested_level(world, api_gateway_event, lambda_context):
    _seed_mixed(world)
    merged = _problems(api_gateway_event, lambda_context, category='delivery')
    shipping = merged['categories'][0]['subcategories'][0]
    assert (shipping['subcategory'], shipping['problem_count']) == ('shipping', 1)
    group = shipping['problems'][0]
    # The newest problem text opens the group, the other is folded in.
    assert (group['problem'], group['similar_problems'], group['count']) == (
        'Slow delivery times', ['Delivery too slow'], 2)
    assert (group['root_cause'], group['sample_ids']) == ('Carrier backlog', ['d1', 'd2'])
    assert group['sentiment_counts'] == {'negative': 2}
    apart = _problems(api_gateway_event, lambda_context, category='delivery', similarity='off')
    assert apart['categories'][0]['subcategories'][0]['problem_count'] == 2


def test_the_filters_narrow_the_tree(world, api_gateway_event, lambda_context):
    _seed_mixed(world)

    def get(**params: str) -> dict:
        return _tree(_problems(api_gateway_event, lambda_context, None, **params))

    assert get(urgent='1') == {('delivery', 'shipping'): [('Slow delivery times', 1, 1)],
                               ('billing', 'refunds'): [('Refund never arrived', 1, 1)]}
    assert get(source='app') == {('delivery', 'shipping'): [('Delivery too slow', 1, 0)]}
    assert get(channel='social') == {('delivery', 'shipping'): [('Slow delivery times', 1, 1)]}
    assert get(category='delivery', subcategory='packaging') == {
        ('delivery', 'packaging'): [('Box arrived crushed', 1, 0)]}
    assert ('Charged twice', 1, 0) in get()[('billing', 'refunds')]
    assert get(date_basis='review')[('billing', 'refunds')] == [('Refund never arrived', 1, 1)]


def test_the_subcategory_list_ignores_the_chosen_subcategory(world, api_gateway_event, lambda_context):
    _seed_mixed(world)
    body = _problems(api_gateway_event, lambda_context, category='delivery', subcategory='packaging')
    assert body['subcategories'] == ['packaging', 'shipping']


def test_a_restricted_viewer_sees_only_their_categories(world, api_gateway_event, lambda_context):
    _seed_mixed(world)
    body = _problems(api_gateway_event, lambda_context, claims=RESTRICTED_CLAIMS)
    assert {c['category'] for c in body['categories']} == {'delivery'}
    assert body['feedback_count'] == 3


@pytest.mark.usefixtures('world')
def test_an_unknown_similarity_is_a_400(api_gateway_event, lambda_context):
    response, _ = call_route(lambda_handler, api_gateway_event, lambda_context, method='GET',
                             path='/feedback/problems', query_params={'days': '7', 'similarity': 'max'})
    assert response['statusCode'] == 400


def test_an_exhausted_budget_is_reported_partial(world, api_gateway_event, lambda_context, monkeypatch):
    _seed_mixed(world)
    import metrics_handler
    from shared.time_budget import WalkBudget

    class Exhausted(WalkBudget):
        def __init__(self) -> None:
            super().__init__(seconds=0)

    monkeypatch.setattr(metrics_handler, 'WalkBudget', Exhausted)
    body = _problems(api_gateway_event, lambda_context)
    assert (body['is_partial'], body['partial_reason'], body['scanned_through']) == (True, 'time_budget', _day(0))
    # Only today was read: yesterday's two delivery reviews are missing, and the answer says so.
    assert body['feedback_count'] == 3
