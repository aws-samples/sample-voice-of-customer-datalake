"""The board pool's PreSignUp and CustomMessage triggers (auth/board_triggers.py)."""
from __future__ import annotations

import re
import time

import pytest
from moto import mock_aws

from auth import board_triggers
from shared.participants_settings import BOARD_AUDIENCE_KEY, SETTINGS_KEY
from shared.review_share_audience import share_key
from shared.test.moto_tables import create_pk_sk_table


@pytest.fixture
def settings_table(monkeypatch):
    monkeypatch.setenv('PARTICIPANTS_TABLE', 'participants')
    monkeypatch.setenv('FRONTEND_URL', 'https://voc.example.com/')
    with mock_aws():
        table = create_pk_sk_table('participants')
        table.put_item(Item={**SETTINGS_KEY, 'company_domains': ['example.com', 'acme.example']})
        monkeypatch.setattr(board_triggers, '_table', None)
        yield table
    monkeypatch.setattr(board_triggers, '_table', None)


def _sign_up(email, source='PreSignUp_SignUp'):
    return {'triggerSource': source, 'request': {'userAttributes': {'email': email}}, 'response': {}}


@pytest.mark.parametrize('email', ['ann@example.com', ' Ann@EXAMPLE.com ', 'bo@acme.example'])
@pytest.mark.usefixtures('settings_table')
def test_an_allowed_domain_signs_up_but_is_never_auto_confirmed(email):
    # 5.45.00: Cognito's confirmation code proves the inbox; auto-confirming let a chosen
    # password sign in as an address its owner never confirmed.
    answer = board_triggers.pre_sign_up_handler(_sign_up(email), None)
    assert answer['response'] == {}


@pytest.mark.parametrize('email', ['eve@elsewhere.example', 'eve@eu.example.com', 'eve@example.com.evil',
                                   '', None, '@example.com', 'a@b@example.com'])
@pytest.mark.usefixtures('settings_table')
def test_any_other_address_is_refused(email):
    with pytest.raises(board_triggers.SignUpRefusedError, match='domain_not_allowed'):
        board_triggers.pre_sign_up_handler(_sign_up(email), None)


@pytest.mark.usefixtures('settings_table')
def test_a_refusal_carries_only_the_stable_code_the_spa_matches():
    # Cognito wraps the message as "PreSignUp failed with error domain_not_allowed." (boardAuth.ts).
    with pytest.raises(board_triggers.SignUpRefusedError) as refused:
        board_triggers.pre_sign_up_handler(_sign_up('eve@elsewhere.example'), None)
    assert refused.value.args == ('domain_not_allowed',)
    assert str(refused.value) == 'domain_not_allowed'
    assert refused.value.__cause__ is None
    assert refused.value.__context__ is None


def test_an_empty_domain_list_lets_nobody_in(settings_table):
    settings_table.put_item(Item={**SETTINGS_KEY, 'company_domains': []})
    with pytest.raises(board_triggers.SignUpRefusedError):
        board_triggers.pre_sign_up_handler(_sign_up('ann@example.com'), None)


def test_no_settings_row_lets_nobody_in(settings_table):
    settings_table.delete_item(Key=SETTINGS_KEY)
    with pytest.raises(board_triggers.SignUpRefusedError):
        board_triggers.pre_sign_up_handler(_sign_up('ann@example.com'), None)


def test_no_table_configured_refuses(monkeypatch):
    monkeypatch.delenv('PARTICIPANTS_TABLE', raising=False)
    with pytest.raises(board_triggers.SignUpRefusedError):
        board_triggers.pre_sign_up_handler(_sign_up('ann@example.com'), None)


@pytest.mark.usefixtures('settings_table')
def test_an_admin_created_user_is_checked_but_not_auto_confirmed():
    answer = board_triggers.pre_sign_up_handler(_sign_up('ann@example.com', 'PreSignUp_AdminCreateUser'), None)
    assert answer['response'] == {}


