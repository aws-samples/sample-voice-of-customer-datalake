"""Deleting a feedback board: the empty-only delete, ``?with_requests=true`` (archive first, a
resumable time-boxed loop), legacy requests of the seeded board, and seeding only once."""
from __future__ import annotations

from collections.abc import Iterator
from unittest.mock import patch

import pytest
from engagement_fixtures import BOARD_2, USER, boards_world, call, ok

from shared.feature_boards_store import SEEDED_BOARD_ID, SEEDED_MARKER_KEY
from shared.participants_settings import BOARD_AUDIENCE_KEY

BOARDS = '/feature-requests/boards'
WITH_REQUESTS = {'with_requests': 'true'}


@pytest.fixture
def world():
    with boards_world() as w:
        yield w


def _create(ctx, name='Beta feedback'):
    return ok(ctx, 'POST', BOARDS, 201, body={'name': name, 'template': 'beta'})['board']


def _post(ctx, board, title='Slow'):
    created = ok(ctx, 'POST', '/feature-requests', 201, claims=USER, body={
        'board': board['board_id'], 'title': title, 'fields': {'area': 'Seats', 'outcome': 'broken'}})
    request_id = created['request']['request_id']
    ok(ctx, 'POST', f'/feature-requests/{request_id}/supports', 201, claims=BOARD_2, body={'fields': {}})
    return request_id


def _legacy(world, n: int, *, board_id: str | None = None, stamp: str = '2020-01-01') -> list[str]:
    """``n`` requests written straight to the table (no ``board_id`` = the seeded board's), each with a +1."""
    ids = []
    for i in range(n):
        request_id = f'fr_{board_id or "legacy"}_{stamp}_{i:04d}'
        item = {'pk': f'FR#{request_id}', 'sk': 'META', 'request_id': request_id, 'title': 'Old', 'status': 'new',
                'gsi1pk': 'FRS', 'gsi1sk': f'{stamp}T00:00:{i:04d}#{request_id}'}
        if board_id is not None:
            item['board_id'] = board_id
        world.requests.put_item(Item=item)
        world.requests.put_item(Item={'pk': f'FR#{request_id}', 'sk': 'SUP#sup_1', 'support_id': 'sup_1',
                                      'request_id': request_id, 'email': 'pat@example.com'})
        ids.append(request_id)
    return ids


def _rows_of(world, request_ids) -> list[dict]:
    wanted = {f'FR#{request_id}' for request_id in request_ids}
    return [item for item in world.requests.scan()['Items'] if item['pk'] in wanted]


def _ticking_clock() -> Iterator[float]:
    tick = 0.0
    while True:
        yield tick
        tick += 1.0


# ── The plain delete ──────────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
def test_a_plain_delete_still_refuses_a_board_with_requests(lambda_context):
    board = _create(lambda_context)
    _post(lambda_context, board)
    for query in (None, {'with_requests': 'false'}, {'with_requests': '0'}):
        status, body = call(lambda_context, 'DELETE', f'{BOARDS}/{board["board_id"]}', query=query)
        assert (status, body['error']) == (409, 'board_not_empty')
    assert ok(lambda_context, 'GET', f'{BOARDS}/{board["board_id"]}')['board']['archived'] is False


@pytest.mark.usefixtures('world')
def test_a_plain_delete_of_an_empty_board_answers_done(lambda_context):
    board = _create(lambda_context)
    assert ok(lambda_context, 'DELETE', f'{BOARDS}/{board["slug"]}') == {
        'success': True, 'done': True, 'deleted': 0, 'remaining': 0}


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('value', ['yes', '', '2', 'truee'])
def test_an_invalid_with_requests_is_a_400(lambda_context, value):
    board = _create(lambda_context)
    status, _ = call(lambda_context, 'DELETE', f'{BOARDS}/{board["board_id"]}', query={'with_requests': value})
    assert status == 400
    assert ok(lambda_context, 'GET', f'{BOARDS}/{board["board_id"]}')['board']['board_id'] == board['board_id']


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('claims', [USER, BOARD_2])
def test_non_admins_cannot_delete_a_board_with_its_requests(lambda_context, claims):
    board = _create(lambda_context)
    _post(lambda_context, board)
    status, _ = call(lambda_context, 'DELETE', f'{BOARDS}/{board["board_id"]}', claims=claims, query=WITH_REQUESTS)
    assert status == 403


# ── With requests ─────────────────────────────────────────────────────────────

def test_with_requests_deletes_every_request_and_support_then_the_board(world, lambda_context):
    board = _create(lambda_context)
    other = _create(lambda_context, name='Other')
    request_ids = [_post(lambda_context, board, f'Request {i}') for i in range(3)]
    kept = _post(lambda_context, other)
    assert len(_rows_of(world, request_ids)) == 9  # per request: META, the reporter's +1, one more +1
    body = ok(lambda_context, 'DELETE', f'{BOARDS}/{board["board_id"]}', query={'with_requests': 'TRUE'})
    assert body == {'success': True, 'done': True, 'deleted': 3, 'remaining': 0}
    assert _rows_of(world, request_ids) == []
    assert call(lambda_context, 'GET', f'{BOARDS}/{board["board_id"]}')[0] == 404
    assert 'Item' not in world.requests.get_item(Key={'pk': f'SLUG#{board["slug"]}', 'sk': 'BOARD'})
    # Another board's request is untouched.
    assert ok(lambda_context, 'GET', f'/feature-requests/{kept}')['request']['request_id'] == kept


