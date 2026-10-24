"""The pure parts: quote / signature / forward cleanup, subjects, guards, MIME classification."""
from email import message_from_string, policy
from email.message import EmailMessage

import pytest

from email_intake import guards, mime, text_cleanup
from email_intake.test.conftest import fixture_bytes


@pytest.mark.parametrize(('subject', 'expected'), [
    ('Re: [bug] Fwd: Checkout  broken', 'checkout broken'),
    ('AW: WG: Rechnung', 'rechnung'),
    ('RV: TR: Factura', 'factura'),
    ('Re[2]: Hi', 'hi'),
    ('Plain subject', 'plain subject'),
])
def test_normalise_subject_strips_prefixes_and_tags(subject, expected):
    assert text_cleanup.normalise_subject(subject) == expected


def test_subject_kinds_and_tags():
    assert text_cleanup.is_reply_subject('[ext] Re: x')
    assert not text_cleanup.is_reply_subject('Fwd: x')
    assert text_cleanup.is_forward_subject('FW: x')
    assert text_cleanup.subject_tags('[Bug] x [idea]') == ['bug', 'idea']


@pytest.mark.parametrize('text', [
    'New text\n\nOn Mon, 3 Mar 2026 at 10:00, Support <s@x.example> wrote:\n> old',
    'New text\n\nAm 03.03.2026 um 10:00 schrieb Support:\n> alt',
    'New text\n\nLe lun. 3 mars 2026, Support a écrit :\n> ancien',
    'New text\n-----Original Message-----\nFrom: x\nSent: y\n\nold',
    'New text\n> quoted line',
    'New text\n\n-- \nSignature',
    'New text\n\nSent from my iPhone',
    'New text\n\nKind regards,\nAna\nProduct lead',
])
def test_clean_new_text_keeps_only_the_new_part(text):
    assert text_cleanup.clean_new_text(text) == 'New text'


def test_a_mid_message_thanks_is_not_a_sign_off():
    text = 'Thanks for the update.\n' + '\n'.join(f'line {n}' for n in range(10))
    assert text_cleanup.strip_signature(text) == text


def test_split_forward_without_marker_is_none():
    assert text_cleanup.split_forward('Just a message') is None


def test_content_hash_ignores_case_and_whitespace():
    assert text_cleanup.content_hash('Hello  World') == text_cleanup.content_hash('hello world\n')


def _message(headers: str, body: str = 'Body') -> EmailMessage:
    return message_from_string(f'{headers}\n\n{body}', policy=policy.default)


_PASS = 'X-SES-Spam-Verdict: PASS\nX-SES-Virus-Verdict: PASS\n'


@pytest.mark.parametrize(('headers', 'reason'), [
    ('X-SES-Spam-Verdict: PASS\nFrom: a@b.example', 'virus'),
    ('X-SES-Virus-Verdict: PASS\nFrom: a@b.example', 'spam'),
    (_PASS + 'From: a@b.example\nX-Autoreply: yes', 'auto_reply'),
    (_PASS + 'From: a@b.example\nX-Auto-Response-Suppress: OOF', 'auto_reply'),
    (_PASS + 'From: a@b.example\nSubject: Out of office until Monday', 'auto_reply'),
    (_PASS + 'From: a@b.example\nPrecedence: list', 'bulk'),
    (_PASS + 'From: MAILER-DAEMON@b.example', 'loop_sender'),
    (_PASS + 'From: no-reply@b.example', 'loop_sender'),
    (_PASS + 'From: a@b.example\nReturn-Path: <>', 'loop_sender'),
    (_PASS + 'From: feedback@voc.example.com', 'loop_sender'),
    (_PASS + 'From: nobody', 'loop_sender'),
    (_PASS + 'From: a@b.example\nAuto-Submitted: no', None),
    (_PASS + 'X-SES-Spam-Verdict: FAIL\nFrom: a@b.example', 'spam'),
])
def test_drop_reason(headers, reason):
    assert guards.drop_reason(_message(headers), 'voc.example.com') == reason


def test_recipient_aliases_only_at_the_inbox_domain():
    message = _message('To: Bugs <bugs+app@voc.example.com>, other@else.example\nCc: ideas@VOC.example.com')
    assert mime.recipient_aliases(message, 'voc.example.com') == ['bugs', 'ideas']


def test_thread_root_prefers_references():
    message = _message('References: <a@x> <b@x>\nIn-Reply-To: <b@x>')
    assert mime.thread_root_id(message) == 'a@x'
    assert mime.thread_root_id(_message('In-Reply-To: <b@x>')) == 'b@x'
    assert mime.thread_root_id(_message('Subject: x')) is None


def test_html_only_body_becomes_text_without_quotes():
    raw = ('Content-Type: text/html\n\n<html><head><style>p{}</style></head><body><p>Hello</p>'
           '<blockquote>old</blockquote><script>x()</script></body></html>')
    assert mime.body_text(message_from_string(raw, policy=policy.default)) == 'Hello'


def test_attachment_classification():
    parsed = mime.parse_email(fixture_bytes('attachment.eml'))
    assert [(a.filename, a.kind) for a in parsed.attachments] == [
        ('invoice-2026-03.pdf', 'document'), ('screenshot.png', 'image')]
    assert parsed.skipped_count == 3  # inline logo, calendar invite, archive


def test_a_future_date_falls_back_to_now_and_non_email_is_refused():
    parsed = mime.parse_email(b'From: a@b.example\nDate: Sat, 01 Jan 2100 00:00:00 +0000\n\nx')
    assert parsed.created_at < '2100'
    with pytest.raises(ValueError, match='not an email'):
        mime.parse_email(b'')
