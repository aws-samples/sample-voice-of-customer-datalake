"""Pausing a feedback board (temporary, reads stay open) vs archiving it (the step before delete),
and requests that never change board (docs/feature-requests.md -> Pause and archive)."""
from __future__ import annotations

import pytest
from engagement_fixtures import ADMIN, BOARD_2, USER, boards_world, call, ok

from shared.participants_settings import BOARD_AUDIENCE_KEY

BOARDS = '/feature-requests/boards'
FIELDS = {'area': 'Seats', 'outcome': 'broken'}


@pytest.fixture
def world():
    with boards_world() as w:
        yield w


def _board(ctx) -> dict:
    return ok(ctx, 'POST', BOARDS, 201, body={'name': 'Beta feedback', 'template': 'beta'})['board']


def _request(ctx, board: dict, claims=USER) -> dict:
    return ok(ctx, 'POST', '/feature-requests', 201, claims=claims,
              body={'board': board['slug'], 'title': 'Slow', 'fields': FIELDS})


def _set(ctx, board: dict, **flags) -> dict:
    return ok(ctx, 'PUT', f'{BOARDS}/{board["board_id"]}', body=flags)['board']


def _paused_world(ctx) -> tuple[dict, str, str]:
    """A board with one request (by USER) and BOARD_2's +1 on it, then paused."""
    board = _board(ctx)
    created = _request(ctx, board)
    request_id = created['request']['request_id']
    support = ok(ctx, 'POST', f'/feature-requests/{request_id}/supports', 201, claims=BOARD_2, body={'fields': {}})
    _set(ctx, board, paused=True)
    return board, request_id, support['support']['support_id']


def _writes(board: dict, request_id: str, support_id: str) -> list[tuple[str, str, dict, dict]]:
    """Every write a board member makes on a board's requests: (method, path, claims, body)."""
    rid = request_id
    return [
        ('POST', '/feature-requests', USER, {'board': board['slug'], 'title': 'New', 'fields': FIELDS}),
        ('PUT', f'/feature-requests/{rid}', USER, {'title': 'Edited'}),
        ('POST', f'/feature-requests/{rid}/supports', ADMIN, {'fields': {}}),
        ('PUT', f'/feature-requests/{rid}/supports/{support_id}', BOARD_2, {'fields': {'note': 'More'}}),
        ('DELETE', f'/feature-requests/{rid}/supports/{support_id}', BOARD_2, {}),
    ]


@pytest.mark.usefixtures('world')
def test_a_new_board_is_not_paused_and_pausing_stamps_who_and_when(lambda_context):
    board = _board(lambda_context)
    assert board['paused'] is False
    assert 'paused_at' not in board
    paused = _set(lambda_context, board, paused=True)
    assert (paused['paused'], paused['paused_by']) == (True, ADMIN['sub'])
    assert paused['paused_at']
    again = _set(lambda_context, board, paused=True)
    assert again['paused_at'] == paused['paused_at']  # pausing a paused board keeps the first stamp
    member_view = ok(lambda_context, 'GET', f'{BOARDS}/{board["slug"]}', claims=USER)['board']
    assert member_view['paused'] is True
    assert member_view['paused_at'] == paused['paused_at']
    assert 'paused_by' not in member_view  # a Cognito sub, for admins only
    resumed = _set(lambda_context, board, paused=False)
    assert resumed['paused'] is False
    assert 'paused_at' not in resumed
    assert 'paused_by' not in resumed


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('raw', ['yes', 1, None])
def test_paused_must_be_a_boolean(lambda_context, raw):
    board = _board(lambda_context)
    assert call(lambda_context, 'PUT', f'{BOARDS}/{board["board_id"]}', body={'paused': raw})[0] == 400


@pytest.mark.usefixtures('world')
def test_only_an_admin_pauses_a_board(lambda_context):
    board = _board(lambda_context)
    assert call(lambda_context, 'PUT', f'{BOARDS}/{board["board_id"]}', claims=USER, body={'paused': True})[0] == 403


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('index', range(5))
def test_a_paused_board_refuses_every_write_with_board_paused(lambda_context, index):
    board, request_id, support_id = _paused_world(lambda_context)
    method, path, claims, body = _writes(board, request_id, support_id)[index]
    status, answer = call(lambda_context, method, path, claims=claims, body=body)
    assert (status, answer['error']) == (409, 'board_paused')


