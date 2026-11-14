"""The app user pool's CustomMessage trigger: invitation, password-reset and verification-code emails.

The invitation (``CustomMessage_AdminCreateUser``) is what a new team member reads first, often before
anyone has told them what "VoC" is, so it says who invited them, to which workspace, what the product is,
and what to do if they did not expect it. It names:

- the company (Administration → Brand, ``SETTINGS#brand`` / ``config`` → ``brand_name`` in the aggregates
  table), when an admin has set one;
- otherwise, on a workshop deployment (``-c workshop=true``, set by ``npm run generate:workshop-artifacts``),
  the AWS workshop and its organizer;
- the inviter, passed by ``api/users_handler.py`` as ``ClientMetadata.invited_by`` (absent when a user is
  created another way, e.g. in the Cognito console).

Cognito sends the static ``userInvitation`` template (lib/stacks/core-auth.ts) instead of this message,
silently, unless the message contains BOTH ``request.usernameParameter`` and ``request.codeParameter``;
``invitation_message`` therefore always carries both (the username is a random id, shown as a support
reference). Every value that does not come from the deployment itself is HTML-escaped.

Reads only, and never raises for the brand lookup: an unreadable brand means the neutral wording.
Stdlib + the runtime's boto3 only (no layer); lib/stacks/core-auth.ts ships this one file.
"""
from __future__ import annotations

import html
import logging
import os
import re
from dataclasses import dataclass
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

BRAND_KEY = {'pk': 'SETTINGS#brand', 'sk': 'config'}
#: Longest brand or inviter name printed; anything longer is cut (an email subject has to stay readable).
MAX_NAME_CHARS = 80
_CONTROL_CHARS = re.compile(r'[\x00-\x1f\x7f]')

#: The trigger sources this module writes (the reset one is Cognito's "forgot password" flow).
INVITATION_SOURCE = 'CustomMessage_AdminCreateUser'
RESET_SOURCE = 'CustomMessage_ForgotPassword'
RESEND_CODE_SOURCE = 'CustomMessage_ResendCode'

PRODUCT_SUMMARY = (
    'VoC (Voice of the Customer) Analytics brings your customers\u2019 feedback together, from online '
    'reviews, feedback forms and imports, and helps your team understand it with AI: what customers '
    'talk about, what is going wrong, and what to build next.'
)

_table = None


@dataclass(frozen=True)
class Audience:
    """Who the invitation speaks for: the company, an AWS workshop, or neither."""

    brand: str
    workshop: bool

    @property
    def workspace(self) -> str:
        if self.brand:
            return f'the {self.brand} VoC Analytics workspace'
        if self.workshop:
            return 'a VoC Analytics workspace set up for an AWS workshop'
        return 'a VoC Analytics workspace'

    @property
    def subject(self) -> str:
        if self.brand:
            return f'You are invited to the {self.brand} VoC Analytics workspace'
        if self.workshop:
            return 'You are invited to VoC Analytics for an AWS workshop'
        return 'You are invited to VoC Analytics'

    @property
    def contact(self) -> str:
        if self.brand or not self.workshop:
            return 'your VoC Analytics administrator'
        return 'your workshop organizer'

    @property
    def signature(self) -> str:
        return f'{self.brand} VoC Analytics' if self.brand else 'VoC Analytics'


def clean_name(value: Any) -> str:
    """A display name safe to print: a trimmed string without control characters, at most MAX_NAME_CHARS."""
    if not isinstance(value, str):
        return ''
    text = ' '.join(_CONTROL_CHARS.sub(' ', value).split())
    return text[:MAX_NAME_CHARS].rstrip()


def _aggregates_table():
    global _table
    if _table is None:
        _table = boto3.resource('dynamodb').Table(os.environ['AGGREGATES_TABLE'])
    return _table


def brand_name() -> str:
    """The configured brand name, or '' when none is set or it cannot be read."""
    try:
        item = _aggregates_table().get_item(Key=BRAND_KEY).get('Item') or {}
    except (BotoCoreError, ClientError, KeyError) as error:
        logger.warning('Brand lookup failed, using the neutral wording: %s', type(error).__name__)
        return ''
    return clean_name(item.get('brand_name'))


def _workshop() -> bool:
    return os.environ.get('WORKSHOP', '').strip().lower() == 'true'


def _sign_in_url() -> str:
    return os.environ.get('SIGN_IN_URL', '').rstrip('/')


def _page(title: str, body: str) -> str:
    """The shared frame: a solid header with white text, readable in clients that drop gradients."""
    return f"""<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
  <div style="background: #4c51bf; padding: 24px 30px;">
    <h1 style="color: #ffffff; margin: 0; font-size: 22px;">{title}</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
{body}
  </div>
</body>
</html>"""


