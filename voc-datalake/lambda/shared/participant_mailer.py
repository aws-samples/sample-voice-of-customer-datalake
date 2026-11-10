"""The participant ask email, sent with Amazon SES v2 (``SendEmail``, Simple content).

One email per recipient. From ``"{sender_name}" <EMAIL_FROM>``, Reply-To the asker's
verified email. A text and an HTML body: every user-written value is HTML-escaped,
there is one button (the link), and the footer says why the person gets it and links
the unsubscribe page. RFC 8058 one-click unsubscribe headers point at the API
(``List-Unsubscribe`` / ``List-Unsubscribe-Post``). Simple content carries custom
``Headers`` since botocore 1.35; the Lambda Python 3.14 runtime's boto3 has them
(a test pins the installed service model).

Bounces and complaints: SES's account-level suppression list stops later sends to an
address that bounced or complained (docs/participants.md -> Email). Never log an
address or a token.
"""
from __future__ import annotations

import html
from dataclasses import dataclass
from email.utils import formataddr
from typing import Any, Final

import boto3

EMAIL_CHARSET: Final = 'UTF-8'
BUTTON_LABEL: Final = 'Share your feedback'
# Kiro Light palette (docs/kiro-design-system.md), the feedback widget's KIRO defaults
# (static/feedback-widget.js): white on the accent is 4.64:1 (WCAG AA).
ACCENT: Final = '#8e48ff'
TEXT: Final = '#19161d'
MUTED: Final = '#5e5966'
BORDER: Final = '#e4e4e7'
_client: Any = None


def get_sesv2_client() -> Any:
    """The cached SES v2 client (built at init by the engagement handler's warm-up)."""
    global _client
    if _client is None:
        _client = boto3.client('sesv2')
    return _client


@dataclass(frozen=True)
class AskEmail:
    """One rendered email's inputs (``link`` and both unsubscribe URLs carry the recipient's tokens)."""

    to: str
    subject: str
    message: str
    link: str
    sender_name: str
    unsubscribe_page: str
    unsubscribe_post: str
    reply_to: str = ''
    recipient_name: str = ''


def _footer_text(email: AskEmail) -> str:
    return (f'You get this because {email.sender_name} added you to a participant list. '
            f'Unsubscribe: {email.unsubscribe_page}')


def text_body(email: AskEmail) -> str:
    greeting = f'Hello {email.recipient_name},\n\n' if email.recipient_name else ''
    return f'{greeting}{email.message}\n\n{BUTTON_LABEL}: {email.link}\n\n--\n{_footer_text(email)}\n'


def html_body(email: AskEmail) -> str:
    esc = html.escape
    greeting = f'<p>Hello {esc(email.recipient_name)},</p>' if email.recipient_name else ''
    paragraphs = ''.join(f'<p>{esc(part).replace(chr(10), "<br>")}</p>'
                         for part in email.message.split('\n\n') if part.strip())
    return (
        f'<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:{TEXT}">'
        f'{greeting}{paragraphs}'
        f'<p><a href="{esc(email.link, quote=True)}" style="display:inline-block;padding:10px 18px;'
        f'border-radius:8px;background:{ACCENT};color:#ffffff;text-decoration:none">{esc(BUTTON_LABEL)}</a></p>'
        f'<hr style="border:none;border-top:1px solid {BORDER}">'
        f'<p style="font-size:12px;color:{MUTED}">You get this because {esc(email.sender_name)} added you to a '
        f'participant list. <a href="{esc(email.unsubscribe_page, quote=True)}">Unsubscribe</a></p>'
        '</body></html>'
    )


def _content(data: str) -> dict[str, str]:
    return {'Data': data, 'Charset': EMAIL_CHARSET}


def send_request(email: AskEmail, from_address: str) -> dict[str, Any]:
    """The SendEmail request for ``email`` (pure, so the shape is unit-tested)."""
    request: dict[str, Any] = {
        'FromEmailAddress': formataddr((email.sender_name, from_address)),
        'Destination': {'ToAddresses': [email.to]},
        'Content': {'Simple': {
            'Subject': _content(email.subject),
            'Body': {'Text': _content(text_body(email)), 'Html': _content(html_body(email))},
            'Headers': [
                {'Name': 'List-Unsubscribe', 'Value': f'<{email.unsubscribe_post}>'},
                {'Name': 'List-Unsubscribe-Post', 'Value': 'List-Unsubscribe=One-Click'},
            ],
        }},
    }
    if email.reply_to:
        request['ReplyToAddresses'] = [email.reply_to]
    return request


def send(email: AskEmail, from_address: str) -> str:
    """Send ``email``; the SES message id. Raises the client's error (the caller records a code)."""
    response = get_sesv2_client().send_email(**send_request(email, from_address))
    return str(response.get('MessageId', ''))
