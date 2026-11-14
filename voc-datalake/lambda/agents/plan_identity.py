"""Who a plan step runs as: the approver, re-checked in Cognito before every step that acts.

A plan runs as ``plan:{plan_id}`` ACTING AS ITS APPROVER (docs/assistant-plan-mode.md → "Identity").
Before each write (and each think step, which reads as them) the conductor asks Cognito again:

- the user still exists, is enabled, and is the same person (its ``sub`` is the stored approver sub);
- for a plan approved in a workspace, the user is still a member of that active workspace (since 7.29.00; the
  approval itself required it, api/agents_handler.py), else the plan stops;
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

from botocore.exceptions import BotoCoreError, ClientError

from shared.ai_writing import PLAN_PRINCIPAL_CLAIM as PRINCIPAL_CLAIM
from shared.ai_writing import PLAN_PRINCIPAL_PREFIX
from shared.aws import get_cognito_idp_client as _cognito
from shared.exceptions import ConfigurationError
from shared.logging import logger
from shared.model_profile import E2E_GROUP
from shared.project_access import ACTING_SUBJECT_CLAIM, ADMIN_GROUP
from shared.request_workspace import is_current_member
from shared.workspace_ids import is_workspace_id
from shared.ws_repo import WORKSPACE_FIELD

USERS_GROUP: Final = 'users'
#: The workspace a plan was approved in (META ``workspace_id``), for the step's domain calls: not a claim, the plan
#: step sends it as their ``X-Workspace-Id`` header (stream/src/assistant/tools/internal-api.ts), and a domain route
#: that has moved into its workspace (so far the resolved problems; the rest in phases 2 and 3) resolves the approver's
#: membership there (lambda/shared/request_workspace.py).
WORKSPACE_CLAIM: Final = 'voc:workspace'
_GROUPS_PAGE: Final = 60


class ApproverRefused(Exception):
    """The approver may no longer run this step (message is client-safe)."""


class DirectoryUnavailable(Exception):
    """Cognito could not answer; the step fails closed."""


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


def _require_member(meta: Mapping[str, Any], sub: str) -> None:
    """For a plan approved in a workspace (its META's ``workspace_id``, since 7.29.00): the approver is still a member
    of that active workspace (shared/request_workspace.py ``is_current_member``), else ``ApproverRefused`` (the plan
    stops). A META whose field is not a non-empty string names none, as for the claim below; a string that is not a
    workspace id refuses; a read that fails is ``DirectoryUnavailable`` (closed)."""
    ws = meta.get(WORKSPACE_FIELD)
    if not isinstance(ws, str) or not ws:
        return
    if not is_workspace_id(ws):
        raise ApproverRefused('The plan names no workspace it may run in.')
    if not _is_member(ws, sub):
        raise ApproverRefused("The approver is no longer a member of the plan's workspace.")


def _is_member(ws: str, sub: str) -> bool:
    """The membership read; a failed one (or no table configured) is ``DirectoryUnavailable``: the step fails closed."""
    try:
        return is_current_member(ws, sub)
    except (ClientError, BotoCoreError, ConfigurationError) as exc:
        logger.exception('Approver membership re-check failed')
        raise DirectoryUnavailable('workspace membership') from exc


def _groups(username: str) -> set[str]:
    page = _directory_call('admin_list_groups_for_user', Username=username, Limit=_GROUPS_PAGE)
    return {g['GroupName'] for g in page.get('Groups', []) if isinstance(g, dict) and isinstance(g.get('GroupName'), str)}


def _step_groups(username: str, *, needs_admin: bool, admin_if_current: bool) -> set[str]:
    """The approver's groups now. An ordinary step (no admin question) still runs when Cognito cannot
    list them, as before the e2e profile read them; it then simply runs without that profile."""
    if needs_admin or admin_if_current:
        return _groups(username)
    try:
        return _groups(username)
    except DirectoryUnavailable:
        return set()


def require_approver(meta: Mapping[str, Any]) -> tuple[str, str]:
    """``(sub, username)`` of a plan's approver who may still act for it: the account exists, is enabled and is the
    same person, and for a workspace plan is still a member of that active workspace. No group listing: the check a
    wait needs before it reads (agents/conductor/plan_decide.py), and the start of every step's claims.

    Raises :class:`ApproverRefused` (stop the plan) or :class:`DirectoryUnavailable` (closed)."""
    sub, username = meta.get('approver_sub'), meta.get('approver_username')
    if not isinstance(sub, str) or not sub or not isinstance(username, str) or not username:
        raise ApproverRefused('The plan has no approver.')
    _require_current(username, sub)
    _require_member(meta, sub)
    return sub, username


def approver_claims(meta: Mapping[str, Any], *, needs_admin: bool, admin_if_current: bool = False) -> dict[str, str]:
    """The synthetic authorizer claims for one step, after the Cognito re-check.

    ``needs_admin``: the step requires ``admins`` (refused, plan stopped, when the approver is not one).
    ``admin_if_current``: the step may use admin-only reads; ``admins`` is forwarded only when the
    approver is in the group right now, otherwise the step runs as an ordinary user.

    Raises :class:`ApproverRefused` (stop the plan) or :class:`DirectoryUnavailable` (fail the step).
    """
    sub, username = require_approver(meta)
    current = _step_groups(username, needs_admin=needs_admin, admin_if_current=admin_if_current)
    if needs_admin and ADMIN_GROUP not in current:
        raise ApproverRefused('The approver is no longer an administrator.')
    admin = needs_admin or (admin_if_current and ADMIN_GROUP in current)
    names = [ADMIN_GROUP, USERS_GROUP] if admin else [USERS_GROUP]
    # The e2e test users' model profile (shared/model_profile.py) follows the approver's group, read now.
    if E2E_GROUP in current:
        names.append(E2E_GROUP)
    workspace = meta.get('workspace_id')
    return {
        'sub': sub, 'cognito:username': username, 'cognito:groups': ','.join(names),
        ACTING_SUBJECT_CLAIM: sub, PRINCIPAL_CLAIM: f"{PLAN_PRINCIPAL_PREFIX}{meta['plan_id']}",
        **({WORKSPACE_CLAIM: workspace} if isinstance(workspace, str) and workspace else {}),
    }
