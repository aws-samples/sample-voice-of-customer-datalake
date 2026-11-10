"""Feedback boards API: seed, CRUD, slugs, access per audience and pool, the derived sign-up row."""
from __future__ import annotations

import pytest
from engagement_fixtures import ADMIN, BOARD, BOARD_2, BOARD_POOL, ISSUER, USER, call, engagement_world, ok

from shared.feature_boards_store import SEEDED_BOARD_ID, SEEDED_SLUG
from shared.participants_settings import BOARD_AUDIENCE_KEY, SETTINGS_KEY

OUTSIDER = {'sub': 'out-sub', 'email': 'eve@outsider.example', 'email_verified': 'true', 'iss': ISSUER + BOARD_POOL}
PARTNER = {'sub': 'p-sub', 'email': 'pia@partner.example', 'email_verified': 'true', 'iss': ISSUER + BOARD_POOL}
BOARDS = '/feature-requests/boards'


@pytest.fixture
def world():
    with engagement_world() as w:
        w.participants.put_item(Item={**SETTINGS_KEY, 'company_domains': ['acme.example']})
        yield w


def _create(ctx, **body):
    return ok(ctx, 'POST', BOARDS, 201, body={'name': 'Beta feedback', 'template': 'beta', **body})['board']


def _audience_row(world):
    return world.participants.get_item(Key=BOARD_AUDIENCE_KEY).get('Item')


def _slugs(ctx, claims):
    return sorted(board['slug'] for board in ok(ctx, 'GET', BOARDS, claims=claims)['boards'])


# ── Seed ──────────────────────────────────────────────────────────────────────

def test_the_first_listing_seeds_the_sales_board_once(world, lambda_context):
    world.requests.put_item(Item={'pk': 'FR#fr_0000000000000001', 'sk': 'META', 'request_id': 'fr_0000000000000001',
                                  'title': 'Old', 'status': 'planned', 'gsi1pk': 'FRS', 'gsi1sk': '2026#1'})
    (board,) = ok(lambda_context, 'GET', BOARDS, claims=USER)['boards']
    assert (board['board_id'], board['slug'], board['template']) == (SEEDED_BOARD_ID, SEEDED_SLUG, 'sales')
    assert board['audience'] == {'mode': 'company'}
    assert board['request_count'] == 1
    assert board['share_url'] == f'https://voc.example.com/board/{SEEDED_SLUG}'
    assert [s['key'] for s in board['statuses']] == ['new', 'under_review', 'planned', 'shipped', 'declined']
    assert ok(lambda_context, 'GET', BOARDS, claims=USER)['boards'] == [board]
    assert len([i for i in world.requests.scan()['Items'] if i['pk'].startswith('BOARD#')]) == 1
    assert _audience_row(world)['company'] is True
    # The old request reads as the seeded board's.
    (old,) = ok(lambda_context, 'GET', '/feature-requests', claims=BOARD)['requests']
    assert old['board_id'] == SEEDED_BOARD_ID


@pytest.mark.usefixtures('world')
def test_the_old_client_without_board_works_on_the_seeded_board(lambda_context):
    body = ok(lambda_context, 'GET', '/feature-requests', claims=BOARD)
    assert body['board']['board_id'] == SEEDED_BOARD_ID
    assert body['requests'] == []


# ── CRUD and slugs ────────────────────────────────────────────────────────────

def test_admins_create_update_and_delete_boards(world, lambda_context):
    board = _create(lambda_context, description='Early builds')
    assert board['slug'] == 'beta-feedback'
    assert board['statuses'][0]['key'] == 'new'
    assert board['fields']['request']['area'] == {'enabled': True, 'required': True}
    assert board['audience'] == {'mode': 'company', 'domains': [], 'emails': []}
    path = f'{BOARDS}/{board["board_id"]}'
    updated = ok(lambda_context, 'PUT', path, body={'name': 'Beta two', 'slug': 'beta-two'})['board']
    assert (updated['name'], updated['slug']) == ('Beta two', 'beta-two')
    assert ok(lambda_context, 'GET', f'{BOARDS}/beta-two', claims=USER)['board']['board_id'] == board['board_id']
    assert call(lambda_context, 'GET', f'{BOARDS}/beta-feedback', claims=USER)[0] == 404
    # The old slug is free again.
    assert _create(lambda_context)['slug'] == 'beta-feedback'
    assert ok(lambda_context, 'DELETE', path) == {'success': True, 'done': True, 'deleted': 0, 'remaining': 0}
    assert call(lambda_context, 'GET', path)[0] == 404
    assert 'Item' not in world.requests.get_item(Key={'pk': 'SLUG#beta-two', 'sk': 'BOARD'})


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('claims', [USER, BOARD])
def test_only_admins_configure_boards(lambda_context, claims):
    board = _create(lambda_context)
    path = f'{BOARDS}/{board["board_id"]}'
    assert call(lambda_context, 'POST', BOARDS, claims=claims, body={'name': 'X', 'template': 'blank'})[0] == 403
    assert call(lambda_context, 'PUT', path, claims=claims, body={'name': 'X'})[0] == 403
    assert call(lambda_context, 'DELETE', path, claims=claims)[0] == 403


