"""Who a plan step runs as: the approver, re-checked in Cognito before every step that acts.

A plan runs as ``plan:{plan_id}`` ACTING AS ITS APPROVER (docs/assistant-plan-mode.md → "Identity").
Before each write (and each think step, which reads as them) the conductor asks Cognito again:

- the user still exists, is enabled, and is the same person (its ``sub`` is the stored approver sub);
- for an admin-only tool or pack, the user is still in ``admins`` — and only then do the synthetic
  claims carry ``admins``, for that one step.

So a user who is disabled or demoted mid-run stops the plan at its next step. The same re-check the
global MCP server makes for a token's minter (``api/mcp_global_handler.py``), with one difference: a
directory fault here fails the step (closed) instead of the request.
"""
from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any, Final

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from shared.logging import logger
from shared.project_access import ACTING_SUBJECT_CLAIM, ADMIN_GROUP

USERS_GROUP: Final = 'users'
PRINCIPAL_CLAIM: Final = 'voc:principal'
PLAN_PRINCIPAL_PREFIX: Final = 'plan:'
_GROUPS_PAGE: Final = 60


class ApproverRefused(Exception):
    """The approver may no longer run this step (message is client-safe)."""


class DirectoryUnavailable(Exception):
    """Cognito could not answer; the step fails closed."""


_client: Any = None


def _cognito() -> Any:
    global _client
    if _client is None:
        _client = boto3.client('cognito-idp')
    return _client


def _pool() -> str:
    pool = os.environ.get('USER_POOL_ID', '')
    if not pool:
        raise DirectoryUnavailable('USER_POOL_ID is not configured')
    return pool


def _directory_call(operation: str, **kwargs: Any) -> dict:
    try:
        return getattr(_cognito(), operation)(UserPoolId=_pool(), **kwargs)
    except (ClientError, BotoCoreError) as exc:
        if isinstance(exc, ClientError) and exc.response.get('Error', {}).get('Code') == 'UserNotFoundException':
            raise ApproverRefused("The approver's account no longer exists.") from exc
        logger.exception('Approver re-check failed', extra={'operation': operation})
        raise DirectoryUnavailable(operation) from exc


def _require_current(username: str, sub: str) -> None:
    user = _directory_call('admin_get_user', Username=username)
    attributes = {a.get('Name'): a.get('Value') for a in user.get('UserAttributes', []) if isinstance(a, dict)}
    if not user.get('Enabled', False):
        raise ApproverRefused("The approver's account is disabled.")
    if attributes.get('sub') != sub:
        raise ApproverRefused("The approver's account no longer matches the plan.")


def _require_admin(username: str) -> None:
    page = _directory_call('admin_list_groups_for_user', Username=username, Limit=_GROUPS_PAGE)
    groups = {g.get('GroupName') for g in page.get('Groups', []) if isinstance(g, dict)}
    if ADMIN_GROUP not in groups:
        raise ApproverRefused('The approver is no longer an administrator.')


def _is_admin(username: str) -> bool:
    try:
        _require_admin(username)
    except ApproverRefused:
        return False
    return True


def approver_claims(meta: Mapping[str, Any], *, needs_admin: bool, admin_if_current: bool = False) -> dict[str, str]:
    """The synthetic authorizer claims for one step, after the Cognito re-check.

    ``needs_admin``: the step requires ``admins`` (refused, plan stopped, when the approver is not one).
    ``admin_if_current``: the step may use admin-only reads; ``admins`` is forwarded only when the
    approver is in the group right now, otherwise the step runs as an ordinary user.

    Raises :class:`ApproverRefused` (stop the plan) or :class:`DirectoryUnavailable` (fail the step).
    """
    sub, username = meta.get('approver_sub'), meta.get('approver_username')
    if not isinstance(sub, str) or not sub or not isinstance(username, str) or not username:
        raise ApproverRefused('The plan has no approver.')
    _require_current(username, sub)
    if needs_admin:
        _require_admin(username)
    admin = needs_admin or (admin_if_current and _is_admin(username))
    groups = f'{ADMIN_GROUP},{USERS_GROUP}' if admin else USERS_GROUP
    return {
        'sub': sub, 'cognito:username': username, 'cognito:groups': groups,
        ACTING_SUBJECT_CLAIM: sub, PRINCIPAL_CLAIM: f"{PLAN_PRINCIPAL_PREFIX}{meta['plan_id']}",
    }
