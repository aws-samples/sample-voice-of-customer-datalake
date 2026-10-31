"""Participants API: project links, asks, the async send job and the public unsubscribe."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError
from engagement_fixtures import (
    API_HOST,
    OWNER,
    PRIVATE_PROJECT,
    PUBLIC_PROJECT,
    USER,
    call,
    engagement_world,
    ok,
    run_send_job,
)

from shared import participants_send
from shared.participants_asks import RESPONSE_SK, token_key


@pytest.fixture
def world():
    with engagement_world() as w:
        yield w


def _people(ctx, *emails):
    return [ok(ctx, 'POST', '/participants/people', 201, body={'email': e, 'name': e.split('@')[0]})['person']
            ['person_id'] for e in emails]


def _ask(ctx, expected=202, claims=None, **body):
    payload = {'subject': 'Your opinion', 'message': 'Hello\n\nTell us <more>.',
               'link': {'kind': 'form', 'form_id': 'form-1'}, **body}
    kwargs = {'claims': claims} if claims else {}
    return ok(ctx, 'POST', '/participants/asks', expected, body=payload, **kwargs)


def _mark_unsubscribed(world, person_id):
    world.participants.update_item(Key={'pk': f'PERSON#{person_id}', 'sk': 'META'}, UpdateExpression='SET #s = :u',
                                   ExpressionAttributeNames={'#s': 'status'},
                                   ExpressionAttributeValues={':u': 'unsubscribed'})


def _sent_requests(world):
    return [c.kwargs for c in world.ses.send_email.call_args_list]


# ── Project links ─────────────────────────────────────────────────────────────

def test_project_links_lists_and_people_with_reach(world, lambda_context):
    a, b, c = _people(lambda_context, 'a@example.com', 'b@example.com', 'c@example.com')
    list_id = ok(lambda_context, 'POST', '/participants/lists', 201, body={'name': 'Panel', 'kind': 'paid'})['list']
    ok(lambda_context, 'POST', f'/participants/lists/{list_id["list_id"]}/members', body={'person_ids': [a, b]})
    body = ok(lambda_context, 'POST', f'/participants/projects/{PUBLIC_PROJECT}', claims=USER, body={
        'list_ids': [list_id['list_id']], 'person_ids': [b, c], 'people': [{'email': 'd@example.com'}]})
    assert [entry['list_id'] for entry in body['lists']] == [list_id['list_id']]
    assert [p['email'] for p in body['people']] == ['b@example.com', 'c@example.com', 'd@example.com']
    assert body['reach'] == 4
    assert body['created'] == 1
    _mark_unsubscribed(world, c)
    assert ok(lambda_context, 'GET', f'/participants/projects/{PUBLIC_PROJECT}')['reach'] == 3
    ok(lambda_context, 'DELETE', f'/participants/projects/{PUBLIC_PROJECT}/lists/{list_id["list_id"]}')
    ok(lambda_context, 'DELETE', f'/participants/projects/{PUBLIC_PROJECT}/people/{b}')
    after = ok(lambda_context, 'GET', f'/participants/projects/{PUBLIC_PROJECT}')
    assert after['lists'] == []
    assert [p['email'] for p in after['people']] == ['c@example.com', 'd@example.com']


@pytest.mark.usefixtures('world')
def test_project_routes_follow_project_access(lambda_context):
    outsider = {**USER, 'sub': 'outsider-sub'}
    # USER is a viewer of the private project: view yes, edit no; an outsider gets 404 for both.
    assert call(lambda_context, 'GET', f'/participants/projects/{PRIVATE_PROJECT}', claims=USER)[0] == 200
    assert call(lambda_context, 'POST', f'/participants/projects/{PRIVATE_PROJECT}', claims=USER, body={})[0] == 403
    assert call(lambda_context, 'GET', f'/participants/projects/{PRIVATE_PROJECT}', claims=outsider)[0] == 404
    assert call(lambda_context, 'DELETE', f'/participants/projects/{PRIVATE_PROJECT}/lists/lst_0000000000000000',
                claims=outsider)[0] == 404
    assert call(lambda_context, 'POST', f'/participants/projects/{PRIVATE_PROJECT}', claims=OWNER, body={})[0] == 200
    assert call(lambda_context, 'GET', '/participants/projects/proj-missing')[0] == 404
    assert call(lambda_context, 'GET', '/participants/projects/bad id!')[0] == 404


# ── Creating an ask ───────────────────────────────────────────────────────────

def test_creating_an_ask_queues_recipients_and_starts_the_job(world, lambda_context):
    a, b = _people(lambda_context, 'a@example.com', 'b@example.com')
    list_id = ok(lambda_context, 'POST', '/participants/lists', 201, body={'name': 'L', 'kind': 'beta'})['list']['list_id']
    ok(lambda_context, 'POST', f'/participants/lists/{list_id}/members', body={'person_ids': [a, b]})
    ask = _ask(lambda_context, list_ids=[list_id], person_ids=[a], project_id=PUBLIC_PROJECT)['ask']
    assert ask['status'] == 'queued'
    assert ask['counts'] == {'recipients': 2, 'sent': 0, 'failed': 0, 'skipped': 0, 'responded': 0}
    assert ask['link'] == {'kind': 'form', 'form_id': 'form-1',
                           'url': f'https://{API_HOST}/v1/feedback-forms/form-1/iframe'}
    assert ask['project_id'] == PUBLIC_PROJECT
    assert 'created_by_email' not in ask
    assert 'api_base' not in ask
    world.invoke.assert_called_once_with('voc-engagement-api', {'engagement_job': 'send_ask', 'ask_id': ask['ask_id']})
    listed = ok(lambda_context, 'GET', '/participants/asks')['asks']
    assert [entry['ask_id'] for entry in listed] == [ask['ask_id']]
    by_project = ok(lambda_context, 'GET', '/participants/asks', query={'project_id': PUBLIC_PROJECT})['asks']
    assert len(by_project) == 1


@pytest.mark.parametrize(('body', 'status', 'error'), [
    ({}, 400, 'no_recipients'),
    ({'person_ids': ['per_0000000000000000']}, 404, None),
    ({'list_ids': ['lst_0000000000000000']}, 404, None),
    ({'subject': ''}, 400, None),
    ({'subject': 'x' * 161}, 400, None),
    ({'message': 'x' * 4001}, 400, None),
    ({'link': {'kind': 'url', 'url': 'http://example.com'}}, 400, None),
    ({'link': {'kind': 'url', 'url': 'javascript:alert(1)'}}, 400, None),
    ({'link': {'kind': 'form', 'form_id': 'missing'}}, 400, 'form_not_found'),
    ({'link': {'kind': 'form', 'form_id': '../x'}}, 400, None),
    ({'link': None}, 400, None),
    ({'project_id': 'proj-missing'}, 404, None),
])
def test_invalid_asks_are_refused(world, lambda_context, body, status, error):
    (person,) = _people(lambda_context, 'a@example.com')
    payload = {'person_ids': [person], **body} if body else {}
    answer = _ask(lambda_context, expected=status, **payload)
    if error:
        assert answer['error'] == error
    world.invoke.assert_not_called()


@pytest.mark.usefixtures('world')
def test_an_ask_on_a_viewed_project_needs_edit(lambda_context):
    (person,) = _people(lambda_context, 'a@example.com')
    answer = _ask(lambda_context, 403, claims=USER, person_ids=[person], project_id=PRIVATE_PROJECT)
    assert answer['success'] is False


def test_asks_need_email_to_be_configured(lambda_context):
    with engagement_world(EMAIL_FROM=''):
        status, body = call(lambda_context, 'POST', '/participants/asks', body={})
    assert (status, body['error']) == (409, 'email_not_configured')


def test_more_than_500_recipients_is_refused(world, lambda_context):
    with world.participants.batch_writer() as batch:
        for i in range(501):
            person_id = f'per_{i:016x}'
            batch.put_item(Item={'pk': 'LIST#lst_00000000000000aa', 'sk': f'MEMBER#{person_id}', 'person_id': person_id})
    world.participants.put_item(Item={'pk': 'LIST#lst_00000000000000aa', 'sk': 'META', 'list_id': 'lst_00000000000000aa',
                                      'name': 'Big', 'member_count': 501})
    assert _ask(lambda_context, 400, list_ids=['lst_00000000000000aa'])['error'] == 'too_many_recipients'


@pytest.mark.usefixtures('world')
def test_the_daily_cap_is_checked_before_queueing(lambda_context):
    ids = _people(lambda_context, 'a@example.com', 'b@example.com', 'c@example.com')
    ok(lambda_context, 'PUT', '/participants/settings', body={'daily_send_cap': 2})
    status, body = call(lambda_context, 'POST', '/participants/asks', body={
        'person_ids': ids, 'subject': 's', 'message': 'm', 'link': {'kind': 'url', 'url': 'https://example.com/s'}})
    assert (status, body['error']) == (429, 'daily_cap')


def test_unsubscribed_only_recipients_are_no_recipients(world, lambda_context):
    (person,) = _people(lambda_context, 'a@example.com')
    _mark_unsubscribed(world, person)
    assert _ask(lambda_context, 400, person_ids=[person])['error'] == 'no_recipients'


@pytest.mark.usefixtures('world')
def test_ask_lists_hide_projects_the_caller_cannot_view(lambda_context):
    (person,) = _people(lambda_context, 'a@example.com')
    _ask(lambda_context, person_ids=[person], project_id=PRIVATE_PROJECT)
    plain = _ask(lambda_context, person_ids=[person])['ask']
    outsider = {**USER, 'sub': 'outsider-sub'}
    assert [a['ask_id'] for a in ok(lambda_context, 'GET', '/participants/asks', claims=outsider)['asks']] == \
        [plain['ask_id']]
    assert len(ok(lambda_context, 'GET', '/participants/asks', claims=USER)['asks']) == 2
    assert call(lambda_context, 'GET', '/participants/asks', claims=outsider,
                query={'project_id': PRIVATE_PROJECT})[0] == 404
    private_id = next(a['ask_id'] for a in ok(lambda_context, 'GET', '/participants/asks')['asks']
                      if a.get('project_id') == PRIVATE_PROJECT)
    assert call(lambda_context, 'GET', f'/participants/asks/{private_id}', claims=outsider)[0] == 404
    assert call(lambda_context, 'GET', '/participants/asks/ask_0000000000000000')[0] == 404


# ── The send job ──────────────────────────────────────────────────────────────

def test_the_job_sends_one_email_per_active_recipient(world, lambda_context):
    a, b = _people(lambda_context, 'a@example.com', 'b@example.com')
    _mark_unsubscribed(world, b)
    ask = _ask(lambda_context, person_ids=[a, b])['ask']
    run_send_job(lambda_context, world)
    (request,) = _sent_requests(world)
    assert request['FromEmailAddress'] == 'Example Air <noreply@voc.example.com>'
    assert request['Destination'] == {'ToAddresses': ['a@example.com']}
    assert request['ReplyToAddresses'] == ['ada@example.com']
    simple = request['Content']['Simple']
    assert simple['Subject']['Data'] == 'Your opinion'
    html = simple['Body']['Html']['Data']
    assert 'Tell us &lt;more&gt;.' in html
    assert '<more>' not in html
    headers = {h['Name']: h['Value'] for h in simple['Headers']}
    assert headers['List-Unsubscribe-Post'] == 'List-Unsubscribe=One-Click'
    assert headers['List-Unsubscribe'].startswith(f'<https://{API_HOST}/v1/unsubscribe?t=')
    text = simple['Body']['Text']['Data']
    assert f'https://{API_HOST}/v1/feedback-forms/form-1/iframe?r=' in text
    assert 'Unsubscribe: https://voc.example.com/unsubscribe?t=' in text
    detail = ok(lambda_context, 'GET', f'/participants/asks/{ask["ask_id"]}')
    assert detail['ask']['status'] == 'sent'
    assert detail['ask']['counts'] == {'recipients': 2, 'sent': 1, 'failed': 0, 'skipped': 1, 'responded': 0}
    statuses = {r['person_id']: r['status'] for r in detail['recipients']}
    assert statuses == {a: 'sent', b: 'skipped_unsubscribed'}
    person = ok(lambda_context, 'GET', f'/participants/people/{a}')
    assert person['asks'][0]['status'] == 'sent'
    # Only hashes are stored: the token in the email is not a key anywhere.
    token = text.split('?r=')[1].split()[0]
    assert world.participants.get_item(Key=token_key(token, RESPONSE_SK))['Item']['person_id'] == a
    assert not [row for row in world.participants.scan()['Items'] if token in str(row)]


def test_a_repeated_job_event_sends_nothing_twice(world, lambda_context):
    (a,) = _people(lambda_context, 'a@example.com')
    ask = _ask(lambda_context, person_ids=[a])['ask']
    run_send_job(lambda_context, world)
    import engagement_handler
    engagement_handler.lambda_handler({'engagement_job': 'send_ask', 'ask_id': ask['ask_id']}, lambda_context)
    assert world.ses.send_email.call_count == 1


def test_a_refused_send_records_the_code_and_never_the_message(world, lambda_context):
    a, b = _people(lambda_context, 'a@example.com', 'b@example.com')
    refusal = ClientError({'Error': {'Code': 'MessageRejected', 'Message': 'Email address a@example.com is bad'}},
                          'SendEmail')
    world.ses.send_email.side_effect = [refusal, {'MessageId': 'm'}]
    ask = _ask(lambda_context, person_ids=[a, b])['ask']
    run_send_job(lambda_context, world)
    detail = ok(lambda_context, 'GET', f'/participants/asks/{ask["ask_id"]}')
    errors = sorted((r['status'], r['error']) for r in detail['recipients'])
    assert errors == [('failed', 'MessageRejected'), ('sent', None)]
    assert detail['ask']['status'] == 'sent'
    assert 'is bad' not in str(world.participants.scan()['Items'])


def test_every_send_failing_fails_the_ask(world, lambda_context):
    (a,) = _people(lambda_context, 'a@example.com')
    world.ses.send_email.side_effect = ClientError({'Error': {'Code': 'Throttling: <x>', 'Message': 'm'}}, 'SendEmail')
    ask = _ask(lambda_context, person_ids=[a])['ask']
    run_send_job(lambda_context, world)
    detail = ok(lambda_context, 'GET', f'/participants/asks/{ask["ask_id"]}')
    assert detail['ask']['status'] == 'failed'
    assert detail['recipients'][0]['error'] == 'send_error'


def test_the_cap_stops_sending_mid_job(world, lambda_context):
    ids = _people(lambda_context, 'a@example.com', 'b@example.com', 'c@example.com')
    ask = _ask(lambda_context, person_ids=ids)['ask']
    ok(lambda_context, 'PUT', '/participants/settings', body={'daily_send_cap': 2})
    run_send_job(lambda_context, world)
    detail = ok(lambda_context, 'GET', f'/participants/asks/{ask["ask_id"]}')
    assert detail['ask']['counts']['sent'] == 2
    assert [r['error'] for r in detail['recipients'] if r['status'] == 'failed'] == ['daily_cap']
    today = next(row for row in world.participants.scan()['Items']
                 if row['pk'].startswith('SENDCOUNT#') and row['sk'] == 'COUNT')
    assert today['count'] == 2
    assert today['ttl'] > 0


# ── The per-sender daily cap (BE-4) ───────────────────────────────────────────

@pytest.fixture
def sender_cap_of_two(monkeypatch):
    """The 50-a-day sender cap, lowered to 2 where the route and the send job read it."""
    from shared import participants_ask_routes, participants_asks
    monkeypatch.setattr(participants_asks, 'PER_SENDER_DAILY_CAP', 2)
    monkeypatch.setattr(participants_ask_routes, 'PER_SENDER_DAILY_CAP', 2)


def _send_counts(world):
    return {row['sk']: int(row['count']) for row in world.participants.scan()['Items'] if row['pk'].startswith('SENDCOUNT#')}


@pytest.mark.usefixtures('world', 'sender_cap_of_two')
def test_the_sender_cap_is_checked_before_queueing(lambda_context):
    ids = _people(lambda_context, 'a@example.com', 'b@example.com', 'c@example.com')
    assert _ask(lambda_context, 429, claims=USER, person_ids=ids)['error'] == 'sender_daily_cap'


@pytest.mark.usefixtures('sender_cap_of_two')
def test_an_administrators_ask_is_bounded_by_the_deployment_cap_only(world, lambda_context):
    ids = _people(lambda_context, 'a@example.com', 'b@example.com', 'c@example.com')
    _ask(lambda_context, person_ids=ids)
    run_send_job(lambda_context, world)
    assert _send_counts(world) == {'COUNT': 3}


def test_the_sender_cap_is_fifty_a_day():
    from shared.participants_asks import PER_SENDER_DAILY_CAP
    assert PER_SENDER_DAILY_CAP == 50


@pytest.mark.usefixtures('sender_cap_of_two')
def test_the_sender_cap_stops_sending_mid_job_and_counts_nothing_it_refused(world, lambda_context):
    ids = _people(lambda_context, 'a@example.com', 'b@example.com')
    first = _ask(lambda_context, claims=USER, person_ids=ids)['ask']
    (third,) = _people(lambda_context, 'c@example.com')
    second = _ask(lambda_context, claims=USER, person_ids=[third])['ask']
    run_send_job(lambda_context, world)
    run_send_job(lambda_context, world)
    errors = [r['error'] for r in ok(lambda_context, 'GET', f'/participants/asks/{second["ask_id"]}')['recipients']]
    assert ok(lambda_context, 'GET', f'/participants/asks/{first["ask_id"]}')['ask']['counts']['sent'] == 2
    assert errors == ['sender_daily_cap']
    assert _send_counts(world) == {'COUNT': 2, f'SENDER#{USER["sub"]}': 2}


def test_a_deployment_cap_refusal_gives_the_sender_claim_back(world, lambda_context):
    ids = _people(lambda_context, 'a@example.com', 'b@example.com', 'c@example.com')
    _ask(lambda_context, claims=USER, person_ids=ids)
    ok(lambda_context, 'PUT', '/participants/settings', body={'daily_send_cap': 2})
    run_send_job(lambda_context, world)
    assert _send_counts(world) == {'COUNT': 2, f'SENDER#{USER["sub"]}': 2}


def test_an_ask_without_a_sender_counts_against_the_deployment_cap_only(world):
    from shared.participants_asks import claim_send
    assert claim_send(world.participants, 5, '') is None
    assert _send_counts(world) == {'COUNT': 1}


def test_a_failing_deployment_claim_gives_the_sender_claim_back_and_propagates(world, monkeypatch):
    from shared import participants_asks
    real = participants_asks._claim

    def deployment_claim_fails(table, key, cap, now):
        if key['sk'] == 'COUNT':
            raise ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'x'}}, 'UpdateItem')
        return real(table, key, cap, now)

    monkeypatch.setattr(participants_asks, '_claim', deployment_claim_fails)
    with pytest.raises(ClientError):
        participants_asks.claim_send(world.participants, 5, 'sub-1')
    assert _send_counts(world) == {'SENDER#sub-1': 0}


def test_the_job_continues_with_a_cursor(world, lambda_context, monkeypatch):
    monkeypatch.setattr(participants_send, 'SEND_BATCH', 2)
    ids = _people(lambda_context, 'a@example.com', 'b@example.com', 'c@example.com')
    ask = _ask(lambda_context, person_ids=ids)['ask']
    events = run_send_job(lambda_context, world)
    assert len(events) == 2
    assert events[1]['cursor'].startswith('RCPT#')
    assert world.ses.send_email.call_count == 3
    assert ok(lambda_context, 'GET', f'/participants/asks/{ask["ask_id"]}')['ask']['status'] == 'sent'


def test_the_job_stops_before_the_lambda_times_out(world, lambda_context):
    ids = _people(lambda_context, 'a@example.com', 'b@example.com')
    _ask(lambda_context, person_ids=ids)
    payload = world.invoke.call_args.args[1]
    low_time = MagicMock()
    low_time.get_remaining_time_in_millis.return_value = 1000
    result = participants_send.run(payload, low_time)
    assert result['status'] == 'sending'
    assert world.ses.send_email.call_count == 1
    assert world.invoke.call_args.args[1]['cursor'] == result['cursor']


@pytest.mark.usefixtures('world')
def test_the_job_ignores_bad_events(lambda_context):
    assert participants_send.run({'engagement_job': 'send_ask', 'ask_id': 'nope'}, lambda_context) == {'status': 'ignored'}
    assert participants_send.run({'engagement_job': 'send_ask', 'ask_id': 'ask_0000000000000000'},
                                 lambda_context) == {'status': 'ignored'}
    assert not participants_send.is_send_event({'engagement_job': 'send_ask', 'httpMethod': 'POST'})


def test_the_job_fails_the_ask_when_email_was_turned_off(world, lambda_context, monkeypatch):
    (a,) = _people(lambda_context, 'a@example.com')
    ask = _ask(lambda_context, person_ids=[a])['ask']
    monkeypatch.setenv('EMAIL_FROM', '')
    run_send_job(lambda_context, world)
    world.ses.send_email.assert_not_called()
    assert ok(lambda_context, 'GET', f'/participants/asks/{ask["ask_id"]}')['ask']['status'] == 'failed'


def test_an_erased_recipient_fails_as_erased(world, lambda_context):
    a, b = _people(lambda_context, 'a@example.com', 'b@example.com')
    ask = _ask(lambda_context, person_ids=[a, b])['ask']
    ok(lambda_context, 'DELETE', f'/participants/people/{b}')
    run_send_job(lambda_context, world)
    detail = ok(lambda_context, 'GET', f'/participants/asks/{ask["ask_id"]}')
    assert sorted((r['status'], r['error']) for r in detail['recipients']) == [('failed', 'erased'), ('sent', None)]


def test_a_url_link_carries_no_response_token(world, lambda_context):
    (a,) = _people(lambda_context, 'a@example.com')
    _ask(lambda_context, person_ids=[a], link={'kind': 'url', 'url': 'https://survey.example.com/s'})
    run_send_job(lambda_context, world)
    text = _sent_requests(world)[0]['Content']['Simple']['Body']['Text']['Data']
    assert 'https://survey.example.com/s\n' in text
    assert not [row for row in world.participants.scan()['Items'] if row['sk'] == RESPONSE_SK]


# ── Unsubscribe ───────────────────────────────────────────────────────────────

def _unsubscribe_token(world, lambda_context, email='a@example.com'):
    (person,) = _people(lambda_context, email)
    _ask(lambda_context, person_ids=[person])
    run_send_job(lambda_context, world)
    text = _sent_requests(world)[-1]['Content']['Simple']['Body']['Text']['Data']
    return person, text.split('/unsubscribe?t=')[1].split()[0]


def test_one_click_unsubscribe_posts_the_token_in_the_url(world, lambda_context):
    person, token = _unsubscribe_token(world, lambda_context)
    status, body = call(lambda_context, 'POST', '/unsubscribe', claims=None, query={'t': token},
                        raw_body='List-Unsubscribe=One-Click')
    assert (status, body) == (200, {'success': True})
    assert ok(lambda_context, 'GET', f'/participants/people/{person}')['person']['status'] == 'unsubscribed'


def test_the_unsubscribe_page_posts_the_token_as_json(world, lambda_context):
    person, token = _unsubscribe_token(world, lambda_context)
    assert call(lambda_context, 'POST', '/unsubscribe', claims=None, body={'token': token}) == (200, {'success': True})
    assert ok(lambda_context, 'GET', f'/participants/people/{person}')['person']['status'] == 'unsubscribed'
    # Idempotent, and an unsubscribed person is skipped by the next ask.
    assert call(lambda_context, 'POST', '/unsubscribe', claims=None, body={'token': token})[0] == 200


@pytest.mark.usefixtures('world')
@pytest.mark.parametrize('kwargs', [
    {'body': {'token': 'x' * 32}}, {'body': {'token': 5}}, {'body': None}, {'raw_body': 'not json'},
    {'query': {'t': 'short'}}, {'body': ['token']},
])
def test_unknown_tokens_still_answer_200(lambda_context, kwargs):
    assert call(lambda_context, 'POST', '/unsubscribe', claims=None, **kwargs) == (200, {'success': True})


@pytest.mark.usefixtures('world')
def test_unsubscribe_answers_200_when_the_store_fails(lambda_context, monkeypatch):
    def broken(*_args, **_kwargs):
        raise ClientError({'Error': {'Code': 'InternalServerError', 'Message': 'x'}}, 'GetItem')
    monkeypatch.setattr('shared.participants_ask_routes.resolve_token', broken)
    assert call(lambda_context, 'POST', '/unsubscribe', claims=None, body={'token': 'y' * 32}) == \
        (200, {'success': True})
