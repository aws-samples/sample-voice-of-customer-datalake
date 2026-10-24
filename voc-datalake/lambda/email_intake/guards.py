"""The cheap, deterministic gates every received email passes before anything is spent on it.

The inbox is public (plan Q-public), so an email is dropped, never answered, when:

- SES's spam or virus verdict is not ``PASS`` (``X-SES-Spam-Verdict`` /
  ``X-SES-Virus-Verdict``; a missing verdict counts as a failure). SPF and DKIM are
  recorded by the caller but never required: forwarded mail often fails SPF.
- it is automatic: ``Auto-Submitted`` other than ``no``, an out-of-office header or
  subject, or ``Precedence: bulk|list|junk`` / a ``List-Id`` (mailing lists, newsletters);
- it comes from a mail system: mailer-daemon, postmaster, noreply-style senders, the
  null sender ``<>``, or our own inbox domain (a loop).

Nothing here ever replies: no bounce, no auto-reply, so no backscatter.
"""
from __future__ import annotations

import re
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Final

__all__ = ['drop_reason', 'sender_address']

_VERDICT_OK: Final = 'PASS'
_BULK_PRECEDENCE: Final = frozenset({'bulk', 'list', 'junk'})
_AUTO_REPLY_HEADERS: Final = ('X-Autoreply', 'X-Autorespond', 'X-Auto-Reply')
_SYSTEM_LOCAL_PARTS_RE: Final = re.compile(
    r'^(?:mailer-daemon|postmaster|no[-_.]?reply|do[-_.]?not[-_.]?reply|bounces?|notifications?)(?:[+-].*)?\Z',
    re.IGNORECASE,
)
_OUT_OF_OFFICE_SUBJECT_RE: Final = re.compile(
    r'^\s*(?:out of (?:the )?office|automatic reply|auto(?:matic)?[- ]?reply|autoreply|abwesenheit|'
    r'automatische antwort|réponse automatique|respuesta automática|fuera de la oficina|'
    r'resposta automática)\b',
    re.IGNORECASE,
)


def sender_address(message: EmailMessage) -> str:
    """The ``From`` address, lower-cased ('' when there is none)."""
    return parseaddr(str(message.get('From', '')))[1].strip().lower()


def _verdict_passes(message: EmailMessage, header: str) -> bool:
    """Every ``header`` occurrence says PASS (and there is one): a forged copy cannot outvote SES's own."""
    values = [str(value).strip().upper() for value in message.get_all(header, [])]
    return bool(values) and all(value == _VERDICT_OK for value in values)


def _verdict_failure(message: EmailMessage) -> str | None:
    if not _verdict_passes(message, 'X-SES-Virus-Verdict'):
        return 'virus'
    if not _verdict_passes(message, 'X-SES-Spam-Verdict'):
        return 'spam'
    return None


def _is_automatic(message: EmailMessage) -> bool:
    auto_submitted = str(message.get('Auto-Submitted', '')).strip().lower()
    if auto_submitted and auto_submitted != 'no':
        return True
    if any(message.get(header) for header in _AUTO_REPLY_HEADERS):
        return True
    suppress = str(message.get('X-Auto-Response-Suppress', '')).strip().lower()
    if 'oof' in suppress:
        return True
    return bool(_OUT_OF_OFFICE_SUBJECT_RE.match(str(message.get('Subject', ''))))


def _is_bulk(message: EmailMessage) -> bool:
    if str(message.get('Precedence', '')).strip().lower() in _BULK_PRECEDENCE:
        return True
    return message.get('List-Id') is not None


def _is_system_sender(message: EmailMessage, sender: str, inbox_domain: str) -> bool:
    return_path = str(message.get('Return-Path', '')).strip()
    if return_path == '<>':
        return True
    if '@' not in sender:
        return True
    local, _, domain = sender.rpartition('@')
    if inbox_domain and (domain == inbox_domain or domain.endswith(f'.{inbox_domain}')):
        return True
    return bool(_SYSTEM_LOCAL_PARTS_RE.match(local))


def drop_reason(message: EmailMessage, inbox_domain: str) -> str | None:
    """Why ``message`` must be dropped (a ``DROP_REASONS`` value), or None when it may be read."""
    verdict = _verdict_failure(message)
    if verdict:
        return verdict
    if _is_automatic(message):
        return 'auto_reply'
    if _is_bulk(message):
        return 'bulk'
    if _is_system_sender(message, sender_address(message), inbox_domain.lower()):
        return 'loop_sender'
    return None