def _message(source='CustomMessage_Authentication', email='ann+x@example.com'):
    return {'triggerSource': source, 'request': {'codeParameter': '{####}', 'userAttributes': {'email': email}},
            'response': {'emailSubject': None, 'emailMessage': None}}


@pytest.mark.usefixtures('settings_table')
def test_the_sign_in_email_has_the_code_and_the_link():
    answer = board_triggers.custom_message_handler(_message(), None)['response']
    assert answer['emailSubject'] == 'Your sign-in code'
    message = answer['emailMessage']
    assert message.count('{####}') == 3
    assert 'href="https://voc.example.com/board/login?email=ann%2Bx%40example.com&amp;code={####}"' in message


@pytest.mark.usefixtures('settings_table')
def test_a_plain_text_reader_still_sees_the_link_as_text():
    message = board_triggers.custom_message_handler(_message(), None)['response']['emailMessage']
    visible = re.sub(r'<[^>]+>', '', message)
    assert 'Or open this link: https://voc.example.com/board/login?email=ann%2Bx%40example.com&amp;code={####}' in visible


@pytest.mark.usefixtures('settings_table')
def test_the_link_is_html_escaped():
    message = board_triggers.custom_message_handler(_message(email='"><script>@example.com'), None)
    body = message['response']['emailMessage']
    assert '<script>' not in body
    assert 'email=%22%3E%3Cscript%3E%40example.com' in body


@pytest.mark.usefixtures('settings_table')
def test_without_a_frontend_only_the_code_is_sent(monkeypatch):
    monkeypatch.setenv('FRONTEND_URL', '')
    body = board_triggers.custom_message_handler(_message(), None)['response']['emailMessage']
    assert '{####}' in body
    assert 'href' not in body


@pytest.mark.parametrize('source', ['CustomMessage_SignUp', 'CustomMessage_ResendCode', 'CustomMessage_ForgotPassword',
                                    'CustomMessage_Authentication'])
@pytest.mark.usefixtures('settings_table')
def test_every_emailed_code_is_the_sign_in_email_with_its_link(source):
    answer = board_triggers.custom_message_handler(_message(source), None)['response']
    assert answer['emailSubject'] == 'Your sign-in code'
    assert '/board/login?email=ann%2Bx%40example.com&amp;code={####}' in answer['emailMessage']


@pytest.mark.parametrize('source', ['CustomMessage_AdminCreateUser', 'CustomMessage_UpdateUserAttribute',
                                    'CustomMessage_VerifyUserAttribute'])
def test_other_messages_keep_the_cognito_default(source):
    event = _message(source)
    assert board_triggers.custom_message_handler(event, None)['response'] == {'emailSubject': None,
                                                                             'emailMessage': None}


@pytest.mark.usefixtures('settings_table')
def test_one_entry_point_serves_both_triggers():
    assert board_triggers.handler(_sign_up('ann@example.com'), None)['response'] == {}
    assert '{####}' in board_triggers.handler(_message(), None)['response']['emailMessage']
    other = {'triggerSource': 'PostConfirmation_ConfirmSignUp', 'response': {}}
    assert board_triggers.handler(other, None) is other
    with pytest.raises(board_triggers.SignUpRefusedError):
        board_triggers.handler(_sign_up('eve@elsewhere.example'), None)


# ── The feedback boards' audience row (SETTINGS / board_audience) ─────────────

def _audience(table, **row):
    table.put_item(Item={**BOARD_AUDIENCE_KEY, 'company': False, 'anyone': False, 'domains': [], 'emails': [], **row})


def _admitted(email):
    try:
        board_triggers.pre_sign_up_handler(_sign_up(email), None)
    except board_triggers.SignUpRefusedError:
        return False
    return True