@pytest.mark.usefixtures('world')
def test_an_exhausted_budget_keeps_the_board_archived_and_a_second_call_finishes(lambda_context):
    board = _create(lambda_context)
    for i in range(5):
        _post(lambda_context, board, f'Request {i}')
    path = f'{BOARDS}/{board["board_id"]}'
    clock = _ticking_clock()
    with patch('shared.feature_boards_delete.DELETE_BUDGET_SECONDS', 2.5), \
            patch('shared.feature_boards_delete.monotonic', lambda: next(clock)):
        first = ok(lambda_context, 'DELETE', path, query=WITH_REQUESTS)
    assert first == {'success': True, 'done': False, 'deleted': 3, 'remaining': 2}
    kept = ok(lambda_context, 'GET', path)['board']
    assert (kept['archived'], kept['request_count']) == (True, 2)
    assert call(lambda_context, 'GET', path, claims=USER)[0] == 404  # archived: admins only
    assert call(lambda_context, 'POST', '/feature-requests', claims=USER, body={
        'board': board['board_id'], 'title': 'X', 'fields': {'area': 'A', 'outcome': 'works'}})[0] == 404
    assert ok(lambda_context, 'DELETE', path, query=WITH_REQUESTS) == {
        'success': True, 'done': True, 'deleted': 2, 'remaining': 0}
    assert call(lambda_context, 'GET', path)[0] == 404


def test_a_board_whose_requests_are_older_than_the_listing_cap_is_not_empty(world, lambda_context):
    board = _create(lambda_context)
    other = _create(lambda_context, name='Busy')
    old = _legacy(world, 3, board_id=board['board_id'], stamp='2020-01-01')
    _legacy(world, 6, board_id=other['board_id'], stamp='2026-01-01')  # newer than every one of ``old``
    path = f'{BOARDS}/{board["board_id"]}'
    with patch('shared.feature_requests_store.MAX_REQUESTS_LISTED', 4):
        status, body = call(lambda_context, 'DELETE', path)
        assert (status, body['error']) == (409, 'board_not_empty')
        assert ok(lambda_context, 'DELETE', path, query=WITH_REQUESTS) == {
            'success': True, 'done': True, 'deleted': 3, 'remaining': 0}
    assert _rows_of(world, old) == []


def test_legacy_requests_without_a_board_are_deleted_with_the_seeded_board(world, lambda_context):
    ok(lambda_context, 'GET', BOARDS)  # seeds brd_sales
    other = _create(lambda_context)
    legacy = _legacy(world, 2)
    tagged = _legacy(world, 1, board_id=SEEDED_BOARD_ID, stamp='2021-01-01')
    kept = _legacy(world, 1, board_id=other['board_id'], stamp='2022-01-01')
    body = ok(lambda_context, 'DELETE', f'{BOARDS}/{SEEDED_BOARD_ID}', query=WITH_REQUESTS)
    assert body == {'success': True, 'done': True, 'deleted': 3, 'remaining': 0}
    assert _rows_of(world, legacy + tagged) == []
    assert len(_rows_of(world, kept)) == 2


# ── Seeding once ──────────────────────────────────────────────────────────────

def test_deleting_the_last_board_does_not_seed_it_again(world, lambda_context):
    (seeded,) = ok(lambda_context, 'GET', BOARDS)['boards']
    assert 'Item' in world.requests.get_item(Key=SEEDED_MARKER_KEY)
    ok(lambda_context, 'DELETE', f'{BOARDS}/{seeded["board_id"]}')
    assert ok(lambda_context, 'GET', BOARDS)['boards'] == []
    assert ok(lambda_context, 'GET', BOARDS, claims=USER)['boards'] == []
    assert not [item for item in world.requests.scan()['Items'] if item['pk'].startswith('BOARD#')]


def test_a_deployment_seeded_before_the_marker_does_not_seed_again(world, lambda_context):
    (seeded,) = ok(lambda_context, 'GET', BOARDS)['boards']
    world.requests.delete_item(Key=SEEDED_MARKER_KEY)  # as seeded by a release before the marker
    ok(lambda_context, 'DELETE', f'{BOARDS}/{seeded["board_id"]}')
    assert 'Item' in world.requests.get_item(Key=SEEDED_MARKER_KEY)
    assert ok(lambda_context, 'GET', BOARDS)['boards'] == []


def test_the_marker_is_never_listed_as_a_board(world, lambda_context):
    ok(lambda_context, 'GET', BOARDS)
    marker = world.requests.get_item(Key=SEEDED_MARKER_KEY)['Item']
    assert 'gsi1pk' not in marker
    assert len(ok(lambda_context, 'GET', BOARDS)['boards']) == 1


def test_with_zero_boards_every_route_answers_without_a_server_error(world, lambda_context):
    (seeded,) = ok(lambda_context, 'GET', BOARDS)['boards']
    ok(lambda_context, 'DELETE', f'{BOARDS}/{seeded["board_id"]}')
    assert call(lambda_context, 'GET', '/feature-requests', claims=USER)[0] == 404
    assert call(lambda_context, 'GET', f'{BOARDS}/{seeded["slug"]}')[0] == 404
    assert call(lambda_context, 'POST', '/feature-requests', claims=USER, body={'title': 'X'})[0] == 404
    row = world.participants.get_item(Key=BOARD_AUDIENCE_KEY)['Item']
    assert (row['company'], row['anyone'], row['domains'], row['emails']) == (False, False, [], [])
    created = _create(lambda_context, name='Fresh start')
    assert [board['board_id'] for board in ok(lambda_context, 'GET', BOARDS)['boards']] == [created['board_id']]
