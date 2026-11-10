"""Cognito triggers of the feature-request board's own user pool (docs/feature-requests.md -> Sign-in).

``pre_sign_up_handler`` (PreSignUp): only an email that some non-archived feedback board
would admit, or that an active document review link admits, may create a board account. Two
items of voc-participants decide the boards: the boards' derived audience row (``SETTINGS`` /
``board_audience``: any email, listed domains and addresses, and whether a board admits the
company domains) and the engagement settings' ``company_domains``. Without an audience row (no
board saved yet) the company domains alone decide, as before boards; an empty list lets nobody
in. A review link is named by the sign-up's ``ClientMetadata.share_id`` and read from the
projects table (``DOCSHARE#{id}`` / ``META``, ``shared.review_share_audience``). Anything else is
refused with ``domain_not_allowed``, which the SPA shows.

A self sign-up is NOT confirmed here (5.45.00): Cognito emails it a confirmation code and the
account exists only once that code is entered, so owning the inbox is the proof. Auto-confirming
let anyone who chose a password at sign-up sign in with it as an address they do not own (the
pool must allow the PASSWORD first factor), so that was removed.

``custom_message_handler`` (CustomMessage): every code this pool emails (sign-up confirmation,
a resent code, the password-reset code the default-email sign-in uses, and the EMAIL_OTP sign-in
code) is rendered as "your sign-in code" with a link to
``{FRONTEND_URL}/board/login?email=…&code={####}`` that completes the sign-in in the browser
that asked for it. Every other message keeps Cognito's default.

Both trigger functions of core-board-auth.ts run ``handler`` (``auth/board_triggers.handler``),
which dispatches on the trigger source; they are two functions only so that each keeps its own
least-privilege role (the CustomMessage one has no table access). The bundle holds only this file, ``shared/__init__.py``,
``shared/participants_settings.py`` and ``shared/review_share_audience.py``. Stdlib + boto3 + those two
only (test_board_triggers_bundle.py pins that). Env: ``PARTICIPANTS_TABLE``, ``PROJECTS_TABLE``,
``FRONTEND_URL``. Never logs an address.
"""
from __future__ import annotations

import html
import logging
import os
import time
from typing import Any, Final
from urllib.parse import quote

import boto3

from shared.participants_settings import (
    BOARD_AUDIENCE_KEY,
    SETTINGS_KEY,
    audience_from_item,
    board_audience_admits,
    from_item,
)
from shared.review_share_audience import is_share_id, share_admits, share_key

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

REFUSED: Final = 'domain_not_allowed'
CODE_MESSAGE_SOURCES: Final = frozenset({
    'CustomMessage_SignUp', 'CustomMessage_ResendCode', 'CustomMessage_ForgotPassword',
    'CustomMessage_Authentication',
})
CODE_PLACEHOLDER: Final = '{####}'
EMAIL_SUBJECT: Final = 'Your sign-in code'
_table: Any = None
_projects: Any = None


class SignUpRefusedError(Exception):
    """Cognito answers the sign-up with ``PreSignUp failed with error domain_not_allowed.``

    Raising is the ONLY way a PreSignUp trigger refuses, so the Lambda runtime logs one
    ``[ERROR] SignUpRefusedError: domain_not_allowed`` line (and counts an ``Errors`` datapoint)
    per refusal by design; no ops alarm watches this function. The message is the stable code
    alone: the SPA matches it, and it carries no address or other detail.
    """

    def __init__(self) -> None:
        super().__init__(REFUSED)


def get_table() -> Any:
    global _table
    if _table is None:
        _table = boto3.resource('dynamodb').Table(os.environ.get('PARTICIPANTS_TABLE', ''))
    return _table


def get_projects_table() -> Any:
    global _projects
    if _projects is None:
        _projects = boto3.resource('dynamodb').Table(os.environ.get('PROJECTS_TABLE', ''))
    return _projects


def _request(event: dict) -> dict:
    request = event.get('request')
    return request if isinstance(request, dict) else {}


def _attributes(event: dict) -> dict:
    attributes = _request(event).get('userAttributes')
    return attributes if isinstance(attributes, dict) else {}


