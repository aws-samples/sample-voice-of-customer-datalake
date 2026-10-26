"""Parsing limits: attachment sizes from the encoded payload, decoding only what is read, nesting depth."""
from email import policy
from email.message import EmailMessage
from unittest.mock import patch

import pytest

from email_intake import mime


def _email(body: str = 'Body text') -> EmailMessage:
    message = EmailMessage(policy=policy.default)
    message['From'] = 'Ana <user@example.com>'
    message['To'] = 'feedback@voc.example.com'
    message['Subject'] = 'Feedback'
    message['Message-ID'] = '<limits-001@example.com>'
    message.set_content(body)
    return message


def _with_attachment(data: bytes, maintype: str, subtype: str, filename: str) -> bytes:
    message = _email()
    message.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)
    return message.as_bytes()


def _nested(levels: int) -> bytes:
    """An email carrying ``levels`` forwards, each attached to the next as a ``message/rfc822``."""
    message = _email('The innermost customer text')
    for _level in range(levels):
        outer = _email('FYI')
        outer.add_attachment(message)
        message = outer
    return message.as_bytes()


def test_the_nesting_limit_is_three():
    assert mime.MAX_NESTED_DEPTH == 3


def test_nested_messages_up_to_the_limit_parse():
    parsed = mime.parse_email(_nested(mime.MAX_NESTED_DEPTH))
    assert len(parsed.nested) == 1


def test_one_level_past_the_limit_is_not_an_email():
    with pytest.raises(ValueError, match='nested too deeply'):
        mime.parse_email(_nested(mime.MAX_NESTED_DEPTH + 1))


def test_an_oversized_attachment_is_sized_from_its_encoding_and_never_decoded(monkeypatch):
    monkeypatch.setattr(mime, 'MAX_DOCUMENT_BYTES', 1_000)
    raw = _with_attachment(b'%PDF' + b'x' * 3_000, 'application', 'pdf', 'big.pdf')
    with patch.object(mime, '_payload_bytes', wraps=mime._payload_bytes) as decode:
        parsed = mime.parse_email(raw)
    [attachment] = parsed.attachments
    assert (attachment.kind, attachment.data) == ('too_large', b'')
    assert attachment.size == 3_004
    decode.assert_not_called()


def test_an_unsupported_attachment_is_never_decoded():
    raw = _with_attachment(b'\x00' * 500, 'application', 'x-custom', 'data.custom')
    with patch.object(mime, '_payload_bytes', wraps=mime._payload_bytes) as decode:
        parsed = mime.parse_email(raw)
    assert [(a.kind, a.data) for a in parsed.attachments] == [('unsupported', b'')]
    decode.assert_not_called()


def test_a_readable_attachment_is_decoded_with_its_real_size():
    raw = _with_attachment(b'%PDF-1.4 tiny', 'application', 'pdf', 'small.pdf')
    [attachment] = mime.parse_email(raw).attachments
    assert (attachment.kind, attachment.size, attachment.data) == ('document', 13, b'%PDF-1.4 tiny')