def test_a_list_board_admits_its_domains_and_addresses(settings_table):
    _audience(settings_table, domains=['partner.example'], emails=['solo@elsewhere.example'])
    assert _admitted('pia@partner.example')
    assert _admitted('Solo@Elsewhere.example')
    assert not _admitted('other@elsewhere.example')
    # No company board: the company domains alone no longer admit.
    assert not _admitted('ann@example.com')


def test_a_company_board_admits_the_company_domains(settings_table):
    _audience(settings_table, company=True)
    assert _admitted('ann@example.com')
    assert not _admitted('pia@partner.example')


def test_an_anyone_board_admits_any_address(settings_table):
    _audience(settings_table, anyone=True)
    assert _admitted('eve@anywhere.example')
    assert not _admitted('not-an-address')


def test_without_an_audience_row_the_company_domains_decide(settings_table):
    assert settings_table.get_item(Key=BOARD_AUDIENCE_KEY).get('Item') is None
    assert _admitted('ann@example.com')
    assert not _admitted('pia@partner.example')


# ── Document review links (DOCSHARE#{id} / META in the projects table) ────────

SHARE_ID = 'shr_' + 'a' * 32


@pytest.fixture
def projects_table(settings_table, monkeypatch):
    """A projects table beside the participants one (same moto context)."""
    del settings_table
    monkeypatch.setenv('PROJECTS_TABLE', 'projects')
    table = create_pk_sk_table('projects')
    monkeypatch.setattr(board_triggers, '_projects', None)
    yield table
    monkeypatch.setattr(board_triggers, '_projects', None)


def _link(table, *, expires_in=3600, revoked=False, audience=None):
    table.put_item(Item={**share_key(SHARE_ID), 'revoked': revoked, 'expires_at_epoch': int(time.time()) + expires_in,
                         'audience': audience or {'mode': 'anyone', 'domains': [], 'emails': []}})


def _review_sign_up(email, share_id=SHARE_ID):
    event = _sign_up(email)
    event['request']['clientMetadata'] = {'share_id': share_id}
    return event


def _review_admitted(email, share_id=SHARE_ID):
    try:
        board_triggers.pre_sign_up_handler(_review_sign_up(email, share_id), None)
    except board_triggers.SignUpRefusedError:
        return False
    return True


def test_an_active_anyone_link_admits_an_address_no_board_admits(projects_table):
    _link(projects_table)
    assert _review_admitted('reviewer@elsewhere.example')
    assert not _admitted('reviewer@elsewhere.example'), 'without the share id the boards alone decide'


def test_a_list_link_admits_only_its_domains_and_addresses(projects_table):
    _link(projects_table, audience={'mode': 'list', 'domains': ['partner.example'], 'emails': ['Solo@Other.example']})
    assert _review_admitted('pia@partner.example')
    assert _review_admitted('solo@other.example')
    assert not _review_admitted('eve@other.example')


@pytest.mark.parametrize(('expires_in', 'revoked'), [(-1, False), (3600, True)])
def test_an_expired_or_revoked_link_admits_nobody(projects_table, expires_in, revoked):
    _link(projects_table, expires_in=expires_in, revoked=revoked)
    assert not _review_admitted('reviewer@elsewhere.example')


@pytest.mark.parametrize('share_id', ['shr_' + 'b' * 32, 'shr_short', 'DOCSHARE#x', None, 7])
def test_an_unknown_or_malformed_share_id_admits_nobody(projects_table, share_id):
    _link(projects_table)
    assert not _review_admitted('reviewer@elsewhere.example', share_id)


@pytest.mark.usefixtures('projects_table')
def test_a_review_link_still_lets_a_board_address_in():
    assert _review_admitted('ann@example.com'), 'no link row: the company domains still decide'


def test_a_review_link_sign_up_is_not_auto_confirmed_either(projects_table):
    _link(projects_table)
    assert board_triggers.pre_sign_up_handler(_review_sign_up('reviewer@elsewhere.example'), None)['response'] == {}
