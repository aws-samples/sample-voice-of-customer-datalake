"""Participants API: settings, lists, people, memberships and erasure (api/engagement_handler.py)."""
from __future__ import annotations

import pytest
from engagement_fixtures import USER, call, engagement_world, ok, run_send_job

from shared.digests import sha256_hex


@pytest.fixture
def world():
    with engagement_world() as w:
        yield w


def _person(ctx, email='pat@example.com', **fields):
    return ok(ctx, 'POST', '/participants/people', 201, body={'email': email, **fields})['person']


def _list(ctx, name='Beta customers', kind='beta'):
    return ok(ctx, 'POST', '/participants/lists', 201, body={'name': name, 'kind': kind})['list']


# ── Settings ──────────────────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
def test_settings_defaults_carry_the_brand_name_and_the_feature_flags(lambda_context):
    body = ok(lambda_context, 'GET', '/participants/settings', claims=USER)
    assert body['settings'] == {'company_domains': [], 'allow_external_people': True, 'daily_send_cap': 500,
                                'sender_name': 'Example Air'}
    assert body['email_enabled'] is True
    assert body['board_enabled'] is True
    assert body['board_url'] == 'https://voc.example.com/board'


def test_settings_flags_follow_the_environment(lambda_context):
    with engagement_world(EMAIL_FROM='', BOARD_USER_POOL_ID=''):
        body = ok(lambda_context, 'GET', '/participants/settings')
    assert (body['email_enabled'], body['board_enabled']) == (False, False)


@pytest.mark.usefixtures('world')
def test_admin_saves_settings_and_only_the_named_fields_change(lambda_context):
    body = ok(lambda_context, 'PUT', '/participants/settings',
              body={'company_domains': ['Example.com', '@acme.example', 'example.com'], 'daily_send_cap': 20})
    assert body['settings']['company_domains'] == ['example.com', 'acme.example']
    assert body['settings']['daily_send_cap'] == 20
    body = ok(lambda_context, 'PUT', '/participants/settings', body={'sender_name': 'Research team'})
    assert body['settings']['company_domains'] == ['example.com', 'acme.example']
    assert body['settings']['sender_name'] == 'Research team'
    assert body['settings']['updated_by'] == 'admin-sub'


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('bad', [
    {'company_domains': ['not a domain']}, {'company_domains': 'example.com'},
    {'daily_send_cap': 0}, {'daily_send_cap': 5001}, {'daily_send_cap': True},
    {'allow_external_people': 'yes'}, {'sender_name': ''}, {'sender_name': 'x' * 81}, {'colour': 'red'},
])
def test_invalid_settings_are_refused(lambda_context, bad):
    status, body = call(lambda_context, 'PUT', '/participants/settings', body=bad)
    assert status == 400
    assert body['success'] is False


@pytest.mark.usefixtures('world')
def test_settings_write_is_admin_only(lambda_context):
    status, _ = call(lambda_context, 'PUT', '/participants/settings', claims=USER, body={'daily_send_cap': 9})
    assert status == 403


# ── Lists and members ─────────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
def test_list_lifecycle_with_members(lambda_context):
    created = _list(lambda_context)
    list_id = created['list_id']
    assert created['member_count'] == 0
    assert created['kind'] == 'beta'
    person = _person(lambda_context, email='Pat@Example.com', name='Pat')
    body = ok(lambda_context, 'POST', f'/participants/lists/{list_id}/members', claims=USER, body={
        'person_ids': [person['person_id']],
        'people': [{'email': 'new@acme.example', 'name': 'New'}, {'email': 'pat@example.com'},
                   {'email': 'not-an-email'}],
    })
    assert body == {'added': 2, 'already': 0, 'created': 1,
                    'rejected': [{'email': 'not-an-email', 'reason': 'invalid_email'}]}
    again = ok(lambda_context, 'POST', f'/participants/lists/{list_id}/members',
               body={'person_ids': [person['person_id']]})
    assert again['added'] == 0
    assert again['already'] == 1
    detail = ok(lambda_context, 'GET', f'/participants/lists/{list_id}')
    assert detail['list']['member_count'] == 2
    assert [m['email'] for m in detail['members']] == ['new@acme.example', 'Pat@Example.com']
    ok(lambda_context, 'DELETE', f'/participants/lists/{list_id}/members/{person["person_id"]}', claims=USER)
    assert ok(lambda_context, 'GET', f'/participants/lists/{list_id}')['list']['member_count'] == 1
    renamed = ok(lambda_context, 'PUT', f'/participants/lists/{list_id}', claims=USER, body={'name': 'Paid panel'})
    assert renamed['list']['name'] == 'Paid panel'
    assert [entry['name'] for entry in ok(lambda_context, 'GET', '/participants/lists')['lists']] == ['Paid panel']


