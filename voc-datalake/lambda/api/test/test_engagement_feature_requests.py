"""Feature-request board API: identity per pool, requests, supports, totals and promote."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from engagement_fixtures import (
    ADMIN,
    BOARD,
    BOARD_2,
    PRIVATE_PROJECT,
    PUBLIC_PROJECT,
    STRANGER,
    USER,
    call,
    engagement_world,
    ok,
)

from shared import feature_requests_store
from shared.engagement_common import is_id
from shared.feature_requests_store import compute_totals, recompute_totals
from shared.participants_settings import SETTINGS_KEY


@pytest.fixture
def world():
    with engagement_world() as w:
        # The board pool's callers (acme.example) use the seeded company board.
        w.participants.put_item(Item={**SETTINGS_KEY, 'company_domains': ['acme.example']})
        yield w


def _request(ctx, claims=BOARD, **overrides):
    body = {'title': 'SSO with SAML', 'description': 'Needed for the enterprise tier', 'customer': 'Acme',
            'deal': 'Acme renewal', 'impact': 'at_risk', 'amount_usd': 120_000, 'name': 'Sam Seller',
            'contact_email': 'cio@acme.example', **overrides}
    return ok(ctx, 'POST', '/feature-requests', 201, claims=claims, body=body)


def _support(ctx, request_id, claims=BOARD_2, **overrides):
    body = {'customer': 'Example Air', 'impact': 'committed', 'amount_usd': 50_000, 'name': 'Kim', **overrides}
    return ok(ctx, 'POST', f'/feature-requests/{request_id}/supports', 201, claims=claims, body=body)


# ── Identity ──────────────────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
def test_viewer_comes_from_the_verified_email_and_the_pool(lambda_context):
    board = ok(lambda_context, 'GET', '/feature-requests', claims=BOARD)['viewer']
    # A board-pool token is never admin, whatever groups it carries.
    assert board == {'email': 'sam@acme.example', 'name': '', 'is_admin': False, 'pool': 'board'}
    app_admin = ok(lambda_context, 'GET', '/feature-requests', claims=ADMIN)['viewer']
    assert app_admin == {'email': 'ada@example.com', 'name': 'Ada Admin', 'is_admin': True, 'pool': 'app'}
    assert ok(lambda_context, 'GET', '/feature-requests', claims=USER)['viewer']['is_admin'] is False


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('claims', [
    STRANGER,
    {**BOARD, 'email_verified': 'false'},
    {**BOARD, 'email_verified': None},
    {**BOARD, 'email': ''},
    {**BOARD, 'iss': 'https://evil.example/' + BOARD['iss'].rsplit('/', 1)[-1]},
    {key: value for key, value in BOARD.items() if key != 'iss'},
])
def test_unknown_pools_and_unverified_emails_are_refused(lambda_context, claims):
    assert call(lambda_context, 'GET', '/feature-requests', claims=claims)[0] == 403


def test_the_board_pool_is_refused_when_it_is_not_deployed(lambda_context):
    with engagement_world(BOARD_USER_POOL_ID=''):
        assert call(lambda_context, 'GET', '/feature-requests', claims=BOARD)[0] == 403


# ── Requests and supports ─────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
def test_creating_a_request_writes_the_reporter_support(lambda_context):
    body = _request(lambda_context)
    request = body['request']
    assert request['status'] == 'new'
    assert request['reporter_email'] == 'sam@acme.example'
    assert request['reporter_name'] == 'Sam Seller'
    assert request['totals'] == {'supporters': 1, 'customers': 1, 'committed_usd': 0, 'at_risk_usd': 120_000}
    assert 'version' not in request
    (support,) = body['supports']
    assert support['is_reporter'] is True
    assert support['email'] == 'sam@acme.example'
    assert support['contact_email'] == 'cio@acme.example'
    listed = ok(lambda_context, 'GET', '/feature-requests', claims=USER)['requests']
    assert [r['request_id'] for r in listed] == [request['request_id']]


@pytest.mark.usefixtures('world')
def test_supports_recompute_the_totals(lambda_context):
    request_id = _request(lambda_context)['request']['request_id']
    body = _support(lambda_context, request_id)
    assert body['request']['totals'] == {'supporters': 2, 'customers': 2, 'committed_usd': 50_000,
                                         'at_risk_usd': 120_000}
    # Same customer in another case, no impact: no new customer, no amount.
    body = _support(lambda_context, request_id, claims=USER, customer='ACME', impact='none', amount_usd=999)
    assert body['support']['amount_usd'] == 0
    assert body['request']['totals'] == {'supporters': 3, 'customers': 2, 'committed_usd': 50_000,
                                         'at_risk_usd': 120_000}
    detail = ok(lambda_context, 'GET', f'/feature-requests/{request_id}', claims=BOARD_2)
    assert len(detail['supports']) == 3


@pytest.mark.usefixtures('world')
def test_one_support_per_person_the_reporter_included(lambda_context):
    request_id = _request(lambda_context)['request']['request_id']
    path = f'/feature-requests/{request_id}/supports'
    plus_one = {'customer': 'Example Air', 'impact': 'committed', 'amount_usd': 1}
    # The reporter already supports their own request (the +1 filed with it).
    assert call(lambda_context, 'POST', path, claims=BOARD, body=plus_one) == (409, {'success': False,
                                                                                'error': 'already_supported'})
    _support(lambda_context, request_id)
    status, body = call(lambda_context, 'POST', path, claims={**BOARD_2, 'email': 'KIM@acme.example'}, body=plus_one)
    assert (status, body['error']) == (409, 'already_supported')
    detail = ok(lambda_context, 'GET', f'/feature-requests/{request_id}', claims=BOARD_2)
    assert len(detail['supports']) == 2
    assert detail['request']['totals']['supporters'] == 2


@pytest.mark.usefixtures('world')
def test_two_simultaneous_plus_ones_by_one_person_store_one(lambda_context):
    # Both deliveries pass the read check before either writes (the race): the person's own key
    # makes the second conditional put fail, so only one +1 is stored and the loser gets a 409.
    request_id = _request(lambda_context)['request']['request_id']
    path = f'/feature-requests/{request_id}/supports'
    plus_one = {'customer': 'Example Air', 'impact': 'committed', 'amount_usd': 1}
    with patch('shared.feature_requests_routes._not_yet_supporting'):
        _support(lambda_context, request_id)
        status, body = call(lambda_context, 'POST', path, claims={**BOARD_2, 'email': 'KIM@acme.example'},
                            body=plus_one)
    assert (status, body['error']) == (409, 'already_supported')
    detail = ok(lambda_context, 'GET', f'/feature-requests/{request_id}', claims=BOARD_2)
    assert len(detail['supports']) == 2
    assert detail['request']['totals']['supporters'] == 2


def test_a_persons_support_id_is_stable_per_request_and_case_blind():
    support_id = feature_requests_store.support_id_for('fr_0123456789abcdef', 'Kim@Acme.example')
    assert support_id == feature_requests_store.support_id_for('fr_0123456789abcdef', ' kim@acme.example')
    assert support_id != feature_requests_store.support_id_for('fr_fedcba9876543210', 'kim@acme.example')
    assert support_id != feature_requests_store.support_id_for('fr_0123456789abcdef', 'sam@acme.example')
    assert is_id(support_id, feature_requests_store.SUPPORT_PREFIX)


@pytest.mark.usefixtures('world')
def test_supports_are_edited_and_removed_by_their_owner_or_an_admin(lambda_context):
    request_id = _request(lambda_context)['request']['request_id']
    support_id = _support(lambda_context, request_id)['support']['support_id']
    path = f'/feature-requests/{request_id}/supports/{support_id}'
    edit = {'customer': 'Example Air', 'impact': 'committed', 'amount_usd': 75_000}
    assert call(lambda_context, 'PUT', path, claims=BOARD, body=edit)[0] == 403
    body = ok(lambda_context, 'PUT', path, claims=BOARD_2, body=edit)
    assert body['request']['totals']['committed_usd'] == 75_000
    detail = ok(lambda_context, 'GET', f'/feature-requests/{request_id}')
    edited = next(s for s in detail['supports'] if s['support_id'] == support_id)
    assert (edited['email'], edited['name'], edited['is_reporter']) == ('kim@acme.example', 'Kim', False)
    assert call(lambda_context, 'DELETE', path, claims=USER)[0] == 403
    body = ok(lambda_context, 'DELETE', path, claims=ADMIN)
    assert body['request']['totals']['committed_usd'] == 0
    assert call(lambda_context, 'DELETE', path, claims=ADMIN)[0] == 404


def test_an_edit_racing_a_delete_never_brings_the_support_back(world, lambda_context):
    """PUT read the row, then a concurrent DELETE removed it: the conditional write answers 404."""
    request_id = _request(lambda_context)['request']['request_id']
    support_id = _support(lambda_context, request_id)['support']['support_id']
    key = feature_requests_store.support_key(request_id, support_id)
    real_get = feature_requests_store.get_support

    def get_then_lose(table, rid, sid):
        row = real_get(table, rid, sid)
        world.requests.delete_item(Key=key)
        return row

    edit = {'customer': 'Example Air', 'impact': 'none', 'amount_usd': 0}
    with patch('shared.feature_requests_routes.get_support', get_then_lose):
        status, _ = call(lambda_context, 'PUT', f'/feature-requests/{request_id}/supports/{support_id}',
                         claims=BOARD_2, body=edit)
    assert status == 404
    assert 'Item' not in world.requests.get_item(Key=key)


@pytest.mark.usefixtures('world')
def test_the_reporter_or_an_admin_edits_the_request(lambda_context):
    request_id = _request(lambda_context)['request']['request_id']
    path = f'/feature-requests/{request_id}'
    assert call(lambda_context, 'PUT', path, claims=BOARD_2, body={'title': 'Mine now'})[0] == 403
    assert ok(lambda_context, 'PUT', path, claims=BOARD, body={'title': 'SAML SSO'})['request']['title'] == 'SAML SSO'
    # A sales request must keep a description (shared.feature_board_fields.DESCRIPTION_REQUIRED_TEMPLATES).
    assert call(lambda_context, 'PUT', path, claims=ADMIN, body={'description': ''})[0] == 400
    assert ok(lambda_context, 'PUT', path, claims=ADMIN, body={'description': 'IdP-initiated'})['request'][
        'description'] == 'IdP-initiated'
    assert call(lambda_context, 'PUT', path, claims=BOARD, body={})[0] == 400


def test_status_and_delete_are_admin_only(world, lambda_context):
    request_id = _request(lambda_context)['request']['request_id']
    status_path = f'/feature-requests/{request_id}/status'
    assert call(lambda_context, 'PUT', status_path, claims=BOARD, body={'status': 'planned'})[0] == 403
    assert call(lambda_context, 'PUT', status_path, claims=USER, body={'status': 'planned'})[0] == 403
    assert call(lambda_context, 'PUT', status_path, body={'status': 'maybe'})[0] == 400
    assert ok(lambda_context, 'PUT', status_path, body={'status': 'shipped'})['request']['status'] == 'shipped'
    assert call(lambda_context, 'DELETE', f'/feature-requests/{request_id}', claims=BOARD)[0] == 403
    ok(lambda_context, 'DELETE', f'/feature-requests/{request_id}')
    assert call(lambda_context, 'GET', f'/feature-requests/{request_id}')[0] == 404
    assert [item['pk'] for item in world.requests.scan()['Items'] if item['pk'].startswith('FR#')] == []


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('body', [
    {'title': ''}, {'title': 'x' * 161}, {'description': 'x' * 4001}, {'impact': 'huge'},
    {'customer': ''}, {'amount_usd': -1}, {'amount_usd': 10_000_000_001}, {'amount_usd': 1.5},
    {'amount_usd': True}, {'amount_usd': '100'}, {'contact_email': 'nope'}, {'note': 'x' * 1001},
    {'deal': 'x' * 161},
])
def test_invalid_requests_are_refused(lambda_context, body):
    base = {'title': 'T', 'customer': 'Acme', 'impact': 'committed', 'amount_usd': 1}
    assert call(lambda_context, 'POST', '/feature-requests', claims=BOARD, body={**base, **body})[0] == 400


@pytest.mark.usefixtures('world')
def test_unknown_ids_are_404(lambda_context):
    assert call(lambda_context, 'GET', '/feature-requests/fr_0000000000000000')[0] == 404
    assert call(lambda_context, 'GET', '/feature-requests/nonsense')[0] == 404
    assert call(lambda_context, 'POST', '/feature-requests/fr_0000000000000000/supports', claims=BOARD,
                body={'customer': 'A', 'impact': 'none'})[0] == 404
    request_id = _request(lambda_context)['request']['request_id']
    assert call(lambda_context, 'PUT', f'/feature-requests/{request_id}/supports/sup_0000000000000000',
                body={'customer': 'A', 'impact': 'none'})[0] == 404


# ── Totals ────────────────────────────────────────────────────────────────────

def test_compute_totals_counts_distinct_people_and_customers():
    rows = [{'email': 'a@x.example', 'customer': 'Acme ', 'impact': 'committed', 'amount_usd': 10},
            {'email': 'A@x.example', 'customer': 'acme', 'impact': 'at_risk', 'amount_usd': 5},
            {'email': 'b@x.example', 'customer': '', 'impact': 'none', 'amount_usd': 0}]
    assert compute_totals(rows) == {'supporters': 2, 'customers': 1, 'committed_usd': 10, 'at_risk_usd': 5}


def test_recompute_retries_once_on_a_version_conflict(world, lambda_context):
    request_id = _request(lambda_context)['request']['request_id']
    real = feature_requests_store._write_totals
    conflict = ClientError({'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'x'}}, 'UpdateItem')
    calls = []

    def flaky(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise conflict
        return real(*args, **kwargs)

    with patch.object(feature_requests_store, '_write_totals', flaky):
        meta = recompute_totals(world.requests, request_id)
    assert len(calls) == 2
    assert int(meta['version']) == 1
    with patch.object(feature_requests_store, '_write_totals', side_effect=conflict), \
            pytest.raises(feature_requests_store.ConflictError):
        recompute_totals(world.requests, request_id)


# ── Promote ───────────────────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
def test_promote_turns_supporters_into_project_participants(lambda_context):
    request_id = _request(lambda_context)['request']['request_id']
    _support(lambda_context, request_id)
    _support(lambda_context, request_id, claims=USER, customer='Acme', impact='none', contact_email='buyer@acme.example')
    body = ok(lambda_context, 'POST', f'/feature-requests/{request_id}/promote', body={'project_id': PUBLIC_PROJECT})
    assert body['added'] == 5
    assert body['skipped'] == []
    assert body['list']['name'] == 'Requests: SSO with SAML'
    assert body['list']['kind'] == 'requesters'
    assert body['list']['member_count'] == 5
    assert body['request']['status'] == 'planned'
    assert body['request']['project_id'] == PUBLIC_PROJECT
    assert body['request']['list_id'] == body['list']['list_id']
    project = ok(lambda_context, 'GET', f'/participants/projects/{PUBLIC_PROJECT}')
    assert [entry['list_id'] for entry in project['lists']] == [body['list']['list_id']]
    assert project['reach'] == 5
    people = ok(lambda_context, 'GET', '/participants/people')['people']
    assert {p['origin'] for p in people} == {'feature_request'}
    kim = next(p for p in people if p['email'] == 'kim@acme.example')
    assert kim['name'] == 'Kim'
    # Again: the same list is reused and nobody joins twice.
    again = ok(lambda_context, 'POST', f'/feature-requests/{request_id}/promote', body={'project_id': PUBLIC_PROJECT})
    assert again['added'] == 0
    assert again['list']['list_id'] == body['list']['list_id']


@pytest.mark.usefixtures('world')
def test_promote_skips_external_contacts_when_they_are_not_allowed(lambda_context):
    ok(lambda_context, 'PUT', '/participants/settings',
       body={'company_domains': ['acme.example'], 'allow_external_people': False})
    request_id = _request(lambda_context, contact_email='cto@partner.example')['request']['request_id']
    body = ok(lambda_context, 'POST', f'/feature-requests/{request_id}/promote', body={'project_id': PUBLIC_PROJECT})
    assert body['added'] == 1
    assert body['skipped'] == [{'email': 'cto@partner.example', 'reason': 'external_not_allowed'}]


@pytest.mark.usefixtures('world')
def test_promote_needs_an_admin_with_edit_on_the_project(lambda_context):
    request_id = _request(lambda_context)['request']['request_id']
    path = f'/feature-requests/{request_id}/promote'
    assert call(lambda_context, 'POST', path, claims=BOARD, body={'project_id': PUBLIC_PROJECT})[0] == 403
    assert call(lambda_context, 'POST', path, claims=USER, body={'project_id': PUBLIC_PROJECT})[0] == 403
    assert call(lambda_context, 'POST', path, body={'project_id': 'proj-missing'})[0] == 404
    assert call(lambda_context, 'POST', path, body={})[0] == 404
    assert call(lambda_context, 'POST', path, body={'project_id': PRIVATE_PROJECT})[0] == 200
    status = ok(lambda_context, 'GET', f'/feature-requests/{request_id}')['request']['status']
    assert status == 'planned'