def invitation_message(*, audience: Audience, inviter: str, given_name: str, sign_in_url: str,
                       username_parameter: str, code_parameter: str, valid_days: int) -> tuple[str, str]:
    """(subject, html) for an invitation. ``audience``, ``inviter`` and ``given_name`` are unescaped."""
    workspace = html.escape(audience.workspace)
    who = f'{html.escape(inviter)} invited you to {workspace}' if inviter else f'You have been invited to {workspace}'
    greeting = f'Hello {html.escape(given_name)},' if given_name else 'Hello,'
    workshop_note = (
        '\n    <p>The workshop organizer created this account for you before the session, '
        'so you can sign in as soon as it starts.</p>'
        if audience.workshop and not audience.brand else ''
    )
    url = html.escape(sign_in_url)
    body = f"""    <p>{greeting}</p>
    <p>{who}.</p>
    <p>{html.escape(PRODUCT_SUMMARY)}</p>{workshop_note}
    <p><strong>To sign in:</strong></p>
    <ol>
      <li>Open <a href="{url}" style="color: #4c51bf;">{url}</a></li>
      <li>Sign in with this email address and the temporary password below:
        <div style="font-family: monospace; font-size: 18px; font-weight: bold; color: #4c51bf; margin: 8px 0;">{code_parameter}</div>
      </li>
      <li>Choose your own password when asked. The temporary one works for {valid_days} days.</li>
    </ol>
    <p>If you were not expecting this invitation, check with {html.escape(audience.contact)} before signing in, or ignore this email. Nobody from VoC Analytics will ask you for your password by email or phone.</p>
    <p style="color: #666; font-size: 12px;">Support reference: {username_parameter}</p>
    <p style="margin-top: 24px;">{html.escape(audience.signature)}</p>"""
    return audience.subject, _page('Welcome to VoC Analytics', body)


def _forgot_password_message(code_parameter: str, sign_in_url: str) -> tuple[str, str]:
    body = f"""    <p>We received a request to reset your password for VoC Analytics.</p>
    <div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
      <p style="margin: 0 0 10px 0; color: #666;">Your password reset code:</p>
      <p style="font-family: monospace; font-size: 24px; font-weight: bold; color: #4c51bf; margin: 0;">{code_parameter}</p>
    </div>
    <p style="color: #666; font-size: 14px;">If you did not request this, please ignore this email.</p>
    <p style="text-align: center; margin-top: 20px;"><a href="{html.escape(sign_in_url)}" style="color: #4c51bf;">Go to VoC Analytics</a></p>"""
    return 'VoC Analytics - Reset your password', _page('Password Reset', body)


def _resend_code_message(code_parameter: str, sign_in_url: str) -> tuple[str, str]:
    body = f"""    <p>Here is your verification code for VoC Analytics.</p>
    <div style="background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
      <p style="margin: 0 0 10px 0; color: #666;">Your verification code:</p>
      <p style="font-family: monospace; font-size: 24px; font-weight: bold; color: #4c51bf; margin: 0;">{code_parameter}</p>
    </div>
    <p style="text-align: center; margin-top: 20px;"><a href="{html.escape(sign_in_url)}" style="color: #4c51bf;">Go to VoC Analytics</a></p>"""
    return 'VoC Analytics - Your verification code', _page('Verification Code', body)


def _valid_days() -> int:
    raw = os.environ.get('TEMP_PASSWORD_DAYS', '7')
    return int(raw) if raw.isdigit() and int(raw) > 0 else 7


def handler(event: dict, context: Any) -> dict:
    source = event.get('triggerSource', '')
    request = event.get('request') or {}
    code_parameter = request.get('codeParameter') or '{####}'
    sign_in_url = _sign_in_url()

    if source == INVITATION_SOURCE:
        attributes = request.get('userAttributes') or {}
        metadata = request.get('clientMetadata') or {}
        subject, message = invitation_message(
            audience=Audience(brand=brand_name(), workshop=_workshop()),
            inviter=clean_name(metadata.get('invited_by')),
            given_name=clean_name(attributes.get('given_name')),
            sign_in_url=sign_in_url,
            username_parameter=request.get('usernameParameter') or '{username}',
            code_parameter=code_parameter,
            valid_days=_valid_days(),
        )
    elif source == RESET_SOURCE:
        subject, message = _forgot_password_message(code_parameter, sign_in_url)
    elif source == RESEND_CODE_SOURCE:
        subject, message = _resend_code_message(code_parameter, sign_in_url)
    else:
        return event

    response = event.setdefault('response', {})
    response['emailSubject'] = subject
    response['emailMessage'] = message
    return event
