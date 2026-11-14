"""The app pool's CustomMessage trigger (auth/user_messages.py): who invited you, to what, and what to do."""
from __future__ import annotations

import pytest
from moto import mock_aws

from auth import user_messages
from shared.test.moto_tables import create_pk_sk_table


@pytest.fixture
def aggregates(monkeypatch):
    monkeypatch.setenv('AGGREGATES_TABLE', 'aggregates')
    monkeypatch.setenv('SIGN_IN_URL', 'https://voc.example.com/')
    monkeypatch.delenv('WORKSHOP', raising=False)
    monkeypatch.delenv('TEMP_PASSWORD_DAYS', raising=False)
    with mock_aws():
        table = create_pk_sk_table('aggregates')
        monkeypatch.setattr(user_messages, '_table', None)
        yield table
    monkeypatch.setattr(user_messages, '_table', None)


def _invitation(metadata=None, attributes=None):
    return {
        'triggerSource': 'CustomMessage_AdminCreateUser',
        'request': {
            'usernameParameter': '{username}', 'codeParameter': '{####}',
            'userAttributes': attributes or {'email': 'new@example.com'},
            'clientMetadata': metadata or {},
        },
        'response': {},
    }


def _send(event):
    response = user_messages.handler(event, None)['response']
    return response['emailSubject'], response['emailMessage']


def _set_brand(table, name):
    table.put_item(Item={**user_messages.BRAND_KEY, 'brand_name': name})


def test_names_the_brand_and_the_inviter_when_both_are_known(aggregates):
    _set_brand(aggregates, 'Acme')
    subject, message = _send(_invitation({'invited_by': 'Luca Perrozzi'}, {'given_name': 'Ana'}))
    assert subject == 'You are invited to the Acme VoC Analytics workspace'
    assert 'Hello Ana,' in message
    assert 'Luca Perrozzi invited you to the Acme VoC Analytics workspace.' in message
    assert 'check with your VoC Analytics administrator' in message
    assert 'Acme VoC Analytics</p>' in message
    assert 'workshop' not in message.lower()


@pytest.mark.parametrize('brand', ['', 'Acme'])
def test_always_carries_both_placeholders_cognito_requires(aggregates, brand):
    # Without BOTH, Cognito silently sends the static userInvitation template instead.
    _set_brand(aggregates, brand)
    _, message = _send(_invitation())
    assert '{username}' in message
    assert '{####}' in message


@pytest.mark.usefixtures('aggregates')
def test_explains_what_voc_is():
    _, message = _send(_invitation())
    assert 'Voice of the Customer' in message


@pytest.mark.usefixtures('aggregates')
def test_points_a_workshop_participant_to_the_organizer_when_no_brand_is_set(monkeypatch):
    monkeypatch.setenv('WORKSHOP', 'true')
    subject, message = _send(_invitation())
    assert subject == 'You are invited to VoC Analytics for an AWS workshop'
    assert 'a VoC Analytics workspace set up for an AWS workshop' in message
    assert 'check with your workshop organizer' in message
    assert 'The workshop organizer created this account' in message


def test_a_configured_brand_wins_over_the_workshop_wording(aggregates, monkeypatch):
    monkeypatch.setenv('WORKSHOP', 'true')
    _set_brand(aggregates, 'Acme')
    subject, message = _send(_invitation())
    assert subject == 'You are invited to the Acme VoC Analytics workspace'
    assert 'workshop' not in message.lower()


@pytest.mark.usefixtures('aggregates')
def test_uses_neutral_wording_without_a_brand_outside_a_workshop():
    subject, message = _send(_invitation())
    assert subject == 'You are invited to VoC Analytics'
    assert 'You have been invited to a VoC Analytics workspace.' in message
    assert 'check with your VoC Analytics administrator' in message
    assert 'workshop' not in message.lower()


def test_escapes_names_it_did_not_write(aggregates):
    _set_brand(aggregates, '<b>Acme</b>')
    _, message = _send(_invitation({'invited_by': '<script>x</script>'}, {'given_name': 'A&B'}))
    assert '<script>' not in message
    assert '<b>Acme</b>' not in message
    assert '&lt;script&gt;x&lt;/script&gt;' in message
    assert 'Hello A&amp;B,' in message


@pytest.mark.parametrize(('raw', 'clean'), [
    ('Ana\r\nBcc: x@evil', 'Ana Bcc: x@evil'),
    ('  Luca   Perrozzi ', 'Luca Perrozzi'),
    (None, ''),
    (42, ''),
])
def test_cleans_names_of_control_characters_and_extra_spaces(raw, clean):
    assert user_messages.clean_name(raw) == clean


def test_caps_long_names():
    assert len(user_messages.clean_name('x' * 500)) == user_messages.MAX_NAME_CHARS


@pytest.mark.usefixtures('aggregates')
def test_uses_neutral_wording_when_the_brand_cannot_be_read(monkeypatch):
    monkeypatch.setenv('AGGREGATES_TABLE', 'missing-table')
    monkeypatch.setattr(user_messages, '_table', None)
    subject, _ = _send(_invitation())
    assert subject == 'You are invited to VoC Analytics'


@pytest.mark.usefixtures('aggregates')
@pytest.mark.parametrize(('days', 'stated'), [(None, 'works for 7 days'), ('3', 'works for 3 days'),
                                              ('0', 'works for 7 days'), ('soon', 'works for 7 days')])
def test_states_how_long_the_temporary_password_works(monkeypatch, days, stated):
    if days is not None:
        monkeypatch.setenv('TEMP_PASSWORD_DAYS', days)
    _, message = _send(_invitation())
    assert stated in message


@pytest.mark.usefixtures('aggregates')
def test_links_the_sign_in_page_without_a_trailing_slash():
    _, message = _send(_invitation())
    assert '<a href="https://voc.example.com"' in message


@pytest.mark.usefixtures('aggregates')
@pytest.mark.parametrize(('source', 'subject'), [
    ('CustomMessage_ForgotPassword', 'VoC Analytics - Reset your password'),
    ('CustomMessage_ResendCode', 'VoC Analytics - Your verification code'),
])
def test_keeps_the_reset_and_resend_emails(source, subject):
    event = {'triggerSource': source, 'request': {'codeParameter': '{####}'}, 'response': {}}
    sent_subject, message = _send(event)
    assert sent_subject == subject
    assert '{####}' in message


@pytest.mark.usefixtures('aggregates')
def test_leaves_other_messages_to_cognito():
    event = {'triggerSource': 'CustomMessage_UpdateUserAttribute', 'request': {}, 'response': {}}
    assert user_messages.handler(event, None)['response'] == {}
