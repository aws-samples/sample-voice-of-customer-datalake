"""PII redaction for feedback text before it is archived or queued.

``redact_text`` replaces personal data with fixed placeholders::

    [EMAIL] [PHONE] [IBAN] [CARD] [IP] [NAME] [ADDRESS]

Pattern detection always runs: e-mail addresses, IBANs (mod-97 checked),
payment card numbers (13-19 digits, Luhn checked), IPv4 and IPv6 addresses
(``ipaddress`` checked) and phone numbers in E.164 and the common national
formats (DE, FR, ES, UK, US). The phone rule is deliberately conservative so
dates, version numbers and bare order ids survive: a run of digits counts as a
phone number only when it starts with ``+``, a trunk ``0`` or a ``(`` area
code, or matches the grouped US (``555-123-4567``) or Spanish mobile
(``612 345 678``) shape.

Names and postal addresses need a model: Amazon Comprehend ``DetectPiiEntities``
runs on top of the patterns only when the env var ``PII_COMPREHEND`` is ``1``
and the text's language is one Comprehend supports for PII (``en``, ``es``). An
unknown language skips it. ``redact_text`` never raises: when Comprehend fails,
the pattern result stands and the ``PiiComprehendFailures`` metric counts it.
"""

from __future__ import annotations

import ipaddress
import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Final

import boto3

from shared.logging import logger, metrics

__all__ = [
    'PLACEHOLDERS',
    'RedactionResult',
    'redact_text',
]

PLACEHOLDERS: Final = {
    'EMAIL': '[EMAIL]', 'PHONE': '[PHONE]', 'IBAN': '[IBAN]', 'CARD': '[CARD]',
    'IP': '[IP]', 'NAME': '[NAME]', 'ADDRESS': '[ADDRESS]',
}

COMPREHEND_PII_LANGUAGES: Final = frozenset({'en', 'es'})
# DetectPiiEntities accepts at most 100 KB of UTF-8; feedback text is capped at
# 50,000 characters, which can exceed that in multi-byte scripts. Text past the
# limit keeps the pattern-only result.
_COMPREHEND_MAX_BYTES: Final = 100_000
_COMPREHEND_TYPES: Final = {'NAME': 'NAME', 'ADDRESS': 'ADDRESS'}
_COMPREHEND_MIN_SCORE: Final = 0.5

_EMAIL_RE: Final = re.compile(r'(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}\b')
# Country code, check digits, then 4-character groups (optionally space separated)
# and a short tail; the checksum decides.
_IBAN_RE: Final = re.compile(r'\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b')
_CARD_RE: Final = re.compile(r'(?<![\d.-])\d(?:[ -]?\d){12,18}(?![\d.-]?\d)')
_IPV4_OCTET: Final = r'(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)'
_IPV4_RE: Final = re.compile(rf'(?<![\w.]){_IPV4_OCTET}(?:\.{_IPV4_OCTET}){{3}}(?!\.?\d|\w)')
# Hex groups, optionally ending in an embedded IPv4 (``::ffff:10.0.0.1``).
_IPV6_RE: Final = re.compile(
    r'(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f]{0,4})(?![\w:])')
# A phone candidate: optional "+", an optional "(" group, then digits and the
# separators people type (space, dot, dash, parentheses). Classified below.
_PHONE_CANDIDATE_RE: Final = re.compile(r'(?<![\w+.:/-])(?:\+|\()?\d[\d \t.()-]{5,}\d(?![\w.:/-]?\d)(?!\w)')
_US_GROUPED_RE: Final = re.compile(r'\A\d{3}[-. ]\d{3}[-. ]\d{4}\Z')
_ES_MOBILE_RE: Final = re.compile(r'\A[6-9]\d{2} \d{3} \d{3}\Z')
_MIN_PHONE_DIGITS: Final = 8
_MAX_PHONE_DIGITS: Final = 15
_MIN_TRUNK_PHONE_DIGITS: Final = 9
_MIN_IPV6_HEX_DIGITS: Final = 4
_IBAN_MIN_CHARS: Final = 15
_IBAN_MAX_CHARS: Final = 34
_IBAN_MODULUS: Final = 97


@dataclass(frozen=True)
class RedactionResult:
    """The redacted text and how many of each placeholder were inserted."""

    text: str
    counts: dict[str, int] = field(default_factory=dict)

    @property
    def redacted(self) -> bool:
        """True when anything was replaced."""
        return any(self.counts.values())


def _iban_valid(candidate: str) -> bool:
    compact = candidate.replace(' ', '')
    if not _IBAN_MIN_CHARS <= len(compact) <= _IBAN_MAX_CHARS:
        return False
    rearranged = compact[4:] + compact[:4]
    digits = ''.join(str(int(ch, 36)) for ch in rearranged)
    return int(digits) % _IBAN_MODULUS == 1


def _luhn_valid(candidate: str) -> bool:
    digits = [int(ch) for ch in candidate if ch.isdigit()]
    checksum = 0
    for index, digit in enumerate(reversed(digits)):
        doubled = digit * 2 if index % 2 else digit
        checksum += doubled - 9 if doubled > 9 else doubled
    return checksum % 10 == 0


def _ipv6_valid(candidate: str) -> bool:
    if sum(ch.isalnum() for ch in candidate) < _MIN_IPV6_HEX_DIGITS:
        return False
    try:
        ipaddress.IPv6Address(candidate)
    except ValueError:
        return False
    return True


