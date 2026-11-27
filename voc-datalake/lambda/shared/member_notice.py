"""The notice an existing account gets when a workspace admin adds it to a workspace (docs/multi-workspace.md,
"Invites").

Sent only with ``-c emailFrom=<address>`` (``EMAIL_FROM``, and ``FRONTEND_URL`` for the link: both set by
lib/stacks/api-workspaces-lambda.ts with the flag, neither without it), through the deployment's one outbound mail
path (shared/outbound_mail.py). A new account gets nothing here: Cognito's own invitation (AdminCreateUser) already
emailed it. One email, in plain English like the Cognito invitation, from ``VoC Analytics``: the workspace's name,
the role, and the link ``{FRONTEND_URL}/workspace/{slug}/`` (the address the web app builds for the workspace,
frontend/src/workspace/workspacePath.ts ``workspaceUrl``). No inviter, no other member, nothing secret. The recipient
is the address Cognito holds for the account (the add's own look-up), never a field of the request.

Best effort, after the membership is written: nothing here raises. Every outcome is logged (the workspace id and the
outcome only: no address, no sub, no hash of either, since an unsalted hash of a sub is undone by anyone who can list
the subs) and counted (``WorkspaceMemberNotices`` by ``Outcome``: ``sent``,
``send_failed``, ``repeat``, ``email_off``, ``no_address``), and the add's answer says ``notified``.

The flood guard: before the send, a conditional put of ``WS#{ws}`` / ``NOTICE#{sub}`` (``sent_at`` and the table's TTL
attribute ``ttl``, a day on), which succeeds only when no such row exists or its ``ttl`` has passed (DynamoDB removes
an expired row within days, not at once). So a workspace notifies one account at most once a day, however often it is
removed and added again; a send that fails keeps the claim (one attempt a day). The row holds no address or name,
expires by itself, and a workspace's hard delete removes it with every other ``WS#{ws}`` row but ``META``
(lambda/jobs/workspace_delete/sweeps.py, the control rows). It is the one row of voc-workspaces besides ``INVITE#``
that carries ``ttl`` (shared/test/test_platform_workspaces.py pins both).
"""
from __future__ import annotations

import html
import os
import re
import time
import unicodedata
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, Final

from aws_lambda_powertools.metrics import MetricUnit, single_metric
from botocore.exceptions import BotoCoreError, ClientError

from shared import outbound_mail
from shared.exceptions import ValidationError
from shared.logging import logger, metrics
from shared.ops_alerts import normalize_email
from shared.outbound_mail import ACCENT, MUTED, TEXT
from shared.workspace import WorkspaceContext
from shared.workspace_ids import is_workspace_slug, ws_key
from shared.workspace_members import Account

#: The deployment's name, as the Cognito templates say it (lib/stacks/core-auth.ts).
APP_NAME: Final = 'VoC Analytics'
#: The subject's fixed start, as the Cognito templates' ("VoC Analytics - Welcome! …"); the name follows in quotes.
SUBJECT_PREFIX: Final = f'{APP_NAME} - You were added to '
#: At most this many characters of the workspace's name in the subject (an ellipsis ends a longer one).
MAX_SUBJECT_NAME: Final = 80
NOTICE_PREFIX: Final = 'NOTICE#'
#: One notice per workspace and account per this many seconds.
NOTICE_WINDOW_SECONDS: Final = 24 * 3600
METRIC: Final = 'WorkspaceMemberNotices'
#: The metric's ``Outcome`` values.
OUTCOME_SENT: Final = 'sent'
OUTCOME_FAILED: Final = 'send_failed'
OUTCOME_REPEAT: Final = 'repeat'
#: No ``-c emailFrom`` (no sender or no link origin).
OUTCOME_OFF: Final = 'email_off'
#: The account's Cognito address is not one plain address (none, or one the app's rule refuses).
OUTCOME_NO_ADDRESS: Final = 'no_address'
ROLE_WORDS: Final = {'admin': 'an admin', 'editor': 'an editor', 'viewer': 'a viewer'}
#: Control characters and line or paragraph separators become a space; format characters (bidi marks) go.
_TO_SPACE: Final = frozenset({'Cc', 'Zl', 'Zp', 'Zs'})
#: A name that reads as a link or an address to a mail client (a scheme, `www.`, an `@`, or a dotted host such as
#: `example.com`): such a name is never shown in the notice, which names the workspace by its slug instead, so the
#: notice's link is the one address in it (a slug is lowercase letters, digits and hyphens: shared/workspace_ids.py).
_LINK_LIKE: Final = re.compile(r'://|\bwww\.|@|[^\W_][\w-]*\.[^\W\d_]{2,}', re.IGNORECASE)


def one_line(value: str) -> str:
    """``value`` as one plain line: control characters and separators a space, format characters dropped, runs of
    spaces one, trimmed (so a name can never break a header or a line of the text)."""
    kept = []
    for ch in value:
        category = unicodedata.category(ch)
        if category in _TO_SPACE:
            kept.append(' ')
        elif category not in {'Cf', 'Cs', 'Co', 'Cn'}:
            kept.append(ch)
    return ' '.join(''.join(kept).split())


def shown_name(name: str, slug: str) -> str:
    """The workspace's name as the notice shows it: ``one_line`` of it, or the slug when that is empty or reads as a
    link or an address (``_LINK_LIKE``: a workspace admin chooses the name, and the deployment signs the email)."""
    clean = one_line(name)
    return slug if not clean or _LINK_LIKE.search(clean) else clean


def subject_line(name: str) -> str:
    """The subject: the fixed prefix and the workspace's name in quotes, on one line, cut to ``MAX_SUBJECT_NAME``."""
    clean = one_line(name)
    if len(clean) > MAX_SUBJECT_NAME:
        clean = f'{clean[:MAX_SUBJECT_NAME - 1]}…'
    return f'{SUBJECT_PREFIX}"{clean}"'


