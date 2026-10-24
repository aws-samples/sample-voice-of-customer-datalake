"""Only the NEW part of an email: quoted history, signatures and forward headers removed.

Pure string functions (no AWS, no email objects) so every rule is unit-testable on its own:

- ``strip_quoted``: drops ``>`` lines, cuts at an "On ... wrote:" attribution (in the
  languages the inbox sees most, also split over two lines), at Outlook's
  ``-----Original Message-----`` and at an Outlook ``From:`` / ``Sent:`` header block.
- ``strip_signature``: cuts at the RFC 3676 ``-- `` delimiter, at a mobile footer
  ("Sent from my iPhone") and at a sign-off ("Best regards,") near the end.
- ``split_forward``: finds an inline forwarded message (Gmail's
  ``---------- Forwarded message ---------`` or an Outlook header block) and returns
  the forwarder's note, the original's sender and the original's body.
- ``normalise_subject``: the subject without ``Re:`` / ``Fwd:`` / ``AW:`` ... prefixes and
  ``[tags]``, lower-cased, for the thread fallback.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from email.utils import parseaddr
from typing import Final

__all__ = [
    'clean_new_text',
    'content_hash',
    'is_forward_subject',
    'is_reply_subject',
    'normalise_subject',
    'split_forward',
    'subject_tags',
]

_REPLY_PREFIX: Final = r'(?:re|aw|sv|vs|rv|ref|antw|odp|r)'
_FORWARD_PREFIX: Final = r'(?:fwd?|wg|tr|rv|enc|doorst|vb)'
_PREFIX_RE: Final = re.compile(
    rf'^\s*(?:(?:{_REPLY_PREFIX}|{_FORWARD_PREFIX})(?:\[\d+\])?\s*:\s*|\[[^\]]{{0,40}}\]\s*)+',
    re.IGNORECASE,
)
_REPLY_SUBJECT_RE: Final = re.compile(rf'^\s*(?:\[[^\]]{{0,40}}\]\s*)*{_REPLY_PREFIX}(?:\[\d+\])?\s*:', re.IGNORECASE)
_FORWARD_SUBJECT_RE: Final = re.compile(rf'^\s*(?:\[[^\]]{{0,40}}\]\s*)*{_FORWARD_PREFIX}\s*:', re.IGNORECASE)
_TAG_RE: Final = re.compile(r'\[([A-Za-z][A-Za-z _-]{0,30})\]')

_ATTRIBUTION_RE: Final = re.compile(
    r'^\s*(?:on|am|le|el|em|il|op|den|dnia)\b.{0,300}?'
    r'(?:(?:wrote|a\s+écrit|escribió|escreveu|ha\s+scritto|schreef|skrev|napisał)|'
    r'(?:schrieb|skrev)\b.{0,200}?)\s*:\s*\Z',  # German puts the name after the verb
    re.IGNORECASE,
)
_ORIGINAL_MESSAGE_RE: Final = re.compile(
    r'^\s*-{2,}\s*(?:original message|ursprüngliche nachricht|message d\'origine|mensaje original)\s*-{2,}\s*\Z',
    re.IGNORECASE,
)
_GMAIL_FORWARD_RE: Final = re.compile(
    r'^\s*-{3,}\s*(?:forwarded message|weitergeleitete nachricht|message transféré|mensaje reenviado)\s*-{3,}\s*\Z',
    re.IGNORECASE,
)
_HEADER_LINE_RE: Final = re.compile(
    r'^\s*\*?(from|von|de|sent|gesendet|envoyé|enviado|date|datum|to|an|à|para|cc|subject|betreff|objet|asunto)'
    r'\*?\s*:\s*(.*)\Z',
    re.IGNORECASE,
)
_FROM_HEADERS: Final = frozenset({'from', 'von', 'de'})
_SENT_HEADERS: Final = frozenset({'sent', 'gesendet', 'envoyé', 'enviado', 'date', 'datum'})
_UNDERSCORE_RULE_RE: Final = re.compile(r'^\s*_{10,}\s*\Z')

_SIGNATURE_DELIMITER_RE: Final = re.compile(r'^--\s?\Z')
_MOBILE_FOOTER_RE: Final = re.compile(
    r'^\s*(?:sent from my \w+|get outlook for \w+|von meinem \w+ gesendet|envoyé de mon \w+|enviado desde mi \w+)',
    re.IGNORECASE,
)
_SIGN_OFF_RE: Final = re.compile(
    r'^\s*(?:best|kind|warm|many)?\s*(?:regards|wishes|thanks|thank you|cheers|sincerely|grüße|gruß|'
    r'viele grüße|mit freundlichen grüßen|cordialement|saludos|atentamente|merci)\b[\s,.!]*\Z',
    re.IGNORECASE,
)
#: A sign-off only ends the message when at most this many lines (a name, a title) follow it.
_SIGN_OFF_TAIL_LINES: Final = 6


@dataclass(frozen=True)
class ForwardedOriginal:
    """An inline forwarded message: what the forwarder wrote above it, and the original."""

    note: str
    sender: str
    sender_name: str
    body: str


def normalise_subject(subject: str) -> str:
    """``Re: [bug] Fwd: Checkout`` -> ``checkout``: prefixes and tags off, whitespace collapsed."""
    return ' '.join(_PREFIX_RE.sub('', subject or '').split()).lower()


def is_reply_subject(subject: str) -> bool:
    return bool(_REPLY_SUBJECT_RE.match(subject or ''))


def is_forward_subject(subject: str) -> bool:
    return bool(_FORWARD_SUBJECT_RE.match(subject or ''))


def subject_tags(subject: str) -> list[str]:
    """The ``[tag]`` labels in a subject, lower-cased, in order."""
    return [tag.strip().lower() for tag in _TAG_RE.findall(subject or '')]


def _is_outlook_header_block(lines: list[str], index: int) -> bool:
    """A ``From:`` line followed within four lines by a ``Sent:``/``Date:`` line."""
    first = _HEADER_LINE_RE.match(lines[index])
    if not first or first.group(1).lower() not in _FROM_HEADERS:
        return False
    for line in lines[index + 1:index + 5]:
        match = _HEADER_LINE_RE.match(line)
        if match and match.group(1).lower() in _SENT_HEADERS:
            return True
    return False


def _is_forward_marker(lines: list[str], index: int) -> bool:
    """A line that opens a forwarded / original message: a separator line or an Outlook header block."""
    line = lines[index]
    if _ORIGINAL_MESSAGE_RE.match(line) or _GMAIL_FORWARD_RE.match(line):
        return True
    if _UNDERSCORE_RULE_RE.match(line) and index + 1 < len(lines) and _is_outlook_header_block(lines, index + 1):
        return True
    return _is_outlook_header_block(lines, index)


def _is_attribution(lines: list[str], index: int) -> bool:
    """"On ... wrote:", also wrapped over two lines ("On Mon, 3 Mar 2026, Ana <a@b>\nwrote:")."""
    if _ATTRIBUTION_RE.match(lines[index]):
        return True
    return index + 1 < len(lines) and bool(_ATTRIBUTION_RE.match(f'{lines[index]} {lines[index + 1].strip()}'))


def _quote_cut(lines: list[str], index: int) -> bool:
    return _is_attribution(lines, index) or _is_forward_marker(lines, index)


def strip_quoted(text: str) -> str:
    """The text above the first quoted-history marker, without ``>`` lines."""
    lines = (text or '').replace('\r\n', '\n').split('\n')
    kept: list[str] = []
    for index, line in enumerate(lines):
        if _quote_cut(lines, index):
            break
        if line.lstrip().startswith('>'):
            continue
        kept.append(line)
    return '\n'.join(kept).strip()


def strip_signature(text: str) -> str:
    """``text`` without its signature: from the ``-- `` delimiter, a mobile footer, or a late sign-off."""
    lines = (text or '').split('\n')
    for index, line in enumerate(lines):
        if _SIGNATURE_DELIMITER_RE.match(line) or _MOBILE_FOOTER_RE.match(line):
            return '\n'.join(lines[:index]).strip()
        if index > 0 and _SIGN_OFF_RE.match(line) and len(lines) - index - 1 <= _SIGN_OFF_TAIL_LINES:
            return '\n'.join(lines[:index]).strip()
    return (text or '').strip()


def clean_new_text(text: str) -> str:
    """The new part of a message: quoted history and signature removed."""
    return strip_signature(strip_quoted(text))


def _forward_start(lines: list[str]) -> int | None:
    return next((index for index in range(len(lines)) if _is_forward_marker(lines, index)), None)


def _forward_headers(lines: list[str], start: int) -> tuple[str, int]:
    """The original's ``From:`` value, and the index of the first body line after the header block."""
    sender = ''
    index = start
    while index < len(lines) and (not lines[index].strip() or not _HEADER_LINE_RE.match(lines[index])):
        index += 1
        if index - start > 2:
            break
    while index < len(lines):
        match = _HEADER_LINE_RE.match(lines[index])
        if not match:
            break
        if match.group(1).lower() in _FROM_HEADERS and not sender:
            sender = match.group(2).strip()
        index += 1
    return sender, index


def split_forward(text: str) -> ForwardedOriginal | None:
    """The inline forwarded original in ``text``, or None when there is none."""
    lines = (text or '').replace('\r\n', '\n').split('\n')
    start = _forward_start(lines)
    if start is None:
        return None
    header_start = start if _HEADER_LINE_RE.match(lines[start]) else start + 1
    sender_value, body_start = _forward_headers(lines, header_start)
    name, address = parseaddr(sender_value.replace('mailto:', ''))
    if not address and '@' in sender_value:
        address = sender_value.split()[-1].strip('<>[]()')
    body = clean_new_text('\n'.join(lines[body_start:]))
    if not body:
        return None
    return ForwardedOriginal(
        note=clean_new_text('\n'.join(lines[:start])),
        sender=address.strip().lower(),
        sender_name=name.strip(),
        body=body,
    )


def content_hash(text: str) -> str:
    """A stable hash of the content: case and whitespace do not change it."""
    normalised = ' '.join((text or '').lower().split())
    return hashlib.sha256(normalised.encode('utf-8')).hexdigest()[:32]