def _phone_valid(candidate: str) -> bool:
    """True when a digits-and-separators run reads as a phone number, not a date or id."""
    digits = sum(ch.isdigit() for ch in candidate)
    if not _MIN_PHONE_DIGITS <= digits <= _MAX_PHONE_DIGITS:
        return False
    if candidate.startswith('+'):
        return True
    if candidate.startswith('('):
        return digits >= _MIN_TRUNK_PHONE_DIGITS
    if candidate.startswith('0'):
        return digits >= _MIN_TRUNK_PHONE_DIGITS and not candidate.isdigit()
    return bool(_US_GROUPED_RE.match(candidate) or _ES_MOBILE_RE.match(candidate))


# (kind, pattern, validator) in application order: the specific, checksummed
# shapes first, so a phone rule never sees the digits of an IBAN or a card.
_RULES: Final[tuple[tuple[str, re.Pattern[str], Callable[[str], bool]], ...]] = (
    ('EMAIL', _EMAIL_RE, lambda _candidate: True),
    ('IBAN', _IBAN_RE, _iban_valid),
    ('CARD', _CARD_RE, _luhn_valid),
    ('IP', _IPV6_RE, _ipv6_valid),
    ('IP', _IPV4_RE, lambda _candidate: True),
    ('PHONE', _PHONE_CANDIDATE_RE, _phone_valid),
)


def _apply_rule(
    text: str, kind: str, pattern: re.Pattern[str], valid: Callable[[str], bool], counts: dict[str, int],
) -> str:
    def replace(match: re.Match[str]) -> str:
        candidate = match.group(0)
        if not valid(candidate):
            return candidate
        counts[kind] = counts.get(kind, 0) + 1
        return PLACEHOLDERS[kind]
    return pattern.sub(replace, text)


def _redact_patterns(text: str, counts: dict[str, int]) -> str:
    for kind, pattern, valid in _RULES:
        text = _apply_rule(text, kind, pattern, valid, counts)
    return text


_comprehend_client: list[Any] = []


def _comprehend() -> Any:
    if not _comprehend_client:
        _comprehend_client.append(boto3.client('comprehend'))
    return _comprehend_client[0]


def _comprehend_language(language: str | None) -> str | None:
    """The Comprehend PII language code for ``language`` ('en-US' -> 'en'), or None."""
    if os.environ.get('PII_COMPREHEND') != '1' or not language:
        return None
    code = language.split('-', 1)[0].lower()
    return code if code in COMPREHEND_PII_LANGUAGES else None


def _entity_spans(entities: list[dict[str, Any]], length: int) -> list[tuple[int, int, str]]:
    """Non-overlapping (begin, end, kind) spans of the NAME/ADDRESS entities, in order."""
    spans: list[tuple[int, int, str]] = []
    for entity in entities:
        kind = _COMPREHEND_TYPES.get(str(entity.get('Type')))
        begin, end = entity.get('BeginOffset'), entity.get('EndOffset')
        if kind is None or not isinstance(begin, int) or not isinstance(end, int):
            continue
        if float(entity.get('Score') or 0) < _COMPREHEND_MIN_SCORE or not 0 <= begin < end <= length:
            continue
        spans.append((begin, end, kind))
    spans.sort(key=lambda span: span[0])
    kept: list[tuple[int, int, str]] = []
    for span in spans:
        if not kept or span[0] >= kept[-1][1]:
            kept.append(span)
    return kept


def _redact_entities(text: str, language: str, counts: dict[str, int]) -> str:
    response = _comprehend().detect_pii_entities(Text=text, LanguageCode=language)
    pieces: list[str] = []
    cursor = 0
    for begin, end, kind in _entity_spans(response.get('Entities') or [], len(text)):
        pieces.extend((text[cursor:begin], PLACEHOLDERS[kind]))
        counts[kind] = counts.get(kind, 0) + 1
        cursor = end
    pieces.append(text[cursor:])
    return ''.join(pieces)


def _with_entities(text: str, language: str | None, counts: dict[str, int]) -> str:
    code = _comprehend_language(language)
    if code is None or not text.strip() or len(text.encode('utf-8')) > _COMPREHEND_MAX_BYTES:
        return text
    entity_counts: dict[str, int] = {}
    try:
        redacted = _redact_entities(text, code, entity_counts)
    except Exception:
        logger.exception('Comprehend PII detection failed; keeping the pattern redaction')
        metrics.add_metric(name='PiiComprehendFailures', unit='Count', value=1)
        return text
    for kind, count in entity_counts.items():
        counts[kind] = counts.get(kind, 0) + count
    return redacted


def redact_text(text: str | None, language: str | None = None) -> RedactionResult:
    """``text`` with personal data replaced by placeholders; never raises.

    ``None`` or an empty string comes back as ``''`` with no counts.
    """
    if not text:
        return RedactionResult('', {})
    counts: dict[str, int] = {}
    try:
        redacted = _redact_patterns(text, counts)
    except Exception:
        # Defensive: a pattern bug must not let the unredacted text through.
        logger.exception('Pattern PII redaction failed; withholding the text')
        return RedactionResult('[withheld]', {'WITHHELD': 1})
    return RedactionResult(_with_entities(redacted, language, counts), counts)