@pytest.mark.usefixtures('world')
def test_deleting_a_list_keeps_its_people(lambda_context):
    list_id = _list(lambda_context)['list_id']
    person = _person(lambda_context)
    ok(lambda_context, 'POST', f'/participants/lists/{list_id}/members', body={'person_ids': [person['person_id']]})
    ok(lambda_context, 'POST', '/participants/projects/proj-public', body={'list_ids': [list_id]})
    status, _ = call(lambda_context, 'DELETE', f'/participants/lists/{list_id}', claims=USER)
    assert status == 403
    ok(lambda_context, 'DELETE', f'/participants/lists/{list_id}')
    assert call(lambda_context, 'GET', f'/participants/lists/{list_id}')[0] == 404
    detail = ok(lambda_context, 'GET', f'/participants/people/{person["person_id"]}')
    assert detail['lists'] == []
    assert ok(lambda_context, 'GET', '/participants/projects/proj-public')['lists'] == []


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize(('body', 'status'), [
    ({'name': ''}, 400), ({'name': 'x' * 121}, 400), ({'name': 'A', 'kind': 'vip'}, 400),
    ({'name': 'A', 'description': 5}, 400),
])
def test_invalid_list_bodies_are_refused(lambda_context, body, status):
    assert call(lambda_context, 'POST', '/participants/lists', body=body)[0] == status


@pytest.mark.usefixtures('world')
def test_list_routes_answer_404_for_unknown_or_malformed_ids(lambda_context):
    assert call(lambda_context, 'GET', '/participants/lists/lst_0000000000000000')[0] == 404
    assert call(lambda_context, 'GET', '/participants/lists/nonsense')[0] == 404
    assert call(lambda_context, 'PUT', '/participants/lists/lst_0000000000000000', body={'name': 'x'})[0] == 404
    list_id = _list(lambda_context)['list_id']
    assert call(lambda_context, 'PUT', f'/participants/lists/{list_id}', body={})[0] == 400
    assert call(lambda_context, 'POST', f'/participants/lists/{list_id}/members',
                body={'person_ids': ['per_0000000000000000']})[0] == 404
    assert call(lambda_context, 'POST', f'/participants/lists/{list_id}/members',
                body={'people': [{'email': f'p{i}@example.com'} for i in range(201)]})[0] == 400


@pytest.mark.usefixtures('world')
def test_external_people_follow_the_setting(lambda_context):
    ok(lambda_context, 'PUT', '/participants/settings',
       body={'company_domains': ['example.com'], 'allow_external_people': False})
    status, body = call(lambda_context, 'POST', '/participants/people', body={'email': 'x@acme.example'})
    assert (status, body['error']) == (400, 'external_not_allowed')
    _person(lambda_context, email='in@example.com')
    list_id = _list(lambda_context)['list_id']
    body = ok(lambda_context, 'POST', f'/participants/lists/{list_id}/members',
              body={'people': [{'email': 'x@acme.example'}, {'email': 'in@example.com'}]})
    assert body['rejected'] == [{'email': 'x@acme.example', 'reason': 'external_not_allowed'}]
    assert body['added'] == 1


def _origins(ctx):
    return {p['email']: p['origin'] for p in ok(ctx, 'GET', '/participants/people')['people']}