@pytest.mark.usefixtures('world')
def test_an_admin_cannot_post_or_edit_on_a_paused_board_either(lambda_context):
    board, request_id, _ = _paused_world(lambda_context)
    for method, path, body in [
        ('POST', '/feature-requests', {'board': board['slug'], 'title': 'New', 'fields': FIELDS}),
        ('PUT', f'/feature-requests/{request_id}', {'title': 'Edited'}),
    ]:
        status, answer = call(lambda_context, method, path, claims=ADMIN, body=body)
        assert (status, answer['error']) == (409, 'board_paused')


@pytest.mark.usefixtures('world')
def test_a_paused_board_still_serves_its_reads(lambda_context, world):
    board, request_id, _ = _paused_world(lambda_context)
    assert board['slug'] in [entry['slug'] for entry in ok(lambda_context, 'GET', BOARDS, claims=BOARD_2)['boards']]
    listing = ok(lambda_context, 'GET', '/feature-requests', claims=BOARD_2, query={'board': board['slug']})
    assert [row['request_id'] for row in listing['requests']] == [request_id]
    assert listing['board']['paused'] is True
    detail = ok(lambda_context, 'GET', f'/feature-requests/{request_id}', claims=BOARD_2)
    assert len(detail['supports']) == 2
    # Still in the sign-up audience, so its people can sign in and read.
    assert world.participants.get_item(Key=BOARD_AUDIENCE_KEY)['Item']['company'] is True


@pytest.mark.usefixtures('world')
def test_admins_still_triage_a_paused_board(lambda_context):
    _, request_id, support_id = _paused_world(lambda_context)
    moved = ok(lambda_context, 'PUT', f'/feature-requests/{request_id}/status', body={'status': 'seen'})
    assert moved['request']['status'] == 'seen'
    left = ok(lambda_context, 'DELETE', f'/feature-requests/{request_id}/supports/{support_id}')
    assert left['request']['totals']['supporters'] == 1
    assert ok(lambda_context, 'DELETE', f'/feature-requests/{request_id}') == {'success': True}


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('index', range(5))
def test_resuming_a_board_restores_every_write(lambda_context, index):
    board, request_id, support_id = _paused_world(lambda_context)
    _set(lambda_context, board, paused=False)
    method, path, claims, body = _writes(board, request_id, support_id)[index]
    status, answer = call(lambda_context, method, path, claims=claims, body=body)
    assert status in (200, 201), answer


@pytest.mark.usefixtures('world')
def test_an_archived_board_is_hidden_from_non_admins_but_kept_for_admins(lambda_context, world):
    board = _board(lambda_context)
    _set(lambda_context, board, audience={'mode': 'list', 'domains': ['partner.example']})
    request_id = _request(lambda_context, board)['request']['request_id']
    audience = world.participants.get_item(Key=BOARD_AUDIENCE_KEY)['Item']
    assert 'partner.example' in audience['domains']
    _set(lambda_context, board, archived=True)
    for claims in (USER, BOARD_2):
        assert board['slug'] not in [entry['slug'] for entry in ok(lambda_context, 'GET', BOARDS, claims=claims)['boards']]
        assert call(lambda_context, 'GET', f'{BOARDS}/{board["slug"]}', claims=claims)[0] == 404
        assert call(lambda_context, 'GET', f'/feature-requests/{request_id}', claims=claims)[0] == 404
    assert ok(lambda_context, 'GET', f'/feature-requests/{request_id}')['request']['request_id'] == request_id
    assert 'partner.example' not in world.participants.get_item(Key=BOARD_AUDIENCE_KEY)['Item']['domains']
    restored = _set(lambda_context, board, archived=False)
    assert restored['archived'] is False
    assert ok(lambda_context, 'GET', f'{BOARDS}/{board["slug"]}', claims=USER)['board']['board_id'] == board['board_id']


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('key', ['board', 'board_id'])
def test_a_request_cannot_be_moved_to_another_board(lambda_context, key):
    source = _board(lambda_context)
    target = ok(lambda_context, 'POST', BOARDS, 201, body={'name': 'Other', 'template': 'beta'})['board']
    request_id = _request(lambda_context, source)['request']['request_id']
    status, answer = call(lambda_context, 'PUT', f'/feature-requests/{request_id}',
                          body={'title': 'Moved', key: target['board_id']})
    assert (status, answer['error']) == (400, 'A request cannot be moved to another board')
    detail = ok(lambda_context, 'GET', f'/feature-requests/{request_id}')['request']
    assert (detail['board_id'], detail['title']) == (source['board_id'], 'Slow')
