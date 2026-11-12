"""Platform admins: the Cognito group ``platform-admins`` (docs/multi-workspace.md, "Control plane").

Two checks, for two jobs:

* ``require_platform_admin`` (and ``is_platform_admin``): the caller's TOKEN carries the group. The visible gate at
  the top of every platform-admin route (``lambda/api/test/test_route_admin_gates.py`` looks for the call): 403 for
  everyone else, an administrator outside the group included.
* ``is_live_platform_admin``: the caller is a platform admin NOW, by the token's group AND the caller's live Cognito
  membership (``AdminListGroupsForUser``) AND an enabled account whose ``sub`` is the token's (``AdminGetUser``:
  a reused username is not the same person). One page of groups is read: Cognito's first page holds 60, and a
  user in more groups than that is outside this sample's model. A token keeps its groups until
  it expires, so a revoked or disabled platform admin's token alone would still pass; the live look-up makes a
  revoke or a disable take effect at once. The users API (its platform-admin rules), the workspaces API's
  ``/platform`` routes, a platform admin's entry into a workspace (shared/workspace.py) and the writes of what every
  workspace shares (shared/platform_admin_gate.py: the start theme, the alerts) all use this one check.

A caller with no username claim, an unknown (deleted) user, a missing group or a disabled account is not a
platform admin. A failed look-up (a Cognito fault) raises ``ClientError`` / ``BotoCoreError``: each caller answers
its own fixed 500 and never admits the caller.
"""
from __future__ import annotations

from typing import Any, Final

from shared.api import get_caller_groups
from shared.caller_claims import first_claim
from shared.exceptions import AuthorizationError

PLATFORM_ADMIN_GROUP: Final = 'platform-admins'
#: The claims that name the caller to Cognito's admin calls (the REST authorizer's, then the access token's).
_USERNAME_CLAIMS: Final = ('cognito:username', 'username')


def is_platform_admin(event: dict) -> bool:
    """Whether the caller's token carries the ``platform-admins`` group."""
    return PLATFORM_ADMIN_GROUP in get_caller_groups(event)


def require_platform_admin(event: dict) -> None:
    """403 unless the caller's token carries the group (an administrator outside the group is refused too)."""
    if not is_platform_admin(event):
        raise AuthorizationError('Platform admin access required')


def is_live_platform_admin(event: dict, cognito: Any, user_pool_id: str) -> bool:
    """Whether the caller is a platform admin now: the token's group, the live membership and an enabled account.

    ``cognito`` is the caller's ``cognito-idp`` client (its ``exceptions.UserNotFoundException`` is caught: a
    deleted caller whose token is still valid is refused, not a fault). Every other Cognito error propagates.
    """
    if not is_platform_admin(event):
        return False
    username = first_claim(event, _USERNAME_CLAIMS)
    if username is None:
        return False
    try:
        groups = cognito.admin_list_groups_for_user(Username=username, UserPoolId=user_pool_id).get('Groups', [])
        # A disabled account keeps its groups, and its unexpired ID token still passes the authorizer: require both.
        if PLATFORM_ADMIN_GROUP not in [group.get('GroupName') for group in groups]:
            return False
        caller = cognito.admin_get_user(UserPoolId=user_pool_id, Username=username)
    except cognito.exceptions.UserNotFoundException:
        return False
    # The same person, not only the same name: a deleted platform admin's token must not pass on an account that
    # reused the username.
    attributes = {attr.get('Name'): attr.get('Value') for attr in caller.get('UserAttributes', [])}
    return caller.get('Enabled') is True and attributes.get('sub') == first_claim(event, ('sub',))
