"""The deployment's one outbound mail path: Amazon SES v2 ``SendEmail`` with Simple content, opt-in behind
``-c emailFrom=<address>`` (lib/utils/email-sender.ts; docs/deployment.md, "Participant email and the feature-request
board").

Two senders build on it: the participant asks (shared/participant_mailer.py, which adds its own one-click unsubscribe
headers) and the notice an existing account gets when a workspace admin adds it to a workspace
(shared/member_notice.py). Each builds a :class:`SimpleEmail`; this module turns it into the one request shape and
sends it. The subject and both bodies go as Simple content's ``Data`` (SES encodes them), the From as
``formataddr((sender_name, from_address))``, so no value a sender puts in can add a header: only ``headers`` does,
and only the participant mailer passes any. Never log an address.
"""
from __future__ import annotations

from dataclasses import dataclass
from email.utils import formataddr
from typing import Any, Final

import boto3

EMAIL_CHARSET: Final = 'UTF-8'
# The emails' palette: Kiro Light (docs/kiro-design-system.md), the feedback widget's KIRO defaults
# (static/feedback-widget.js): white on the accent is 4.64:1 (WCAG AA).
ACCENT: Final = '#8e48ff'
TEXT: Final = '#19161d'
MUTED: Final = '#5e5966'
BORDER: Final = '#e4e4e7'
_client: Any = None


def get_sesv2_client() -> Any:
    """The cached SES v2 client (built at init by a sender's warm-up, or on the first send)."""
    global _client
    if _client is None:
        _client = boto3.client('sesv2')
    return _client


@dataclass(frozen=True)
class SimpleEmail:
    """One email to one recipient: the rendered subject and bodies, and the sender's display name."""

    to: str
    subject: str
    text: str
    html: str
    sender_name: str
    reply_to: str = ''
    #: Extra headers ``(name, value)`` (SES v2 Simple content's ``Headers``, botocore 1.35 and later).
    headers: tuple[tuple[str, str], ...] = ()


def _content(data: str) -> dict[str, str]:
    return {'Data': data, 'Charset': EMAIL_CHARSET}


def send_request(email: SimpleEmail, from_address: str) -> dict[str, Any]:
    """The SendEmail request for ``email`` (pure, so the shape is unit-tested)."""
    simple: dict[str, Any] = {
        'Subject': _content(email.subject),
        'Body': {'Text': _content(email.text), 'Html': _content(email.html)},
    }
    if email.headers:
        simple['Headers'] = [{'Name': name, 'Value': value} for name, value in email.headers]
    request: dict[str, Any] = {
        'FromEmailAddress': formataddr((email.sender_name, from_address)),
        'Destination': {'ToAddresses': [email.to]},
        'Content': {'Simple': simple},
    }
    if email.reply_to:
        request['ReplyToAddresses'] = [email.reply_to]
    return request


def send(email: SimpleEmail, from_address: str, client: Any = None) -> str:
    """Send ``email`` (with ``client``, default the cached one); the SES message id. Raises the client's error (the
    caller records a code)."""
    ses = client if client is not None else get_sesv2_client()
    response = ses.send_email(**send_request(email, from_address))
    return str(response.get('MessageId', ''))
