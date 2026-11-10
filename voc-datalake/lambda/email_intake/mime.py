"""Reading one received email: headers, body text, attachments, the alias it was sent to.

Stdlib ``email`` with ``policy.default`` (decoded headers, ``get_body`` / ``iter_attachments``);
HTML bodies become text with BeautifulSoup (in the ingestion layer). No AWS here.

Attachments are classified, never executed or unpacked:

- ``document`` / ``image``: a type Bedrock Converse can read (``CONVERSE_DOCUMENT_FORMATS``,
  ``CONVERSE_IMAGE_FORMATS``) within its size limit; read by the one summarisation call.
- ``message``: a nested ``message/rfc822`` (a forwarded ``.eml``), parsed as an email.
- ``too_large`` / ``unsupported`` / ``over_limit`` (past ``MAX_READ_ATTACHMENTS``): listed by
  name only ("not read").
- ``skipped``: inline logos (small images with a Content-ID), calendar invites,
  archives and executables. Counted, never listed, never read.

An attachment's size comes from its ENCODED payload (base64 is read as three bytes per four
characters), so only an attachment that will be read is ever decoded. A message nested
``message/rfc822`` deeper than ``MAX_NESTED_DEPTH`` is refused as not an email.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email import message_from_bytes, policy
from email.message import EmailMessage, Message, MIMEPart
from email.utils import getaddresses, parsedate_to_datetime
from typing import Final

from shared.image_limits import CONVERSE_IMAGE_FORMATS, MAX_IMAGE_BYTES

__all__ = [
    'Attachment',
    'ParsedEmail',
    'body_text',
    'parse_email',
    'recipient_aliases',
    'thread_root_id',
]

#: Converse document formats by content type (the API's document block ``format`` values).
CONVERSE_DOCUMENT_FORMATS: Final = {
    'application/pdf': 'pdf',
    'text/csv': 'csv',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/html': 'html',
    'text/plain': 'txt',
    'text/markdown': 'md',
}
_EXTENSION_TYPES: Final = {
    'pdf': 'application/pdf', 'csv': 'text/csv', 'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'html': 'text/html', 'htm': 'text/html', 'txt': 'text/plain', 'md': 'text/markdown', 'log': 'text/plain',
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp',
    'eml': 'message/rfc822',
}
#: Converse's per-document limit (4.5 MB).
MAX_DOCUMENT_BYTES: Final = 4_500_000
#: An inline image with a Content-ID below this size is a signature logo, not evidence.
INLINE_LOGO_MAX_BYTES: Final = 40_000
_SKIPPED_EXTENSIONS: Final = frozenset({
    'ics', 'vcs', 'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'exe', 'msi', 'dll', 'bat', 'cmd',
    'com', 'scr', 'js', 'vbs', 'ps1', 'sh', 'jar', 'apk', 'dmg', 'iso', 'bin', 'p7s', 'asc', 'sig',
})
_SKIPPED_TYPES: Final = frozenset({
    'text/calendar', 'application/ics', 'application/zip', 'application/x-zip-compressed',
    'application/x-rar-compressed', 'application/x-7z-compressed', 'application/gzip', 'application/x-tar',
    'application/x-msdownload', 'application/x-msdos-program', 'application/java-archive',
    'application/pkcs7-signature', 'application/x-pkcs7-signature', 'application/pgp-signature',
})
#: Never read more than this many attachments of an email (the rest are listed "not read").
MAX_READ_ATTACHMENTS: Final = 5
#: ``message/rfc822`` levels an email may nest (a forward of a forward of a forward).
MAX_NESTED_DEPTH: Final = 3
_RFC822: Final = 'message/rfc822'
_BLANK_RUNS_RE: Final = re.compile(r'\n{3,}')
#: A Date header more than a day in the future is not believed (the queue schema refuses it).
_MAX_CLOCK_SKEW: Final = timedelta(days=1)


@dataclass(frozen=True)
class Attachment:
    filename: str
    content_type: str
    kind: str
    size: int
    data: bytes = b''


@dataclass
class ParsedEmail:
    message: EmailMessage
    subject: str
    message_id: str
    created_at: str
    body: str
    attachments: list[Attachment] = field(default_factory=list)
    nested: list[EmailMessage] = field(default_factory=list)
    skipped_count: int = 0


def _html_to_text(html: str) -> str:
    from bs4 import BeautifulSoup  # bs4: the ingestion layer; lxml: the email-intake-deps layer

    soup = BeautifulSoup(html, 'lxml')
    for tag in soup(['script', 'style', 'head']):
        tag.decompose()
    for quote in soup.select('blockquote, div.gmail_quote, div#appendonsend, div#divRplyFwdMsg'):
        quote.decompose()
    text = soup.get_text('\n')
    lines = [line.strip() for line in text.split('\n')]
    return _BLANK_RUNS_RE.sub('\n\n', '\n'.join(lines)).strip()


def _part_text(part: MIMEPart) -> str:
    try:
        content = part.get_content()
    except (LookupError, ValueError):
        payload = part.get_payload(decode=True)
        content = payload.decode('utf-8', errors='replace') if isinstance(payload, bytes) else ''
    return content if isinstance(content, str) else ''


def body_text(message: EmailMessage) -> str:
    """The body as text: ``text/plain`` when there is one, else the HTML part converted."""
    plain = message.get_body(preferencelist=('plain',))
    if plain is not None:
        text = _part_text(plain)
        if text.strip():
            return text.replace('\r\n', '\n').strip()
    html = message.get_body(preferencelist=('html',))
    return _html_to_text(_part_text(html)) if html is not None else ''


def _extension(filename: str) -> str:
    return filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''


def _content_type(part: MIMEPart, filename: str) -> str:
    declared = part.get_content_type().lower()
    if declared in ('application/octet-stream', 'binary/octet-stream'):
        return _EXTENSION_TYPES.get(_extension(filename), declared)
    return declared


def _is_inline_logo(part: MIMEPart, content_type: str, size: int) -> bool:
    return (content_type.startswith('image/') and part.get('Content-ID') is not None
            and size <= INLINE_LOGO_MAX_BYTES)


def _readable_kind(content_type: str, size: int) -> str:
    if content_type in CONVERSE_IMAGE_FORMATS:
        return 'image' if size <= MAX_IMAGE_BYTES else 'too_large'
    if content_type in CONVERSE_DOCUMENT_FORMATS:
        return 'document' if size <= MAX_DOCUMENT_BYTES else 'too_large'
    return 'unsupported'


def _classify(part: MIMEPart, filename: str, content_type: str, size: int) -> str:
    if content_type in _SKIPPED_TYPES or _extension(filename) in _SKIPPED_EXTENSIONS:
        return 'skipped'
    if _is_inline_logo(part, content_type, size):
        return 'skipped'
    return _readable_kind(content_type, size)


def _payload_bytes(part: MIMEPart) -> bytes:
    payload = part.get_payload(decode=True)
    return payload if isinstance(payload, bytes) else b''


def _encoded_size(part: MIMEPart) -> int:
    """The decoded size estimated from the encoded payload, without decoding it."""
    payload = part.get_payload()
    if not isinstance(payload, str):
        return 0
    if part.get('Content-Transfer-Encoding', '').strip().lower() == 'base64':
        encoded = ''.join(payload.split())
        return max(0, len(encoded) * 3 // 4 - (len(encoded) - len(encoded.rstrip('='))))
    return len(payload)


def nesting_too_deep(message: Message, limit: int = MAX_NESTED_DEPTH) -> bool:
    """True when ``message`` nests ``message/rfc822`` parts more than ``limit`` levels deep."""
    stack: list[tuple[Message, int]] = [(message, 0)]
    while stack:
        part, depth = stack.pop()
        level = depth + 1 if part.get_content_type() == _RFC822 else depth
        if level > limit:
            return True
        payload = part.get_payload()
        if isinstance(payload, list):
            stack.extend((child, level) for child in payload if isinstance(child, Message))
    return False


def _nested_message(part: MIMEPart) -> EmailMessage | None:
    payload = part.get_payload()
    if isinstance(payload, list) and payload and isinstance(payload[0], EmailMessage):
        return payload[0]
    raw = _payload_bytes(part)
    if not raw:
        return None
    nested = message_from_bytes(raw, policy=policy.default)
    return None if nesting_too_deep(nested, MAX_NESTED_DEPTH - 1) else nested


def _collect_attachments(parsed: ParsedEmail) -> None:
    readable = 0
    for index, part in enumerate(parsed.message.iter_attachments(), start=1):
        filename = (part.get_filename() or f'attachment-{index}').strip()
        content_type = _content_type(part, filename)
        if content_type == _RFC822:
            nested = _nested_message(part)
            if nested is not None:
                parsed.nested.append(nested)
                continue
        size = _encoded_size(part)
        kind = _classify(part, filename, content_type, size)
        if kind == 'skipped':
            parsed.skipped_count += 1
            continue
        if kind in ('document', 'image'):
            readable += 1
            if readable > MAX_READ_ATTACHMENTS:
                kind = 'over_limit'
        parsed.attachments.append(_attachment(part, filename[:200], content_type, kind, size))


def _attachment(part: MIMEPart, filename: str, content_type: str, kind: str, size: int) -> Attachment:
    """Only an attachment that will be read is decoded; its real size then replaces the estimate."""
    if kind not in ('document', 'image'):
        return Attachment(filename, content_type, kind, size)
    data = _payload_bytes(part)
    if _readable_kind(content_type, len(data)) == 'too_large':
        return Attachment(filename, content_type, 'too_large', len(data))
    return Attachment(filename, content_type, kind, len(data), data)


def _created_at(message: EmailMessage, now: datetime) -> str:
    try:
        sent = parsedate_to_datetime(str(message.get('Date', '')))
    except (TypeError, ValueError, IndexError):
        return now.isoformat()
    if sent.tzinfo is None:
        sent = sent.replace(tzinfo=UTC)
    return now.isoformat() if sent > now + _MAX_CLOCK_SKEW else sent.astimezone(UTC).isoformat()


def _message_id(message: EmailMessage) -> str:
    return str(message.get('Message-ID', '')).strip().strip('<>').strip()


def parse_email(raw: bytes, *, now: datetime | None = None) -> ParsedEmail:
    """Parse ``raw`` (an RFC 5322 message as SES stored it). Raises ValueError when it is not an email."""
    message = message_from_bytes(raw, policy=policy.default)
    if not message.keys():
        raise ValueError('not an email message')
    if nesting_too_deep(message):
        raise ValueError('message/rfc822 nested too deeply')
    parsed = ParsedEmail(
        message=message,
        subject=' '.join(str(message.get('Subject', '')).split())[:500],
        message_id=_message_id(message),
        created_at=_created_at(message, now or datetime.now(UTC)),
        body=body_text(message),
    )
    _collect_attachments(parsed)
    return parsed


def thread_root_id(message: EmailMessage) -> str | None:
    """The thread's root Message-ID: the first ``References`` id, else ``In-Reply-To``."""
    for header in ('References', 'In-Reply-To'):
        ids = re.findall(r'<([^<>\s]+)>', str(message.get(header, '')))
        if ids:
            return ids[0]
    return None


def recipient_aliases(message: EmailMessage, inbox_domain: str) -> list[str]:
    """The local parts of every recipient at ``inbox_domain``, lower-cased, in header order."""
    domain = inbox_domain.lower()
    values = [str(value) for header in ('To', 'Cc', 'Delivered-To', 'X-Original-To')
              for value in message.get_all(header, [])]
    aliases: list[str] = []
    for _name, address in getaddresses(values):
        local, _, at = address.lower().rpartition('@')
        alias = local.split('+', 1)[0]
        if at == domain and alias and alias not in aliases:
            aliases.append(alias)
    return aliases