@pytest.mark.usefixtures('world')
def test_slug_conflicts(lambda_context):
    _create(lambda_context, slug='beta')
    status, body = call(lambda_context, 'POST', BOARDS, body={'name': 'Other', 'template': 'blank', 'slug': 'beta'})
    assert (status, body['error']) == (409, 'slug_taken')
    other = _create(lambda_context, name='Other')
    status, body = call(lambda_context, 'PUT', f'{BOARDS}/{other["board_id"]}', body={'slug': 'beta'})
    assert (status, body['error']) == (409, 'slug_taken')
    # A slug from the name that is taken gets the id's suffix instead of a conflict.
    again = _create(lambda_context, name='Beta')
    assert again['slug'] == f'beta-{again["board_id"].removeprefix("brd_")}'


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('body', [
    {'name': '', 'template': 'beta'}, {'name': 'x' * 81, 'template': 'beta'}, {'name': 'A', 'template': 'x'},
    {'name': 'A', 'template': 'beta', 'slug': 'Bad Slug'}, {'name': 'A', 'template': 'beta', 'slug': 'login'},
    {'name': 'A', 'template': 'beta', 'slug': 'a--b'}, {'name': 'A', 'template': 'beta', 'slug': 'a' * 61},
    {'name': 'A', 'template': 'beta', 'description': 'x' * 1001}, {'name': 'A', 'template': 'beta', 'extra': 1},
    {'name': 'A', 'template': 'beta', 'audience': {'mode': 'everyone'}},
    {'name': 'A', 'template': 'beta', 'audience': {'mode': 'list', 'domains': ['not a domain']}},
    {'name': 'A', 'template': 'beta', 'audience': {'mode': 'list', 'emails': ['nope']}},
    {'name': 'A', 'template': 'beta', 'audience': {'mode': 'list', 'domains': [f'd{i}.example' for i in range(51)]}},
])
def test_invalid_boards_are_refused(lambda_context, body):
    assert call(lambda_context, 'POST', BOARDS, body=body)[0] == 400


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('body', [
    {}, {'template': 'sales'}, {'archived': 'yes'}, {'statuses': []},
    {'statuses': [{'key': f's_{letter}', 'label': 'S'} for letter in 'abcdefghi']},
    {'statuses': [{'key': 'Bad', 'label': 'Bad'}]}, {'statuses': [{'key': 'new', 'label': ''}]},
    {'statuses': [{'key': 'new', 'label': 'A'}, {'key': 'new', 'label': 'B'}]},
    {'fields': {'request': {'nope': {'enabled': True}}}}, {'fields': {'request': {'area': {'enabled': False,
                                                                                         'required': True}}}},
    {'fields': {'other': {}}}, {'fields': {'support': {'rating': {'enabled': True}}}},
])
def test_invalid_board_updates_are_refused(lambda_context, body):
    board = _create(lambda_context)
    assert call(lambda_context, 'PUT', f'{BOARDS}/{board["board_id"]}', body=body)[0] == 400


@pytest.mark.usefixtures('world')
def test_a_board_with_requests_is_archived_not_deleted(lambda_context):
    board = _create(lambda_context)
    ok(lambda_context, 'POST', '/feature-requests', 201, claims=USER, body={
        'board': board['slug'], 'title': 'Slow', 'fields': {'area': 'Seats', 'outcome': 'broken'}})
    status, body = call(lambda_context, 'DELETE', f'{BOARDS}/{board["board_id"]}')
    assert (status, body['error']) == (409, 'board_not_empty')
    archived = ok(lambda_context, 'PUT', f'{BOARDS}/{board["board_id"]}', body={'archived': True})['board']
    assert archived['archived'] is True
    assert archived['request_count'] == 1
    assert board['slug'] not in _slugs(lambda_context, USER)
    assert board['slug'] in _slugs(lambda_context, ADMIN)
    assert call(lambda_context, 'GET', f'{BOARDS}/{board["slug"]}', claims=USER)[0] == 404
    status, body = call(lambda_context, 'POST', '/feature-requests', body={
        'board': board['slug'], 'title': 'X', 'fields': {'area': 'A', 'outcome': 'works'}})
    assert (status, body['error']) == (409, 'board_archived')


@pytest.mark.usefixtures('world')
def test_a_status_in_use_cannot_be_removed(lambda_context):
    board = _create(lambda_context)
    created = ok(lambda_context, 'POST', '/feature-requests', 201, claims=USER, body={
        'board': board['board_id'], 'title': 'Slow', 'fields': {'area': 'Seats', 'outcome': 'broken'}})
    request_id = created['request']['request_id']
    ok(lambda_context, 'PUT', f'/feature-requests/{request_id}/status', body={'status': 'seen'})
    path = f'{BOARDS}/{board["board_id"]}'
    status, body = call(lambda_context, 'PUT', path, body={'statuses': [{'key': 'new', 'label': 'New'}]})
    assert (status, body['error']) == (409, 'status_in_use')
    renamed = [{'key': 'new', 'label': 'Open'}, {'key': 'seen', 'label': 'Read'}]
    assert ok(lambda_context, 'PUT', path, body={'statuses': renamed})['board']['statuses'] == renamed