@pytest.mark.usefixtures('world')
def test_people_added_through_the_assistant_are_stored_with_origin_assistant(lambda_context):
    list_id = _list(lambda_context)['list_id']
    ok(lambda_context, 'POST', f'/participants/lists/{list_id}/members', claims=USER,
       body={'origin': 'assistant', 'people': [{'email': 'ai@example.com'}]})
    ok(lambda_context, 'POST', f'/participants/lists/{list_id}/members', claims=USER,
       body={'people': [{'email': 'typed@example.com'}]})

    assert _origins(lambda_context) == {'ai@example.com': 'assistant', 'typed@example.com': 'manual'}


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('origin', ['feature_request', 'agent', '', 7, None])
def test_a_client_cannot_claim_any_other_origin(lambda_context, origin):
    list_id = _list(lambda_context)['list_id']
    status, body = call(lambda_context, 'POST', f'/participants/lists/{list_id}/members', claims=USER,
                        body={'origin': origin, 'people': [{'email': 'x@example.com'}]})

    assert (status, body['error']) == (400, 'origin must be one of: manual, assistant')
    assert _origins(lambda_context) == {}


# ── People ────────────────────────────────────────────────────────────────────

@pytest.mark.usefixtures('world')
def test_person_create_read_update(lambda_context):
    list_id = _list(lambda_context)['list_id']
    person = ok(lambda_context, 'POST', '/participants/people', 201, claims=USER, body={
        'email': ' Lee@Example.com ', 'name': 'Lee', 'company': 'Example Air', 'tags': ['vip', 'vip', 'eu'],
        'list_ids': [list_id]})['person']
    assert person['email'] == 'Lee@Example.com'
    assert person['tags'] == ['vip', 'eu']
    assert person['status'] == 'active'
    assert person['origin'] == 'manual'
    assert person['created_by'] == 'user-sub'
    assert 'email_lc' not in person
    assert 'gsi1pk' not in person
    detail = ok(lambda_context, 'GET', f'/participants/people/{person["person_id"]}')
    assert [entry['list_id'] for entry in detail['lists']] == [list_id]
    assert detail['asks'] == []
    updated = ok(lambda_context, 'PUT', f'/participants/people/{person["person_id"]}', body={'title': 'CTO'})
    assert updated['person']['title'] == 'CTO'
    assert updated['person']['name'] == 'Lee'


def test_email_is_unique_case_insensitively_and_immutable(world, lambda_context):
    person = _person(lambda_context, email='dup@example.com')
    status, _ = call(lambda_context, 'POST', '/participants/people', body={'email': 'DUP@example.com'})
    assert status == 409
    status, _ = call(lambda_context, 'PUT', f'/participants/people/{person["person_id"]}',
                     body={'email': 'other@example.com'})
    assert status == 400
    guard = world.participants.get_item(Key={'pk': f'EMAIL#{sha256_hex("dup@example.com")}', 'sk': 'PERSON'})
    assert guard['Item']['person_id'] == person['person_id']


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('body', [
    {}, {'email': 'nope'}, {'email': 'a@b'}, {'email': 'x@example.com', 'name': 7},
    {'email': 'x@example.com', 'tags': 'vip'}, {'email': 'x@example.com', 'list_ids': ['lst_0000000000000000']},
])
def test_invalid_people_are_refused(lambda_context, body):
    assert call(lambda_context, 'POST', '/participants/people', body=body)[0] in (400, 404)


@pytest.mark.usefixtures('world')
def test_people_search_and_list_filter(lambda_context):
    _person(lambda_context, email='a@example.com', name='Alice', company='Acme')
    _person(lambda_context, email='b@example.com', name='Bert', company='Example Air')
    list_id = _list(lambda_context)['list_id']
    ok(lambda_context, 'POST', f'/participants/lists/{list_id}/members', body={'people': [{'email': 'b@example.com'}]})
    found = ok(lambda_context, 'GET', '/participants/people', query={'q': 'ACME'})['people']
    assert [p['email'] for p in found] == ['a@example.com']
    assert len(ok(lambda_context, 'GET', '/participants/people')['people']) == 2
    members = ok(lambda_context, 'GET', '/participants/people', query={'list_id': list_id})['people']
    assert [p['email'] for p in members] == ['b@example.com']
    assert ok(lambda_context, 'GET', '/participants/people', query={'list_id': list_id, 'q': 'alice'})['people'] == []


