"""The app user pool's CustomMessage trigger: invitation, password-reset and verification-code emails.

The invitation (``CustomMessage_AdminCreateUser``) is what a new team member reads first, often before
anyone has told them what "VoC" is, so it says who invited them, to which workspace, what the product is,
and what to do if they did not expect it. It names:

- the company (Administration → Brand, ``SETTINGS#brand`` / ``config`` → ``brand_name`` in the aggregates
  table), when an admin has set one, and the colour prototypes use (Company → Design system, the
  ``primary``/``brand``/``accent`` hex colour token) for the header, the link and the password;
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
#: The design system (Company → Design system, shared/company_context.py DESIGN_SYSTEM_PK): its colour tokens give
#: the invitation the same accent colour prototypes are built with.
DESIGN_SYSTEM_KEY = {'pk': 'SETTINGS#design_system', 'sk': 'config'}
#: Colour token names, in order of preference, that name the accent; otherwise the first usable colour wins.
ACCENT_TOKEN_NAMES = ('primary', 'brand', 'accent')
#: The accent without a design system: the app's own indigo.
DEFAULT_ACCENT = '#4c51bf'
#: Only a plain hex colour goes into the email's inline styles (rgb()/hsl()/keywords are skipped, never echoed).
_HEX_COLOR = re.compile(r'#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})')
#: Longest brand or inviter name printed; anything longer is cut (an email subject has to stay readable).
MAX_NAME_CHARS = 80
#: Cognito's own default lifetime of a temporary password, stated when TEMP_PASSWORD_DAYS is unusable.
COGNITO_DEFAULT_TEMP_PASSWORD_DAYS = 7
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
            return f'the {self.brand} VoC Analytics workspace running on AWS'
        if self.workshop:
            return 'a VoC Analytics workspace running on AWS, set up for an AWS workshop'
        return 'a VoC Analytics workspace running on AWS'

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


def _read_settings(key: dict, what: str) -> dict:
    """One settings row from the aggregates table, or {} when it is missing or cannot be read (never raises)."""
    try:
        return _aggregates_table().get_item(Key=key).get('Item') or {}
    except (BotoCoreError, ClientError, KeyError) as error:
        logger.warning('%s lookup failed, using the default: %s', what, type(error).__name__)
        return {}


def brand_name() -> str:
    """The configured brand name, or '' when none is set or it cannot be read."""
    return clean_name(_read_settings(BRAND_KEY, 'Brand').get('brand_name'))


def pick_accent(colors: Any) -> str:
    """The accent among design-system colour tokens: the first hex colour named primary/brand/accent,
    else the first hex colour, else DEFAULT_ACCENT. Anything but a plain hex value is ignored."""
    entries = [c for c in colors if isinstance(c, dict)] if isinstance(colors, list) else []
    usable = [(str(c.get('name', '')).strip().lower(), str(c.get('value', '')).strip()) for c in entries]
    usable = [(name, value) for name, value in usable if _HEX_COLOR.fullmatch(value)]
    for wanted in ACCENT_TOKEN_NAMES:
        for name, value in usable:
            if name == wanted or name.startswith(f'{wanted}-'):
                return value.lower()
    return usable[0][1].lower() if usable else DEFAULT_ACCENT


def accent_color() -> str:
    """The invitation's accent: the design system's (as prototypes use it), or the app's own indigo."""
    tokens = _read_settings(DESIGN_SYSTEM_KEY, 'Design system').get('tokens')
    return pick_accent(tokens.get('colors') if isinstance(tokens, dict) else None)


def text_on(background: str) -> str:
    """White or near-black, whichever reads better on a hex ``background`` (WCAG relative luminance)."""
    hex_digits = background.lstrip('#')
    if len(hex_digits) == 3:
        hex_digits = ''.join(ch * 2 for ch in hex_digits)

    def channel(pair: str) -> float:
        value = int(pair, 16) / 255
        return value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4

    red, green, blue = (channel(hex_digits[i:i + 2]) for i in (0, 2, 4))
    luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    # Contrast against white is (1.05)/(L+0.05), against #111 about (L+0.05)/0.056: pick the larger.
    return '#ffffff' if 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.056 else '#111111'


def _workshop() -> bool:
    return os.environ.get('WORKSHOP', '').strip().lower() == 'true'


def _sign_in_url() -> str:
    return os.environ.get('SIGN_IN_URL', '').rstrip('/')


def _page(title: str, body: str, accent: str = DEFAULT_ACCENT) -> str:
    """The shared frame: a solid header in ``accent`` with readable text (no gradient: some clients drop it)."""
    return f"""<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
  <div style="background: {accent}; padding: 24px 30px;">
    <h1 style="color: {text_on(accent)}; margin: 0; font-size: 22px;">{title}</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
{body}
  </div>
</body>
</html>"""


def invitation_message(*, audience: Audience, inviter: str, given_name: str, sign_in_url: str,
                       username_parameter: str, code_parameter: str, valid_days: int,
                       accent: str = DEFAULT_ACCENT) -> tuple[str, str]:
    """(subject, html) for an invitation. ``audience``, ``inviter`` and ``given_name`` are unescaped;
    ``accent`` must already be a validated hex colour (``pick_accent``)."""
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
      <li>Open <a href="{url}" style="color: {accent};">{url}</a></li>
      <li>Sign in with this email address and the temporary password below:
        <div style="font-family: monospace; font-size: 18px; font-weight: bold; color: {accent}; margin: 8px 0;">{code_parameter}</div>
      </li>
      <li>Choose your own password when asked. The temporary one works for {valid_days} days.</li>
    </ol>
    <p>If you were not expecting this invitation, check with {html.escape(audience.contact)} before signing in, or ignore this email. Nobody from VoC Analytics will ask you for your password by email or phone.</p>
    <p style="color: #666; font-size: 12px;">Support reference: {username_parameter}</p>
    <p style="margin-top: 24px;">{html.escape(audience.signature)}</p>"""
    return audience.subject, _page('Welcome to VoC Analytics', body, accent)


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
    # Always set by the stack (core-auth.ts TEMPORARY_PASSWORD_DAYS); an unparsable value keeps Cognito's 7.
    raw = os.environ['TEMP_PASSWORD_DAYS'].strip()
    return int(raw) if raw.isdigit() and int(raw) > 0 else COGNITO_DEFAULT_TEMP_PASSWORD_DAYS


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
            accent=accent_color(),
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