# ── Access ────────────────────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
def test_board_pool_callers_see_only_the_boards_their_email_matches(lambda_context):
    listed = _create(lambda_context, name='Partners', audience={'mode': 'list', 'domains': ['partner.example'],
                                                                'emails': ['kim@acme.example']})
    anyone = _create(lambda_context, name='Public beta', audience={'mode': 'anyone'})
    ok(lambda_context, 'GET', BOARDS)  # the seeded company board exists (created before the first POST)
    assert _slugs(lambda_context, BOARD) == sorted([SEEDED_SLUG, anyone['slug']])
    assert _slugs(lambda_context, BOARD_2) == sorted([SEEDED_SLUG, anyone['slug'], listed['slug']])
    assert _slugs(lambda_context, PARTNER) == sorted([anyone['slug'], listed['slug']])
    assert _slugs(lambda_context, OUTSIDER) == [anyone['slug']]
    assert len(_slugs(lambda_context, USER)) == 3
    for claims, ref in ((OUTSIDER, listed['slug']), (OUTSIDER, SEEDED_SLUG), (BOARD, listed['board_id'])):
        assert call(lambda_context, 'GET', f'{BOARDS}/{ref}', claims=claims)[0] == 404
        assert call(lambda_context, 'GET', '/feature-requests', claims=claims, query={'board': ref})[0] == 404


@pytest.mark.usefixtures('world')
def test_non_admins_get_the_audience_mode_only(lambda_context):
    board = _create(lambda_context, audience={'mode': 'list', 'emails': ['kim@acme.example']})
    seen = ok(lambda_context, 'GET', f'{BOARDS}/{board["slug"]}', claims=BOARD_2)['board']
    assert seen['audience'] == {'mode': 'list'}
    assert 'created_by' not in seen
    assert ok(lambda_context, 'GET', f'{BOARDS}/{board["slug"]}')['board']['audience']['emails'] == ['kim@acme.example']


@pytest.mark.usefixtures('world')
def test_requests_on_an_invisible_board_are_404_on_every_route(lambda_context):
    board = _create(lambda_context, audience={'mode': 'list', 'domains': ['partner.example']})
    created = ok(lambda_context, 'POST', '/feature-requests', 201, claims=PARTNER, body={
        'board': board['slug'], 'title': 'Slow', 'fields': {'area': 'Seats', 'outcome': 'broken'}})
    request_id = created['request']['request_id']
    support_id = created['supports'][0]['support_id']
    base = f'/feature-requests/{request_id}'
    for method, path, body in (('GET', base, None), ('PUT', base, {'title': 'X'}),
                               ('POST', f'{base}/supports', {'fields': {}}),
                               ('PUT', f'{base}/supports/{support_id}', {'fields': {}}),
                               ('DELETE', f'{base}/supports/{support_id}', None)):
        assert call(lambda_context, method, path, claims=BOARD, body=body)[0] == 404, (method, path)
    assert call(lambda_context, 'POST', '/feature-requests', claims=BOARD, body={
        'board': board['slug'], 'title': 'X', 'fields': {'area': 'A', 'outcome': 'works'}})[0] == 404
    # App users and admins use it.
    assert ok(lambda_context, 'GET', base, claims=USER)['request']['request_id'] == request_id


# ── The derived sign-up row ───────────────────────────────────────────────────

def test_every_save_rewrites_the_sign_up_row(world, lambda_context):
    ok(lambda_context, 'GET', BOARDS)
    assert _audience_row(world) | {'updated_at': ''} == {**BOARD_AUDIENCE_KEY, 'company': True, 'anyone': False,
                                                         'domains': [], 'emails': [], 'updated_at': ''}
    listed = _create(lambda_context, audience={'mode': 'list', 'domains': ['partner.example'],
                                               'emails': ['Kim@Acme.example']})
    row = _audience_row(world)
    assert (row['domains'], row['emails']) == (['partner.example'], ['kim@acme.example'])
    anyone = _create(lambda_context, name='Open', audience={'mode': 'anyone'})
    assert _audience_row(world)['anyone'] is True
    ok(lambda_context, 'PUT', f'{BOARDS}/{anyone["board_id"]}', body={'archived': True})
    assert _audience_row(world)['anyone'] is False
    ok(lambda_context, 'DELETE', f'{BOARDS}/{listed["board_id"]}')
    row = _audience_row(world)
    assert (row['company'], row['domains'], row['emails']) == (True, [], [])
    ok(lambda_context, 'PUT', f'{BOARDS}/{SEEDED_BOARD_ID}', body={'audience': {'mode': 'list', 'emails': []}})
    assert _audience_row(world)['company'] is False