@pytest.mark.usefixtures('world')
def test_people_carry_their_list_ids_and_they_follow_membership(lambda_context):
    """The Participants page's lists column: from the person META, kept in step on every change."""
    staff, beta = _list(lambda_context, 'Staff', 'employees')['list_id'], _list(lambda_context)['list_id']
    person = _person(lambda_context, list_ids=[staff])
    loner = _person(lambda_context, email='solo@example.com')
    assert person['list_ids'] == [staff]
    assert loner['list_ids'] == []
    ok(lambda_context, 'POST', f'/participants/lists/{beta}/members', body={'person_ids': [person['person_id']]})

    def lists_of(people):
        return {p['email']: p['list_ids'] for p in people}

    assert lists_of(ok(lambda_context, 'GET', '/participants/people')['people']) == {
        'pat@example.com': sorted([staff, beta]), 'solo@example.com': []}
    assert lists_of(ok(lambda_context, 'GET', f'/participants/lists/{beta}')['members']) == {
        'pat@example.com': sorted([staff, beta])}
    ok(lambda_context, 'DELETE', f'/participants/lists/{staff}/members/{person["person_id"]}')
    ok(lambda_context, 'DELETE', f'/participants/lists/{beta}')
    assert lists_of(ok(lambda_context, 'GET', '/participants/people')['people'])['pat@example.com'] == []


@pytest.mark.usefixtures('world')
def test_person_routes_answer_404_for_unknown_ids(lambda_context):
    assert call(lambda_context, 'GET', '/participants/people/per_0000000000000000')[0] == 404
    assert call(lambda_context, 'PUT', '/participants/people/per_0000000000000000', body={'name': 'x'})[0] == 404
    assert call(lambda_context, 'DELETE', '/participants/people/per_0000000000000000')[0] == 404
    person = _person(lambda_context)
    assert call(lambda_context, 'PUT', f'/participants/people/{person["person_id"]}', body={})[0] == 400


def test_erasure_is_admin_only_and_removes_every_trace(world, lambda_context):
    list_id = _list(lambda_context)['list_id']
    person = _person(lambda_context, email='gone@example.com', list_ids=[list_id])
    person_id = person['person_id']
    ok(lambda_context, 'POST', '/participants/projects/proj-public', body={'person_ids': [person_id]})
    ok(lambda_context, 'POST', '/participants/asks', 202, body={
        'person_ids': [person_id], 'subject': 'Hi', 'message': 'Please', 'link': {'kind': 'form', 'form_id': 'form-1'}})
    run_send_job(lambda_context, world)
    assert call(lambda_context, 'DELETE', f'/participants/people/{person_id}', claims=USER)[0] == 403
    ok(lambda_context, 'DELETE', f'/participants/people/{person_id}')
    rows = world.participants.scan()['Items']
    # Only the ask's recipient row still names the person, and it holds no token any more.
    naming = [row for row in rows if person_id in row['pk'] or row['sk'].endswith(person_id)]
    assert [row['sk'] for row in naming] == [f'RCPT#{person_id}']
    assert not [row for row in rows if row['pk'].startswith(('TOKEN#', 'EMAIL#'))]
    recipient = next(row for row in rows if row['sk'] == f'RCPT#{person_id}')
    assert set(recipient) == {'pk', 'sk', 'person_id', 'status', 'sent_at'}
    assert ok(lambda_context, 'GET', f'/participants/lists/{list_id}')['list']['member_count'] == 0
    assert ok(lambda_context, 'GET', '/participants/projects/proj-public')['people'] == []
    ask_id = next(row['ask_id'] for row in rows if row['sk'] == 'META' and row['pk'].startswith('ASK#'))
    recipients = ok(lambda_context, 'GET', f'/participants/asks/{ask_id}')['recipients']
    assert recipients == [{'person_id': person_id, 'email': None, 'name': None, 'status': 'sent',
                           'sent_at': recipient['sent_at'], 'responded_at': None, 'error': None}]