def workspace_link(frontend_url: str, slug: str) -> str:
    """The workspace's address in the web app, ``{frontend}/workspace/{slug}/``; ValueError for a slug the platform
    cannot make (shared/workspace_ids.py)."""
    if not is_workspace_slug(slug):
        raise ValueError('not a workspace slug')
    return f'{frontend_url.rstrip("/")}/workspace/{slug}/'


def _text_body(name: str, role: str, link: str) -> str:
    return (f'Hello,\n\nYou were added to the workspace "{name}" in {APP_NAME} as {role}.\n\n'
            f'Open it: {link}\n\n'
            f'You get this email because a workspace admin added your account. If you did not expect it, you can '
            f'ignore it or ask the workspace\'s admins.\n\n--\n{APP_NAME}\n')


def _html_body(name: str, role: str, link: str) -> str:
    esc = html.escape
    return (
        f'<!DOCTYPE html><html lang="en"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:{TEXT}">'
        f'<p>Hello,</p><p>You were added to the workspace "<strong>{esc(name)}</strong>" in {APP_NAME} as '
        f'{esc(role)}.</p>'
        f'<p><a href="{esc(link, quote=True)}" style="display:inline-block;padding:10px 18px;border-radius:8px;'
        f'background:{ACCENT};color:#ffffff;text-decoration:none">Open the workspace</a></p>'
        f'<p style="font-size:12px;color:{MUTED}">You get this email because a workspace admin added your account. '
        'If you did not expect it, you can ignore it or ask the workspace\'s admins.</p>'
        '</body></html>'
    )


def notice_request(to: str, context: WorkspaceContext, role: str, frontend_url: str) -> outbound_mail.SimpleEmail:
    """The notice to ``to`` for ``role`` in the workspace (pure). ValueError for an unknown role or a bad slug."""
    name = shown_name(context.name, context.slug)
    words = ROLE_WORDS[role]
    link = workspace_link(frontend_url, context.slug)
    return outbound_mail.SimpleEmail(to=to, subject=subject_line(name),
                                     text=_text_body(name, words, link), html=_html_body(name, words, link),
                                     sender_name=APP_NAME)


def _recipient(email: str) -> str | None:
    """The account's address when it is one plain address (the app's rule), else None."""
    try:
        normalize_email(email)
    except ValidationError:
        return None
    return email.strip() if email.isascii() and email.isprintable() else None


def _meter(outcome: str) -> None:
    try:
        with single_metric(name=METRIC, unit=MetricUnit.Count, value=1,
                           namespace=metrics.namespace or 'VoC') as metric:
            metric.add_dimension(name='Outcome', value=outcome)
    except Exception as error:  # noqa: BLE001 - a metric never fails the add
        logger.warning('Could not count a workspace member notice', extra={'error': type(error).__name__})


def _claim(table: Any, ws: str, sub: str, now: float) -> bool:
    """The day's guard row, put unless one is still live; False when one is (a notice went within the day)."""
    try:
        table.put_item(
            Item={'pk': ws_key(ws), 'sk': f'{NOTICE_PREFIX}{sub}', 'ttl': int(now) + NOTICE_WINDOW_SECONDS,
                  'sent_at': datetime.fromtimestamp(now, UTC).isoformat()},
            ConditionExpression='attribute_not_exists(pk) OR #ttl < :now',
            ExpressionAttributeNames={'#ttl': 'ttl'}, ExpressionAttributeValues={':now': int(now)})
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            return False
        raise
    return True


def _code(error: BaseException) -> str:
    if isinstance(error, ClientError):
        code = error.response.get('Error', {}).get('Code')
        if isinstance(code, str) and code.isascii() and code.isalnum():
            return code
    return type(error).__name__


def _outcome(table: Any, context: WorkspaceContext, sub: str, to: str, role: str, env: Mapping[str, str],
             now: float) -> str:
    from_address = (env.get('EMAIL_FROM') or '').strip()
    frontend_url = (env.get('FRONTEND_URL') or '').strip()
    if not from_address or not frontend_url:
        return OUTCOME_OFF
    email = notice_request(to, context, role, frontend_url)
    if not _claim(table, context.ws, sub, now):
        return OUTCOME_REPEAT
    outbound_mail.send(email, from_address)
    return OUTCOME_SENT


def notify_added_member(table: Any, context: WorkspaceContext, account: Account, role: str, *,
                        env: Mapping[str, str] | None = None, clock: Callable[[], float] = time.time) -> bool:
    """Tell ``account`` (just made a member with ``role``) by email, once a day at most; True when the notice went.
    Never raises: the add is done whatever happens here."""
    # The workspace and the outcome only: no address, no sub, no unsalted hash of one (a list of subs undoes it).
    extra = {'workspace_id': context.ws}
    if account.created:
        return False  # Cognito's invitation went to it
    to = _recipient(account.email)
    try:
        outcome = OUTCOME_NO_ADDRESS if to is None else _outcome(
            table, context, account.sub, to, role, os.environ if env is None else env, clock())
    # The code only, never the message: a client's validation error may quote the address.
    except (ClientError, BotoCoreError) as error:
        logger.warning('Workspace member notice not sent', extra={**extra, 'code': _code(error)})
        outcome = OUTCOME_FAILED
    except Exception as error:  # noqa: BLE001 - a notice never fails the add
        logger.warning('Workspace member notice failed', extra={**extra, 'code': type(error).__name__})
        outcome = OUTCOME_FAILED
    if outcome != OUTCOME_FAILED:
        logger.info('Workspace member notice', extra={**extra, 'outcome': outcome})
    _meter(outcome)
    return outcome == OUTCOME_SENT
