"""Board insights (shared/feature_requests_insights_routes.py): scope, counts, window, backfill."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from engagement_fixtures import ADMIN, BOARD, BOARD_2, USER, boards_world, call, ok

from shared import feature_requests_enrich as enrich
from shared.feature_requests_enrich import MAX_IDS_PER_JOB, text_sha16
from shared.feature_requests_insights_routes import MAX_BACKFILL
from shared.feature_requests_store import request_key

INSIGHTS = '/feature-requests/insights'
SALES_FIELDS = {'customer': 'Example Air', 'impact': 'at_risk', 'amount_usd': 1000}


@pytest.fixture
def world():
    with boards_world() as w:
        yield w


def _file(ctx, claims=USER, **body):
    return ok(ctx, 'POST', '/feature-requests', 201, claims=claims,
              body={'title': 'Split invoices', 'description': 'By cost centre', **SALES_FIELDS, **body})['request']


def _enrich(world, request, category='billing', sentiment='negative'):
    enrichment = {'status': 'ok', 'category': category, 'subcategory': None, 'sentiment': sentiment,
                  'problem_summary': 'A problem.', 'language': 'en', 'model_id': 'global.example-model',
                  'prompt_version': '1.0.0', 'text_sha16': text_sha16(request), 'enriched_at': '2026-11-01T00:00:00Z'}
    world.requests.update_item(Key=request_key(request['request_id']), UpdateExpression='SET enrichment = :e',
                               ExpressionAttributeValues={':e': enrichment})


def _set(world, request_id, **values):
    names = {f'#{key}': key for key in values}
    world.requests.update_item(Key=request_key(request_id), UpdateExpression='SET ' + ', '.join(
        f'#{key} = :{key}' for key in values), ExpressionAttributeNames=names,
        ExpressionAttributeValues={f':{key}': value for key, value in values.items()})


def _partner_board(ctx):
    board = ok(ctx, 'POST', '/feature-requests/boards', 201, body={
        'name': 'Partner beta', 'template': 'beta', 'audience': {'mode': 'list', 'domains': ['partner.example']}})
    return board['board']


def test_the_counts_follow_the_contract(world, lambda_context):
    first = _file(lambda_context)
    second = _file(lambda_context, title='Dark mode', description='At night')
    ok(lambda_context, 'POST', f"/feature-requests/{second['request_id']}/supports", 201, claims=BOARD_2,
       body={**SALES_FIELDS, 'name': 'Kim'})
    _enrich(world, first)
    body = ok(lambda_context, 'GET', INSIGHTS, claims=USER, query={'board': 'sales-feature-requests'})
    assert body['success'] is True
    assert body['board'] == {'id': 'brd_sales', 'label': 'Sales feature requests'}
    assert body['window_days'] == 0
    assert body['totals'] == {'requests': 2, 'supporters': 3, 'enriched': 1}
    assert [row['request_id'] for row in body['top']] == [second['request_id'], first['request_id']]
    assert body['top'][0] == {'request_id': second['request_id'], 'board_id': 'brd_sales', 'title': 'Dark mode',
                              'status': second['status'], 'supporters': 2, 'category': None}
    assert body['by_category'] == [{'category': 'uncategorized', 'requests': 1, 'supporters': 2},
                                   {'category': 'billing', 'requests': 1, 'supporters': 1}]
    assert body['by_status'] == [{'status': first['status'], 'requests': 2, 'supporters': 3}]
    assert body['by_sentiment'] == [{'sentiment': 'negative', 'requests': 1}, {'sentiment': 'unknown', 'requests': 1}]
    # No email or name of any person.
    assert 'example.com' not in str(body)
    assert 'Kim' not in str(body)


def test_a_failed_enrichment_counts_as_not_enriched(world, lambda_context):
    request = _file(lambda_context)
    _set(world, request['request_id'], enrichment={'status': 'failed', 'category': 'billing'})
    body = ok(lambda_context, 'GET', INSIGHTS, claims=USER)
    assert body['totals']['enriched'] == 0
    assert body['by_category'][0]['category'] == 'uncategorized'


@pytest.mark.usefixtures('world')
def test_without_a_board_every_visible_board_counts(lambda_context):
    _file(lambda_context)
    partner = _partner_board(lambda_context)
    ok(lambda_context, 'POST', '/feature-requests', 201, claims=ADMIN,
       body={'board': partner['slug'], 'title': 'Faster sync', 'fields': {'area': 'Sync', 'outcome': 'broken'}})
    assert ok(lambda_context, 'GET', INSIGHTS, claims=ADMIN)['totals']['requests'] == 2
    as_board_user = ok(lambda_context, 'GET', INSIGHTS, claims=BOARD)
    assert (as_board_user['board'], as_board_user['totals']['requests']) == (None, 1)
    # A board the caller may not use is invisible, as on every board route.
    assert call(lambda_context, 'GET', INSIGHTS, claims=BOARD, query={'board': partner['slug']})[0] == 404


def test_days_filters_on_created_at(world, lambda_context):
    old = _file(lambda_context)
    _file(lambda_context, title='New one')
    _set(world, old['request_id'], created_at='2020-01-01T00:00:00+00:00')
    assert ok(lambda_context, 'GET', INSIGHTS, query={'days': '7'})['totals']['requests'] == 1
    assert ok(lambda_context, 'GET', INSIGHTS, query={'days': '0'})['totals']['requests'] == 2


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('days', ['-1', '3651', 'seven', '1.5'])
def test_an_invalid_window_is_refused(lambda_context, days):
    assert call(lambda_context, 'GET', INSIGHTS, query={'days': days})[0] == 400


def test_the_backfill_is_admin_only_and_bounded(world, lambda_context):
    requests = [_file(lambda_context, title=f'Request {n}') for n in range(3)]
    _enrich(world, requests[0])
    world.enrich_invoke.reset_mock()
    for claims in (USER, BOARD):
        assert call(lambda_context, 'POST', f'{INSIGHTS}/enrich', claims=claims)[0] == 403
    with patch('shared.feature_requests_insights_routes.MAX_BACKFILL', 1):
        body = ok(lambda_context, 'POST', f'{INSIGHTS}/enrich')
    assert body == {'success': True, 'queued': 1, 'remaining': 1}
    payload = world.enrich_invoke.call_args.args[1]
    assert payload['engagement_job'] == 'enrich_feature_request'
    assert payload['request_ids'][0] in {requests[1]['request_id'], requests[2]['request_id']}


def test_the_backfill_fans_out_one_job_per_batch_from_the_route(world, lambda_context):
    """The route invokes every job itself (ceil(n / MAX_IDS_PER_JOB), ≤ 20 for 200): no job chain is needed."""
    ids = {_file(lambda_context, title=f'Request {n}')['request_id'] for n in range(2 * MAX_IDS_PER_JOB + 1)}
    world.enrich_invoke.reset_mock()
    assert ok(lambda_context, 'POST', f'{INSIGHTS}/enrich')['queued'] == len(ids)
    batches = [c.args[1]['request_ids'] for c in world.enrich_invoke.call_args_list]
    assert [len(batch) for batch in batches] == [MAX_IDS_PER_JOB, MAX_IDS_PER_JOB, 1]
    assert {rid for batch in batches for rid in batch} == ids
    assert MAX_BACKFILL // MAX_IDS_PER_JOB == 20


def test_the_backfill_requeues_a_stale_or_failed_enrichment(world, lambda_context):
    stale, failed = _file(lambda_context), _file(lambda_context, title='Other')
    _enrich(world, stale)
    _set(world, stale['request_id'], title='Renamed')
    _set(world, failed['request_id'], enrichment={'status': 'failed', 'text_sha16': text_sha16(failed)})
    assert ok(lambda_context, 'POST', f'{INSIGHTS}/enrich') == {'success': True, 'queued': 2, 'remaining': 0}


@pytest.mark.usefixtures('world')
def test_insights_is_never_read_as_a_request_id(lambda_context):
    _file(lambda_context)
    assert call(lambda_context, 'GET', INSIGHTS, claims=USER)[0] == 200


def test_a_second_backfill_before_the_jobs_ran_queues_nothing_again(world, lambda_context):
    """The lease (enrich_queued_at): a repeated click must not send the same requests to the model twice."""
    ids = {_file(lambda_context, title=f'Request {n}')['request_id'] for n in range(2)}
    world.enrich_invoke.reset_mock()
    assert ok(lambda_context, 'POST', f'{INSIGHTS}/enrich') == {'success': True, 'queued': 2, 'remaining': 0}
    assert ok(lambda_context, 'POST', f'{INSIGHTS}/enrich') == {'success': True, 'queued': 0, 'remaining': 2}
    assert {rid for c in world.enrich_invoke.call_args_list for rid in c.args[1]['request_ids']} == ids
    assert world.enrich_invoke.call_count == 1


def test_a_lapsed_lease_is_claimed_again(world, lambda_context):
    request = _file(lambda_context)
    world.enrich_invoke.reset_mock()
    _set(world, request['request_id'], enrich_queued_at='2000-01-01T00:00:00+00:00')
    assert ok(lambda_context, 'POST', f'{INSIGHTS}/enrich')['queued'] == 1


@pytest.mark.usefixtures('world')
def test_the_lease_is_bookkeeping_never_shown_on_the_request(lambda_context):
    request = _file(lambda_context)
    ok(lambda_context, 'POST', f'{INSIGHTS}/enrich')
    shown = ok(lambda_context, 'GET', f"/feature-requests/{request['request_id']}", claims=USER)['request']
    assert 'enrich_queued_at' not in shown


def test_a_job_that_could_not_be_queued_releases_its_lease(world, lambda_context):
    """A failed async invoke must not hold the request for the lease: the next call queues it."""
    request = _file(lambda_context)
    world.enrich_invoke.reset_mock()
    world.enrich_invoke.side_effect = RuntimeError('invoke failed')
    assert ok(lambda_context, 'POST', f'{INSIGHTS}/enrich') == {'success': True, 'queued': 0, 'remaining': 1}
    row = world.requests.get_item(Key=request_key(request['request_id']))['Item']
    assert 'enrich_queued_at' not in row
    world.enrich_invoke.side_effect = None
    assert ok(lambda_context, 'POST', f'{INSIGHTS}/enrich')['queued'] == 1


def test_a_failed_lease_release_keeps_the_answer(world, lambda_context):
    """release_claims is best-effort: a DynamoDB error on one release never turns a queued backfill into a 500."""
    _file(lambda_context)
    world.enrich_invoke.reset_mock()
    world.enrich_invoke.side_effect = RuntimeError('invoke failed')
    real_write = enrich.conditional_write

    def failing_release(write, **request):
        if str(request.get('UpdateExpression', '')).startswith('REMOVE'):
            raise ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}},
                              'UpdateItem')
        return real_write(write, **request)

    with patch('shared.feature_requests_enrich.conditional_write', side_effect=failing_release):
        assert ok(lambda_context, 'POST', f'{INSIGHTS}/enrich') == {'success': True, 'queued': 0, 'remaining': 1}
