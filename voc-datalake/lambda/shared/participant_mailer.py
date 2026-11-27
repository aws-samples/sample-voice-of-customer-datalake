"""The participant ask email, sent with Amazon SES v2 (``SendEmail``, Simple content) through the deployment's one
outbound mail path (shared/outbound_mail.py; the unsubscribe headers are this mailer's own).

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
from typing import Final

from shared import outbound_mail
from shared.outbound_mail import ACCENT, BORDER, MUTED, TEXT

# The one SES v2 client and send (shared/outbound_mail.py); named here too, so the engagement API warms it at init and
# its tests replace it here.
get_sesv2_client = outbound_mail.get_sesv2_client
BUTTON_LABEL: Final = 'Share your feedback'


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


def simple_email(email: AskEmail) -> outbound_mail.SimpleEmail:
    """``email`` rendered for the shared send, with its RFC 8058 one-click unsubscribe headers (this mailer's own)."""
    return outbound_mail.SimpleEmail(
        to=email.to, subject=email.subject, text=text_body(email), html=html_body(email),
        sender_name=email.sender_name, reply_to=email.reply_to,
        headers=(('List-Unsubscribe', f'<{email.unsubscribe_post}>'),
                 ('List-Unsubscribe-Post', 'List-Unsubscribe=One-Click')))


def send(email: AskEmail, from_address: str) -> str:
    """Send ``email``; the SES message id. Raises the client's error (the caller records a code)."""
    return outbound_mail.send(simple_email(email), from_address, client=get_sesv2_client())
