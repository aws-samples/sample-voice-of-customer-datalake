"""Pure pieces of the engagement domain: the mailer request, settings parsing, ids and emails."""
from __future__ import annotations

from decimal import Decimal

import boto3
import pytest
from botocore.exceptions import BotoCoreError, ClientError

from shared import participant_mailer, participants_settings
from shared.engagement_common import is_id, new_id, new_token, normalize_email
from shared.participants_send import error_code


def _email(**overrides):
    values = {'to': 'pat@example.com', 'subject': 'Your view', 'message': 'Line one\nline two\n\n<b>Para</b>',
              'link': 'https://api.example/v1/feedback-forms/f/iframe?r=T&x=1', 'sender_name': 'Example Air',
              'unsubscribe_page': 'https://voc.example.com/unsubscribe?t=U',
              'unsubscribe_post': 'https://api.example/v1/unsubscribe?t=U', 'reply_to': 'ada@example.com',
              'recipient_name': 'Pat <3'}
    return participant_mailer.AskEmail(**{**values, **overrides})


def test_the_installed_sesv2_model_accepts_custom_headers_in_simple_content():
    simple = boto3.client('sesv2', region_name='us-east-1').meta.service_model.operation_model('SendEmail') \
        .input_shape.members['Content'].members['Simple']
    assert 'Headers' in simple.members


def test_the_send_request_shape():
    request = participant_mailer.send_request(_email(), 'noreply@voc.example.com')
    assert request['FromEmailAddress'] == 'Example Air <noreply@voc.example.com>'
    assert request['ReplyToAddresses'] == ['ada@example.com']
    simple = request['Content']['Simple']
    assert simple['Subject'] == {'Data': 'Your view', 'Charset': 'UTF-8'}
    assert simple['Headers'] == [
        {'Name': 'List-Unsubscribe', 'Value': '<https://api.example/v1/unsubscribe?t=U>'},
        {'Name': 'List-Unsubscribe-Post', 'Value': 'List-Unsubscribe=One-Click'},
    ]
    assert 'ReplyToAddresses' not in participant_mailer.send_request(_email(reply_to=''), 'n@voc.example.com')


def test_a_sender_name_with_special_characters_is_quoted():
    request = participant_mailer.send_request(_email(sender_name='Acme, Inc.'), 'n@voc.example.com')
    assert request['FromEmailAddress'] == '"Acme, Inc." <n@voc.example.com>'


def test_the_html_body_escapes_every_user_value():
    html = participant_mailer.html_body(_email())
    assert '&lt;b&gt;Para&lt;/b&gt;' in html
    assert 'Pat &lt;3' in html
    assert 'Line one<br>line two' in html
    assert 'href="https://api.example/v1/feedback-forms/f/iframe?r=T&amp;x=1"' in html
    assert 'You get this because Example Air added you to a participant list.' in html


def test_the_text_body_carries_the_link_and_the_footer():
    text = participant_mailer.text_body(_email(recipient_name=''))
    assert text.startswith('Line one')
    assert 'Share your feedback: https://api.example/v1/feedback-forms/f/iframe?r=T&x=1' in text
    assert text.endswith('Unsubscribe: https://voc.example.com/unsubscribe?t=U\n')


def test_settings_read_leniently_from_dynamodb():
    item = {'company_domains': ['example.com', 'NOT A DOMAIN', 7], 'allow_external_people': False,
            'daily_send_cap': Decimal('42'), 'sender_name': '  Team  '}
    assert participants_settings.from_item(item, 'Brand') == {
        'company_domains': ['example.com'], 'allow_external_people': False, 'daily_send_cap': 42,
        'sender_name': 'Team'}
    assert participants_settings.from_item({'daily_send_cap': Decimal('99999')})['daily_send_cap'] == 5000
    assert participants_settings.from_item({'daily_send_cap': 'x'})['daily_send_cap'] == 500
    assert participants_settings.from_item(None, '')['sender_name'] == 'Customer research'


def test_company_email_is_an_exact_domain_match():
    settings = {'company_domains': ['example.com'], 'allow_external_people': False}
    assert participants_settings.is_company_email(settings, 'a@example.com')
    assert not participants_settings.is_company_email(settings, 'a@sub.example.com')
    assert not participants_settings.may_add_person(settings, 'a@acme.example')
    assert participants_settings.may_add_person({**settings, 'allow_external_people': True}, 'a@acme.example')


def test_ids_tokens_and_emails():
    person_id = new_id('per')
    assert is_id(person_id, 'per')
    assert not is_id(person_id, 'lst')
    assert not is_id(person_id + '\n', 'per')
    assert len(new_token()) == 32
    assert normalize_email('  Pat@Example.COM ') == ('Pat@Example.COM', 'pat@example.com')
    for bad in ('', 'pat', 'pat@', '@example.com', 'p t@example.com', 'pat@example', 'a@b@c.example', None, 5,
                'x' * 250 + '@example.com'):
        with pytest.raises(ValueError, match='invalid_email'):
            normalize_email(bad)


def test_a_send_error_is_recorded_as_a_safe_code():
    def client_error(code):
        return ClientError({'Error': {'Code': code, 'Message': 'pat@example.com is suppressed'}}, 'SendEmail')
    assert error_code(client_error('MessageRejected')) == 'MessageRejected'
    assert error_code(client_error('Bad code with spaces')) == 'send_error'
    assert error_code(BotoCoreError()) == 'send_error'
