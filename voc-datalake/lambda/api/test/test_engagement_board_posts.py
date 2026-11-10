"""Requests and +1s on feedback boards: fields per template, statuses, totals, rate limits, promote."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from engagement_fixtures import ADMIN, BOARD, BOARD_POOL, ISSUER, PUBLIC_PROJECT, USER, call, engagement_world, ok

from shared import feature_boards_limits
from shared.exceptions import ConflictError, NotFoundError
from shared.feature_boards_store import SEEDED_BOARD_ID
from shared.feature_requests_store import create_request
from shared.participants_settings import SETTINGS_KEY

BOARDS = '/feature-requests/boards'
STRANGER_1 = {'sub': 's1', 'email': 'one@anywhere.example', 'email_verified': 'true', 'iss': ISSUER + BOARD_POOL}
STRANGER_2 = {'sub': 's2', 'email': 'two@anywhere.example', 'email_verified': 'true', 'iss': ISSUER + BOARD_POOL}


@pytest.fixture
def world():
    with engagement_world() as w:
        w.participants.put_item(Item={**SETTINGS_KEY, 'company_domains': ['acme.example']})
        yield w


def _board(ctx, template, **body):
    return ok(ctx, 'POST', BOARDS, 201, body={'name': f'{template} board', 'template': template, **body})['board']


def _post(ctx, board, fields, claims=USER, expected=201, **extra):
    body = {'board': board['slug'], 'title': 'Something', 'description': 'What happened', 'fields': fields, **extra}
    return ok(ctx, 'POST', '/feature-requests', expected, claims=claims, body=body)


SERVICE = {'kind': 'bug', 'severity': 'high', 'reference': 'PNR-123', 'steps': '1. Open', 'affected_count': 4}
BETA = {'area': 'Seat map', 'outcome': 'confusing', 'rating': 4, 'link': 'https://example.com/build/7'}


# ── Fields per template ───────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
@pytest.mark.parametrize(('template', 'fields'), [
    ('service', {'severity': 'high'}), ('service', {'kind': 'bug'}), ('service', {**SERVICE, 'kind': 'praise'}),
    ('service', {**SERVICE, 'affected_count': 0}), ('service', {**SERVICE, 'reference': 'x' * 81}),
    ('service', {**SERVICE, 'steps': 'x' * 2001}), ('service', {**SERVICE, 'customer': 'Acme'}),
    ('beta', {'area': 'Seats'}), ('beta', {**BETA, 'rating': 6}), ('beta', {**BETA, 'rating': 0}),
    ('beta', {**BETA, 'link': 'http://example.com'}), ('beta', {**BETA, 'link': 'javascript:alert(1)'}),
    ('beta', {**BETA, 'link': 'https://'}), ('beta', {**BETA, 'link': 'https://example.com/' + 'x' * 500}),
    ('beta', {**BETA, 'outcome': 'great'}), ('beta', {**BETA, 'unknown': 1}),
    ('blank', {'customer': 'Acme'}), ('sales', {'customer': 'Acme'}),
    ('sales', {'customer': 'Acme', 'impact': 'committed'}), ('sales', {'customer': 'Acme', 'impact': 'none',
                                                                      'contact_email': 'nope'}),
])
def test_values_are_checked_against_the_board_fields(lambda_context, template, fields):
    board = _board(lambda_context, template)
    assert call(lambda_context, 'POST', '/feature-requests', claims=USER,
                body={'board': board['slug'], 'title': 'T', 'description': 'D', 'fields': fields})[0] == 400


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize(('template', 'fields', 'required'), [
    ('sales', {'customer': 'Acme', 'impact': 'none'}, True), ('service', SERVICE, True),
    ('beta', BETA, False), ('blank', {}, False),
])
def test_the_description_is_required_where_the_template_says(lambda_context, template, fields, required):
    board = _board(lambda_context, template)
    status, body = call(lambda_context, 'POST', '/feature-requests', claims=USER,
                        body={'board': board['slug'], 'title': 'T', 'description': '  ', 'fields': fields})
    assert status == (400 if required else 201)
    if required:
        assert body['error'] == 'description is required'
        return
    request_id = body['request']['request_id']
    assert body['request']['description'] == ''
    # Clearing it later follows the same rule.
    assert ok(lambda_context, 'PUT', f'/feature-requests/{request_id}', claims=USER,
              body={'description': ''})['request']['description'] == ''


@pytest.mark.usefixtures('world')
def test_a_service_issue_counts_the_people_affected(lambda_context):
    board = _board(lambda_context, 'service')
    created = _post(lambda_context, board, SERVICE)
    request = created['request']
    assert request['fields'] == SERVICE
    assert request['status'] == 'new'
    assert request['totals'] == {'supporters': 1, 'affected': 4}
    assert created['supports'][0]['fields'] == {}
    body = ok(lambda_context, 'POST', f'/feature-requests/{request["request_id"]}/supports', 201, claims=ADMIN,
              body={'fields': {'note': 'Same on Android'}})
    assert body['support']['fields'] == {'note': 'Same on Android'}
    assert body['request']['totals'] == {'supporters': 2, 'affected': 5}
    edited = ok(lambda_context, 'PUT', f'/feature-requests/{request["request_id"]}', claims=USER,
                body={'fields': {**SERVICE, 'affected_count': 10}})['request']
    assert edited['totals'] == {'supporters': 2, 'affected': 11}


@pytest.mark.usefixtures('world')
def test_beta_feedback_and_blank_boards(lambda_context):
    beta = _post(lambda_context, _board(lambda_context, 'beta'), BETA)['request']
    assert beta['totals'] == {'supporters': 1, 'avg_rating': 4}
    assert beta['fields']['link'] == 'https://example.com/build/7'
    blank = _post(lambda_context, _board(lambda_context, 'blank'), {})['request']
    assert blank['totals'] == {'supporters': 1}
    assert blank['fields'] == {}


@pytest.mark.usefixtures('world')
def test_a_sales_request_with_fields_gives_the_reporter_support_its_values(lambda_context):
    board = _board(lambda_context, 'sales')
    fields = {'customer': 'Acme', 'deal': 'Renewal', 'impact': 'committed', 'amount_usd': 9000}
    created = _post(lambda_context, board, fields)
    assert created['request']['fields'] == fields
    assert created['request']['totals'] == {'supporters': 1, 'customers': 1, 'committed_usd': 9000, 'at_risk_usd': 0}
    assert created['supports'][0]['fields'] == fields


@pytest.mark.usefixtures('world')
def test_edited_fields_switch_a_board_field_on_and_off(lambda_context):
    board = _board(lambda_context, 'blank')
    path = f'{BOARDS}/{board["board_id"]}'
    config = {'request': {'severity': {'enabled': True, 'required': True}}, 'support': {}}
    ok(lambda_context, 'PUT', path, body={'fields': config})
    assert call(lambda_context, 'POST', '/feature-requests', claims=USER,
                body={'board': board['slug'], 'title': 'T', 'fields': {}})[0] == 400
    assert _post(lambda_context, board, {'severity': 'low'})['request']['fields'] == {'severity': 'low'}


@pytest.mark.usefixtures('world')
def test_requests_from_before_boards_show_their_reporter_values_as_fields(lambda_context):
    old = ok(lambda_context, 'POST', '/feature-requests', 201, claims=BOARD, body={
        'title': 'SSO', 'description': 'Needed', 'customer': 'Acme', 'impact': 'at_risk', 'amount_usd': 5, 'note': 'Weekly ask'})
    request_id = old['request']['request_id']
    assert old['request']['board_id'] == SEEDED_BOARD_ID
    assert old['supports'][0]['note'] == 'Weekly ask'
    detail = ok(lambda_context, 'GET', f'/feature-requests/{request_id}', claims=USER)
    assert detail['request']['fields'] == {'customer': 'Acme', 'impact': 'at_risk', 'amount_usd': 5}


# ── Statuses ──────────────────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
def test_status_is_one_of_the_board_statuses(lambda_context):
    board = _board(lambda_context, 'service')
    request_id = _post(lambda_context, board, SERVICE)['request']['request_id']
    path = f'/feature-requests/{request_id}/status'
    assert call(lambda_context, 'PUT', path, body={'status': 'planned'})[0] == 400
    assert ok(lambda_context, 'PUT', path, body={'status': 'wont_fix'})['request']['status'] == 'wont_fix'
    statuses = [{'key': 'open', 'label': 'Open'}, {'key': 'wont_fix', 'label': 'No'}]
    ok(lambda_context, 'PUT', f'{BOARDS}/{board["board_id"]}', body={'statuses': statuses})
    # A new request starts in the board's first status.
    assert _post(lambda_context, board, SERVICE)['request']['status'] == 'open'


@pytest.mark.usefixtures('world')
def test_promote_moves_to_planned_only_where_the_board_has_it(lambda_context):
    service = _post(lambda_context, _board(lambda_context, 'service'), SERVICE)['request']
    body = ok(lambda_context, 'POST', f'/feature-requests/{service["request_id"]}/promote',
              body={'project_id': PUBLIC_PROJECT})
    assert body['request']['status'] == 'new'
    assert body['request']['totals'] == {'supporters': 1, 'affected': 4}
    custom = _board(lambda_context, 'blank')
    ok(lambda_context, 'PUT', f'{BOARDS}/{custom["board_id"]}', body={'statuses': [
        {'key': 'inbox', 'label': 'Inbox'}, {'key': 'planned', 'label': 'Planned'}]})
    request_id = _post(lambda_context, custom, {})['request']['request_id']
    body = ok(lambda_context, 'POST', f'/feature-requests/{request_id}/promote', body={'project_id': PUBLIC_PROJECT})
    assert body['request']['status'] == 'planned'


# ── Rate limits on anyone boards ──────────────────────────────────────────────

@pytest.fixture
def small_limits(monkeypatch):
    monkeypatch.setattr(feature_boards_limits, 'MAX_REQUESTS_PER_POSTER', 2)
    monkeypatch.setattr(feature_boards_limits, 'MAX_REQUESTS_PER_BOARD', 3)
    monkeypatch.setattr(feature_boards_limits, 'MAX_SUPPORTS_PER_POSTER', 1)


@pytest.mark.usefixtures('world', 'small_limits')
def test_anyone_boards_cap_requests_per_poster_and_per_board(lambda_context):
    board = _board(lambda_context, 'blank', audience={'mode': 'anyone'})
    for _ in range(2):
        _post(lambda_context, board, {}, claims=STRANGER_1)
    status, body = call(lambda_context, 'POST', '/feature-requests', claims=STRANGER_1,
                        body={'board': board['slug'], 'title': 'Third', 'fields': {}})
    assert (status, body['error']) == (429, 'rate_limited')
    _post(lambda_context, board, {}, claims=STRANGER_2)
    # The board's own cap (3) is reached: the second poster's next one is refused too.
    assert call(lambda_context, 'POST', '/feature-requests', claims=STRANGER_2,
                body={'board': board['slug'], 'title': 'Fourth', 'fields': {}})[0] == 429
    # Admins are never limited; other audiences are not limited.
    _post(lambda_context, board, {}, claims=ADMIN)
    company = _board(lambda_context, 'blank', name='Company')
    for _ in range(3):
        _post(lambda_context, company, {}, claims=BOARD)


@pytest.mark.usefixtures('small_limits')
def test_anyone_boards_cap_supports_per_poster(world, lambda_context):
    board = _board(lambda_context, 'blank', audience={'mode': 'anyone'})
    # Two requests: one person supports a request once (a second +1 there is 409 already_supported).
    first, second = (_post(lambda_context, board, {}, claims=STRANGER_1)['request']['request_id'] for _ in range(2))
    ok(lambda_context, 'POST', f'/feature-requests/{first}/supports', 201, claims=STRANGER_2, body={'fields': {}})
    status, body = call(lambda_context, 'POST', f'/feature-requests/{second}/supports', claims=STRANGER_2,
                        body={'fields': {}})
    assert (status, body['error']) == (429, 'rate_limited')
    rows = [item for item in world.requests.scan()['Items'] if item['pk'].startswith('RATE#')]
    assert rows
    assert all(int(row['ttl']) > 0 for row in rows)
    assert not any('two@anywhere.example' in row['pk'] for row in rows)


@pytest.mark.usefixtures('small_limits')
def test_a_plus_one_that_loses_the_race_gives_its_charge_back(world, lambda_context):
    """Two +1s of one person at once both pass the read check; the conditional put refuses the
    second (409). Its rate charge is refunded, so the person's one +1 for the day stays usable."""
    board = _board(lambda_context, 'blank', audience={'mode': 'anyone'})
    request_id = _post(lambda_context, board, {}, claims=STRANGER_1)['request']['request_id']
    path = f'/feature-requests/{request_id}/supports'
    # The lost race: the read check passed, then the person's other +1 landed first.
    with patch('shared.feature_requests_routes.put_support', side_effect=ConflictError('already_supported')):
        status, body = call(lambda_context, 'POST', path, claims=STRANGER_2, body={'fields': {}})

    assert (status, body['error']) == (409, 'already_supported')
    charges = [int(row['supports']) for row in world.requests.scan()['Items']
               if row['pk'].startswith('RATE#') and 'supports' in row]
    assert charges == [0]
    # The day's only +1 (the limit is 1 here) is still available.
    ok(lambda_context, 'POST', path, 201, claims=STRANGER_2, body={'fields': {}})


def test_a_request_on_a_board_deleted_meanwhile_is_404(world):
    gone = {'board_id': 'brd_0000abcd', 'template': 'blank'}
    with pytest.raises(NotFoundError):
        create_request(world.requests, gone, {'title': 'T', 'status': 'new', 'fields': {}}, {}, ('a@b.example', ''))
    assert world.requests.scan()['Items'] == []