def _email_lc(event: dict) -> str:
    raw = _attributes(event).get('email')
    email = raw.strip().lower() if isinstance(raw, str) else ''
    return email if email.count('@') == 1 and not email.startswith('@') else ''


def _boards_admit(email_lc: str) -> bool:
    if not os.environ.get('PARTICIPANTS_TABLE'):
        return False
    table = get_table()
    settings = from_item(table.get_item(Key=SETTINGS_KEY, ConsistentRead=True).get('Item'))
    audience = audience_from_item(table.get_item(Key=BOARD_AUDIENCE_KEY, ConsistentRead=True).get('Item'))
    return board_audience_admits(audience, settings, email_lc)


def _review_link_admits(event: dict, email_lc: str) -> bool:
    """The sign-up names an active review link (``ClientMetadata.share_id``) that admits the email."""
    metadata = _request(event).get('clientMetadata')
    share_id = metadata.get('share_id') if isinstance(metadata, dict) else None
    if not is_share_id(share_id) or not os.environ.get('PROJECTS_TABLE'):
        return False
    item = get_projects_table().get_item(Key=share_key(share_id), ConsistentRead=True).get('Item')
    return share_admits(item if isinstance(item, dict) else None, email_lc, int(time.time()))


def pre_sign_up_handler(event: dict, _context: Any) -> dict:
    """Refuse unless a board or a review link admits the email. Never auto-confirms (see the module doc)."""
    email_lc = _email_lc(event)
    if not email_lc:
        logger.info('Board sign-up refused: no address')
        raise SignUpRefusedError
    if not _review_link_admits(event, email_lc) and not _boards_admit(email_lc):
        logger.info('Board sign-up refused: no board or review link admits the address')
        raise SignUpRefusedError
    return event


def sign_in_link(email: str, code: str) -> str:
    """The board's login link (the SPA reads ``email`` and ``code``); '' without FRONTEND_URL."""
    frontend = os.environ.get('FRONTEND_URL', '').rstrip('/')
    return f'{frontend}/board/login?email={quote(email, safe="")}&code={code}' if frontend else ''


def sign_in_message(email: str, code: str) -> str:
    """Short, neutral HTML: the code, the link (when the frontend is known), the expiry.

    Cognito sends this one body to every mail client, so the link is ALSO written out as text:
    a client that shows only plain text still has an address to open.
    """
    link = sign_in_link(email, code)
    escaped = html.escape(link, quote=True)
    link_lines = (f'<p><a href="{escaped}">Finish signing in</a></p>'
              f'<p>Or open this link: {escaped}</p>'
              if link else '')
    return (
        '<p>Your sign-in code is:</p>'
        f'<p style="font-size:20px;font-weight:600;letter-spacing:2px">{html.escape(code)}</p>'
        f'{link_lines}'
        '<p>The code works once and expires in a few minutes. '
        'If you did not ask to sign in, ignore this email.</p>'
    )


def custom_message_handler(event: dict, _context: Any) -> dict:
    """Every emailed code as "your sign-in code" with a link; any other message is Cognito's default."""
    if event.get('triggerSource') not in CODE_MESSAGE_SOURCES:
        return event
    code = _request(event).get('codeParameter')
    code = code if isinstance(code, str) and code else CODE_PLACEHOLDER
    email = _attributes(event).get('email')
    response = event.setdefault('response', {})
    response['emailSubject'] = EMAIL_SUBJECT
    response['emailMessage'] = sign_in_message(email if isinstance(email, str) else '', code)
    return event


def handler(event: dict, context: Any) -> dict:
    """The ONE entry point for both triggers (``auth/board_triggers.handler``), by trigger source.

    PreSignUp_* -> ``pre_sign_up_handler``, CustomMessage_* -> ``custom_message_handler``,
    anything else is returned unchanged.
    """
    source = event.get('triggerSource')
    source = source if isinstance(source, str) else ''
    if source.startswith('PreSignUp_'):
        return pre_sign_up_handler(event, context)
    if source.startswith('CustomMessage_'):
        return custom_message_handler(event, context)
    return event
